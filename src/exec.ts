/**
 * One subprocess, read back as text.
 *
 * Two callers sit on opposite sides of this extension: the keychain read that
 * finds a Claude credential, and the refresh ping that makes Claude Code renew
 * one. The runner is neither's property — it is the shape every `execFile` in
 * this extension has, and what differs between them is only a timeout and an
 * environment — so it lives here rather than in either, which would otherwise
 * make the credential module import the ping module for a process helper.
 */
import { execFile } from "node:child_process";

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
