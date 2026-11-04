import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEFAULT_CONFIG,
  READINGS_FILE_VERSION,
  createDispatcher,
  type PassReadings,
  railGauge,
} from "../src/index.ts";
import type { AntigravityRail } from "../src/rail.ts";
import {
  type AntigravityReadings,
  type GoodReading,
  type MeteredReading,
  type RailReading,
  type RailReadings,
  type VendorReading,
} from "../src/rail-reading.ts";

import { agentTable, routeOf } from "./helpers/identifiers.ts";
import { failureOf, fakeReads, poolFailure, readingOf, type Used } from "./helpers/rails.ts";

const NOW = 1_730_123_456_789;
const TTL = 10_000;
const PRIMARY = "claude-bridge/claude-opus-5-5";
const ALTERNATE = "openai-codex/gpt-6-sol";
type LiveRail = "claude" | "codex";

// Compile-negative guards. `@ts-expect-error` is the only way these type
// exclusions are pinned: if either assignment ever compiles, `npm run typecheck`
// fails on the now-unnecessary suppression, so the guard cannot rot silently.
const meteredReading: MeteredReading = { rail: "deepseek", ok: true, windows: [], metered: true, note: "metered" };
const deepseekGood: GoodReading = { rail: "deepseek", ok: true, windows: [], readAt: 0, raw: {} };
// Type-level guard: a metered reading carries no last good reading, so the union's
// metered arm must reject one even though its other arms accept `lastGood`.
// @ts-expect-error
const meteredWithLastGood: RailReadings = { latest: meteredReading, lastGood: deepseekGood };
// Type-level guard: `deepseek` is the only metered rail, so its reading cannot
// name another one.
// @ts-expect-error
const meteredClaude: MeteredReading = { rail: "claude", ok: true, windows: [], metered: true };

