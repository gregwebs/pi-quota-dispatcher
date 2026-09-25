import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type Decision,
  type DispatcherConfig,
  type Rail,
  type RailState,
  type RailWindow,
  DEFAULT_CONFIG,
  budgetUsed,
  createDispatcher,
  decide,
  parseClaudeUsage,
  parseCodexUsage,
  upsertModel,
} from "../src/index.ts";

// ---------------------------------------------------------------- parsing

test("parseClaudeUsage classifies the session budget apart from the week", () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 0 },
    seven_day: { utilization: 27 },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 12 },
  });
  assert.deepEqual(windows, [
    { label: "5h", used: 0, budget: "session" },
    { label: "7d", used: 27, budget: "weekly" },
    { label: "7d Sonnet", used: 12, budget: "weekly" },
  ]);
});

test("parseClaudeUsage gives every window a distinct label", () => {
  const windows = parseClaudeUsage({
    seven_day_opus: { utilization: 1 },
    seven_day_omelette: { utilization: 2 },
  });
  const labels = windows.map((w) => w.label);
  assert.equal(new Set(labels).size, labels.length, `duplicate label among ${labels.join(", ")}`);
});

test("parseClaudeUsage returns nothing when no window carries a number", () => {
  assert.deepEqual(parseClaudeUsage({ seven_day: { utilization: null } }), []);
  assert.deepEqual(parseClaudeUsage(undefined), []);
});

test("parseCodexUsage classifies both windows and surfaces limit_reached", () => {
  const { windows, limited } = parseCodexUsage({
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 64 },
    },
  });
  assert.deepEqual(windows, [
    { label: "5h", used: 0, budget: "session" },
    { label: "7d", used: 64, budget: "weekly" },
  ]);
  assert.equal(limited, false);
});

test("parseCodexUsage labels each window from its advertised length", () => {
  const { windows } = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 9, limit_window_seconds: 18000, reset_after_seconds: 17135 },
      secondary_window: { used_percent: 65, limit_window_seconds: 604800, reset_after_seconds: 408848 },
    },
  });
  assert.deepEqual(windows, [
    { label: "5h", used: 9, budget: "session", resetsInSeconds: 17135 },
    { label: "7d", used: 65, budget: "weekly", resetsInSeconds: 408848 },
  ]);
});

test("parseCodexUsage reports limit_reached=true", () => {
  const { limited } = parseCodexUsage({ rate_limit: { limit_reached: true } });
  assert.equal(limited, true);
});

// ---------------------------------------------------------------- frontmatter

const AGENT = `---
name: reviewer
description: Reviews code.
tools: read, grep
model: "openai-codex/gpt-6-astra"
# model: "claude-bridge/claude-opus-5-5"
thinking: high
fallbackModels:
  - model: "claude-bridge/claude-opus-5-5"
---

Body text mentioning model: not frontmatter.
`;

