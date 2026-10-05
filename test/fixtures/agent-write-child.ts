/**
 * One coordinated write, in a process of its own — and the plumbing for tests
 * that need one.
 *
 * The multi-process tests need a second real pi process, not a second task in
 * one: what is being tested is that two processes sharing an agent file cannot
 * interleave, and an in-process stand-in would only test the stand-in. Run as a
 * program, this module takes one JSON job as its only argument, prints its
 * result as JSON, and exits. It is not a `*.test.ts` file, so the runner does
 * not collect it, and its job only runs when it *is* the program — importing the
 * helpers below from a test must not run whatever argument the test runner was
 * given.
 *
 * Three job kinds exist for the cases a child cannot be instrumented from
 * outside. `hold` keeps the lock until the parent drops a release file, which is
 * how a test observes contention from the other side. `hold-then-die` takes the
 * lock and SIGKILLs itself, the only honest way to leave a lock behind the way a
 * crash does. An `apply` that names `readyMarker` and `awaitFile` announces
 * itself and then waits, so a test can start several writes at the same instant
 * rather than one after another.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type Coordination,
  type FileWritePacing,
  type ThinkingLevel,
  type WriteResult,
  applyDecision,
  parseModelId,
  withFileLock,
} from "../../src/index.ts";

const FIXTURE = fileURLToPath(import.meta.url);

/** How long a waiting child sleeps between looks for the file it is waiting on. */
const WAIT_POLL_MS = 2;

/** How long a child holds the lock for a test that is not about that timing. */
const HOLD_DEADLINE_MS = 15_000;

/** How long the parent waits for a child's ready or holder marker before failing. */
const MARKER_WAIT_MS = 10_000;

/** How long a spawned child is given to exit before it is killed as hung. */
const CHILD_EXIT_MS = 20_000;

interface JobBase {
  file: string;
  /** Small timings, so a test never waits out the shipped ones. */
  pacing?: Partial<FileWritePacing>;
}

type Job =
  | (JobBase & {
      kind: "apply";
      model: string;
      /** What this child's pass read, which is what its write may replace. */
      base: string | undefined;
      thinking?: ThinkingLevel;
      dry?: boolean;
      /** Created once this child is loaded, before it waits for `awaitFile`. */
      readyMarker?: string;
      /** Waited for before the write, so several children can be let go at once. */
      awaitFile?: string;
    })
  | (JobBase & { kind: "hold"; marker: string; release: string })
  | (JobBase & { kind: "hold-then-die"; marker: string });

/**
 * Timings for the tests that are not about timing: stale enough that a live
 * holder is never taken over, and patient enough that contention between the
 * spawned children resolves rather than refusing.
 */
export const FAST: Partial<FileWritePacing> = { staleMs: 10_000, waitMs: 2_000, pollMs: 5 };

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface Holder {
  pid: number;
  /** Cues the child to let go, and waits for it to exit. */
  release: () => Promise<ChildResult>;
  done: Promise<ChildResult>;
}

/** Polls `predicate` rather than sleeping a fixed time, so a slow machine is slow, not flaky. */
export async function waitUntil(
  what: string,
  predicate: () => boolean,
  timeoutMs = MARKER_WAIT_MS,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

/**
 * Spawn the fixture with one job.
 *
 * The deadline is not about the work being slow — it is what keeps a fixture
 * that never exits (a lost release file, a lock nobody takes over) a failing
 * test rather than a hung suite. Whatever is still running at the deadline is
 * killed, and the assertion on the signal is the test's to make.
 */
export function spawnFixture(
  job: unknown,
  timeoutMs = CHILD_EXIT_MS,
): { child: ChildProcess; done: Promise<ChildResult> } {
  const child = spawn(process.execPath, [FIXTURE, JSON.stringify(job)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const done = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture never exited for ${JSON.stringify(job)}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

/** Fails rather than returning a result for a child that was killed instead of exiting. */
export function assertCleanExit(result: ChildResult): void {
  if (result.signal !== null || result.code !== 0) {
    throw new Error(
      `fixture exited ${result.signal ?? result.code}: ${result.stderr}${result.stdout}`,
    );
  }
}

export async function runFixture(job: unknown): Promise<WriteResult> {
  const result = await spawnFixture(job).done;
  assertCleanExit(result);
  return JSON.parse(result.stdout) as WriteResult;
}

/**
 * A real second process holding `file`'s lock, so a test sees contention from the
 * outside rather than through an in-process stand-in.
 */
export async function startHolder(
  file: string,
  pacing: Partial<FileWritePacing> = FAST,
): Promise<Holder> {
  const marker = `${file}.holder`;
  const release = `${file}.release`;
  const { child, done } = spawnFixture({ kind: "hold", file, marker, release, pacing });
  await waitUntil("the child to take the lock", () => existsSync(marker));
  return {
    pid: child.pid ?? 0,
    done,
    release: async () => {
      await writeFile(release, "", "utf8");
      return done;
    },
  };
}

/** Resolves once `path` exists, so the parent can hand a running child a cue. */
async function waitForFile(path: string): Promise<void> {
  const until = Date.now() + HOLD_DEADLINE_MS;
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch (err) {
      // Only absence is worth waiting on. A file this process cannot open will
      // not become openable by asking again, and a deadline would report it as
      // the wrong fault.
      if ((err as { code?: unknown } | null)?.code !== "ENOENT") throw err;
      if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  }
}

async function runJob(job: Job): Promise<void> {
  const coordination: Coordination = job.pacing === undefined ? {} : { pacing: job.pacing };

  switch (job.kind) {
    case "apply": {
      // The job arrives as decoded JSON, so its model is a raw string again.
      // Validate it before touching a file: a job that names an id this seam
      // would never accept is refused here rather than handed to a write.
      const model = parseModelId(job.model);
      if ("rejection" in model) {
        const result: WriteResult = { kind: "held", why: model.rejection };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        break;
      }
      if (job.readyMarker !== undefined) await writeFile(job.readyMarker, "ready", "utf8");
      if (job.awaitFile !== undefined) await waitForFile(job.awaitFile);
      const result = await applyDecision(
        {
          file: job.file,
          model: model.value,
          ...(job.thinking === undefined ? {} : { thinking: job.thinking }),
          base: job.base,
          dry: job.dry ?? false,
        },
        coordination,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      break;
    }
    case "hold": {
      const attempt = await withFileLock(job.file, coordination, async () => {
        await writeFile(job.marker, "held", "utf8");
        await waitForFile(job.release);
      });
      process.stdout.write(`${JSON.stringify(attempt)}\n`);
      break;
    }
    case "hold-then-die": {
      await withFileLock(job.file, coordination, async () => {
        await writeFile(job.marker, "held", "utf8");
        process.kill(process.pid, "SIGKILL");
      });
      break;
    }
  }
}

// Only when executed, so that importing the helpers above from a test does not
// try to run the test runner's own arguments as a job.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJob(JSON.parse(process.argv[2] ?? "{}") as Job);
}