async function fixture(t: TestContext, opts: { antigravity?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pqd-readings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agents");
  await mkdir(agentDir);
  const agentFile = join(agentDir, "planner.md");
  await writeFile(agentFile, `---\nname: planner\nmodel: "${PRIMARY}"\n---\n\nBody.\n`);
  const claudeCredsPath = join(root, "claude-credentials.json");
  await writeFile(claudeCredsPath, JSON.stringify({
    claudeAiOauth: { accessToken: "test-token", expiresAt: NOW + 86_400_000 },
  }));
  const piAuthPath = join(root, "pi-auth.json");
  await writeFile(piAuthPath, JSON.stringify({
    "openai-codex": { access: "test-token", accountId: "acct-test" },
    ...(opts.antigravity === true
      ? { antigravity: { access: "test-token", expires: NOW + 86_400_000, projectId: "test-project" } }
      : {}),
  }));

  const probe = {
    clock: NOW,
    /** What each rail's next read reports, by budget. */
    used: { claude: { session: 93, weekly: 21 }, codex: { session: 3, weekly: 4 } } as Record<LiveRail, Used>,
    /** The reading the last read produced, so a raw body's identity can be pinned. */
    rails: {} as Record<LiveRail, VendorReading>,
    failed: { claude: false, codex: false },
    calls: { claude: 0, codex: 0 },
    /** Antigravity reads, counted apart so the two-vendor assertions stay exact. */
    antigravityCalls: 0,
    /** The three pools' one answer, stamped when it is read. */
    poolUsed: {} as Partial<Record<AntigravityRail, Used>>,
    /** Overrides a rail's answer for one test; the counters above still run. */
    answer: {} as Partial<Record<LiveRail | "antigravity", (call: number) => VendorReading | AntigravityReadings>>,
    // A hook the concurrency test installs; the stub awaits it before answering,
    // so a test can hold both reads in flight at once. Undefined everywhere else.
    beforeRespond: undefined as undefined | ((rail: LiveRail) => Promise<void>),
    /** The extension's observer, installed here so a test can watch each pass. */
    onReadings: undefined as undefined | ((pass: PassReadings) => void),
  };
  const answerFor = (rail: LiveRail, call: number): VendorReading => {
    // A failed rail fails whatever else a test installed: that is the read's
    // answer, and what is behind it does not matter.
    if (probe.failed[rail]) return failureOf(rail, "HTTP 429", probe.clock);
    const override = probe.answer[rail];
    return override === undefined
      ? readingOf(rail, probe.used[rail], probe.clock)
      : (override(call) as VendorReading);
  };
  const read = fakeReads({
    claude: async (_token, call) => {
      probe.calls.claude++;
      if (probe.beforeRespond) await probe.beforeRespond("claude");
      return (probe.rails.claude = answerFor("claude", call));
    },
    codex: async (_credential, call) => {
      probe.calls.codex++;
      if (probe.beforeRespond) await probe.beforeRespond("codex");
      return (probe.rails.codex = answerFor("codex", call));
    },
    antigravity: (credential) => {
      // A credential the fixture does not carry is a group-wide failure with no
      // request, which is what an install without that provider gets — and the
      // reason this fixture's pool count is zero by default.
      if (!("token" in credential)) return poolFailure(credential.error, probe.clock);
      probe.antigravityCalls++;
      const override = probe.answer.antigravity;
      if (override !== undefined) return override(1) as AntigravityReadings;
      return {
        "antigravity-argon": readingOf("antigravity-argon", probe.poolUsed["antigravity-argon"]!, probe.clock) as never,
        "antigravity-gemini": readingOf("antigravity-gemini", probe.poolUsed["antigravity-gemini"]!, probe.clock) as never,
        "antigravity-3p": readingOf("antigravity-3p", probe.poolUsed["antigravity-3p"]!, probe.clock) as never,
      };
    },
  });
  const readingsPath = join(root, "quota-dispatch-readings.json");
  // One answer for the three pools: the percentages the old document fixture
  // reported, so a stored reading can never be mistaken for a fresh one.
  probe.poolUsed = {
    "antigravity-argon": { weekly: 0 },
    "antigravity-gemini": { session: 42, weekly: 12 },
    "antigravity-3p": { session: 0, weekly: 2 },
  };
  const dispatcher = createDispatcher({
    // This fixture carries the Codex credential in pi's own auth file, which is
    // what `codexCredsPath` names by default (ADR 0020).
    ...DEFAULT_CONFIG, agentDir, claudeCredsPath, piAuthPath, codexCredsPath: piAuthPath, ttlMs: TTL, claudeRefresh: "off",
    readingsPath,
    agents: agentTable({ planner: routeOf({ primary: { model: PRIMARY, rail: "claude" }, alternates: [{ model: ALTERNATE, rail: "codex" }] }) }),
  }, {
    read,
    now: () => probe.clock,
    readKeychain: async () => ({ error: "no keychain" }),
    onReadings: (pass) => probe.onReadings?.(pass),
  });
  return { dispatcher, probe, agentFile, piAuthPath, readingsPath };
}

function good(reading: RailReading): GoodReading {
  assert.ok(reading.ok && !reading.metered, "expected a successful vendor read");
  return reading;
}

/**
 * A rail that was read, so its `lastGood` key is reachable at all. The metered
 * variant has no `lastGood` — that is the union's point — so a test reading one
 * has to say which side of it it is on.
 */
function withLastGood(readings: RailReadings): { latest: RailReading; lastGood?: GoodReading } {
  assert.ok(readings.latest.metered !== true, "the metered rail has no last good reading");
  return readings;
}

for (const rail of ["claude", "codex"] as const) {
  test(`${rail} successful reads keep the identical raw body that supplied their windows`, async (t) => {
    const { dispatcher, probe } = await fixture(t);
    const first = good((await dispatcher.railReadings(rail, true)).latest);
    assert.equal(first, probe.rails[rail], "the reading the read produced, untouched");
    assert.equal(first.readAt, NOW);
    const session = rail === "claude" ? 93 : 3;
    const weekly = rail === "claude" ? 21 : 4;
    assert.deepEqual(first.windows, [
      { label: "5h", used: session, budget: "session" },
      { label: "7d", used: weekly, budget: "weekly" },
    ]);
    probe.clock += 200;
    probe.used[rail] = { session: 7, weekly: 11 };
    const second = good((await dispatcher.railReadings(rail, true)).latest);
    assert.equal(second, probe.rails[rail]);
    assert.notEqual(second.raw, first.raw);
    assert.equal(second.readAt, NOW + 200);
    assert.deepEqual(second.windows.map((w) => w.used), [7, 11]);
  });

  test(`${rail} retains the earlier lastGood through failures and replaces it on recovery`, async (t) => {
    const { dispatcher, probe } = await fixture(t);
    const first = good((await dispatcher.railReadings(rail, true)).latest);
    const earlierRaw = first.raw;
    probe.failed[rail] = true;
    probe.clock += 500;
    const failed = withLastGood(await dispatcher.railReadings(rail, true));
    assert.equal(failed.latest.ok, false);
    assert.equal(failed.latest.readAt, NOW + 500);
    assert.deepEqual(failed.latest.windows, []);
    assert.ok(!("raw" in failed.latest));
    assert.equal(failed.lastGood, first);
    assert.equal(failed.lastGood.readAt, NOW);
    assert.equal(failed.lastGood.raw, earlierRaw);
    assert.deepEqual(failed.lastGood.windows, first.windows);

    probe.clock += 500;
    const failedAgain = withLastGood(await dispatcher.railReadings(rail, true));
    assert.equal(failedAgain.lastGood, first, "consecutive failures cannot erase the success");
    probe.failed[rail] = false;
    probe.used[rail] = { session: 8, weekly: 15 };
    probe.clock += 500;
    const recovered = withLastGood(await dispatcher.railReadings(rail, true));
    assert.equal(recovered.latest, recovered.lastGood);
    assert.notEqual(recovered.lastGood, first);
    const latest = good(recovered.latest);
    assert.equal(latest.readAt, NOW + 1500);
    assert.equal(latest, probe.rails[rail]);
    assert.deepEqual(latest.windows.map((w) => w.used), [8, 15]);
  });

  test(`${rail} never-successful failures omit raw and lastGood entirely`, async (t) => {
    const { dispatcher, probe } = await fixture(t);
    probe.failed[rail] = true;
    const readings = await dispatcher.railReadings(rail, true);
    assert.equal(readings.latest.ok, false);
    assert.equal(readings.latest.readAt, NOW);
    assert.deepEqual(readings.latest.windows, []);
    assert.ok(!("raw" in readings.latest));
    assert.ok(!("lastGood" in readings));
  });

  test(`${rail} caches successes and failures for ttlMs, while force bypasses the cache`, async (t) => {
    const { dispatcher, probe } = await fixture(t);
    const first = await dispatcher.railReadings(rail);
    probe.clock = NOW + TTL - 1;
    const cached = await dispatcher.railReadings(rail);
    assert.equal(cached.latest, first.latest);
    assert.equal(probe.calls[rail], 1);
    probe.failed[rail] = true;
    const forced = await dispatcher.railReadings(rail, true);
    assert.equal(forced.latest.ok, false);
    assert.equal(probe.calls[rail], 2);
    assert.equal(forced.latest.readAt, probe.clock);
    probe.clock += TTL - 1;
    assert.equal((await dispatcher.railReadings(rail)).latest, forced.latest);
    assert.equal(probe.calls[rail], 2, "a failure hit must not refetch or re-arm its TTL");
    probe.clock += 2;
    const lapsed = await dispatcher.railReadings(rail);
    assert.equal(probe.calls[rail], 3);
    assert.equal(lapsed.latest.ok, false);
    assert.equal(lapsed.latest.readAt, probe.clock);
  });
}

test("the TTL starts when the finished reading is stored, not when the response arrived", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  // The read answers with a reading stamped at NOW and then lets the clock run
  // past `ttlMs` before `railReadings` reaches its `cache.set` — which is what a
  // slow parse or a slow credential step looks like from the store's side. A TTL
  // stamped at arrival (`readAt`) would already be lapsed by the time it is
  // stored; one stamped at storage is not.
  probe.answer.claude = () => {
    const reading = readingOf("claude", { session: 93, weekly: 21 }, NOW);
    probe.clock += TTL + 1;
    return reading;
  };
  const first = await dispatcher.railReadings("claude");
  const second = await dispatcher.railReadings("claude");
  assert.equal(probe.calls.claude, 1, "parsing must not eat into the TTL");
  assert.equal(second.latest, first.latest, "the immediate next call is served from the cache");
});

