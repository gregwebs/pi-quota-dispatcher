/**
 * Explicit configuration generation.
 *
 * A configuration file may declare a `generator.command` that prints a whole
 * ordinary configuration layer as JSON. The `/quota-dispatch generate` form
 * runs it, validates everything it printed all-or-nothing, and — only then —
 * replaces that one file's ordinary contents, preserving the declaration that
 * named the command. This module is the whole of that: the bounded execution,
 * the strict check in the context of the layer beneath, the atomic publication,
 * and the failure rendering. It knows nothing about dispatchers, pi, timers or
 * UI; the runtime is supplied by a `prepare` callback run before publication.
 *
 * Two things are deliberately narrower than they might look. A generated layer
 * replaces *one* file, not the merged configuration: the other layer is read as
 * an ordinary load would read it and the result is the configuration those two
 * files describe together. And the run is bounded execution of trusted user
 * code, not a sandbox: the process group is killed on timeout, but a descendant
 * that deliberately detaches is beyond what this promises. See
 * docs/adr/0015-configuration-generation.md.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  type ConfigFileFault,
  type GeneratorDeclaration,
  type LoadedConfig,
  DEFAULT_GENERATOR_TIMEOUT_MS,
  errorText,
  escapeInvisible,
  loadConfigReplacingLayer,
  parseConfigObject,
  parseGeneratorDeclaration,
} from "./config.ts";
import { type Coordination, errnoIs, replaceFileAtomically, withFileLock } from "./agent-file.ts";

/**
 * The most stdout bytes a generator may produce. A configuration is kilobytes;
 * a megabyte is an order of magnitude of headroom for a generator that pretty-
 * prints, and still a bound the process cannot walk past.
 */
export const GENERATOR_STDOUT_CAP_BYTES = 1024 * 1024;

/** The stderr tail kept, per run: enough to diagnose, bounded regardless. */
export const GENERATOR_STDERR_CAP_BYTES = 16 * 1024;

/** The most stderr lines rendered in a diagnostic. */
export const GENERATOR_STDERR_LINES = 20;

export interface BashRunInput {
  command: string;
  /** The working directory; the target config file's own directory. */
  cwd: string;
  timeoutMs: number;
}

/**
 * What one bounded run ended as.
 *
 * `failure` is set whenever the run did not complete normally — a timeout, a
 * stdout overflow, a signal, a non-zero exit, or a spawn fault. It is `undefined`
 * only for a process that exited 0 *and* whose output pipes closed, which is the
 * success condition the contract states.
 */
export interface BashRun {
  stdout: Buffer;
  stderr: Buffer;
  failure?: string;
}

/** The execution seam, so tests can exercise the orchestration without Bash. */
export type BashRunner = (input: BashRunInput) => Promise<BashRun>;

/** Concatenate a chunk list, preserving order. */
function join(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat(chunks);
}

/** Keep only the last `cap` bytes of a growing chunk list, mutating it. */
function trimTail(chunks: Buffer[], state: { bytes: number }, cap: number): void {
  while (state.bytes > cap && chunks.length > 0) {
    const first = chunks[0];
    const excess = state.bytes - cap;
    if (first.length <= excess) {
      chunks.shift();
      state.bytes -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      state.bytes -= excess;
    }
  }
}

/**
 * Run `bash -c <command>` under a timeout, capturing bounded output.
 *
 * A local runner rather than pi's own `exec`, for three reasons the contract
 * cares about: pi's capture is unbounded, its exit status is ambiguous when a
 * signal killed the child, and its timeout leaves the process alive. Here the
 * command runs in its own process group (POSIX), stdout is capped, stderr is a
 * bounded tail, and the group is killed the moment either the clock or the cap
 * is reached — so a script that spawns a background process and exits still
 * settles when the timeout fires, rather than hanging on a pipe a grandchild
 * holds open.
 *
 * stdin is the null device, so a generator that reads it sees EOF and cannot
 * block waiting for input nobody is there to type.
 */
