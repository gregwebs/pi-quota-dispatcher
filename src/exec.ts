/**
 * One subprocess, read back as text — and, separately, one spawned and only
 * watched.
 *
 * Two shapes, because two kinds of caller want opposite things. The text runners
 * read a credential or a ping: the keychain read and the refresh ping. The
 * spawned run reports only *how it ended*, because its caller must never see what
 * it printed — the Codex CLI talks about an account, and the line that reports
 * the run is allowed to carry no vendor text at all. Neither shape belongs to a
 * caller: `execFile` and `spawn` are what every process in this extension is, and
 * what differs is a timeout, an environment, and whether the output is the point.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * One command's answer: the text it printed, or why it could not be read.
 *
 * A store is read for its *text* rather than for a parsed token because a
 * credential file and a login keychain hold the same JSON shape, so both are
 * judged by the same parser instead of by two that could disagree. A command
 * that failed is a `CredentialRead` too: the ping's own exit is evidence, and
 * its stderr is the one line the user is told about.
 */
export type CredentialRead = { text: string } | { error: string };

/**
 * Runs one command and resolves its stdout as text, or the reason it failed.
 * The seam every runner here offers, so that the argv a caller builds can be
 * tested without the binary on the machine running the tests.
 */
export type CommandRunner = (file: string, args: string[]) => Promise<CredentialRead>;

/**
 * The real runner, for one subprocess: its stdout is the value read back, and a
 * failure is reported as the one line a reader can act on — what the command
 * said, its exit code when it said nothing, or the reason the process never ran.
 *
 * `env` narrows the child's environment; left off, the child inherits this
 * process's, which is what every runner here but the refresh ping wants.
 */
export function execFileRunner(timeoutMs: number, env?: NodeJS.ProcessEnv): CommandRunner {
  return (file, args) =>
    new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          ...(env === undefined ? {} : { env }),
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ text: stdout.trim() });
          resolve({ error: failureDetail(err, stderr, timeoutMs) });
        },
      );
      // A child that reads stdin would otherwise wait for input that is never
      // coming until the timeout kills it; ending the pipe hands it EOF instead.
      //
      // Spawn's `stdio: ["ignore", ...]` cannot do this, because `execFile`
      // discards that option and rebuilds its own spawn options — a `cat` run
      // through the documented form still hung for the full timeout.
      child.stdin?.end();
    });
}

/**
 * One line, because this ends up in a one-line report: the command's own
 * message when it printed one, otherwise the spawn failure's.
 */
function failureDetail(err: Error, stderr: string, timeoutMs: number): string {
  if ((err as { killed?: boolean }).killed) return `timed out after ${timeoutMs}ms`;
  const said = firstLine(stderr) ?? firstLine(err.message);
  const code = (err as { code?: unknown }).code;
  return said ?? (typeof code === "number" ? `exit ${code}` : "failed");
}

/** The first non-empty line of a command's output, trimmed, or nothing it printed. */
export function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

// ------------------------------------------------------------- the spawned run

/**
 * One subprocess that owns nothing of its own: no output, no inherited stdio,
 * and two bounds instead of one.
 *
 * Separate from `CommandRunner` because the caller here needs the opposite of
 * what a reader needs. A reader wants text back and a message to report; this
 * caller wants the *end* — the exit code, or the fact that nothing ended — and
 * must never see what the child printed, because what it prints is a
 * credential's own client talking about an account.
 */
export interface ProcessSpec {
  /** The executable, already resolved by the caller: no `PATH` lookup happens here. */
  readonly file: string;
  readonly args: readonly string[];
  /** A private directory, so the child neither reads nor writes where pi runs. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** How long the child may take before the first signal is sent. */
  readonly deadlineMs: number;
  /** How long each signal may take to work before the next, harsher one. */
  readonly killGraceMs: number;
}

/**
 * How one run ended.
 *
 * `timed-out` carries whether an exit was ever observed, because the two are
 * different reports: a run that exited *after* the deadline is evidence the
 * child stopped on its own, and one that never exited is evidence the signals
 * were sent into processes we cannot see. It carries no exit code, and no case
 * carries output: neither is something this caller is allowed to report.
 */
export type ProcessEnd =
  | { readonly kind: "exited"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "not-started"; readonly errno: string | undefined }
  | { readonly kind: "timed-out"; readonly exited: true }
  | { readonly kind: "timed-out"; readonly exited: false; readonly pid: number | undefined };

/**
 * Runs one subprocess and resolves the way it ended.
 *
 * The seam every caller above a spawn crosses, so an argv and each termination
 * path can be tested without running the real binary.
 */
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessEnd>;

