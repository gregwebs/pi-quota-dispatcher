import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createSharedReadings, READINGS_FILE_VERSION, type VendorReading, type SharedReadingsPacing } from "../src/index.ts";
import { lockPathFor, withLockPath } from "../src/agent-file.ts";
import { assertCleanExit, startHolder, waitUntil } from "./fixtures/agent-write-child.ts";
import { spawnReadingsChild } from "./fixtures/readings-child.ts";

const TTL = 100;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function good(rail: "claude" | "codex", readAt: number, tag = "first"): VendorReading {
  return { rail, ok: true, windows: [{ label: "5h", used: 17, budget: "session" }], readAt, raw: { tag, private: "account" } };
}
function failure(readAt: number): VendorReading {
  return { rail: "claude", ok: false, windows: [], readAt, note: "HTTP 429" };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pqd-shared-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "quota-dispatch-readings.json");
  const credential = join(root, "credentials.json");
  let clock = 1_730_123_456_789;
  const store = (pacing: Partial<SharedReadingsPacing> = {}, sleep = pause) => createSharedReadings({
    path, now: () => clock, sleep,
    pacing: { fetchWaitMs: 1_000, writeWaitMs: 100, pollMs: 2, staleMs: 10_000, ...pacing },
  });
  return { root, path, credential, store, now: () => clock, advance: (ms: number) => { clock += ms; } };
}

test("concurrent calls in one store join, and separate stores share a fresh reading", async (t) => {
  const fx = await fixture(t);
  const a = fx.store();
  const started = gate(); const finish = gate();
  let calls = 0;
  const fetch = async () => { calls++; started.release(); await finish.promise; return good("claude", fx.now()); };
  const first = a.read("claude", fx.credential, { ttlMs: TTL, fetch });
  await started.promise;
  const second = a.read("claude", fx.credential, { ttlMs: TTL, fetch });
  finish.release();
  assert.deepEqual(await second, await first);
  assert.equal(calls, 1);
  const fromFile = await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch });
  assert.deepEqual(fromFile, await first);
  assert.equal(calls, 1);
  assert.equal((await stat(fx.path)).mode & 0o777, 0o600);
  assert.match(await readFile(fx.path, "utf8"), /account/);
});

test("concurrent stale readers wait and reuse the completed fetch", async (t) => {
  const fx = await fixture(t);
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now()) });
  fx.advance(TTL);
  const started = gate(); const finish = gate(); const waiting = gate();
  let calls = 0;
  const fetch = async () => { calls++; started.release(); await finish.promise; return good("claude", fx.now(), "new"); };
  const a = fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch });
  await started.promise;
  const b = fx.store({}, async (ms) => { waiting.release(); await pause(ms); }).read("claude", fx.credential, { ttlMs: TTL, fetch });
  await waiting.promise;
  finish.release();
  assert.deepEqual(await b, await a);
  assert.equal(calls, 1);
});

test("each reader uses its own TTL, including the exact expiry boundary", async (t) => {
  const fx = await fixture(t); let calls = 0;
  const fetch = async () => { calls++; return good("claude", fx.now()); };
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch });
  fx.advance(TTL - 1);
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch });
  assert.equal(calls, 1);
  fx.advance(1);
  await fx.store().read("claude", fx.credential, { ttlMs: TTL * 2, fetch });
  assert.equal(calls, 1);
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch });
  assert.equal(calls, 2);
});

for (const rail of ["claude", "codex"] as const) {
  test(`${rail} credentials are isolated and resolved aliases share an entry`, async (t) => {
    const fx = await fixture(t); let calls = 0;
    const fetch = async () => good(rail, fx.now(), String(++calls));
    const first = await fx.store().read(rail, fx.credential, { ttlMs: TTL, fetch });
    const other = await fx.store().read(rail, join(fx.root, "other.json"), { ttlMs: TTL, fetch });
    assert.notDeepEqual(other, first);
    const alias = await fx.store().read(rail, resolve(fx.root, "sub", "..", "credentials.json"), { ttlMs: TTL, fetch });
    assert.deepEqual(alias, first);
    assert.equal(calls, 2);
    assert.deepEqual(await fx.store().known(rail, fx.credential), first);
  });
}

