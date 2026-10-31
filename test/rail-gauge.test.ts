import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GaugeEntry,
  type GoodReading,
  type GaugeStyle,
  type Rail,
  type RailReadings,
  type RailWindow,
  type VendorRail,
  type FailedReading,
  DEFAULT_CONFIG,
  type DispatcherConfig,
  railGauge,
  railGaugeEntries,
  renderRailGauge,
  resetText,
} from "../src/index.ts";
import { agentTable, routeOf } from "./helpers/identifiers.ts";
import type { AgentRoute } from "../src/config.ts";

// ---------------------------------------------------------------- fixtures

/** Wraps every tone in a marker, so a test can read the tone off the text. */
const TAGGED: GaugeStyle = { dim: (text) => `(${text})`, warning: (text) => `<${text}>` };

/**
 * The style most format tests use: the warning tone is marked and the dim tone
 * is not, so the expected string reads like the spec's own examples.
 */
const WARN: GaugeStyle = { dim: (text) => text, warning: (text) => `<${text}>` };

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CLAUDE_ROUTE = routeOf({
  primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
});
const CODEX_ROUTE = routeOf({ primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } });
const ARGON_ROUTE = routeOf({
  primary: { model: "antigravity-claude/argon", rail: "antigravity-argon" },
});
const GEMINI_ROUTE = routeOf({
  primary: { model: "antigravity-gemini/gemini-4", rail: "antigravity-gemini" },
});
const THIRD_PARTY_ROUTE = routeOf({
  primary: { model: "antigravity-3p/third-party", rail: "antigravity-3p" },
});
const DEEPSEEK_ROUTE = routeOf({
  primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
});

/** A config whose routes name `rails`, one agent each, so the gauge covers them. */
function cfgNaming(rails: readonly Rail[]): DispatcherConfig {
  const routes: Record<string, AgentRoute> = {
    claude: CLAUDE_ROUTE,
    codex: CODEX_ROUTE,
    "antigravity-argon": ARGON_ROUTE,
    "antigravity-gemini": GEMINI_ROUTE,
    "antigravity-3p": THIRD_PARTY_ROUTE,
    deepseek: DEEPSEEK_ROUTE,
  };
  const gated = ["claude", "codex", "antigravity-argon", "antigravity-gemini", "antigravity-3p"];
  const entries: Record<string, AgentRoute> = {};
  for (const rail of gated) if (rails.includes(rail as Rail)) entries[`agent-${rail}`] = routes[rail];
  if (rails.includes("deepseek")) entries["agent-deepseek"] = DEEPSEEK_ROUTE;
  return { ...DEFAULT_CONFIG, agents: agentTable(entries) };
}

/** A good reading of `rail` with the given windows. */
function good(rail: VendorRail, windows: RailWindow[]): GoodReading {
  return { rail, ok: true, windows, readAt: NOW, raw: {} };
}

/** A reading that failed; `lastGood` is added by the caller. */
function failed(rail: VendorRail): FailedReading {
  return { rail, ok: false, windows: [], readAt: NOW, note: "HTTP 500" };
}

function readings(...entries: Array<[Rail, RailReadings]>): Map<Rail, RailReadings> {
  return new Map(entries);
}

/** A latest success is also its own last good reading — the union's own rule. */
function ok(reading: GoodReading): RailReadings {
  return { latest: reading, lastGood: reading };
}

function session(used: number, resetsAt?: number): RailWindow {
  return { label: "5h", used, budget: "session", ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function weekly(used: number, resetsAt?: number): RailWindow {
  return { label: "7d", used, budget: "weekly", ...(resetsAt === undefined ? {} : { resetsAt }) };
}

const EXAMPLE_CFG: DispatcherConfig = { ...cfgNaming(["claude", "codex", "antigravity-argon", "deepseek"]), sessionSwitchAt: 70, weeklySwitchAt: 90 };

function gauge(
  map: Map<Rail, RailReadings>,
  cfg: DispatcherConfig = EXAMPLE_CFG,
  style: GaugeStyle = WARN,
): string | undefined {
  return railGauge({ readings: map, cfg, now: NOW, style });
}

// ---------------------------------------------------------------- rendering

test("renders the spec's example line", () => {
  const map = readings(
    ["claude", ok(good("claude", [session(13), weekly(91, NOW + 4 * DAY)]))],
    ["codex", ok(good("codex", [session(74, NOW + 2 * HOUR), weekly(41)]))],
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(62)]))],
    ["deepseek", { latest: { rail: "deepseek", ok: true, metered: true, windows: [], note: "metered" } }],
  );
  assert.equal(gauge(map), "claude 13/<91,4d> │ codex <74,2h>/41 │ ag-argon –/62");
});

