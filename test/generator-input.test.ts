import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GENERATOR_INPUT_VERSION,
  type GeneratorInput,
  type GeneratorInputOutcome,
  type GeneratorReadingInput,
} from "../src/generator.ts";
import {
  generatorInput,
  type FailedReading,
  type GoodReading,
  type KnownReadings,
  type MeteredReading,
  type VendorRail,
  type VendorRailReadings,
} from "../src/index.ts";

// ---------------------------------------------------------------- readings

// Distinct instants, none on a whole second, so a field taken from the wrong
// reading — or rounded, or left in epoch milliseconds — cannot match by luck.
const CLAUDE_AT = Date.UTC(2025, 1, 3, 9, 14, 22, 431);
const CODEX_AT = Date.UTC(2025, 1, 3, 9, 20, 7, 902);
const FAILED_AT = Date.UTC(2025, 1, 3, 9, 31, 45, 118);
const iso = (ms: number) => new Date(ms).toISOString();

const CLAUDE_RAW = {
  account: { email: "private-reading@example.invalid" },
  five_hour: { utilization: 42, resets_at: "2025-02-03T12:30:00.000+00:00" },
  seven_day: { utilization: 11 },
};

const CLAUDE_GOOD: GoodReading = {
  rail: "claude",
  ok: true,
  readAt: CLAUDE_AT,
  windows: [
    { label: "5h", used: 42, budget: "session", resetsAt: Date.UTC(2025, 1, 3, 12, 30) },
    { label: "7d", used: 11, budget: "weekly" },
    // A window no parser classifies today — `RailWindow.budget` is optional — so
    // the projection is exercised on the display-only shape the type admits.
    { label: "display-only", used: 5 },
  ],
  raw: CLAUDE_RAW,
};

const CODEX_RAW = {
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 3, limit_window_seconds: 604800 },
  },
};

const CODEX_GOOD: GoodReading = {
  rail: "codex",
  ok: true,
  readAt: CODEX_AT,
  windows: [
    { label: "5h", used: 7, budget: "session", resetsAt: CODEX_AT + 3_600_000 },
    { label: "7d", used: 3, budget: "weekly" },
  ],
  raw: CODEX_RAW,
};

const DEEPSEEK: MeteredReading = { rail: "deepseek", ok: true, windows: [], metered: true, note: "metered" };

function failed(rail: VendorRail, note: string, readAt = FAILED_AT): FailedReading {
  return { rail, ok: false, windows: [], readAt, note };
}

/** A rail whose latest read succeeded: its own last good reading, as the cache pairs them. */
function healthy(reading: GoodReading): VendorRailReadings {
  return { latest: reading, lastGood: reading };
}

function known(claude: VendorRailReadings, codex: VendorRailReadings): KnownReadings {
  return { claude, codex, deepseek: { latest: DEEPSEEK } };
}

function ready(outcome: GeneratorInputOutcome): GeneratorInput {
  assert.equal(outcome.kind, "ready", outcome.kind === "refused" ? outcome.reason.join("\n") : "");
  assert.ok(outcome.kind === "ready");
  return outcome.input;
}

function refused(outcome: GeneratorInputOutcome): readonly string[] {
  assert.equal(outcome.kind, "refused", "a capped rail with no success must refuse the run");
  assert.ok(outcome.kind === "refused");
  return outcome.reason;
}

function vendorEntry(input: GeneratorInput, rail: VendorRail): GeneratorReadingInput {
  const entry = input.rails[rail];
  assert.ok(!("metered" in entry), `${rail} must be sent as a reading, not as metered`);
  return entry;
}

/** The only keys a capped rail's entry may carry: facts, and never a `tight` verdict. */
const READING_KEYS = new Set(["ok", "readAt", "windows", "raw", "note", "latestFailure"]);
const WINDOW_KEYS = new Set(["label", "used", "budget", "resetsAt"]);

function assertFactsOnly(input: GeneratorInput): void {
  for (const rail of ["claude", "codex"] as const) {
    const entry = vendorEntry(input, rail);
    for (const key of Object.keys(entry)) assert.ok(READING_KEYS.has(key), `${rail} carries an unexpected key "${key}"`);
    for (const window of entry.windows) {
      for (const key of Object.keys(window)) {
        assert.ok(WINDOW_KEYS.has(key), `${rail} window ${window.label} carries an unexpected key "${key}"`);
      }
    }
  }
}

// ---------------------------------------------------------------- type-level guards

// Compile-negative guards: if either assignment ever compiles, `npm run
// typecheck` fails on the unnecessary suppression. `KnownReadings` is keyed per
// rail precisely so a consumer needs no "claude is metered" or "deepseek was
// read" case; these pin that its arms cannot be swapped.
const claudeAsMetered: KnownReadings = {
  // @ts-expect-error a vendor rail cannot hold the metered arm
  claude: { latest: DEEPSEEK },
  codex: healthy(CODEX_GOOD),
  deepseek: { latest: DEEPSEEK },
};
const deepseekAsRead: KnownReadings = {
  claude: healthy(CLAUDE_GOOD),
  codex: healthy(CODEX_GOOD),
  // @ts-expect-error the metered rail cannot hold a vendor reading
  deepseek: healthy({ ...CODEX_GOOD, rail: "deepseek" }),
};
void claudeAsMetered;
void deepseekAsRead;