test("a Codex limit_reached read reports every window full while raw keeps the vendor's document", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  // What the read made of a `limit_reached` document: every budget full, the
  // note gone with it, and the vendor's document kept as `raw` — its own 17 and
  // 38 still in there, so a reader is not promised that the windows are an
  // arithmetic restatement of the body. The document itself is
  // `rail-read.test.ts`'s.
  const vendorBody = { rate_limit: { primary_window: { used_percent: 17 }, secondary_window: { used_percent: 38 } } };
  probe.answer.codex = () => ({
    ...readingOf("codex", { session: 100, weekly: 100 }, probe.clock),
    raw: vendorBody,
    note: "limit_reached=true",
  });

  const readings = withLastGood(await dispatcher.railReadings("codex", true));
  const latest = good(readings.latest);
  // The limiter rewrites every window to full even though the vendor's own
  // asymmetric percentages say otherwise: a rail blocked outright is not merely
  // close, and the policy must not see a comfortable-looking percentage.
  assert.equal(latest.note, "limit_reached=true");
  assert.deepEqual(latest.windows, [
    { label: "5h", used: 100, budget: "session" },
    { label: "7d", used: 100, budget: "weekly" },
  ]);
  // `raw` stays the vendor's document untouched — both original percentages are
  // still there — so a reader is not promised that the windows are an arithmetic
  // restatement of it.
  assert.equal(latest.raw, vendorBody);
  const raw = latest.raw as {
    rate_limit: { primary_window: { used_percent: number }; secondary_window: { used_percent: number } };
  };
  assert.equal(raw.rate_limit.primary_window.used_percent, 17);
  assert.equal(raw.rate_limit.secondary_window.used_percent, 38);
  // A success is its own last good reading, so the cache keeps this rewritten
  // reading (never the raw document) as the earlier-read fallback.
  assert.equal(readings.lastGood, latest);
});