test("rail is part of the key even when credential paths coincide", async (t) => {
  const fx = await fixture(t);
  for (const rail of ["claude", "codex"] as const) {
    const result = await fx.store().read(rail, fx.credential, { ttlMs: TTL, fetch: async () => good(rail, fx.now()) });
    assert.equal(result.latest.rail, rail);
  }
  assert.equal((await fx.store().known("claude", fx.credential))?.latest.rail, "claude");
});

test("shared failures suppress retry and retain lastGood, even after expiry for known()", async (t) => {
  const fx = await fixture(t);
  const first = await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now()) });
  fx.advance(TTL);
  const failed = await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => failure(fx.now()) });
  assert.equal(failed.latest.ok, false);
  assert.deepEqual(failed.lastGood, first.latest);
  const fresh = await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => { assert.fail("shared failure must not retry"); } });
  assert.deepEqual(fresh, failed);
  fx.advance(TTL * 10);
  assert.deepEqual(await fx.store().known("claude", fx.credential), failed);
});

test("force fetches a previously completed reading but joins a fetch in flight", async (t) => {
  const fx = await fixture(t); let calls = 0;
  const fetch = async () => { calls++; return good("claude", fx.now(), String(calls)); };
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch });
  fx.advance(1);
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, force: true, fetch });
  assert.equal(calls, 2);
  const started = gate(); const finish = gate(); const waiting = gate();
  const a = fx.store().read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
    calls++; started.release(); await finish.promise; fx.advance(1); return good("claude", fx.now(), "in-flight");
  } });
  await started.promise;
  const b = fx.store({}, async (ms) => { waiting.release(); await pause(ms); }).read("claude", fx.credential, { ttlMs: TTL, force: true, fetch });
  await waiting.promise; finish.release();
  assert.deepEqual(await b, await a);
  assert.equal(calls, 3);
});

test("bound-exceeded waiter self-fetches; a later failure cannot erase its newer lastGood", async (t) => {
  const fx = await fixture(t);
  await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now(), "old") });
  fx.advance(TTL);
  const started = gate(); const finish = gate();
  const a = fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => {
    started.release(); await finish.promise; fx.advance(1); return failure(fx.now());
  } });
  await started.promise;
  let bCalls = 0;
  const b = await fx.store({ fetchWaitMs: 20 }).read("claude", fx.credential, { ttlMs: TTL, fetch: async () => {
    bCalls++; fx.advance(1); return good("claude", fx.now(), "newer-success");
  } });
  assert.equal(bCalls, 1, "waiter must not stall behind the unfinished holder");
  finish.release(); await a;
  const next = await fx.store().read("claude", fx.credential, { ttlMs: TTL, fetch: async () => { assert.fail("latest failure is fresh"); } });
  assert.equal(next.latest.ok, false);
  assert.deepEqual(next.lastGood, b.latest, "concurrent failure must preserve B's newer success in the shared file");
});

for (const [name, text] of [
  ["corrupt JSON", "{broken"],
  ["unknown version", JSON.stringify({ version: READINGS_FILE_VERSION + 1, entries: [] })],
  ["invalid entry", JSON.stringify({ version: READINGS_FILE_VERSION, entries: [{ rail: "claude", credential: "/c", at: 1, latest: { rail: "claude", ok: true, windows: [], readAt: 1 } }] })],
] as const) {
  test(`${name} is empty, warns once, and is repaired by the next write`, async (t) => {
    const fx = await fixture(t); await writeFile(fx.path, text);
    const store = fx.store();
    assert.equal(await store.known("claude", fx.credential), undefined);
    assert.equal(await store.known("claude", fx.credential), undefined);
    assert.equal(store.warnings().length, 1);
    assert.match(store.warnings()[0]!, /quota-dispatch-readings\.json.*unusable.*ignoring/i);
    const result = await store.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now()) });
    assert.equal(JSON.parse(await readFile(fx.path, "utf8")).version, READINGS_FILE_VERSION);
    assert.deepEqual(await fx.store().known("claude", fx.credential), result);
  });
}

test("a blocked write is skipped and the reading remains usable in memory", async (t) => {
  const fx = await fixture(t); await writeFile(fx.path, JSON.stringify({ version: READINGS_FILE_VERSION, entries: [] }));
  const holder = await startHolder(fx.path);
  try {
    assert.ok(existsSync(lockPathFor(fx.path)));
    const store = fx.store({ writeWaitMs: 20 }); let calls = 0;
    const fetch = async () => { calls++; return good("claude", fx.now()); };
    const result = await store.read("claude", fx.credential, { ttlMs: TTL, fetch });
    assert.deepEqual(await store.read("claude", fx.credential, { ttlMs: TTL, fetch }), result);
    assert.equal(calls, 1);
    assert.equal(await fx.store().known("claude", fx.credential), undefined);
  } finally {
    assertCleanExit(await holder.release());
  }
});