test("a maxed rail goes last however high its figure", () => {
  const cfg = cfgNaming(["claude", "codex", "antigravity-3p", "antigravity-argon"]);
  const map = readings(
    ["claude", ok(good("claude", [session(20), weekly(10)]))],
    ["codex", ok(good("codex", [session(74), weekly(41)]))],
    ["antigravity-3p", ok(good("antigravity-3p", [session(0), weekly(100)]))],
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(100)]))],
  );
  // Both pools are at 100%, which is the most-used key and would put them first. They
  // are the least useful instead: nothing can be sent to either for days. The tie
  // between them still follows the fixed order.
  assert.equal(gauge(map, cfg), "codex 74/41 │ claude 20/10 │ ag-3p x/<100> │ ag-argon –/<100>");
});

test("a spent rail sorts after a rail with no number at all", () => {
  const cfg = cfgNaming(["claude", "codex", "antigravity-3p"]);
  const map = readings(
    ["claude", ok(good("claude", [session(0), weekly(0)]))],
    // Nothing has ever been read for codex, so it may still have headroom — which
    // the spent rail provably does not.
    ["codex", { latest: failed("codex") }],
    ["antigravity-3p", ok(good("antigravity-3p", [session(0), weekly(100)]))],
  );
  assert.equal(gauge(map, cfg), "claude 0/0 │ codex ? │ ag-3p x/<100>");
});

test("a stale rail whose last good week was spent sorts last too", () => {
  const cfg = cfgNaming(["claude", "antigravity-3p"]);
  const map = readings(
    ["claude", ok(good("claude", [session(0), weekly(0)]))],
    [
      "antigravity-3p",
      {
        latest: failed("antigravity-3p"),
        lastGood: good("antigravity-3p", [session(0), weekly(100)]),
      },
    ],
  );
  assert.equal(gauge(map, cfg), "claude 0/0 │ ag-3p x/100?");
});

test("orders most-used first", () => {
  const cfg = cfgNaming(["claude", "codex", "antigravity-gemini"]);
  const map = readings(
    ["claude", ok(good("claude", [session(20), weekly(1)]))],
    ["codex", ok(good("codex", [session(50), weekly(1)]))],
    ["antigravity-gemini", ok(good("antigravity-gemini", [session(1), weekly(80)]))],
  );
  const line = gauge(map, cfg)!;
  assert.equal(line, "ag-gemini 1/80 │ codex 50/1 │ claude 20/1");
});

test("ties keep the fixed order whatever order the entries arrive in", () => {
  const cfg = cfgNaming([
    "claude",
    "codex",
    "antigravity-3p",
    "antigravity-gemini",
    "antigravity-argon",
  ]);
  const entries: Array<[Rail, RailReadings]> = [
    ["claude", ok(good("claude", [session(50)]))],
    ["codex", ok(good("codex", [session(50)]))],
    ["antigravity-3p", ok(good("antigravity-3p", [session(50)]))],
    ["antigravity-gemini", ok(good("antigravity-gemini", [session(50)]))],
    // Argon has no session budget, so its peak is the week's 50.
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(50)]))],
  ];
  // Every one of them carries a week it did not report, so the slot is `?`; the
  // peak is what ties, and Argon's is the only week it has.
  const expected = "claude 50/? │ codex 50/? │ ag-3p 50/? │ ag-gemini 50/? │ ag-argon –/50";
  assert.equal(gauge(readings(...entries), cfg), expected);
  assert.equal(gauge(readings(...[...entries].reverse()), cfg), expected);
});

test("orders on the raw figure and prints the rounded one", () => {
  const cfg = cfgNaming(["claude", "codex"]);
  const map = readings(
    ["claude", ok(good("claude", [session(74.2), weekly(1)]))],
    ["codex", ok(good("codex", [session(74.4), weekly(1)]))],
  );
  // Both print 74, and the higher raw figure comes first.
  assert.equal(gauge(map, cfg), "codex 74/1 │ claude 74/1");

  // Exactly equal raw peaks keep the fixed order instead.
  const equal = readings(
    ["claude", ok(good("claude", [session(74.4), weekly(1)]))],
    ["codex", ok(good("codex", [session(74.4), weekly(1)]))],
  );
  assert.equal(gauge(equal, cfg), "claude 74/1 │ codex 74/1");
});