test("allReadings exposes deepseek as metered with no raw, readAt, lastGood or fetch", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  assert.deepEqual(await dispatcher.railReadings("deepseek", true), {
    latest: { rail: "deepseek", ok: true, windows: [], metered: true, note: "metered" },
  });
  assert.deepEqual(probe.calls, { claude: 0, codex: 0 });
  const all = await dispatcher.allReadings(true);
  // Canonical order, not sorted: the report prints the two long-standing vendor
  // rails, then one account's three Antigravity pools, then the metered rail.
  assert.deepEqual([...all.keys()], [
    "claude",
    "codex",
    "antigravity-argon",
    "antigravity-gemini",
    "antigravity-3p",
    "deepseek",
  ]);
  assert.deepEqual(all.get("deepseek"), {
    latest: { rail: "deepseek", ok: true, windows: [], metered: true, note: "metered" },
  });
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
});

test("evaluate holds after success to failure rather than assigning an attractive alternate from lastGood", async (t) => {
  const { dispatcher, probe, agentFile } = await fixture(t);
  const before = await readFile(agentFile, "utf8");
  const [initial] = await dispatcher.evaluate({ force: true, dry: true });
  assert.equal(initial.decision.kind, "assign");
  assert.equal(initial.decision.kind === "assign" && initial.decision.model, ALTERNATE);
  assert.equal(initial.outcome, "would-write");
  const earlier = good((await dispatcher.railReadings("claude")).latest);
  probe.failed.claude = true;
  probe.clock += 500;
  await dispatcher.railReadings("claude", true);
  const [held] = await dispatcher.evaluate();
  assert.equal(held.decision.kind, "hold");
  assert.equal(held.outcome, "held");
  assert.ok(!("model" in held.decision));
  assert.equal(await readFile(agentFile, "utf8"), before);
  assert.equal(withLastGood(await dispatcher.railReadings("claude")).lastGood, earlier);
});