test("two real processes share one request, including an overlapping reader", async (t) => {
  const fx = await fixture(t);
  const marker = join(fx.root, "fetching"); const release = join(fx.root, "release");
  const a = spawnReadingsChild({ readingsPath: fx.path, credential: fx.credential, marker, release, delayMs: 20 }); t.after(a.kill);
  await waitUntil("first child's fetch", () => existsSync(marker));
  const waitingMarker = join(fx.root, "second-waiting");
  const b = spawnReadingsChild({ readingsPath: fx.path, credential: fx.credential, waitingMarker }); t.after(b.kill);
  await waitUntil("second child waiting on the fetch lock", () => existsSync(waitingMarker));
  await writeFile(release, "go");
  const [ar, br] = await Promise.all([a.done, b.done]);
  assertCleanExit(ar); assertCleanExit(br);
  const one = JSON.parse(ar.stdout); const two = JSON.parse(br.stdout);
  assert.equal(Number(one.fetched) + Number(two.fetched), 1);
  assert.deepEqual(two.result, one.result);
  const c = spawnReadingsChild({ readingsPath: fx.path, credential: fx.credential }); t.after(c.kill);
  const cr = await c.done; assertCleanExit(cr);
  assert.equal(JSON.parse(cr.stdout).fetched, false);
});

test("a real child dying inside its fetch lock is taken over without waiting out the bound", async (t) => {
  const fx = await fixture(t);
  const marker = join(fx.root, "dead-holder");
  const child = spawnReadingsChild({ readingsPath: fx.path, credential: fx.credential, kind: "hold-then-die", marker }); t.after(child.kill);
  const exit = await child.done;
  assert.equal(exit.signal, "SIGKILL"); assert.ok(existsSync(marker));
  let sleeps = 0;
  const store = fx.store({ fetchWaitMs: 1_000 }, async (ms) => { sleeps++; await pause(ms); });
  const result = await store.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now()) });
  assert.equal(result.latest.ok, true);
  assert.equal(sleeps, 0, "a confirmed dead holder must be recovered immediately");
});

// The write and its locks are an optimisation over the overlay, so a file the
// process cannot even reach must still answer. A missing parent makes the lock
// create itself fail rather than be contended, which used to reject the whole
// read before any fetch was made.
test("a reading the store cannot publish still fetches and never throws", async (t) => {
  const fx = await fixture(t);
  const unwritable = join(fx.root, "missing", "quota-dispatch-readings.json");
  const store = createSharedReadings({
    path: unwritable, now: fx.now,
    pacing: { fetchWaitMs: 1_000, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 },
  });
  let calls = 0;
  const result = await store.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => {
    calls++; return good("claude", fx.now(), "missing-parent");
  } });
  assert.equal(result.latest.ok, true);
  assert.equal(calls, 1, "the fetch must run even though neither lock can be created");
  assert.equal(existsSync(unwritable), false, "nothing can have been published");
});

test("force does not join a fresh-cache read but joins a fetch in flight", async (t) => {
  const fx = await fixture(t);
  const store = fx.store();
  let calls = 0;
  const fetch = async () => { calls++; return good("claude", fx.now(), String(calls)); };
  const warm = await store.read("claude", fx.credential, { ttlMs: TTL, fetch });
  const [, forced] = await Promise.all([
    store.read("claude", fx.credential, { ttlMs: TTL, fetch }),
    store.read("claude", fx.credential, { ttlMs: TTL, force: true, fetch }),
  ]);
  assert.equal(calls, 2, "a forced read must not be answered by a fresh-cache read");
  assert.notDeepEqual(forced, warm);

  const started = gate(); const finish = gate();
  let joinedCalls = 0;
  const a = store.read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
    joinedCalls++; started.release(); await finish.promise; return good("claude", fx.now(), "joined");
  } });
  await started.promise;
  const b = store.read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
    joinedCalls++; return good("claude", fx.now(), "duplicate");
  } });
  finish.release();
  assert.deepEqual(await b, await a);
  assert.equal(joinedCalls, 1, "two forced reads over one store must share the one fetch");
});