// ---------------------------------------------------------------- the document

test("the document is version 1 and names every rail, even the metered one", () => {
  const input = ready(generatorInput(known(healthy(CLAUDE_GOOD), healthy(CODEX_GOOD))));
  assert.equal(GENERATOR_INPUT_VERSION, 1);
  assert.equal(input.version, 1);
  assert.deepEqual(Object.keys(input).sort(), ["rails", "version"]);
  assert.deepEqual(Object.keys(input.rails).sort(), ["claude", "codex", "deepseek"]);
  // A document a subprocess reads is JSON: nothing in it may be lost or changed
  // by serialization (a Date, an `undefined` key, a Map).
  assert.deepEqual(JSON.parse(JSON.stringify(input)), input);
});

test("the metered rail is exactly the documented placeholder", () => {
  const input = ready(generatorInput(known(healthy(CLAUDE_GOOD), healthy(CODEX_GOOD))));
  // Not `ok`, and not the internal `"metered"` note `MeteredReading` carries for
  // the report: the wire form is the contract's three keys and nothing else.
  assert.deepEqual(input.rails.deepseek, { metered: true, windows: [], raw: null });
});

test("a good latest is sent with ISO times, its windows as reported, and its raw body", () => {
  const input = ready(generatorInput(known(healthy(CLAUDE_GOOD), healthy(CODEX_GOOD))));
  // Whole-object equality, so a `latestFailure: undefined` or `note: undefined`
  // key, or a `null` where a window had no budget, fails here: strict deep
  // equality compares the keys, not just the values.
  assert.deepEqual(input.rails.claude, {
    ok: true,
    readAt: "2025-02-03T09:14:22.431Z",
    windows: [
      { label: "5h", used: 42, budget: "session", resetsAt: "2025-02-03T12:30:00.000Z" },
      { label: "7d", used: 11, budget: "weekly" },
      { label: "display-only", used: 5 },
    ],
    // Verbatim, account details included: the generator is the reader `raw` is
    // kept for, and the windows are not a substitute for it.
    raw: CLAUDE_RAW,
  });
  assert.deepEqual(input.rails.codex, {
    ok: true,
    readAt: iso(CODEX_AT),
    windows: [
      { label: "5h", used: 7, budget: "session", resetsAt: iso(CODEX_AT + 3_600_000) },
      { label: "7d", used: 3, budget: "weekly" },
    ],
    raw: CODEX_RAW,
  });
  assert.ok(!("latestFailure" in input.rails.claude), "a good latest has no failure to report");
});