/**
 * The real `ProcessRunner`: one child, waited for to a monotonic deadline.
 *
 * The deadline exists because the child cannot be trusted to stop — it is an
 * agent, not a token refresher, and its own network waits are its own business.
 * The clock is monotonic (`performance.now`) and injectable so that "an exit
 * observed at the deadline is late" is a testable rule rather than a race, and
 * so a wall clock that jumps cannot make a waiting run look finished.
 *
 * The escalation is deliberately three steps rather than one: `SIGTERM` asks,
 * `SIGKILL` after a grace period insists, and after a further grace period the
 * runner stops waiting and says no exit was observed. A signal is never treated
 * as proof the child stopped, because it is not — this covers the direct child
 * only, and a child that survives `SIGKILL` (or one that spawned descendants)
 * is the caller's residual risk, not something a timer can establish.
 */
export function createSpawnProcess(deps: { now?: () => number; spawn?: typeof spawn } = {}): ProcessRunner {
  const monotonic = deps.now ?? (() => performance.now());
  const launch = deps.spawn ?? spawn;

  return (spec) =>
    new Promise<ProcessEnd>((resolve) => {
      let settled = false;
      let timedOut = false;
      const timers: NodeJS.Timeout[] = [];
      const settle = (end: ProcessEnd): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        timers.length = 0;
        resolve(end);
      };

      // Taken before the spawn, so the elapsed time measured at `exit` includes
      // the child's own startup. The alternative — counting from the first sign
      // of life — would let a child that hangs in startup outlive the deadline
      // the report states.
      const startedAt = monotonic();
      let child: ChildProcess;
      try {
        child = launch(spec.file, [...spec.args], {
          cwd: spec.cwd,
          env: spec.env,
          // EOF on stdin, and neither pipe captured: a child that asks a
          // question is answered by nothing, and nothing it prints can reach a
          // report that must carry no vendor text.
          stdio: "ignore",
          shell: false,
          windowsHide: true,
          detached: false,
        });
      } catch (err) {
        settle({ kind: "not-started", errno: spawnErrno(err) });
        return;
      }

      /**
       * Sending a signal, with its failure swallowed.
       *
       * `kill` throws only for a pid Node never had, and a post-spawn failure to
       * signal proves nothing about whether the child is running: the timers are
       * the only thing that decides when this gives up, so a throw here must not
       * settle the run or cancel the escalations behind it.
       */
      const signal = (name: NodeJS.Signals): void => {
        try {
          child.kill(name);
        } catch {
          // Deliberately nothing: the next timer, or the exit event, decides.
        }
      };

      // `on` rather than `once`: an `'error'` event with no listener throws, and
      // a stream that fails twice must not become this process's failure. A
      // child that never produced a pid never ran; one that failed after it did
      // is a stream failure the exit event still has to report.
      child.on("error", (err: Error) => {
        if (child.pid === undefined) settle({ kind: "not-started", errno: spawnErrno(err) });
      });

      child.once("exit", (code, exitSignal) => {
        if (settled) return;
        // Both conditions, not either: the timer firing and the clock reaching
        // the deadline are the same rule seen twice, and an exit that lands in
        // the gap between them is late, not successful.
        if (!timedOut && monotonic() - startedAt < spec.deadlineMs) {
          settle({ kind: "exited", code, signal: exitSignal });
          return;
        }
        settle({ kind: "timed-out", exited: true });
      });

      timers.push(
        setTimeout(() => {
          if (settled) return;
          timedOut = true;
          signal("SIGTERM");
          // A signal is a request the child may answer synchronously — an
          // injected child can emit `exit` from inside `kill` — and a timer armed
          // after the run has settled would outlive the promise that is done.
          if (settled) return;
          timers.push(
            setTimeout(() => {
              if (settled) return;
              signal("SIGKILL");
              if (settled) return;
              timers.push(
                setTimeout(() => {
                  settle({ kind: "timed-out", exited: false, pid: child.pid });
                }, spec.killGraceMs),
              );
            }, spec.killGraceMs),
          );
        }, spec.deadlineMs),
      );
    });
}

/**
 * The errno a failed spawn is reported by: Node's string `code`, never its
 * numeric `errno`.
 *
 * The number means nothing outside the system that minted it, and the report is
 * one redacted line rather than an errno table; the string is the same token a
 * reader already knows from `ENOENT`.
 */
function spawnErrno(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The runner production uses. */
export const spawnProcess: ProcessRunner = createSpawnProcess();