// A forced read joins a peer's refresh only when the peer published a different
// entry. The decision used to compare wall-clock stamps, so two refreshes in one
// clock millisecond both fetched. The stores share a frozen `now`, and the
// second waits on the first's lock rather than timing out, so it observes the
// first's publication while its own baseline still names the older entry.
test("two forced stores over one file make one fetch when the clock is frozen", async (t) => {
  const fx = await fixture(t);
  const path = join(fx.root, "frozen-clock.json");
  const pacing = { fetchWaitMs: 1_000, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 };
  await createSharedReadings({ path, now: fx.now, pacing })
    .read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now(), "old") });
  const started = gate(); const finish = gate(); const waiting = gate();
  let calls = 0;
  const a = createSharedReadings({ path, now: fx.now, pacing })
    .read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
      calls++; started.release(); await finish.promise; return good("claude", fx.now(), "new");
    } });
  await started.promise;
  const b = createSharedReadings({ path, now: fx.now, pacing, sleep: async (ms) => { waiting.release(); await pause(ms); } })
    .read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
      calls++; return good("claude", fx.now(), "duplicate");
    } });
  await waiting.promise;
  finish.release();
  await Promise.all([a, b]);
  assert.equal(calls, 1, "a forced read must join a peer's refresh even when both stamps share a millisecond");
});

// A forced read must not be answered by a merge that only enriched `lastGood`.
// The slow success and the bounded waiter's failure share one `at`, so the
// merge republishes the same `latest`; joining it would return a reading older
// than the refresh the caller asked for.
test("a forced read is not satisfied by a merge that only added lastGood", async (t) => {
  const fx = await fixture(t);
  const path = join(fx.root, "lastgood-only.json");
  const pacing = { fetchWaitMs: 100, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 };
  const held = gate(); const free = gate(); const delayed = gate(); const resume = gate(); const waiting = gate();
  const hold = withLockPath(lockPathFor(path), { waitMs: 100, pollMs: 2, staleMs: 10_000 }, fx.now, async () => {},
    async () => { held.release(); await free.promise; });
  await held.promise;
  const slow = createSharedReadings({ path, now: fx.now, pacing, sleep: async () => { delayed.release(); await resume.promise; } });
  const slowRead = slow.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now(), "completed-before-refresh") });
  await delayed.promise;
  free.release();
  await hold;
  fx.advance(1);
  await createSharedReadings({ path, now: fx.now, pacing: { ...pacing, fetchWaitMs: 2 } })
    .read("claude", fx.credential, { ttlMs: TTL, fetch: async () => failure(fx.now()) });
  let forcedCalls = 0;
  const forced = createSharedReadings({ path, now: fx.now, pacing, sleep: async (ms) => { waiting.release(); await pause(ms); } })
    .read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
      forcedCalls++; return good("claude", fx.now(), "forced-fresh");
    } });
  await waiting.promise;
  resume.release();
  await slowRead;
  const result = await forced;
  assert.equal(forcedCalls, 1, "a merge that only enriched lastGood published no vendor answer");
  assert.ok(result.latest.ok, "the forced read must answer with its own fetch");
});

// A forced read may join an ordinary read that is itself waiting on a peer
// process's fetch. The peer's publication is the vendor answer the forced read
// would have made; joining it must not also ask the vendor.
test("a forced read joins an ordinary read waiting on a peer's fetch", async (t) => {
  const fx = await fixture(t);
  const path = join(fx.root, "peer-join.json");
  const pacing = { fetchWaitMs: 1_000, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 };
  await createSharedReadings({ path, now: fx.now, pacing })
    .read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now(), "old") });
  fx.advance(TTL);
  const started = gate(); const finish = gate(); const waiting = gate();
  let calls = 0;
  const peer = createSharedReadings({ path, now: fx.now, pacing })
    .read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
      calls++; started.release(); await finish.promise; return good("claude", fx.now(), "peer");
    } });
  await started.promise;
  const store = createSharedReadings({ path, now: fx.now, pacing, sleep: async (ms) => { waiting.release(); await pause(ms); } });
  const ordinary = store.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => {
    calls++; return good("claude", fx.now(), "unexpected ordinary");
  } });
  await waiting.promise;
  const forced = store.read("claude", fx.credential, { ttlMs: TTL, force: true, fetch: async () => {
    calls++; return good("claude", fx.now(), "extra forced");
  } });
  finish.release();
  const [peerResult, ordinaryResult, forcedResult] = await Promise.all([peer, ordinary, forced]);
  assert.equal(calls, 1, "the peer's fetch must be the only vendor call");
  assert.deepEqual(ordinaryResult, peerResult);
  assert.deepEqual(forcedResult, peerResult);
});

