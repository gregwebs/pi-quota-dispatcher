import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createSpawnProcess, spawnProcess, type ProcessSpec } from "../src/exec.ts";
import { tempDir } from "./helpers/temp-dir.ts";

// The contract this file pins is the one `/quota-dispatch refresh-codex` leans
// on: a child that owns nothing, a monotonic deadline that no exit observed at
// or after it can turn into success, and a runner that says "no exit was
// observed" rather than pretending a signal is proof.

function spec(cwd: string, over: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    file: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd,
    env: process.env,
    deadlineMs: 10_000,
    killGraceMs: 2_000,
    ...over,
  };
}

/**
 * Waits for a marker the child writes itself.
 *
 * Every test that makes the deadline do the work synchronises on one: without
 * it, a slow machine could still be starting the child when the timer fires, and
 * the test would pass or fail on scheduling rather than on the rule being
 * tested.
 */
async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      // Not yet.
    }
    if (Date.now() > until) throw new Error(`the child never wrote its ready marker`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("spawnProcess resolves a natural exit with its code", async (t) => {
  const cwd = await tempDir(t, "exec");
  const end = await spawnProcess(spec(cwd, { args: ["-e", "process.exit(7)"] }));
  assert.deepEqual(end, { kind: "exited", code: 7, signal: null });
});

test("spawnProcess reports a missing file as not started, by Node's string errno", async (t) => {
  const cwd = await tempDir(t, "exec");
  const end = await spawnProcess(spec(cwd, { file: join(cwd, "no-such-binary") }));
  // The string, not the numeric `errno`: a redacted line is the only place this
  // ends up, and `ENOENT` is the token a reader knows.
  assert.deepEqual(end, { kind: "not-started", errno: "ENOENT" });
});

test("spawnProcess gives the child no stdin and no captured output", async (t) => {
  const cwd = await tempDir(t, "exec");
  // Reads stdin to its end and exits 3 if anything was there, while printing to
  // both streams: with `stdio: "ignore"` the read sees EOF at once and nothing
  // printed can come back through the runner.
  const script = [
    "let seen = '';",
    "process.stdin.on('data', (chunk) => { seen += chunk; });",
    "process.stdin.on('end', () => process.exit(seen === '' ? 0 : 3));",
    "process.stdout.write('noise on stdout');",
    "process.stderr.write('noise on stderr');",
  ].join(" ");

  const end = await spawnProcess(spec(cwd, { args: ["-e", script] }));
  assert.deepEqual(end, { kind: "exited", code: 0, signal: null });
  // The runner's whole answer, so a later field carrying output would fail here.
  assert.deepEqual(Object.keys(end).sort(), ["code", "kind", "signal"]);
});

test("spawnProcess sends no signal before the deadline, and a natural exit does not wait for it", async (t) => {
  const cwd = await tempDir(t, "exec");
  const signalled = join(cwd, "signalled");
  const script = [
    `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(signalled)}, 'term'));`,
    "setTimeout(() => process.exit(0), 50);",
  ].join(" ");

  const startedAt = Date.now();
  // Long enough that a runner which waited out its timer instead of settling
  // would hang the test, and clear enough that a signal would be recorded.
  const end = await spawnProcess(spec(cwd, { args: ["-e", script], deadlineMs: 60_000, killGraceMs: 60_000 }));
  assert.deepEqual(end, { kind: "exited", code: 0, signal: null });
  assert.ok(Date.now() - startedAt < 10_000, "a natural exit must settle at once, not at the deadline");
  assert.equal(
    await stat(signalled).then(() => true, () => false),
    false,
    "no signal may be sent before the deadline",
  );
});

test("deadline hit: SIGTERM ends a waiting child and settles timed-out", async (t) => {
  const cwd = await tempDir(t, "exec");
  const ready = join(cwd, "ready");
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1');`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");

  // Room for the child to start before the deadline can matter, so a loaded
  // machine fails on the rule under test rather than on startup jitter.
  const pending = spawnProcess(spec(cwd, { args: ["-e", script], deadlineMs: 2_000, killGraceMs: 1_000 }));
  await waitFor(ready);
  const end = await pending;
  assert.deepEqual(end, { kind: "timed-out", exited: true });
});

test("late exit: an exit observed at the deadline is timed-out, never exited", async (t) => {
  const cwd = await tempDir(t, "exec");
  const deadlineMs = 100_000;
  let clock = 0;
  const run = createSpawnProcess({ now: () => clock });

  const pending = run(spec(cwd, { args: ["-e", "process.exit(0)"], deadlineMs, killGraceMs: 1_000 }));
  // `startedAt` was read synchronously, before the child existed; moving the
  // clock to exactly the deadline makes the exit an observed-late one without
  // waiting out a real timer.
  clock = deadlineMs;

  assert.deepEqual(await pending, { kind: "timed-out", exited: true });
});

test("child ignoring TERM: SIGTERM is delivered and ignored, then SIGKILL ends the direct child", async (t) => {
  const cwd = await tempDir(t, "exec");
  const ready = join(cwd, "ready");
  const termSeen = join(cwd, "term-seen");
  // The handler is installed *before* the ready marker is written, so a SIGTERM
  // sent after the marker cannot be missed by a child still starting up — and it
  // records that it ran, so "TERM first, then KILL" is observed rather than
  // assumed about the runner.
  const script = [
    `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(termSeen)}, '1'));`,
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1');`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");

  // Enough room for a loaded machine to start the child before the deadline.
  const pending = spawnProcess(spec(cwd, { args: ["-e", script], deadlineMs: 1_500, killGraceMs: 400 }));
  await waitFor(ready);
  const end = await pending;
  assert.deepEqual(end, { kind: "timed-out", exited: true });
  assert.equal(
    await stat(termSeen).then(() => true, () => false),
    true,
    "SIGTERM must be delivered before the grace period runs out",
  );
});

test("the escalation sends SIGTERM first, then SIGKILL one grace period later", async (t) => {
  const cwd = await tempDir(t, "exec");
  const emitter = new EventEmitter();
  const signals: Array<{ signal: NodeJS.Signals; at: number }> = [];
  const child = Object.assign(emitter, {
    pid: 77,
    kill: (signal: NodeJS.Signals) => {
      signals.push({ signal, at: Date.now() });
      return true;
    },
  }) as unknown as ChildProcess;
  const run = createSpawnProcess({ spawn: (() => child) as unknown as typeof spawn });

  // A child that never exits, so the timers are the only thing that can settle it.
  const deadlineMs = 30;
  const killGraceMs = 40;
  const end = await run(spec(cwd, { args: [], deadlineMs, killGraceMs }));

  assert.deepEqual(end, { kind: "timed-out", exited: false, pid: 77 });
  assert.deepEqual(signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  const gap = signals[1].at - signals[0].at;
  assert.ok(gap >= killGraceMs - 5, `SIGKILL must wait out the grace period, not follow at once: ${gap}ms`);
});

test("no exit observed: ignored signals and a post-spawn error settle timed-out with the pid", async (t) => {
  const cwd = await tempDir(t, "exec");
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    pid: 4242,
    kill: () => {
      throw new Error("kill refused");
    },
  }) as unknown as ChildProcess;
  const run = createSpawnProcess({ spawn: (() => child) as unknown as typeof spawn });

  const pending = run(spec(cwd, { args: [], deadlineMs: 30, killGraceMs: 20 }));
  // A failure after the pid exists is a stream failure, not a failed spawn: it
  // must not settle `not-started` and must not cancel the timers behind it.
  setImmediate(() => emitter.emit("error", new Error("stream failed")));
  setImmediate(() => emitter.emit("error", new Error("stream failed again")));

  assert.deepEqual(await pending, { kind: "timed-out", exited: false, pid: 4242 });
});
