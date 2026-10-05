import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createSharedReadings, type StickyHalt } from "../src/readings-file.ts";
import { lockPathFor, withLockPath } from "../src/agent-file.ts";

const NOW = 1_730_123_456_789;
const cooldown = { at: NOW, note: "offline failure" };
const sticky: StickyHalt = { note: "undiverted", claudePath: "/test/bin/claude", claudeMtimeMs: 123 };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pqd-gates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "readings.json");
  const credential = join(root, "claude.json");
  let clock = NOW;
  const make = (file = path, sleep?: (ms: number) => Promise<void>) => createSharedReadings({
    path: file, now: () => clock,
    sleep: sleep ?? (async (ms) => { clock += ms; }),
    pacing: { fetchWaitMs: 100, writeWaitMs: 100, pollMs: 1, staleMs: 10_000 },
  });
  return { root, path, credential, other: join(root, "other.json"), make };
}

// Defect: a global credential gate or an encoder/decoder dropping one field.
test("credential gates round-trip without leaking to another credential", async (t) => {
  const fx = await fixture(t); const store = fx.make();
  await store.setGates(fx.credential, { cooldown, halt: "episode stopped" });
  assert.deepEqual(await store.gates(fx.credential), { cooldown, halt: "episode stopped" });
  assert.deepEqual(await store.gates(fx.other), {});
});

// Defect: gates kept only in memory, or writing one key erases a peer's key.
test("two stores see each other's credential gates", async (t) => {
  const fx = await fixture(t); const a = fx.make(); const b = fx.make();
  await a.setGates(fx.credential, { cooldown });
  assert.deepEqual(await b.gates(fx.credential), { cooldown });
  await b.setGates(fx.other, { halt: "other episode" });
  assert.deepEqual(await a.gates(fx.other), { halt: "other episode" });
  assert.deepEqual(await fx.make().gates(fx.credential), { cooldown });
});

// Defect: clearHalt replaces the whole object, or loses precedence over halt.
test("clearHalt removes only halt and takes precedence over halt in a patch", async (t) => {
  const fx = await fixture(t); const store = fx.make();
  await store.setGates(fx.credential, { cooldown, halt: "stopped" });
  await store.setGates(fx.credential, { clearHalt: true, halt: "must not survive" });
  assert.deepEqual(await store.gates(fx.credential), { cooldown });
  assert.deepEqual(await fx.make().gates(fx.credential), { cooldown });
});

// Defect: partial patch overwrites the existing halt rather than merging under lock.
test("a cooldown patch preserves an existing halt from a peer", async (t) => {
  const fx = await fixture(t);
  await fx.make().setGates(fx.credential, { halt: "stopped" });
  const store = fx.make(); await store.setGates(fx.credential, { cooldown });
  assert.deepEqual(await store.gates(fx.credential), { cooldown, halt: "stopped" });
  assert.deepEqual(await fx.make().gates(fx.credential), { cooldown, halt: "stopped" });
});

// Defect: sticky keyed to a credential, or clearing it destroys credential gates.
test("sticky halt is machine-wide, shared, and can be unconditionally cleared", async (t) => {
  const fx = await fixture(t); const a = fx.make(); const b = fx.make();
  await a.setGates(fx.credential, { cooldown });
  await a.setStickyHalt(sticky);
  assert.deepEqual(await b.gates(fx.other), { sticky });
  await b.setStickyHalt(undefined);
  assert.deepEqual(await b.gates(fx.other), {});
  assert.deepEqual(await fx.make().gates(fx.credential), { cooldown });
});

// Defect: reference equality instead of deep equality, or stale clear erases a new halt.
test("conditional sticky clear compares the current halt deeply and preserves a peer replacement", async (t) => {
  const fx = await fixture(t); const writer = fx.make(); const clearer = fx.make();
  await writer.setStickyHalt(sticky);
  const expected = (await clearer.gates(fx.credential)).sticky!;
  const replacement: StickyHalt = { ...sticky, note: "new peer anomaly" };
  await writer.setStickyHalt(replacement);
  await clearer.setStickyHalt(undefined, expected);
  assert.deepEqual(await clearer.gates(fx.credential), { sticky: replacement });
  assert.deepEqual(await fx.make().gates(fx.credential), { sticky: replacement });
  await clearer.setStickyHalt(undefined, { ...replacement });
  assert.deepEqual(await clearer.gates(fx.credential), {});
  assert.deepEqual(await fx.make().gates(fx.credential), {});
});