test("a window at the epoch keeps its zero reset and its zero usage", () => {
  // `0` is a real instant and a real percentage. A spread guarded by truthiness
  // rather than by `!== undefined` would drop both, and the generator would be
  // told the vendor never said when the window clears.
  const atEpoch: GoodReading = {
    ...CLAUDE_GOOD,
    readAt: 0,
    windows: [{ label: "5h", used: 0, budget: "session", resetsAt: 0 }],
  };
  const entry = vendorEntry(ready(generatorInput(known(healthy(atEpoch), healthy(CODEX_GOOD)))), "claude");
  assert.equal(entry.readAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(entry.windows, [{ label: "5h", used: 0, budget: "session", resetsAt: "1970-01-01T00:00:00.000Z" }]);
});

test("a failed latest sends the last good reading, marked with the failure", () => {
  const failure = failed("codex", "HTTP 429");
  const input = ready(generatorInput(known(healthy(CLAUDE_GOOD), { latest: failure, lastGood: CODEX_GOOD })));
  // `readAt` is the *sent* reading's: the failure's instant goes only in the
  // marker, so a generator can tell how old the numbers it is reading are.
  assert.deepEqual(input.rails.codex, {
    ok: true,
    readAt: iso(CODEX_AT),
    windows: [
      { label: "5h", used: 7, budget: "session", resetsAt: iso(CODEX_AT + 3_600_000) },
      { label: "7d", used: 3, budget: "weekly" },
    ],
    raw: CODEX_RAW,
    latestFailure: { at: iso(FAILED_AT), note: "HTTP 429" },
  });
  // The marker is per rail: the healthy one beside it is not tarred with it.
  assert.ok(!("latestFailure" in input.rails.claude));
});

test("a good reading's note is carried, and never confused with the failure's", () => {
  // Under `limit_reached` every window reads 100 over the vendor's lower
  // percentages; without the note the document would contradict its own `raw`.
  const limited: GoodReading = {
    ...CODEX_GOOD,
    windows: [
      { label: "5h", used: 100, budget: "session" },
      { label: "7d", used: 100, budget: "weekly" },
    ],
    note: "limit_reached=true",
  };
  const fresh = vendorEntry(ready(generatorInput(known(healthy(CLAUDE_GOOD), healthy(limited)))), "codex");
  assert.equal(fresh.note, "limit_reached=true");
  assert.ok(!("latestFailure" in fresh));

  // The same reading standing in for a failed read: `note` is still the sent
  // reading's own, and the failure's note goes only in the marker.
  const behindFailure = vendorEntry(
    ready(generatorInput(known(healthy(CLAUDE_GOOD), {
      latest: failed("codex", "HTTP 500 after 2 attempts"),
      lastGood: limited,
    }))),
    "codex",
  );
  assert.equal(behindFailure.note, "limit_reached=true");
  assert.deepEqual(behindFailure.latestFailure, { at: iso(FAILED_AT), note: "HTTP 500 after 2 attempts" });

  // And a last good reading with no note of its own does not borrow the
  // failure's: there is no `note` key at all.
  const plain = vendorEntry(
    ready(generatorInput(known({ latest: failed("claude", "HTTP 401"), lastGood: CLAUDE_GOOD }, healthy(CODEX_GOOD)))),
    "claude",
  );
  assert.ok(!("note" in plain), `the failure's note leaked into the reading: ${JSON.stringify(plain)}`);
  assert.deepEqual(plain.latestFailure, { at: iso(FAILED_AT), note: "HTTP 401" });
});

test("no rail entry carries a judgment, whatever the readings say", () => {
  // Readings a policy would call tight on every budget. The document still
  // states only what was read: the thresholds are the generator's to choose.
  const full: GoodReading = {
    ...CLAUDE_GOOD,
    windows: [
      { label: "5h", used: 100, budget: "session", resetsAt: CLAUDE_AT + 60_000 },
      { label: "7d", used: 99, budget: "weekly" },
    ],
  };
  for (const readings of [
    known(healthy(full), healthy(CODEX_GOOD)),
    known({ latest: failed("claude", "HTTP 500 after 2 attempts"), lastGood: full }, healthy(CODEX_GOOD)),
    known(healthy(CLAUDE_GOOD), { latest: failed("codex", "HTTP 429"), lastGood: { ...CODEX_GOOD, note: "limit_reached=true" } }),
  ]) {
    assertFactsOnly(ready(generatorInput(readings)));
  }
});

// ---------------------------------------------------------------- refusal

test("claude with no success ever refuses the run, naming the rail and why", () => {
  const reason = refused(generatorInput(known({ latest: failed("claude", "no Claude credentials") }, healthy(CODEX_GOOD))));
  assert.ok(
    reason.some((line) => line.includes("claude") && line.includes("no Claude credentials")),
    reason.join("\n"),
  );
  assert.ok(!reason.some((line) => line.trimStart().startsWith("codex")), `a healthy codex is not a reason: ${reason.join("\n")}`);
});

test("codex with no success ever refuses the run, and only codex is named as a reason", () => {
  const reason = refused(generatorInput(known(healthy(CLAUDE_GOOD), { latest: failed("codex", "no pi auth file") })));
  assert.ok(reason.some((line) => line.includes("codex") && line.includes("no pi auth file")), reason.join("\n"));
  assert.ok(!reason.some((line) => line.trimStart().startsWith("claude")), `a healthy claude is not a reason: ${reason.join("\n")}`);
});

test("both capped rails failing are both reported, claude first", () => {
  const reason = refused(generatorInput(known(
    { latest: failed("claude", "HTTP 401") },
    { latest: failed("codex", "no pi auth file") },
  )));
  const claudeLine = reason.findIndex((line) => line.includes("claude") && line.includes("HTTP 401"));
  const codexLine = reason.findIndex((line) => line.includes("codex") && line.includes("no pi auth file"));
  assert.notEqual(claudeLine, -1, `claude's reason is missing: ${reason.join("\n")}`);
  assert.notEqual(codexLine, -1, `codex's reason is missing — only the first failing rail was reported: ${reason.join("\n")}`);
  assert.ok(claudeLine < codexLine, reason.join("\n"));
});

test("a failed latest with a last good reading is not a refusal", () => {
  // The refusal is "no success, ever", not "the newest read failed": the last
  // good reading is exactly what stands in for the failure.
  const outcome = generatorInput(known(
    { latest: failed("claude", "HTTP 500 after 2 attempts"), lastGood: CLAUDE_GOOD },
    { latest: failed("codex", "HTTP 429"), lastGood: CODEX_GOOD },
  ));
  const input = ready(outcome);
  assert.equal(vendorEntry(input, "claude").latestFailure?.note, "HTTP 500 after 2 attempts");
  assert.equal(vendorEntry(input, "codex").latestFailure?.note, "HTTP 429");
});

test("the refusal reason is exactly the header, the failing rail's line and the advice", () => {
  // Pinned whole, in order, not by substring: the advice line is the only thing
  // telling the user how to clear the refusal, and a substring check on the
  // lines that remain would not notice it being dropped or moved.
  assert.deepEqual(
    refused(generatorInput(known(healthy(CLAUDE_GOOD), { latest: failed("codex", "no pi auth file") }))),
    [
      "the generator was not run: a quota-capped rail has no successful reading yet.",
      "the codex rail has no valid reading yet (no pi auth file).",
      "Run /quota-dispatch refresh once the rail can be read, then generate again.",
    ],
  );
});