test("the threshold is tight at equality and not one hundredth below it", () => {
  const cfg = { ...cfgNaming(["claude"]), sessionSwitchAt: 70 };
  const at = readings(["claude", ok(good("claude", [session(70, NOW + HOUR), weekly(0)]))]);
  assert.equal(gauge(at, cfg), "claude <70,1h>/0");

  // The same figure one hundredth below the threshold is not tight, and still
  // carries the countdown: the tone says how alarming it is, the countdown says
  // when it moves, and the second is worth as much at 69% as at 70%.
  const below = readings(["claude", ok(good("claude", [session(69.99, NOW + HOUR), weekly(0)]))]);
  assert.equal(gauge(below, cfg), "claude 70,1h/0");
});

test("a comfortable budget shows when its figure drops", () => {
  const cfg = cfgNaming(["claude"]);
  const map = readings(["claude", ok(good("claude", [session(42, NOW + 3 * HOUR), weekly(11, NOW + 6 * DAY)]))]);
  assert.equal(gauge(map, cfg), "claude 42,3h/11,6d");
});

test("a comfortable budget spread over windows moves when the last maximum does", () => {
  // The figure printed is the highest of the windows, so it drops when the
  // window holding that maximum resets — not when a lower one does, and not
  // when the earliest of two equal maxima does.
  const cfg = cfgNaming(["claude"]);
  const map = readings([
    "claude",
    ok(
      good("claude", [
        weekly(30, NOW + 30 * MINUTE),
        weekly(42, NOW + 2 * DAY),
        weekly(42, NOW + 4 * DAY),
      ]),
    ),
  ]);
  assert.equal(gauge(map, cfg), "claude ?/42,4d");
});

test("one maximum-holding window with no reset leaves the countdown unknown", () => {
  const cfg = cfgNaming(["claude"]);
  const map = readings([
    "claude",
    ok(good("claude", [session(0), weekly(42, NOW + 2 * DAY), weekly(42)])),
  ]);
  assert.equal(gauge(map, cfg), "claude 0/42");
});

test("a tight budget with no reported reset is colored and carries no arrow", () => {
  const cfg = { ...cfgNaming(["claude"]), sessionSwitchAt: 70 };
  const map = readings(["claude", ok(good("claude", [session(90), weekly(0)]))]);
  assert.equal(gauge(map, cfg), "claude <90>/0");
});

test("a budget's reset is the latest among its tight windows", () => {
  const cfg = { ...cfgNaming(["claude"]), weeklySwitchAt: 90 };
  const map = readings([
    "claude",
    ok(
      good("claude", [
        session(0),
        weekly(92, NOW + 2 * DAY),
        weekly(95, NOW + 4 * DAY),
        // Below the threshold, so its later reset says nothing about when the
        // budget stops being tight.
        weekly(50, NOW + 6 * DAY),
      ]),
    ),
  ]);
  assert.equal(gauge(map, cfg), "claude 0/<95,4d>");
});

test("a tight budget counts down to its last tight window, not to its highest", () => {
  // The tight rule is about the decision, and the decision stays made until the
  // *last* window above the threshold resets. A comfortable budget's rule is
  // about the figure, which moves when the highest window does. The two are
  // deliberately different, and a shared helper once collapsed them: this pins
  // the case where the highest window resets first.
  const cfg = { ...cfgNaming(["claude"]), weeklySwitchAt: 90 };
  const map = readings([
    "claude",
    ok(good("claude", [session(0), weekly(92, NOW + 6 * DAY), weekly(95, NOW + 2 * DAY)])),
  ]);
  assert.equal(gauge(map, cfg), "claude 0/<95,6d>");
});

test("one tight window with no reset makes the whole budget's reset unknown", () => {
  const cfg = { ...cfgNaming(["claude"]), weeklySwitchAt: 90 };
  const map = readings([
    "claude",
    ok(good("claude", [session(0), weekly(95), weekly(91, NOW + 2 * DAY)])),
  ]);
  assert.equal(gauge(map, cfg), "claude 0/<95>");
});

test("a budget the rail does not carry reads as absent, one it did not report as unknown", () => {
  const cfg = cfgNaming(["codex", "antigravity-argon"]);
  const map = readings(
    ["codex", ok(good("codex", [weekly(41)]))],
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(62)]))],
  );
  assert.equal(gauge(map, cfg), "ag-argon –/62 │ codex ?/41");
});

