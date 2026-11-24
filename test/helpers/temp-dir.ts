/**
 * Temp directories for tests, removed by the test run that made them.
 *
 * `mkdtemp` leaves its directory behind and nothing in the test lifecycle
 * collects it, so a suite where every test calls `mkdtemp` grows `/tmp`
 * without bound — one machine had 7,487 `pqd-*` directories after ordinary
 * runs (issue #101). Every temp directory this suite makes therefore comes from
 * one of the two makers here, and `test/temp-dir.test.ts` fails when a file
 * under `test/` so much as names `mkdtemp`.
 *
 * `tempDir` is the everyday maker: the test that owns the directory passes its
 * own context, and the removal hangs on that test's `after` hook so it runs even
 * when the test fails.
 *
 * `tempRoot` is for the directories no single test owns — a `HOME` or a stand-in
 * CLI built before any test exists, and a shared fixture helper's directories in
 * a file where threading a context through every test body would buy nothing.
 * Those go into a module registry, which the process flushes on its way out: a
 * directory that reaches that point is removed then, so a missed drain costs a
 * directory that lived too long rather than one that stayed. A directory that
 * refuses to go is named on stderr and fails the run, since a silent leftover is
 * the whole of the fault the issue reports. A file still drains explicitly with
 * `removeTempRoots` where the timing matters, or where a failed assertion must
 * not skip it, and orders that drain by hand where something must be read first
 * (the codex suites read their spawn trap before anything is removed).
 *
 * Both keep the `pqd-` tag: a directory that does leak is recognisable, and
 * `ls /tmp | grep pqd-` is the check the issue asks for.
 */
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

const roots: string[] = [];

/**
 * A temp directory that goes away when the test owning `t` finishes, whatever
 * the test's outcome.
 */
export async function tempDir(t: TestContext, name: string): Promise<string> {
  const dir = await makeTempDir(name);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp directory the process removes at the latest, or a file's own drain sooner. */
export async function tempRoot(name: string): Promise<string> {
  const dir = await makeTempDir(name);
  roots.push(dir);
  return dir;
}

/**
 * Removes every directory `tempRoot` made, so far.
 *
 * Not required for correctness: the process flushes the registry as it exits.
 * Call it from a file-level `after` hook when the directories should not live to
 * the end of the process, which is also the only place an ordering against
 * another hook can be stated.
 *
 * A directory that would not go away stays in the registry for that last
 * attempt, and the failure is not raised: a cleanup that lost a race with a
 * child process is not a failing test, and throwing here would replace the
 * failure a `finally` was guarding.
 */
export async function removeTempRoots(): Promise<void> {
  const made = takeRoots();
  await Promise.all(
    made.map(async (root) => {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        roots.push(root);
      }
    }),
  );
}

// The last resort for everything a test file did not drain: a module that threw
// while loading, a missing `after`, an assertion that failed before the drain.
// It cannot be async — nothing else runs after `exit` — and it attempts every
// root, because one that will not go must not stop the rest from going. A root
// that will not go at all is a fact about the machine, so it is reported and it
// fails the run rather than leaving a directory behind silently.
process.on("exit", () => {
  for (const root of takeRoots()) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      // Set, not `?? 1`: an explicit zero is a passing run too, and this failure
      // has to fail it. A code that already says the run failed is left alone.
      if (!process.exitCode) process.exitCode = 1;
      console.error(`a temp directory this run made could not be removed: ${root} (${errorText(err)})`);
    }
  }
});

function takeRoots(): string[] {
  return roots.splice(0);
}

/** The only thing a removal failure can say from an `exit` handler. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function makeTempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pqd-${name}-`));
}
