/**
 * The judgment **tight**, as the reading module states it.
 *
 * `isTight` is the one implementation the policy and the rail gauge both call, so
 * a change here changes what both of them do. Four facts about it are worth
 * pinning, because each is a plausible slip rather than a spelling: the threshold
 * is inclusive, one point below is not tight, a budget the rail does not carry is
 * never tight whatever the threshold, and a carried budget the read did not
 * report is not tight either. The last two are the ones a plain "compare two
 * numbers" implementation loses. Lose the carriage rule and a pool with no
 * session cap reads as tight on one — refused as a destination, or moved off as a
 * primary, for pressure the vendor never promised. Lose the unreported rule and a
 * missing figure reads as room, which routes work onto a rail that may be
 * blocked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Rail } from "../src/rail.ts";
import { isTight, type GoodReading, type MeteredReading, type RailWindow } from "../src/rail-reading.ts";

const CLOCK = 1_730_123_456_789;

function reading(rail: Rail, windows: RailWindow[]): GoodReading {
  return { rail, ok: true, windows, readAt: CLOCK, raw: {} };
}

function claude(session: number, weekly = 0): GoodReading {
  return reading("claude", [
    { label: "5h", used: session, budget: "session" },
    { label: "7d", used: weekly, budget: "weekly" },
  ]);
}

test("a budget at the threshold is tight, and one point below it is not", () => {
  assert.equal(isTight(claude(70), "session", 70), true);
  assert.equal(isTight(claude(69), "session", 70), false);
});

test("a carried budget is tight at a zero threshold, so a pool with no room at all is not mistaken for one", () => {
  assert.equal(isTight(claude(0), "session", 0), true);
});

test("a budget the rail does not carry is never tight, even at a zero threshold", () => {
  // Argon has one weekly pool and no session window: the vendor never promised a
  // session cap there, so `sessionSwitchAt: 0` must not refuse it on one.
  const argon = reading("antigravity-argon", [{ label: "gemini-argon-wtu-weekly", used: 0, budget: "weekly" }]);
  assert.equal(isTight(argon, "session", 0), false);
  assert.equal(isTight(argon, "weekly", 0), true, "the cap it does carry is still weighed");
});

test("a metered rail is never tight on either budget", () => {
  const metered: MeteredReading = { rail: "deepseek", ok: true, metered: true, windows: [] };
  assert.equal(isTight(metered, "session", 0), false);
  assert.equal(isTight(metered, "weekly", 0), false);
});

test("a carried budget the read did not report is not tight", () => {
  // Claude carries a session budget, but this reading came back with only its
  // week. The missing figure is unknown, not zero: the policy holds on it.
  const partial = reading("claude", [{ label: "7d", used: 90, budget: "weekly" }]);
  assert.equal(isTight(partial, "session", 70), false);
  assert.equal(isTight(partial, "weekly", 70), true);
});