test("a spent week switches the session slot off and leaves every other slot alone", () => {
  const cfg = cfgNaming(["antigravity-3p", "antigravity-argon"]);
  const map = readings(
    [
      "antigravity-3p",
      ok(good("antigravity-3p", [session(0, NOW + 5 * HOUR), weekly(100, NOW + 5 * DAY)])),
    ],
    // Argon's week is spent too, and a spent week is all it ever has.
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(100, NOW + 5 * DAY)]))],
  );
  // The vendor turns the 5-hour limit off once a weekly pool is spent and keeps
  // reporting the 5-hour window at 0%, which would read as the roomiest figure
  // on the account. Argon has no session budget to turn off, so it keeps `–`.
  assert.equal(gauge(map, cfg), "ag-3p x/<100,5d> │ ag-argon –/<100,5d>");
});

test("the session slot is drawn until a pool reaches the vendor's own cap", () => {
  const cfg = cfgNaming(["antigravity-3p"]);
  const atWeek = (week: number) =>
    gauge(
      readings(["antigravity-3p", ok(good("antigravity-3p", [session(0), weekly(week)]))]),
      cfg,
    );
  // 100 is the vendor's cap, not a switch threshold: a config that moves
  // `weeklySwitchAt` changes the tone and nothing about the switch-off.
  assert.equal(atWeek(99.9), "ag-3p 0/<100>");
  assert.equal(atWeek(100), "ag-3p x/<100>");
  assert.equal(atWeek(100.4), "ag-3p x/<100>");
});

test("a week the read did not report does not switch the session slot off", () => {
  const cfg = cfgNaming(["antigravity-3p"]);
  const map = readings(["antigravity-3p", ok(good("antigravity-3p", [session(0)]))]);
  assert.equal(gauge(map, cfg), "ag-3p 0/?");
});

test("a stale rail whose last good week was spent still draws the session slot as off", () => {
  const cfg = cfgNaming(["antigravity-3p"]);
  const map = readings([
    "antigravity-3p",
    { latest: failed("antigravity-3p"), lastGood: good("antigravity-3p", [session(0), weekly(100)]) },
  ]);
  assert.equal(gauge(map, cfg), "ag-3p x/100?");
});

test("a failed read with a last good reading is drawn stale, dim and unjudged", () => {
  const cfg = { ...cfgNaming(["codex"]), sessionSwitchAt: 70 };
  // The last good reading knows both its resets: they are the ones the countdown
  // would print, and they are deliberately not printed. They count from a moment
  // that has passed, so a duration computed from them is a fresh-looking number
  // about a reading that is no longer fresh — the `?` is the whole truth here.
  const good61 = good("codex", [session(74, NOW + 2 * HOUR), weekly(41, NOW + 5 * DAY)]);
  const map = readings(["codex", { latest: failed("codex"), lastGood: good61 }]);
  // 74 is past the threshold, and yet nothing is colored or given a reset: the
  // policy holds on this rail, so there is no judgment to draw.
  assert.equal(gauge(map, cfg), "codex 74/41?");
});

test("a stale rail sorts by its last good reading", () => {
  const cfg = cfgNaming(["claude", "codex"]);
  const map = readings(
    ["claude", { latest: failed("claude"), lastGood: good("claude", [session(10), weekly(10)]) }],
    ["codex", { latest: failed("codex"), lastGood: good("codex", [session(80), weekly(10)]) }],
  );
  assert.equal(gauge(map, cfg), "codex 80/10? │ claude 10/10?");
});

test("a tie between a stale rail and a fresh one keeps the fixed order", () => {
  // The sort key is a number either way, so a stale rail that ties a fresh one
  // must fall back to the fixed order rather than being pushed behind every
  // fresh rail. Observed in a live session before this was pinned: a stale
  // `codex 95/97?` printed before a fresh `ag-3p 97,5h/51`. The stale rail's
  // numbers are past both thresholds here and still print uncolored, which is
  // the same rule from the other side.
  const cfg = cfgNaming(["codex", "antigravity-3p"]);
  const map = readings(
    ["codex", { latest: failed("codex"), lastGood: good("codex", [session(95), weekly(97)]) }],
    ["antigravity-3p", ok(good("antigravity-3p", [session(97), weekly(51)]))],
  );
  assert.equal(gauge(map, cfg), "codex 95/97? │ ag-3p <97>/51");
});

