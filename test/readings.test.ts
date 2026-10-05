import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEFAULT_CONFIG,
  createDispatcher,
  parseClaudeUsage,
  parseCodexUsage,
  type GoodReading,
  type MeteredReading,
  type RailReading,
  type RailReadings,
} from "../src/index.ts";

import { agentTable, routeOf } from "./helpers/identifiers.ts";

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

function bodyFor(rail: LiveRail, session = 93, weekly = 21) {
  const account = { email: "private-reading@example.invalid", metadata: ["account-detail-never-print"] };
  return rail === "claude"
    ? { account, five_hour: { utilization: session }, seven_day: { utilization: weekly } }
    : { account, rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: session, limit_window_seconds: 18000 },
        secondary_window: { used_percent: weekly, limit_window_seconds: 604800 },
      } };
}

async function fixture(t: TestContext) {
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
  await writeFile(piAuthPath, JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct-test" } }));

  const probe = {
    clock: NOW,
    bodies: { claude: bodyFor("claude"), codex: bodyFor("codex", 3, 4) } as Record<LiveRail, unknown>,
    failed: { claude: false, codex: false },
    calls: { claude: 0, codex: 0 },
    // A hook the concurrency test installs; the stub awaits it before answering,
    // so a test can hold both reads in flight at once. Undefined everywhere else.
    beforeRespond: undefined as undefined | ((rail: LiveRail) => Promise<void>),
  };
  // A definite HTTP answer avoids retries or real-time backoff in cache tests.
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    const rail = u.includes("anthropic.com") ? "claude" : u.includes("chatgpt.com") ? "codex" : undefined;
    assert.ok(rail, `unexpected network request: ${u}`);
    probe.calls[rail]++;
    if (probe.beforeRespond) await probe.beforeRespond(rail);
    return { ok: !probe.failed[rail], status: probe.failed[rail] ? 429 : 200, json: async () => probe.bodies[rail] };
  }) as unknown as typeof fetch;
  const dispatcher = createDispatcher({
    ...DEFAULT_CONFIG, agentDir, claudeCredsPath, piAuthPath, ttlMs: TTL, claudeRefresh: "off",
    readingsPath: join(root, "quota-dispatch-readings.json"),
    agents: agentTable({ planner: routeOf({ primary: { model: PRIMARY, rail: "claude" }, alternates: [{ model: ALTERNATE, rail: "codex" }] }) }),
  }, { fetchImpl, now: () => probe.clock, readKeychain: async () => ({ error: "no keychain" }) });
  return { dispatcher, probe, agentFile };
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

test("Claude resets are absolute epoch milliseconds, including fractional +00:00 timestamps", () => {
  const sessionReset = "2024-11-02T03:04:05.123456+00:00";
  const weeklyReset = "2024-11-08T06:07:08Z";
  assert.deepEqual(parseClaudeUsage({
    five_hour: { utilization: 13, resets_at: sessionReset },
    seven_day: { utilization: 29, resets_at: weeklyReset },
    seven_day_sonnet: { utilization: 41, resets_at: sessionReset },
  }), [
    { label: "5h", used: 13, budget: "session", resetsAt: Date.parse(sessionReset) },
    { label: "7d", used: 29, budget: "weekly", resetsAt: Date.parse(weeklyReset) },
    { label: "7d Sonnet", used: 41, budget: "weekly", resetsAt: Date.parse(sessionReset) },
  ]);
});

test("Claude omits absent and unparseable resets instead of undefined keys or relative resets", () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 13 },
    seven_day: { utilization: 29, resets_at: "not-a-date" },
  });
  assert.deepEqual(windows, [
    { label: "5h", used: 13, budget: "session" },
    { label: "7d", used: 29, budget: "weekly" },
  ]);
  for (const window of windows) assert.ok(!("resetsInSeconds" in window));
});

test("Codex anchors both resets to a nonzero readAt even when limit_reached is true", () => {
  const readAt = NOW + 12_345;
  assert.deepEqual(parseCodexUsage({ rate_limit: {
    limit_reached: true,
    primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_after_seconds: 0 },
    secondary_window: { used_percent: 38, limit_window_seconds: 604800, reset_after_seconds: 408848 },
  } }, { readAt }), {
    limited: true,
    windows: [
      { label: "5h", used: 17, budget: "session", resetsAt: readAt },
      { label: "7d", used: 38, budget: "weekly", resetsAt: readAt + 408_848_000 },
    ],
  });
});

test("Codex omits an unreported reset without losing the other window's absolute reset", () => {
  assert.deepEqual(parseCodexUsage({ rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 6, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 42 },
  } }, { readAt: NOW }), {
    limited: false,
    windows: [
      { label: "5h", used: 6, budget: "session", resetsAt: NOW + 3_600_000 },
      { label: "7d", used: 42, budget: "weekly" },
    ],
  });
});

test("Codex drops a derived reset that is not an instant a Date can hold", () => {
  const { windows } = parseCodexUsage({ rate_limit: {
    limit_reached: false,
    // `1e308` seconds overflows the product to `Infinity`; `1e13` seconds is
    // finite but lands past the `Date` range (`8.64e15` ms). Both are valid JSON
    // and pass `num`, so only the derived instant can reject them.
    primary_window: { used_percent: 6, reset_after_seconds: 1e308 },
    secondary_window: { used_percent: 42, reset_after_seconds: 1e13 },
  } }, { readAt: NOW });
  assert.deepEqual(windows, [
    { label: "5h", used: 6, budget: "session" },
    { label: "7d", used: 42, budget: "weekly" },
  ]);
});