// Both forced callers join one ordinary cache-hit read. Only the first may
// install a record; the second must re-check the map and join that fetch, or
// the pair makes two requests for one refresh.
test("two forced callers that joined a cache-hit read make one fetch", async (t) => {
  const fx = await fixture(t);
  // A store that cannot take its fetch lock: each forced caller that installs a
  // record self-fetches, so a second record is a second vendor call.
  const store = createSharedReadings({
    path: join(fx.root, "no-lock", "quota-dispatch-readings.json"), now: fx.now,
    pacing: { fetchWaitMs: 1_000, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 },
  });
  let calls = 0;
  const fetch = async () => { calls++; return good("claude", fx.now(), String(calls)); };
  const warm = await store.read("claude", fx.credential, { ttlMs: TTL, fetch });
  const before = calls;
  const [cached, a, b] = await Promise.all([
    store.read("claude", fx.credential, { ttlMs: TTL, fetch }),
    store.read("claude", fx.credential, { ttlMs: TTL, force: true, fetch }),
    store.read("claude", fx.credential, { ttlMs: TTL, force: true, fetch }),
  ]);
  assert.deepEqual(cached, warm, "the ordinary read is the cache hit the forced pair joins");
  assert.equal(calls - before, 1, "two forced reads over one joined cache hit must share their one fetch");
  assert.deepEqual(a, b, "both forced callers must answer with the same fetch");
  assert.notDeepEqual(a, warm);
});

// A slow success can reach the file after a bounded waiter's failure already
// did. The newer `at` lets the failure supply `latest`, but the success must
// still be carried forward as the shared `lastGood`, or generation refuses over
// a rail that did read successfully.
test("a success published after a bounded waiter's failure is still the shared last good reading", async (t) => {
  const fx = await fixture(t);
  const path = join(fx.root, "interleaved.json");
  const pacing = { fetchWaitMs: 100, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 };
  const held = gate(); const free = gate(); const delayed = gate(); const resume = gate();
  const hold = withLockPath(lockPathFor(path), { waitMs: 100, pollMs: 2, staleMs: 10_000 }, fx.now, async () => {},
    async () => { held.release(); await free.promise; });
  await held.promise;
  const slow = createSharedReadings({ path, now: fx.now, pacing, sleep: async () => { delayed.release(); await resume.promise; } });
  const slowRead = slow.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => good("claude", fx.now(), "good") });
  await delayed.promise;
  free.release();
  await hold;
  fx.advance(1);
  const waiter = createSharedReadings({ path, now: fx.now, pacing: { ...pacing, fetchWaitMs: 2 } });
  const failed = await waiter.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => failure(fx.now()) });
  assert.equal(failed.latest.ok, false);
  assert.ok(!("lastGood" in failed), "the waiter published before the success was known");
  resume.release();
  await slowRead;
  const known = await waiter.known("claude", fx.credential);
  assert.equal(known?.latest.ok, false);
  assert.deepEqual(known?.lastGood?.raw, { tag: "good", private: "account" },
    "the later success must survive as the shared last good reading");
});

// A malformed pacing value must not reach the attempt count. The fetch lock is
// held by another store and the injecting store's `sleep` is instant, so an
// `attempts` of `NaN` would spin forever here and a finite one gives up at once
// and self-fetches.
for (const fetchWaitMs of [Number.NaN, undefined as unknown as number]) {
  test(`an unusable fetchWaitMs (${String(fetchWaitMs)}) still self-fetches instead of hanging`, async (t) => {
    const fx = await fixture(t);
    const holder = fx.store();
    const started = gate(); const finish = gate();
    const held = holder.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => {
      started.release(); await finish.promise; return good("claude", fx.now(), "holder");
    } });
    await started.promise;
    const store = fx.store({ fetchWaitMs }, async () => {});
    let calls = 0;
    const result = await store.read("claude", fx.credential, { ttlMs: TTL, fetch: async () => {
      calls++; return good("claude", fx.now(), "self");
    } });
    assert.equal(result.latest.ok, true);
    assert.equal(calls, 1, "the wait must end and the read fetch for itself");
    finish.release();
    await held;
  });
}