export function runBash(input: BashRunInput): Promise<BashRun> {
  return new Promise<BashRun>((settle) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutBytes = { bytes: 0 };
    const stderrBytes = { bytes: 0 };

    const finish = (result: BashRun): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      settle(result);
    };

    const captured = (): { stdout: Buffer; stderr: Buffer } => ({
      stdout: join(stdoutChunks),
      stderr: stderrBytes.bytes > 0 ? join(stderrChunks) : Buffer.alloc(0),
    });

    const killGroup = (): void => {
      if (child === undefined || child.pid === undefined) return;
      const pid = child.pid;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch (err) {
        // ESRCH is the group already gone, which is the outcome wanted. Any
        // other failure to signal the group — or a platform without detach —
        // falls back to the direct child, which is still worth killing.
        if (!errnoIs(err, "ESRCH")) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child is gone too; nothing left to kill.
          }
        }
      }
    };

    const settleFailure = (failure: string): void => {
      killGroup();
      const { stdout, stderr } = captured();
      // Destroyed rather than drained: the settle must not wait on a pipe a
      // descendant holds open, and a stream left live would emit late events
      // into a handler that has already answered.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      finish({ stdout, stderr, failure });
    };

    try {
      child = spawn("bash", ["-c", input.command], {
        cwd: input.cwd,
        // A new process group, so the timeout can kill what the command started
        // rather than only the shell. Not on Windows, where `detached` means a
        // console rather than a group and signalling is per-process.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), failure: `could not be started (${errorText(err)})` });
      return;
    }

    timer = setTimeout(
      () =>
        settleFailure(
          exited
            ? // The shell is gone but a descendant still holds a pipe. Reporting
              // "did not finish" would blame the command for the pipe; the exit
              // status is still the useful part, so it is carried into the line.
              exitSignal !== null
              ? `exited on ${exitSignal}, but a background process kept its output open`
              : `exited with code ${exitCode}, but a background process kept its output open`
            : `did not finish within ${input.timeoutMs} ms`,
        ),
      input.timeoutMs,
    );
    timer.unref?.();

    child.on("exit", (code, signal) => {
      // Recorded separately from `close`, which waits for the output pipes: a
      // command that exits while a background descendant holds a pipe open
      // reaches the timer with the process already gone.
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });

    child.on("error", (err) => {
      // A failure to spawn — a missing cwd, an environment without bash — is not
      // a run that produced output, so the failure stands alone.
      finish({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), failure: `could not be started (${errorText(err)})` });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutBytes.bytes += chunk.length;
      if (stdoutBytes.bytes > GENERATOR_STDOUT_CAP_BYTES) {
        settleFailure(`produced more than ${GENERATOR_STDOUT_CAP_BYTES} bytes on stdout`);
      }
    });
    child.stdout?.on("error", () => settleFailure("its stdout could not be read"));

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes.bytes += chunk.length;
      trimTail(stderrChunks, stderrBytes, GENERATOR_STDERR_CAP_BYTES);
    });
    child.stderr?.on("error", () => {
      // stderr is a diagnostic, not the result: losing it must not lose a run
      // that otherwise succeeded.
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      const { stdout, stderr } = captured();
      if (signal !== null) {
        finish({ stdout, stderr, failure: `was killed by ${signal}` });
        return;
      }
      if (code !== 0) {
        finish({ stdout, stderr, failure: `exited with code ${code}` });
        return;
      }
      finish({ stdout, stderr });
    });
  });
}