test("report uses latest rail lines and never exposes raw account details or absolute resets", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const resetText = "2024-11-02T03:04:05.123456+00:00";
  // The account details and the absolute reset are in the reading, as a real
  // one carries them; the report is what must not repeat either.
  const account = { email: "private-reading@example.invalid", metadata: ["account-detail-never-print"] };
  probe.answer.claude = (): VendorReading => ({
    ...readingOf("claude", { session: 93, weekly: 21 }, probe.clock),
    windows: [
      { label: "5h", used: 93, budget: "session", resetsAt: Date.parse(resetText) },
      { label: "7d", used: 21, budget: "weekly" },
    ],
    raw: account,
  } as VendorReading);
  probe.answer.codex = (): VendorReading => ({
    ...readingOf("codex", { session: 3, weekly: 4 }, probe.clock),
    windows: [
      { label: "5h", used: 3, budget: "session", resetsAt: NOW + 3_600_000 },
      { label: "7d", used: 4, budget: "weekly" },
    ],
  } as VendorReading);
  const assertPrivate = (lines: string[]) => {
    const text = lines.join("\n");
    for (const secret of ["private-reading@example.invalid", "account-detail-never-print", resetText,
      String(Date.parse(resetText)), String(NOW + 3_600_000), "resetsAt", "resets_at", "reset_after_seconds",
      JSON.stringify(account)]) {
      assert.ok(!text.includes(secret), `report leaked ${secret}`);
    }
  };
  const successful = await dispatcher.report({ force: true });
  assert.match(successful.find((line) => line.startsWith("claude: ")) ?? "", /^claude: 5h 93%/);
  assert.match(successful.find((line) => line.startsWith("codex: ")) ?? "", /^codex: 5h 3%/);
  assertPrivate(successful);
  probe.failed.claude = true;
  probe.clock += 500;
  const failed = await dispatcher.railReadings("claude", true);
  const lines = await dispatcher.report();
  assert.ok(lines.includes(`claude: unavailable — ${failed.latest.note}`));
  assert.ok(!lines.some((line) => line.startsWith("claude: 5h")), "lastGood must not masquerade as the latest rail line");
  assertPrivate(lines);
});

// ---------------------------------------------------------------- knownReadings

test("knownReadings reads both capped rails in flight together, not one after the other", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  // A barrier both reads must reach before either answers. Started together, the
  // second arrival releases the pair. A sequential implementation never starts
  // the second read while the first waits, so the first is released only by the
  // safety timer and `peakInFlight` stays 1. The assertion is on `peakInFlight`,
  // not on the clock: the timer only bounds how long a regression takes to fail.
  let inFlight = 0;
  let peakInFlight = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  probe.beforeRespond = async () => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (inFlight >= 2) release();
    const safety = setTimeout(release, 2_000);
    try {
      await bothArrived;
    } finally {
      clearTimeout(safety);
      inFlight--;
    }
  };

  const known = await dispatcher.knownReadings();
  assert.equal(peakInFlight, 2, "the two capped reads must overlap; a sequential pair waits out both vendor latencies");
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
  assert.equal(good(known.claude.latest).readAt, NOW);
  assert.equal(good(known.codex.latest).readAt, NOW);
});

test("knownReadings returns an entry older than ttlMs as it is, without a fetch", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const claude = await dispatcher.railReadings("claude");
  const codex = await dispatcher.railReadings("codex");
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
  // Far past the TTL: `railReadings` would re-read both now. What is already
  // known is what the generator is fed, whatever its age.
  probe.clock += TTL * 100;
  probe.used.claude = { session: 1, weekly: 1 };
  const known = await dispatcher.knownReadings();
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 }, "an aged entry must not be re-read");
  assert.deepEqual(known.claude, claude);
  assert.deepEqual(known.codex, codex);
  assert.equal(good(known.claude.latest).readAt, NOW, "the reading sent is the old one, with its own time");
});

test("knownReadings reads a never-read rail once, unforced, and caches what it read", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const first = await dispatcher.knownReadings();
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
  assert.deepEqual(good(first.claude.latest).windows.map((w) => w.used), [93, 21]);
  assert.deepEqual(good(first.codex.latest).windows.map((w) => w.used), [3, 4]);

  const second = await dispatcher.knownReadings();
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 }, "a second call must read nothing");
  assert.deepEqual(second, first);

  // The read went through the cache, so the policy's own path within the TTL
  // sees it too rather than asking again.
  probe.clock += TTL - 1;
  assert.deepEqual((await dispatcher.railReadings("claude")).latest, first.claude.latest);
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 }, "the snapshot's read must have been cached");
});

test("knownReadings reads only the rail with no entry and leaves the cached one alone", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  await dispatcher.railReadings("claude");
  probe.clock += TTL * 100;
  const known = await dispatcher.knownReadings();
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
  assert.equal(good(known.claude.latest).readAt, NOW);
  assert.equal(good(known.codex.latest).readAt, NOW + TTL * 100);
});