test("upsertModel rewrites only the active model line", () => {
  const out = upsertModel(AGENT, "claude-bridge/claude-opus-5-5");
  assert.ok(out);
  assert.match(out, /^model: "claude-bridge\/claude-opus-5-5"$/m);
  // The commented alternative and the fallbackModels block survive verbatim.
  assert.match(out, /^# model: "claude-bridge\/claude-opus-5-5"$/m);
  assert.match(out, /^fallbackModels:$/m);
  assert.match(out, /^  - model: "claude-bridge\/claude-opus-5-5"$/m);
  // Body is untouched.
  assert.match(out, /Body text mentioning model: not frontmatter\./);
});

test("upsertModel is idempotent", () => {
  const once = upsertModel(AGENT, "deepseek/deepseek-flash");
  const twice = upsertModel(once!, "deepseek/deepseek-flash");
  assert.equal(once, twice);
});

test("upsertModel does not mistake fallbackModels for the model key", () => {
  const src = `---\nname: x\nfallbackModels:\n  - model: "a/b"\n---\n`;
  const out = upsertModel(src, "c/d");
  assert.ok(out);
  assert.match(out, /^model: "c\/d"$/m);
  assert.match(out, /^  - model: "a\/b"$/m);
});

test("upsertModel inserts a model line when only commented ones exist", () => {
  const src = `---\nname: x\n# model: "a/b"\nthinking: high\n---\n`;
  const out = upsertModel(src, "c/d");
  assert.ok(out);
  assert.match(out, /^model: "c\/d"$/m);
  assert.match(out, /^# model: "a\/b"$/m);
});

test("upsertModel returns null without usable frontmatter", () => {
  assert.equal(upsertModel("no frontmatter here", "a/b"), null);
  assert.equal(upsertModel("---\nname: x\n", "a/b"), null);
});

// ---------------------------------------------------------------- policy

/** One rail's readings, as a policy test wants to describe them. */
interface Readings {
  session?: number;
  weekly?: number;
  ok?: boolean;
  note?: string;
}

function railState(rail: Rail, r: Readings = {}): RailState {
  if (r.ok === false) return { rail, ok: false, windows: [], note: r.note };
  const windows: RailWindow[] = [];
  if (r.session !== undefined) windows.push({ label: "5h", used: r.session, budget: "session" });
  if (r.weekly !== undefined) windows.push({ label: "7d", used: r.weekly, budget: "weekly" });
  return { rail, ok: true, windows, ...(r.note ? { note: r.note } : {}) };
}

function rails(claude: Readings, codex: Readings): Map<Rail, RailState> {
  return new Map<Rail, RailState>([
    ["claude", railState("claude", claude)],
    ["codex", railState("codex", codex)],
    // No windows at all: metered, hence uncapped.
    ["deepseek", railState("deepseek", { note: "metered" })],
  ]);
}

const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/agents" };

/**
 * Narrow an assign-decision, failing loudly if the dispatcher held instead.
 * A hold deliberately carries no model, so this is the only honest way to read
 * the assigned one.
 */
function assignedModel(d: Decision): string {
  assert.equal(d.kind, "assign", `expected an assignment, got a hold: ${d.why}`);
  return d.kind === "assign" ? d.model : "";
}

function plannerDecision(claude: Readings, codex: Readings): Decision {
  return decide("planner", DEFAULT_CONFIG.routes.planner, rails(claude, codex), cfg);
}

test("budgetUsed takes the worst window within a budget, not across budgets", () => {
  const state: RailState = {
    rail: "claude",
    ok: true,
    windows: [
      { label: "5h", used: 0, budget: "session" },
      { label: "7d", used: 27, budget: "weekly" },
      { label: "7d Sonnet", used: 91, budget: "weekly" },
    ],
  };
  assert.equal(budgetUsed(state, "session"), 0);
  assert.equal(budgetUsed(state, "weekly"), 91);
});

test("decide assigns the primary while both rails have headroom", () => {
  const d = plannerDecision({ session: 0, weekly: 27 }, { session: 0, weekly: 64 });
  assert.equal(d.kind, "assign");
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("decide moves planner off claude when the session budget is tight", () => {
  const d = plannerDecision({ session: 90 }, { session: 10 });
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
  assert.match(d.why, /session 90% >= 75%/);
});

test("decide moves reviewer off codex when the session budget is tight", () => {
  const d = decide("reviewer", DEFAULT_CONFIG.routes.reviewer, rails({ session: 10 }, { session: 90 }), cfg);
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

// The defect this replaces: pressure was the worst window across *both*
// budgets, so a weekly figure above sessionSwitchAt moved a rail with a
// completely full session budget — and the weekly does not recover for days.
test("a weekly reading alone does not move a rail with session headroom", () => {
  const d = plannerDecision({ session: 0, weekly: 80 }, { session: 0, weekly: 5 });
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("the weekly budget only fires at its own, higher threshold", () => {
  const below = plannerDecision({ session: 0, weekly: 89 }, { session: 0, weekly: 5 });
  assert.equal(assignedModel(below), "claude-bridge/claude-opus-5-5");

  const above = plannerDecision({ session: 0, weekly: 92 }, { session: 0, weekly: 5 });
  assert.equal(assignedModel(above), "openai-codex/gpt-6-sol");
  assert.match(above.why, /weekly 92% >= 90%/);
});

test("a tight weekly is compared against the alternate's weekly, not its session", () => {
  // Claude's week is nearly spent. Codex has a full session budget but a busier
  // week than Claude, so weekly-to-weekly it is not healthier and we stay put.
  const d = plannerDecision({ session: 0, weekly: 95 }, { session: 0, weekly: 88 });
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
  assert.match(d.why, /within margin/);
});

test("decide does not switch when the margin is not met", () => {
  // codex 85 is >= sessionSwitchAt but only 5 points below claude's 90.
  const reviewer = decide("reviewer", DEFAULT_CONFIG.routes.reviewer, rails({ session: 90 }, { session: 85 }), cfg);
  assert.equal(assignedModel(reviewer), "openai-codex/gpt-6-astra");
  assert.match(reviewer.why, /within margin/);

  const planner = plannerDecision({ session: 90 }, { session: 85 });
  assert.equal(assignedModel(planner), "claude-bridge/claude-opus-5-5");
});

test("decide switches on a session budget of 100", () => {
  const d = decide("reviewer", DEFAULT_CONFIG.routes.reviewer, rails({ session: 10 }, { session: 100 }), cfg);
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("the session budget is the one reported when both are tight", () => {
  const d = plannerDecision({ session: 80, weekly: 99 }, { session: 1, weekly: 1 });
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
  assert.match(d.why, /session 80% >= 75%/);
});

test("a metered primary is never tight, so it is left where it is", () => {
  const d = decide("implementer", DEFAULT_CONFIG.routes.implementer, rails({ session: 99 }, { session: 99 }), cfg);
  assert.equal(assignedModel(d), "deepseek/deepseek-flash");
});

// A hold is not "assign the primary". These decisions carry no model at all,
// because naming one is what let an unreadable quota drag agents back onto the
// rail that was under pressure.
test("decide makes no assignment when the primary rail is unreadable", () => {
  const d = plannerDecision({ ok: false, note: "HTTP 401" }, { session: 1 });
  assert.equal(d.kind, "hold");
  assert.match(d.why, /unreadable/);
});

test("decide makes no assignment when the alternate rail is unreadable", () => {
  const d = plannerDecision({ session: 99 }, { ok: false, note: "HTTP 500" });
  assert.equal(d.kind, "hold");
});

// ---------------------------------------------------------------- dispatcher

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

interface Fixture {
  agentDir: string;
  claudeCredsPath: string;
  piAuthPath: string;
}

/**
 * A fixture has to stand alone: it provides agent files *and* fake credential
 * files.
 *
 * The dispatcher reads credentials before it ever touches the network, so a
 * fixture that only stubbed `fetch` would silently fall through to the
 * developer's real `~/.claude/.credentials.json` and `~/.pi/agent/auth.json`.
 * That passes on a developer machine and fails on CI, where those files do not
 * exist and the rail is correctly reported unreadable.
 */
async function fixture(models: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-"));
  const agentDir = join(root, "agents");
  await mkdir(agentDir, { recursive: true });
  for (const [name, model] of Object.entries(models)) {
    await writeFile(join(agentDir, `${name}.md`), TEMPLATE(name, model), "utf8");
  }

  const claudeCredsPath = join(root, "claude-credentials.json");
  await writeFile(
    claudeCredsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
    }),
    "utf8",
  );

  const piAuthPath = join(root, "pi-auth.json");
  await writeFile(
    piAuthPath,
    JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct-test" } }),
    "utf8",
  );

  return { agentDir, claudeCredsPath, piAuthPath };
}

/** Readings the stub endpoints should report, per rail. */
interface StubReadings {
  claude?: { session?: number; weekly?: number };
  codex?: { session?: number; weekly?: number };
  codexLimited?: boolean;
}

function stubFetch(opts: StubReadings = {}) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("anthropic.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: opts.claude?.session ?? 0 },
          seven_day: { utilization: opts.claude?.weekly ?? 0 },
        }),
      };
    }
    if (u.includes("chatgpt.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            limit_reached: opts.codexLimited ?? false,
            primary_window: {
              used_percent: opts.codex?.session ?? 0,
              limit_window_seconds: 18000,
              reset_after_seconds: 3600,
            },
            secondary_window: {
              used_percent: opts.codex?.weekly ?? 0,
              limit_window_seconds: 604800,
              reset_after_seconds: 400000,
            },
          },
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

function dispatcherFor(fx: Fixture, opts: StubReadings = {}) {
  return createDispatcher({ ...DEFAULT_CONFIG, ...fx }, { fetchImpl: stubFetch(opts) });
}

test("a dry run reports would-write and leaves files alone", async () => {
  const fx = await fixture({
    planner: "claude-bridge/claude-opus-5-5",
    reviewer: "openai-codex/gpt-6-astra",
    implementer: "deepseek/deepseek-flash",
  });
  const d = dispatcherFor(fx, { claude: { session: 90 }, codex: { session: 10 } });

  const results = await d.evaluate({ force: true, dry: true });
  const byAgent = Object.fromEntries(results.map((r) => [r.decision.agent, r.outcome]));

  assert.equal(byAgent.planner, "would-write");
  assert.equal(byAgent.reviewer, "unchanged");
  assert.equal(byAgent.implementer, "unchanged");

  const planner = await readFile(join(fx.agentDir, "planner.md"), "utf8");
  assert.match(planner, /^model: "claude-bridge\/claude-opus-5-5"$/m);
});

test("a real run rewrites the frontmatter and nothing else", async () => {
  const fx = await fixture({
    planner: "claude-bridge/claude-opus-5-5",
    reviewer: "openai-codex/gpt-6-astra",
    implementer: "deepseek/deepseek-flash",
  });
  const d = dispatcherFor(fx, { claude: { session: 90 }, codex: { session: 10 } });

  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;
  assert.equal(planner.outcome, "written");

  const after = await readFile(join(fx.agentDir, "planner.md"), "utf8");
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
  assert.match(after, /^thinking: high$/m);
  assert.match(after, /^Body\.$/m);

  // Untouched agents are byte-identical.
  const reviewer = await readFile(join(fx.agentDir, "reviewer.md"), "utf8");
  assert.equal(reviewer, TEMPLATE("reviewer", "openai-codex/gpt-6-astra"));
});

test("re-evaluation is idempotent and reports unchanged", async () => {
  const fx = await fixture({ planner: "openai-codex/gpt-6-sol" });
  const d = dispatcherFor(fx, { claude: { session: 90 }, codex: { session: 10 } });
  const results = await d.evaluate({ force: true });
  assert.equal(results.find((r) => r.decision.agent === "planner")!.outcome, "unchanged");
});

test("a missing agent file is skipped, not created", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const d = dispatcherFor(fx);
  const results = await d.evaluate({ force: true });
  const impl = results.find((r) => r.decision.agent === "implementer")!;
  assert.equal(impl.outcome, "skipped (no file)");
});

test("an unreadable api holds every agent in place", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const failing = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx },
    {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    },
  );
  const lines = await failing.report({ force: true });
  assert.ok(lines.some((l) => l.includes("planner -> (left as is)")));
  assert.ok(lines.some((l) => l.includes("[held]")));
  assert.ok(lines.some((l) => l.includes("unreadable")));
});

test("limit_reached on codex moves the reviewer onto claude", async () => {
  const fx = await fixture({ reviewer: "openai-codex/gpt-6-astra" });
  const d = dispatcherFor(fx, { codex: { session: 20 }, codexLimited: true });
  const results = await d.evaluate({ force: true });
  const reviewer = results.find((r) => r.decision.agent === "reviewer")!;
  assert.equal(assignedModel(reviewer.decision), "claude-bridge/claude-opus-5-5");
  assert.equal(reviewer.outcome, "written");
});

/**
 * Regression guard for a fixture that leaked: these tests used to read the
 * developer's real ~/.claude/.credentials.json, so the switch cases passed
 * locally by accident and failed on CI, where no such file exists and the rail
 * is correctly reported unreadable.
 */
test("a missing credential file holds every agent, even when a switch looks due", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeCredsPath: join(fx.agentDir, "absent.json") },
    { fetchImpl: stubFetch({ claude: { session: 95 } }) },
  );
  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;

  assert.equal(planner.decision.kind, "hold");
  assert.equal(planner.outcome, "held");
  assert.match(planner.decision.why, /unreadable/);
});