/** The stderr tail as diagnostic lines, escaped and capped. */
export function describeStderr(stderr: Buffer): string[] {
  if (stderr.length === 0) return [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(stderr);
  const lines = text
    .split("\n")
    .map((line) => escapeInvisible(line.replace(/\r$/, "")))
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  return ["stderr:", ...lines.slice(-GENERATOR_STDERR_LINES).map((line) => `  ${line}`)];
}

/** The one-line rendering of a config-fault, without the path or consequence. */
function faultLine(fault: ConfigFileFault): string {
  switch (fault.kind) {
    case "unreadable":
      return `could not be read (${escapeInvisible(fault.detail)})`;
    case "not-an-object":
      return "it is not a JSON object";
    case "not-json": {
      const at = fault.at === undefined ? undefined : `line ${fault.at.line}, column ${fault.at.column}`;
      const where = [at, escapeInvisible(fault.detail)].filter(Boolean).join(": ");
      return `it is not valid JSON${where === "" ? "" : ` (${where})`}`;
    }
  }
}

export interface GenerateConfigRequest<P> {
  /** Which layer the generated output replaces. */
  source: "global" | "project";
  /** The target configuration file's path. */
  path: string;
  agentDir?: string;
  cwd?: string;
  readFile?: (path: string) => Promise<string>;
  /** Runs the command; defaults to the bounded Bash runner. */
  run?: BashRunner;
  /** Lock pacing, for tests and for a caller that wants different patience. */
  coordination?: Coordination;
  /**
   * Build the runtime for the validated configuration *before* anything is
   * published, so a configuration that cannot boot never reaches the disk. Must
   * not write the config file or an agent file.
   */
  prepare: (loaded: LoadedConfig) => Promise<P>;
  /**
   * Quiesce same-extension writes and return a release. Acquired after
   * preparation and held across publication; a failed run releases it here, and
   * a successful one hands it back for the caller to release once it has
   * swapped its caches.
   */
  acquireFence?: () => Promise<() => void>;
}

export type GenerateConfigResult<P> =
  | {
      kind: "generated";
      /** The resolved target the bytes were published to. */
      path: string;
      /** The validated configuration the file now describes. */
      loaded: LoadedConfig;
      /** The runtime prepared before publication. */
      prepared: P;
      /** The load's warnings, environment warnings excepted; see the caller. */
      warnings: string[];
      /** Release the same-extension write fence. Idempotent. */
      release: () => void;
      /** Set only for a committed change whose lock release then failed. */
      cleanupNote?: string;
    }
  | { kind: "failed"; lines: string[] };

/** Raised inside the lock when the target's bytes moved under this run. */
class TargetChanged extends Error {}

/** Render one failure into the lines a diagnostic is shown as. */
function renderFailure(path: string, reason: string[], stderr: string[]): string[] {
  return [
    `quota-dispatcher: generating ${path} failed.`,
    ...reason,
    ...stderr,
    "This run did not change the configuration file or the active configuration.",
  ];
}

/**
 * Run the target file's declared generator, validate its output, and publish it.
 *
 * The subprocess runs outside the lock: a generator is not something a shared
 * lock should be held across. Publication is the atomic rename, and everything
 * before it is failure-preserving — the file's bytes are untouched and the
 * caller's active configuration stays as it was. A change to the target while
 * the generator ran is a failure, not permission to clobber the other writer;
 * that external edit is left in place.
 */
export async function generateConfig<P>(
  req: GenerateConfigRequest<P>,
): Promise<GenerateConfigResult<P>> {
  const cwd = req.cwd ?? process.cwd();
  const read = req.readFile ?? ((path: string) => readFile(path, "utf8"));
  const run = req.run ?? runBash;
  const target = resolve(req.path);

  const fail = (reason: string[], stderr: string[] = []): GenerateConfigResult<P> => ({
    kind: "failed",
    lines: renderFailure(target, reason, stderr),
  });

  let original: string;
  try {
    original = await read(target);
  } catch (err) {
    return fail([`the configuration file could not be read (${errorText(err)})`]);
  }

  const parsedTarget = parseConfigObject(original);
  if (parsedTarget.kind === "fault") {
    return fail([`the configuration file ${faultLine(parsedTarget.fault)}`]);
  }
  if (parsedTarget.data.generator === undefined) {
    return fail([`the configuration file declares no "generator" command`]);
  }
  const declared = parseGeneratorDeclaration(parsedTarget.data.generator);
  if ("rejections" in declared) {
    return fail(['the configuration file\'s "generator" declaration is invalid:', ...declared.rejections.map((r) => `  ${r}`)]);
  }
  const declaration: GeneratorDeclaration = declared.declaration;

  const ran = await run({
    command: declaration.command,
    cwd: dirname(target),
    timeoutMs: declaration.timeoutMs ?? DEFAULT_GENERATOR_TIMEOUT_MS,
  });
  // Captured once, and carried through every later failure: the generator's own
  // account of what went wrong is what the user needs, whether the run failed
  // or its output did.
  const stderr = describeStderr(ran.stderr);
  if (ran.failure !== undefined) {
    return fail([`the generator ${ran.failure}.`], stderr);
  }

  let stdout: string;
  try {
    // Fatal decoding, and the byte-order mark is *not* stripped: a BOM is not
    // something JSON.parse accepts, and hiding it here would turn a file that
    // is not valid JSON into one this seam pretends is.
    stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(ran.stdout);
  } catch {
    return fail(["the generator's output is not valid UTF-8."], stderr);
  }

  const printed = parseConfigObject(stdout);
  if (printed.kind === "fault") {
    return fail([`the generator's output ${faultLine(printed.fault)}.`], stderr);
  }

  // The declaration the printed layer carries is never the one that governs:
  // this file's own declaration does, and it is preserved as the same JSON
  // value. It is dropped before serialization rather than after, so a malformed
  // one in the output cannot survive even into the bytes.
  const ordinary: Record<string, unknown> = { ...printed.data };
  delete ordinary.generator;

  // Validate the exact bytes that will be written. Serializing first and
  // re-parsing means the check and the write cannot disagree — in particular,
  // a number too large for JSON (`1e400`) becomes `null` on the way through and
  // is rejected as the wrong type rather than silently dropped.
  const serialized = `${JSON.stringify({ generator: parsedTarget.data.generator, ...ordinary }, null, 2)}\n`;
  const validated = parseConfigObject(serialized);
  if (validated.kind === "fault") {
    return fail([`the generator's output could not be re-serialized (${faultLine(validated.fault)})`], stderr);
  }

  const replacement = await loadConfigReplacingLayer({
    source: req.source,
    path: target,
    data: validated.data,
    ...(req.agentDir !== undefined ? { agentDir: req.agentDir } : {}),
    cwd,
    readFile: read,
  });
  if (replacement.kind === "rejected") {
    return fail(
      ["its output is not a valid configuration.", ...replacement.rejections.map((r) => `  ${r}`)],
      stderr,
    );
  }
  const loaded = replacement.loaded;

  let prepared: P;
  try {
    prepared = await req.prepare(loaded);
  } catch (err) {
    return fail([`the configuration could not be prepared (${errorText(err)})`], stderr);
  }

  const release = req.acquireFence ? await req.acquireFence() : () => {};
  let published = false;
  let cleanupNote: string | undefined;
  try {
    const attempt = await withFileLock(target, req.coordination ?? {}, async (resolved) => {
      // Compare-and-swap: the bytes the run started from, re-read under the
      // lock. A different file — an edit by hand, another process's generation —
      // is left exactly as it is rather than overwritten with an answer built
      // from an older reading.
      if ((await read(resolved)) !== original) throw new TargetChanged();
      await replaceFileAtomically(resolved, serialized);
      published = true;
    });
    if (!attempt.ok) {
      release();
      const why =
        attempt.reason === "held"
          ? "another process holds the file's lock."
          : "the file was removed before it could be replaced.";
      return fail([why], stderr);
    }
  } catch (err) {
    const cause = err instanceof AggregateError ? err.errors[0] : err;
    if (!published) {
      release();
      if (cause instanceof TargetChanged) {
        return fail(["the file changed while the generator ran."], stderr);
      }
      return fail([`the file could not be replaced (${errorText(cause)})`], stderr);
    }
    // The rename landed; only the lock release failed. The change is committed
    // on disk, so it cannot be reported as unchanged — a user told otherwise
    // would edit a file that already moved, and the active configuration swaps
    // to match what is written.
    cleanupNote = `the generated file was published, but its lock could not be released (${errorText(cause)})`;
  }

  return {
    kind: "generated",
    path: target,
    loaded,
    prepared,
    warnings: loaded.warnings,
    release,
    ...(cleanupNote !== undefined ? { cleanupNote } : {}),
  };
}