test("a stale rail's absent budget stays absent, and one it never reported stays unknown", () => {
  const cfg = cfgNaming(["codex", "antigravity-argon"]);
  const map = readings(
    ["codex", { latest: failed("codex"), lastGood: good("codex", [weekly(41)]) }],
    [
      "antigravity-argon",
      { latest: failed("antigravity-argon"), lastGood: good("antigravity-argon", [weekly(62)]) },
    ],
  );
  // Argon has no session budget, so `–`; codex carries one and did not report
  // it, so `?`. Both rails still end in the stale marker.
  assert.equal(gauge(map, cfg), "ag-argon –/62? │ codex ?/41?");
});

test("a rail with no reading at all shows a bare label and sorts last", () => {
  // The unread rail is *first* in the fixed order, so a peak that treated "no
  // number" as zero would tie here and put `claude` first: only reading it as a
  // missing number sorts it after a rail that really is at 0%.
  const cfg = cfgNaming(["claude", "antigravity-argon"]);
  const map = readings(
    ["claude", { latest: failed("claude") }],
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(0)]))],
  );
  assert.equal(gauge(map, cfg), "ag-argon –/0 │ claude ?");
});

test("a rail whose every budget is unreported also sorts last", () => {
  const cfg = cfgNaming(["claude", "codex"]);
  const map = readings(
    ["claude", ok(good("claude", []))],
    ["codex", ok(good("codex", [session(0), weekly(0)]))],
  );
  assert.equal(gauge(map, cfg), "codex 0/0 │ claude ?/?");
});

test("a stale rail with no number in its last good reading sorts last too", () => {
  const cfg = cfgNaming(["claude", "codex"]);
  const map = readings(
    ["claude", { latest: failed("claude"), lastGood: good("claude", []) }],
    ["codex", ok(good("codex", [session(0), weekly(0)]))],
  );
  // Both `?`s: the slot's, for a budget that was never reported, and the rail's,
  // for a reading that is no longer fresh. Pinned as it renders rather than
  // given a third glyph.
  assert.equal(gauge(map, cfg), "codex 0/0 │ claude ?/??");
});

test("the tie order does not depend on the order the entries arrive in", () => {
  // Hand-built entries, because the projection walks the fixed order: only a
  // renderer that ignores its input order can pass with the entries reversed.
  const entry = (rail: VendorRail): GaugeEntry => ({
    rail,
    kind: "fresh",
    spent: false,
    session: { kind: "used", used: 50, resetInMs: undefined },
    weekly: { kind: "unreported" },
  });
  const fixed: VendorRail[] = ["claude", "codex", "antigravity-3p", "antigravity-gemini", "antigravity-argon"];
  const expected = "claude 50/? │ codex 50/? │ ag-3p 50/? │ ag-gemini 50/? │ ag-argon 50/?";
  assert.equal(renderRailGauge(fixed.map(entry), WARN), expected);
  assert.equal(renderRailGauge([...fixed].reverse().map(entry), WARN), expected);
  const shuffled: VendorRail[] = ["antigravity-gemini", "claude", "antigravity-argon", "codex", "antigravity-3p"];
  assert.equal(renderRailGauge(shuffled.map(entry), WARN), expected);
});

// ---------------------------------------------------------------- which rails

test("metered rails never appear", () => {
  const metered: RailReadings = {
    latest: { rail: "deepseek", ok: true, metered: true, windows: [], note: "metered" },
  };
  assert.equal(gauge(readings(["deepseek", metered]), cfgNaming(["deepseek"])), undefined);

  const both = readings(
    ["deepseek", metered],
    ["claude", ok(good("claude", [session(3), weekly(2)]))],
  );
  assert.equal(gauge(both, cfgNaming(["deepseek", "claude"])), "claude 3/2");
});

test("a rail no route names is absent however fresh its reading is", () => {
  const map = readings(
    ["claude", ok(good("claude", [session(3), weekly(2)]))],
    ["codex", ok(good("codex", [session(99), weekly(99)]))],
  );
  assert.equal(gauge(map, cfgNaming(["claude"])), "claude 3/2");
});