test("knownReadings returns a failure beside the last good reading it left behind", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const earlier = good((await dispatcher.railReadings("codex", true)).latest);
  probe.failed.codex = true;
  probe.clock += 500;
  const failure = (await dispatcher.railReadings("codex", true)).latest;
  assert.equal(failure.ok, false);
  await dispatcher.railReadings("claude");
  probe.clock += TTL * 100;

  const known = await dispatcher.knownReadings();
  assert.deepEqual(known.codex, { latest: failure, lastGood: earlier });
  assert.deepEqual(probe.calls, { claude: 1, codex: 2 }, "a cached failure is not retried");
});

test("knownReadings returns a cached failure with no last good as it is, with no hidden retry", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  probe.failed.claude = true;
  await dispatcher.railReadings("claude");
  // The vendor would answer now; the snapshot must still not ask. A failure is
  // an entry, and "no forced read" means only a rail with *no* entry is read —
  // the refusal this leads to points the user at `refresh`.
  probe.failed.claude = false;
  probe.clock += TTL * 100;
  const known = await dispatcher.knownReadings();
  assert.equal(probe.calls.claude, 1, "a cached failure must not be re-read");
  assert.equal(known.claude.latest.ok, false);
  assert.equal(known.claude.latest.readAt, NOW);
  assert.ok(!("lastGood" in known.claude), "a never-successful rail has no last good reading");
});

test("knownReadings gives deepseek the metered arm and never fetches it", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const known = await dispatcher.knownReadings();
  assert.deepEqual(known.deepseek, await dispatcher.railReadings("deepseek"));
  assert.equal(known.deepseek.latest.metered, true);
  assert.ok(!("lastGood" in known.deepseek));
  assert.deepEqual(Object.keys(known).sort(), [
    "antigravity-3p",
    "antigravity-argon",
    "antigravity-gemini",
    "claude",
    "codex",
    "deepseek",
  ]);
  // The fetch stub rejects any URL but the vendors', so a deepseek request would
  // already have failed; the count pins that each vendor was asked once. The
  // Antigravity pools never reach the network here: this fixture's auth file has
  // no `antigravity` entry, so all three fail as unavailable without a request —
  // which is exactly what an install without that provider gets.
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
  assert.equal(probe.antigravityCalls, 0);
  for (const rail of ["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const) {
    assert.equal(known[rail].latest.ok, false);
  }
});

/**
 * One generation, one picture of the Antigravity group.
 *
 * A store holding one pool but not its siblings is what a partially publishable
 * file leaves behind. Reading each pool independently would let a sibling answer
 * from before the fetch the missing pool triggers — three readings of one vendor
 * answer that disagree about when, and about what, was read. The group is warmed
 * once and read back together, so the three always describe the same request.
 */