for (const rail of ["claude", "codex"] as const) {
  test(`${rail} successful reads keep the identical raw body that supplied their windows`, async (t) => {
    const { dispatcher, probe } = await fixture(t);
    const first = good((await dispatcher.railReadings(rail, true)).latest);
    assert.equal(first.raw, probe.bodies[rail]);
    assert.equal(first.readAt, NOW);
    const session = rail === "claude" ? 93 : 3;
    const weekly = rail === "claude" ? 21 : 4;
    assert.deepEqual(first.windows, [
      { label: "5h", used: session, budget: "session" },
      { label: "7d", used: weekly, budget: "weekly" },
    ]);
    probe.clock += 200;
    probe.bodies[rail] = bodyFor(rail, 7, 11);
    const second = good((await dispatcher.railReadings(rail, true)).latest);
    assert.equal(second.raw, probe.bodies[rail]);
    assert.notEqual(second.raw, first.raw);
    assert.equal(second.readAt, NOW + 200);
    assert.deepEqual(second.windows.map((w) => w.used), [7, 11]);
  });

  test(`${rail} retains the earlier lastGood through failures and replaces it on recovery`, async (t) => {
    const { dispatcher, probe } = await fixture(t);
    const first = good((await dispatcher.railReadings(rail, true)).latest);
    const earlierBody = probe.bodies[rail];
    probe.failed[rail] = true;
    probe.clock += 500;
    const failed = withLastGood(await dispatcher.railReadings(rail, true));
    assert.equal(failed.latest.ok, false);
    assert.equal(failed.latest.readAt, NOW + 500);
    assert.deepEqual(failed.latest.windows, []);
    assert.ok(!("raw" in failed.latest));
    assert.equal(failed.lastGood, first);
    assert.equal(failed.lastGood.readAt, NOW);
    assert.equal(failed.lastGood.raw, earlierBody);
    assert.deepEqual(failed.lastGood.windows, first.windows);

    probe.clock += 500;
    const failedAgain = withLastGood(await dispatcher.railReadings(rail, true));
    assert.equal(failedAgain.lastGood, first, "consecutive failures cannot erase the success");
    probe.failed[rail] = false;
    probe.bodies[rail] = bodyFor(rail, 8, 15);
    probe.clock += 500;
    const recovered = withLastGood(await dispatcher.railReadings(rail, true));
    assert.equal(recovered.latest, recovered.lastGood);
    assert.notEqual(recovered.lastGood, first);
    const latest = good(recovered.latest);
    assert.equal(latest.readAt, NOW + 1500);
    assert.equal(latest.raw, probe.bodies[rail]);
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
  let advanced = false;
  const body = bodyFor("claude") as Record<string, any>;
  Object.defineProperty(body.five_hour, "utilization", {
    // A getter is a legitimate way to model parse time: this is the field the
    // parser reads, and that read advances the injected clock past `ttlMs`
    // before `railReadings` reaches its `cache.set`. A plain value could not
    // show the difference between stamping the TTL at arrival (`readAt`) and
    // stamping it at storage — the bug this pins.
    get() {
      if (!advanced) {
        advanced = true;
        probe.clock += TTL + 1;
      }
      return 93;
    },
    enumerable: true,
    configurable: true,
  });
  probe.bodies.claude = body;
  const first = await dispatcher.railReadings("claude");
  const second = await dispatcher.railReadings("claude");
  assert.equal(probe.calls.claude, 1, "parsing must not eat into the TTL");
  assert.equal(second.latest, first.latest, "the immediate next call is served from the cache");
});

test("a Codex limit_reached read reports every window full while raw keeps the vendor's document", async (t) => {
  const { dispatcher, probe } = await fixture(t);
  const vendorBody = { ...bodyFor("codex"), rate_limit: {
    limit_reached: true,
    primary_window: { used_percent: 17, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 38, limit_window_seconds: 604800 },
  } };
  probe.bodies.codex = vendorBody;

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
  assert.deepEqual([...all.keys()].sort(), ["claude", "codex", "deepseek"]);
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
  probe.bodies.claude = { ...bodyFor("claude"), five_hour: { utilization: 93, resets_at: resetText } };
  probe.bodies.codex = { ...bodyFor("codex", 3, 4), rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 3, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 4 },
  } };
  const assertPrivate = (lines: string[]) => {
    const text = lines.join("\n");
    for (const secret of ["private-reading@example.invalid", "account-detail-never-print", resetText,
      String(Date.parse(resetText)), String(NOW + 3_600_000), "resetsAt", "resets_at", "reset_after_seconds",
      JSON.stringify(probe.bodies.claude), JSON.stringify(probe.bodies.codex)]) {
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
  probe.bodies.claude = bodyFor("claude", 1, 1);
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
  assert.deepEqual(Object.keys(known).sort(), ["claude", "codex", "deepseek"]);
  // The fetch stub rejects any URL but the two vendors', so a deepseek request
  // would already have failed; the count pins that each vendor was asked once.
  assert.deepEqual(probe.calls, { claude: 1, codex: 1 });
});