for (const [name, broken] of [
  ["corrupt gates array", { gates: [{ credential: "bad", cooldown: { at: "not a number", note: "bad" } }], stickyHalt: sticky }],
  ["invalid sticky halt", { gates: [{ credential: "valid", halt: "must be discarded" }], stickyHalt: { note: "bad", claudePath: null, claudeMtimeMs: 123 } }],
] as const) {
  // Defect: partially accepting a corrupt document, warning per read, or never repairing.
  test(`${name} faults the whole document, warns once, and a successful write repairs it`, async (t) => {
    const fx = await fixture(t); const store = fx.make();
    // Seed a valid reading through the public API; preserve it in the corrupt
    // document to prove all-or-nothing applies to readings as well as gates.
    await store.read("claude", fx.credential, { ttlMs: 100, fetch: async () => ({
      ok: false, rail: "claude", windows: [], readAt: NOW, note: "seeded failure",
    }) });
    const seeded = JSON.parse(await readFile(fx.path, "utf8"));
    await writeFile(fx.path, JSON.stringify({ ...seeded, version: 2, ...broken }));
    const reader = fx.make();
    assert.deepEqual(await reader.gates("valid"), {});
    assert.deepEqual(await reader.gates(fx.credential), {});
    assert.equal(await reader.known("claude", fx.credential), undefined);
    assert.equal(reader.warnings().length, 1);
    assert.equal(reader.warnings()[0]!.split("\n").length, 1);
    await reader.setGates(fx.credential, { cooldown });
    const repaired = fx.make();
    assert.deepEqual(await repaired.gates(fx.credential), { cooldown });
    assert.deepEqual(repaired.warnings(), []);
    assert.equal(JSON.parse(await readFile(fx.path, "utf8")).version, 2);
  });
}

for (const failure of ["missing parent", "non-directory parent"] as const) {
  // Defect: propagating filesystem errors or dropping this process's protection.
  test(`gate writes with a ${failure} are best effort and retain local fallback`, async (t) => {
    const fx = await fixture(t); const parent = join(fx.root, "unavailable");
    if (failure === "non-directory parent") await writeFile(parent, "not a directory");
    const store = fx.make(join(parent, "readings.json"));
    await assert.doesNotReject(store.setGates(fx.credential, { cooldown, halt: "stopped" }));
    await assert.doesNotReject(store.setStickyHalt(sticky));
    assert.deepEqual(await store.gates(fx.credential), { cooldown, halt: "stopped", sticky });
    await store.setGates(fx.credential, { clearHalt: true });
    await store.setStickyHalt(undefined);
    assert.deepEqual(await store.gates(fx.credential), { cooldown });
  });
}

// Defect: a successful publication leaves a permanent local overlay masking peers.
test("originating store observes a peer's halt clear", async (t) => {
  const fx = await fixture(t); const a = fx.make(); const b = fx.make();
  await a.setGates(fx.credential, { halt: "stopped" });
  await b.setGates(fx.credential, { clearHalt: true });
  assert.deepEqual(await a.gates(fx.credential), {});
});

for (const action of ["clears", "replaces"] as const) {
  test(`originating store observes a peer that ${action} its sticky halt`, async (t) => {
    const fx = await fixture(t); const a = fx.make(); const b = fx.make();
    await a.setStickyHalt(sticky);
    const replacement = { ...sticky, note: "peer replacement" };
    await b.setStickyHalt(action === "clears" ? undefined : replacement);
    assert.deepEqual(await a.gates(fx.credential), action === "clears" ? {} : { sticky: replacement });
  });
}

// Hold the actual shared-file write lock while the injected clock exhausts
// acquisition attempts. No filesystem permission tricks or wall-clock waits.
for (const action of ["arm", "clear"] as const) {
  test(`failed halt ${action} survives a later successful cooldown write`, async (t) => {
    const fx = await fixture(t); const store = fx.make();
    if (action === "clear") await fx.make().setGates(fx.credential, { halt: "stopped" });
    const held = await withLockPath(lockPathFor(fx.path), {}, () => NOW, async () => {
      assert.fail("external lock should be uncontended");
    }, async () => {
      await store.setGates(fx.credential, action === "arm" ? { halt: "stopped" } : { clearHalt: true });
      assert.deepEqual(await store.gates(fx.credential), action === "arm" ? { halt: "stopped" } : {});
      assert.deepEqual(await fx.make().gates(fx.credential), action === "arm" ? {} : { halt: "stopped" },
        "failed write must not change the shared document");
    });
    assert.equal(held.ok, true);
    await store.setGates(fx.credential, { cooldown });
    const expected = action === "arm" ? { cooldown, halt: "stopped" } : { cooldown };
    assert.deepEqual(await store.gates(fx.credential), expected);
    assert.deepEqual(await fx.make().gates(fx.credential), expected);
  });
}