test("a dropped alternate is not a named rail", () => {
  // `checkModels` drops an alternate the running pi cannot spawn, and the config
  // that comes out of it names the remaining rails only. `gaugedRails` reads
  // that config, so the dropped rail cannot appear.
  const withAlternate = routeOf({
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  });
  const checked: DispatcherConfig = {
    ...DEFAULT_CONFIG,
    agents: agentTable({ planner: withAlternate }),
  };
  const map = readings(
    ["claude", ok(good("claude", [session(3), weekly(2)]))],
    ["codex", ok(good("codex", [session(60), weekly(50)]))],
  );
  assert.equal(gauge(map, checked), "codex 60/50 │ claude 3/2");

  const dropped: DispatcherConfig = {
    ...DEFAULT_CONFIG,
    agents: agentTable({ planner: { ...withAlternate, alternates: [] } }),
  };
  assert.equal(gauge(map, dropped), "claude 3/2");
});

test("an unconfigured install has an empty gauge", () => {
  const map = readings(["claude", ok(good("claude", [session(3), weekly(2)]))]);
  assert.equal(gauge(map, DEFAULT_CONFIG), undefined);
  assert.deepEqual(railGaugeEntries({ readings: map, cfg: DEFAULT_CONFIG, now: NOW }), []);
});

// ---------------------------------------------------------------- resetText

test("resetText promotes a value that rounds up to the next unit", () => {
  const table: Array<[number, string]> = [
    [-1, "now"],
    [0, "now"],
    [1, "1m"],
    [45 * MINUTE, "45m"],
    [59 * MINUTE, "59m"],
    [59 * MINUTE + 1, "1h"],
    [59 * MINUTE + 30_000, "1h"],
    [60 * MINUTE, "1h"],
    [HOUR + 29 * MINUTE + 59_999, "1h"],
    [HOUR + 30 * MINUTE, "2h"],
    [3 * HOUR, "3h"],
    [23 * HOUR + 29 * MINUTE + 59_999, "23h"],
    [23 * HOUR + 30 * MINUTE, "1d"],
    [23 * HOUR + 40 * MINUTE, "1d"],
    [DAY, "1d"],
    [35 * HOUR + 59 * MINUTE + 59_999, "1d"],
    [36 * HOUR, "2d"],
    [3.5 * DAY, "4d"],
  ];
  for (const [ms, expected] of table) assert.equal(resetText(ms), expected, `${ms} ms`);
});

// ---------------------------------------------------------------- tones

test("every character outside a tight slot is dim, merged into one run per tone change", () => {
  const map = readings(
    ["claude", ok(good("claude", [session(13), weekly(91, NOW + 4 * DAY)]))],
    ["codex", ok(good("codex", [session(74, NOW + 2 * HOUR), weekly(41)]))],
    ["antigravity-argon", ok(good("antigravity-argon", [weekly(62)]))],
  );
  assert.equal(
    gauge(map, EXAMPLE_CFG, TAGGED),
    "(claude 13/)<91,4d>( │ codex )<74,2h>(/41 │ ag-argon –/62)",
  );
});

test("a percentage is printed whole, as the report prints it", () => {
  const cfg = { ...cfgNaming(["claude"]), sessionSwitchAt: 90 };
  const map = readings(["claude", ok(good("claude", [session(74.6), weekly(0)]))]);
  assert.equal(gauge(map, cfg), "claude 75/0");
});

// ---------------------------------------------------------------- projection

test("the projection marks a rail whose entry is missing as unread", () => {
  const cfg = cfgNaming(["claude", "codex"]);
  const entries = railGaugeEntries({
    readings: readings(["claude", ok(good("claude", [session(3), weekly(2)]))]),
    cfg,
    now: NOW,
  });
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["fresh", "unread"],
  );
});

test("a rendered entry set is a plain value: the renderer takes no readings", () => {
  const cfg = cfgNaming(["claude"]);
  const entries = railGaugeEntries({
    readings: readings(["claude", ok(good("claude", [session(3), weekly(2)]))]),
    cfg,
    now: NOW,
  });
  // Rendering the same projection twice cannot observe a change, which is what
  // makes "a drawing never causes a read" a property of the interface: the
  // renderer is handed entries, not readings, and has nothing to read from.
  assert.equal(renderRailGauge(entries, WARN), renderRailGauge(entries, WARN));
});

test("an empty entry set renders nothing", () => {
  assert.equal(renderRailGauge([], WARN), undefined);
});

test("the gauge draws a rail it has no entry for as unread rather than throwing", () => {
  const cfg = cfgNaming(["antigravity-3p"]);
  const line = gauge(readings(), cfg);
  assert.equal(line, "ag-3p ?");
  const entry: GaugeEntry | undefined = railGaugeEntries({ readings: new Map(), cfg, now: NOW })[0];
  assert.deepEqual(entry, { rail: "antigravity-3p", kind: "unread" });
});