test("knownReadings warms a partial Antigravity group once, so its siblings cannot disagree", async (t) => {
  const { dispatcher, probe, piAuthPath, readingsPath } = await fixture(t, { antigravity: true });
  await writeFile(readingsPath, JSON.stringify({
    version: READINGS_FILE_VERSION,
    entries: [{
      rail: "antigravity-argon",
      credential: resolve(piAuthPath),
      at: NOW - 1,
      // A percentage no pool in the stub's body reports, so a returned Argon
      // reading of 55% could only be this stored one.
      latest: {
        rail: "antigravity-argon",
        ok: true,
        readAt: NOW - 1,
        windows: [{ label: "gemini-argon-wtu-weekly", used: 55, budget: "weekly" }],
        raw: { groups: [] },
      },
    }],
  }), "utf8");

  const known = await dispatcher.knownReadings();
  assert.equal(probe.antigravityCalls, 1, "a missing pool warms the group once, not once per pool");
  const latest = (["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const).map((rail) =>
    good(known[rail].latest),
  );
  assert.deepEqual(new Set(latest.map((r) => r.readAt)), new Set([NOW]), "one vendor answer, one instant");
  assert.deepEqual(latest.map((r) => r.windows.map((w) => [w.label, w.used])), [
    [["7d", 0]],
    [["5h", 42], ["7d", 12]],
    [["5h", 0], ["7d", 2]],
  ]);
});

// ---------------------------------------------------------------- the readings observer

/**
 * The footer's gauge draws what a pass read, so the pass has to hand its
 * readings over. One call per pass, and the map is the pass's own — `lastGood`
 * included, since that is what a rail's stale numbers are drawn from.
 *
 * The hand-over also carries the pass's number and the dispatcher's clock: the
 * number is what lets a display drop a pass that read earlier but finished
 * later, and the clock is the one the readings' own instants are on.
 */
test("onReadings is called once per evaluate and once per report, lastGood included", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  // A good reading first, so the later failure has something behind it.
  await dispatcher.railReadings("codex", true);
  probe.failed.codex = true;
  probe.clock += 500;

  const seen: PassReadings[] = [];
  probe.onReadings = (pass) => seen.push(pass);

  await dispatcher.evaluate({ force: true });
  assert.equal(seen.length, 1, "one pass, one observation");

  const codex = seen[0].readings.get("codex")!;
  assert.equal(codex.latest.ok, false);
  assert.ok(
    withLastGood(codex).lastGood !== undefined,
    "the observer sees the last good reading the policy discards",
  );
  assert.deepEqual(
    seen.map((pass) => [pass.seq, pass.now]),
    [[1, probe.clock]],
    "the pass is numbered and carries the dispatcher's own clock",
  );

  probe.clock += 500;
  await dispatcher.report({ force: true });
  assert.equal(seen.length, 2, "the report is a pass too");
  assert.deepEqual(
    seen.map((pass) => [pass.seq, pass.now]),
    [[1, probe.clock - 500], [2, probe.clock]],
    "pass numbers rise by one, and each is clocked as it is handed over",
  );
});

/**
 * An observer is a display, so it must run after the pass has applied its
 * decisions: a gauge drawn mid-pass would report numbers the files do not yet
 * agree with, and a display that could throw into the pass would be a veto.
 */
test("onReadings is called after the pass's agent-file write", async (t) => {
  const { dispatcher, probe, agentFile } = await fixture(t);
  let observed: string | undefined;
  probe.onReadings = () => {
    // A synchronous read of what the pass has already put on disk. The claude
    // primary is at 93% with a threshold of 75, so the decision is a switch.
    observed = readFileSync(agentFile, "utf8");
  };

  await dispatcher.evaluate({ force: true });
  assert.ok(observed !== undefined, "the observer ran");
  assert.ok(
    observed.includes(`model: "${ALTERNATE}"`),
    `the observer must see the switched model:\n${observed}`,
  );
});

/**
 * Rendering is handed readings, so there is nothing it could fetch. Pinned twice
 * over: the counters do not move across the `railGauge` call itself, and the pass
 * that draws is not charged a request the pass without it would skip.
 */
test("drawing the rail gauge makes no vendor request", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const counts = () => `${probe.calls.claude}/${probe.calls.codex}/${probe.antigravityCalls}`;
  let rendered: string | undefined;
  let acrossRendering: [string, string] | undefined;
  const cfg = {
    ...DEFAULT_CONFIG,
    agents: agentTable({
      planner: routeOf({
        primary: { model: PRIMARY, rail: "claude" },
        alternates: [{ model: ALTERNATE, rail: "codex" }],
      }),
    }),
  };

  // The same pass, counted without the gauge first.
  await dispatcher.evaluate({ force: true });
  const undrawn = counts();

  probe.onReadings = (pass) => {
    const before = counts();
    rendered = railGauge({
      readings: pass.readings,
      cfg,
      now: probe.clock,
      style: { dim: (text) => text, warning: (text) => text },
    });
    acrossRendering = [before, counts()];
  };
  // Both passes are forced, so each re-reads every rail: the two totals compare
  // like with like rather than across a cache the first pass warmed.
  await dispatcher.evaluate({ force: true });

  assert.ok(rendered !== undefined && rendered.includes("claude"), `the gauge drew: ${rendered}`);
  assert.ok(acrossRendering !== undefined);
  assert.equal(acrossRendering[1], acrossRendering[0], "rendering itself makes no request");
  // Two forced passes over two vendor rails: one read each per pass, drawn or not.
  assert.equal(undrawn, "1/1/0", "the undrawn pass is charged one read per rail");
  assert.equal(counts(), "2/2/0", "the drawn pass is charged exactly the same");
});