test("conditional sticky clear waiting for a lock preserves a peer replacement without writing", async (t) => {
  const fx = await fixture(t); const peer = fx.make();
  await peer.setStickyHalt(sticky);
  const lock = lockPathFor(fx.path);
  const replacement = { ...sticky, note: "published while clearer waits" };
  let interleaved = false; let published = ""; let publishedInode = 0;
  const clearer = fx.make(fx.path, async () => {
    assert.equal(interleaved, false, "interleave exactly once");
    interleaved = true;
    await rm(lock);
    await peer.setStickyHalt(replacement);
    published = await readFile(fx.path, "utf8");
    publishedInode = (await stat(fx.path)).ino;
  });
  const held = await withLockPath(lock, {}, () => NOW, async () => {
    assert.fail("external lock should be uncontended");
  }, async () => {
    await clearer.setStickyHalt(undefined, { ...sticky });
  });
  assert.equal(held.ok, true);
  assert.equal(interleaved, true, "clear must encounter the external lock");
  assert.equal(await readFile(fx.path, "utf8"), published, "stale clear must write nothing");
  assert.deepEqual(await clearer.gates(fx.credential), { sticky: replacement });
  assert.deepEqual(await fx.make().gates(fx.credential), { sticky: replacement });
  assert.equal((await stat(fx.path)).ino, publishedInode, "stale clear must not replace the file");
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("overlapping same-store gate writes do not replay a retired halt after a peer clear", async (t) => {
  const fx = await fixture(t); const peer = fx.make();
  const firstWaiting = gate(); const secondWaiting = gate();
  const resumeFirst = gate(); const resumeSecond = gate();
  let waits = 0;
  const store = fx.make(fx.path, async () => {
    waits++;
    assert.ok(waits <= 2, "each writer waits exactly once");
    if (waits === 1) { firstWaiting.release(); await resumeFirst.promise; }
    else { secondWaiting.release(); await resumeSecond.promise; }
  });
  const lock = lockPathFor(fx.path);
  const held = await withLockPath(lock, {}, () => NOW, async () => {
    assert.fail("external lock should be uncontended");
  }, async () => {
    const first = store.setGates(fx.credential, { halt: "stopped" });
    await firstWaiting.promise;
    const second = store.setGates(fx.credential, { cooldown });
    await secondWaiting.promise;
    await rm(lock);
    resumeFirst.release();
    await first; // publication and retirement must finish before the peer clear
    assert.equal((await peer.gates(fx.credential)).halt, "stopped");
    await peer.setGates(fx.credential, { clearHalt: true });
    assert.equal((await peer.gates(fx.credential)).halt, undefined);
    resumeSecond.release();
    await second;
  });
  assert.equal(held.ok, true);
  assert.equal(waits, 2);
  assert.deepEqual(await store.gates(fx.credential), { cooldown });
  assert.deepEqual(await peer.gates(fx.credential), { cooldown });
  assert.deepEqual(await fx.make().gates(fx.credential), { cooldown });
});

for (const release of ["delayed", "failed"] as const) {
  test(`published halt is retired before a ${release} lock release and cannot replay after a peer clear`, async (t) => {
    const fx = await fixture(t); const store = fx.make(); const peer = fx.make();
    const lock = lockPathFor(fx.path);
    const releaseStarted = gate(); const finishRelease = gate();
    const originalUnlink = fs.promises.unlink;
    let intercepted = false;
    let first: Promise<void> | undefined;
    // node:test isolates test files in separate processes and these tests run
    // serially. Intercept only this fixture's first lock release; all unrelated
    // unlinks and subsequent releases retain their normal behaviour.
    fs.promises.unlink = async (path) => {
      if (String(path) !== lock || intercepted) return originalUnlink(path);
      intercepted = true;
      if (release === "failed") {
        releaseStarted.release();
        throw Object.assign(new Error("injected lock release failure"), { code: "EACCES" });
      }
      await originalUnlink(path);
      releaseStarted.release();
      // The lock is available, but the first setGates has not returned from
      // releaseLock. A peer and overlapping write run in this exact window.
      await finishRelease.promise;
    };
    syncBuiltinESMExports();
    try {
      first = store.setGates(fx.credential, { halt: "stopped" });
      await releaseStarted.promise;
      if (release === "failed") {
        await assert.doesNotReject(first, "gate writes remain best effort on release failure");
        await originalUnlink(lock); // deterministic operator recovery
      }
      assert.deepEqual(await peer.gates(fx.credential), { halt: "stopped" });
      await peer.setGates(fx.credential, { clearHalt: true });
      assert.deepEqual(await peer.gates(fx.credential), {});
      assert.deepEqual(await store.gates(fx.credential), {}, "published halt must already be retired");
      await store.setGates(fx.credential, { cooldown });
      finishRelease.release();
      await first;
      assert.equal(intercepted, true);
      assert.deepEqual(await store.gates(fx.credential), { cooldown });
      assert.deepEqual(await peer.gates(fx.credential), { cooldown });
      assert.deepEqual(await fx.make().gates(fx.credential), { cooldown });
    } finally {
      finishRelease.release();
      try { await first; } finally {
        fs.promises.unlink = originalUnlink;
        syncBuiltinESMExports();
      }
    }
  });
}