/**
 * Regression: "hold" used to be spelled by naming the primary, so an
 * unreadable quota rewrote any agent a previous evaluation had moved onto the
 * alternate — dragging work back onto the rail that was under pressure.
 */
test("an unreadable quota leaves an agent on the alternate untouched", async () => {
  const fx = await fixture({ planner: "openai-codex/gpt-6-sol" });
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeCredsPath: join(fx.agentDir, "absent.json") },
    { fetchImpl: stubFetch({ claude: { session: 95 } }) },
  );

  const path = join(fx.agentDir, "planner.md");
  const before = await readFile(path, "utf8");
  const results = await d.evaluate({ force: true });
  const after = await readFile(path, "utf8");

  assert.equal(results.find((r) => r.decision.agent === "planner")!.outcome, "held");
  assert.equal(after, before, "a hold must not touch the file");
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
});

/**
 * Regression: `report` used to forward a `dry` flag into `evaluate`, so the
 * plain `/quota-dispatch` "show me the state" command silently rewrote agent
 * files whenever a switch happened to be due.
 */
test("report never writes, even when a switch is due", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const d = dispatcherFor(fx, { claude: { session: 90 }, codex: { session: 10 } }); // claude tight: a switch to codex is due

  const path = join(fx.agentDir, "planner.md");
  const before = await readFile(path, "utf8");
  const lines = await d.report({ force: true });
  const after = await readFile(path, "utf8");

  assert.equal(after, before, "report must be read-only");
  // It still reports what a real evaluation would do.
  assert.ok(lines.some((l) => l.includes("planner -> openai-codex/gpt-6-sol")));
  assert.ok(lines.some((l) => l.includes("[would-write]")));
});

test("a forced report fetches each rail exactly once", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  let calls = 0;
  const inner = stubFetch({}) as unknown as (u: unknown) => Promise<unknown>;
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx },
    {
      fetchImpl: (async (url: string | URL) => {
        calls++;
        return inner(url);
      }) as unknown as typeof fetch,
    },
  );

  await d.report({ force: true });
  assert.equal(calls, 2, "the two live rails, once each");
});

test("an expired claude token counts as unreadable rather than switching", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  await writeFile(
    fx.claudeCredsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() - 1000 } }),
    "utf8",
  );
  const d = dispatcherFor(fx, { claude: { session: 95 } });
  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;

  assert.equal(planner.decision.kind, "hold");
  assert.match(planner.decision.why, /unreadable/);
});

// ---------------------------------------------------------------- real config

test("the shipped routes reference agents that all exist on disk by convention", () => {
  for (const agent of Object.keys(DEFAULT_CONFIG.routes)) {
    assert.match(agent, /^[a-z][a-z0-9-]*$/);
  }
  for (const route of Object.values(DEFAULT_CONFIG.routes)) {
    assert.ok(route.primary.model.includes("/"));
    if (route.alternate) assert.ok(route.alternate.model.includes("/"));
  }
});
