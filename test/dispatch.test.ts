import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type DispatcherConfig,
  type Rail,
  type RailState,
  DEFAULT_CONFIG,
  createDispatcher,
  decide,
  parseClaudeUsage,
  parseCodexUsage,
  upsertModel,
} from "../src/index.ts";

// ---------------------------------------------------------------- parsing

test("parseClaudeUsage extracts windows and ignores absent ones", () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 0 },
    seven_day: { utilization: 27 },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 12 },
  });
  assert.deepEqual(windows, [
    { label: "5h", used: 0 },
    { label: "7d", used: 27 },
    { label: "7d Sonnet", used: 12 },
  ]);
});

test("parseClaudeUsage returns nothing when no window carries a number", () => {
  assert.deepEqual(parseClaudeUsage({ seven_day: { utilization: null } }), []);
  assert.deepEqual(parseClaudeUsage(undefined), []);
});

test("parseCodexUsage maps both windows and surfaces limit_reached", () => {
  const { windows, limited } = parseCodexUsage({
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 64 },
    },
  });
  assert.deepEqual(windows, [
    { label: "5h", used: 0 },
    { label: "7d", used: 64 },
  ]);
  assert.equal(limited, false);
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

function rails(claude: Partial<RailState>, codex: Partial<RailState>): Map<Rail, RailState> {
  const make = (rail: Rail, p: Partial<RailState>): RailState => ({
    rail,
    ok: true,
    pressure: 0,
    windows: [],
    ...p,
  });
  return new Map<Rail, RailState>([
    ["claude", make("claude", claude)],
    ["codex", make("codex", codex)],
    ["deepseek", make("deepseek", { pressure: 0, note: "metered" })],
  ]);
}

const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/agents" };

test("decide holds the primary while both rails have headroom", () => {
  const d = decide("planner", DEFAULT_CONFIG.routes.planner, rails({ pressure: 27 }, { pressure: 64 }), cfg);
  assert.equal(d.model, "claude-bridge/claude-opus-5-5");
});

test("decide moves planner off claude when claude is tight", () => {
  const d = decide("planner", DEFAULT_CONFIG.routes.planner, rails({ pressure: 90 }, { pressure: 10 }), cfg);
  assert.equal(d.model, "openai-codex/gpt-6-sol");
});

test("decide moves reviewer off codex when codex is tight", () => {
  const d = decide("reviewer", DEFAULT_CONFIG.routes.reviewer, rails({ pressure: 10 }, { pressure: 90 }), cfg);
  assert.equal(d.model, "claude-bridge/claude-opus-5-5");
});

test("decide does not switch when the margin is not met", () => {
  // codex 85 is >= switchAt but only 5 points below claude's 90, so < margin.
  const reviewer = decide("reviewer", DEFAULT_CONFIG.routes.reviewer, rails({ pressure: 90 }, { pressure: 85 }), cfg);
  assert.equal(reviewer.model, "openai-codex/gpt-6-astra");
  const planner = decide("planner", DEFAULT_CONFIG.routes.planner, rails({ pressure: 90 }, { pressure: 85 }), cfg);
  assert.equal(planner.model, "claude-bridge/claude-opus-5-5");
});

test("decide switches on limit_reached pressure of 100", () => {
  const d = decide("reviewer", DEFAULT_CONFIG.routes.reviewer, rails({ pressure: 10 }, { pressure: 100 }), cfg);
  assert.equal(d.model, "claude-bridge/claude-opus-5-5");
});

test("decide holds rather than flapping when the primary rail is unreadable", () => {
  const d = decide(
    "planner",
    DEFAULT_CONFIG.routes.planner,
    rails({ ok: false, pressure: Infinity, note: "HTTP 401" }, { pressure: 1 }),
    cfg,
  );
  assert.equal(d.model, "claude-bridge/claude-opus-5-5");
  assert.match(d.why, /unreadable/);
});

test("decide holds when the alternate rail is unreadable", () => {
  const d = decide(
    "planner",
    DEFAULT_CONFIG.routes.planner,
    rails({ pressure: 99 }, { ok: false, pressure: Infinity, note: "HTTP 500" }),
    cfg,
  );
  assert.equal(d.model, "claude-bridge/claude-opus-5-5");
});

// ---------------------------------------------------------------- dispatcher

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

async function fixture(models: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "pqd-"));
  for (const [name, model] of Object.entries(models)) {
    await writeFile(join(dir, `${name}.md`), TEMPLATE(name, model), "utf8");
  }
  return dir;
}

function stubFetch(claudeUsed: number, codexUsed: number, codexLimited = false) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("anthropic.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: 0 }, seven_day: { utilization: claudeUsed } }),
      };
    }
    if (u.includes("chatgpt.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            limit_reached: codexLimited,
            primary_window: { used_percent: 0 },
            secondary_window: { used_percent: codexUsed },
          },
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

function dispatcherFor(dir: string, claudeUsed: number, codexUsed: number, codexLimited = false) {
  return createDispatcher(
    { ...DEFAULT_CONFIG, agentDir: dir },
    { fetchImpl: stubFetch(claudeUsed, codexUsed, codexLimited) },
  );
}

test("a dry run reports would-write and leaves files alone", async () => {
  const dir = await fixture({
    planner: "claude-bridge/claude-opus-5-5",
    reviewer: "openai-codex/gpt-6-astra",
    implementer: "deepseek/deepseek-flash",
  });
  const d = dispatcherFor(dir, 90, 10);

  const results = await d.evaluate({ force: true, dry: true });
  const byAgent = Object.fromEntries(results.map((r) => [r.decision.agent, r.outcome]));

  assert.equal(byAgent.planner, "would-write");
  assert.equal(byAgent.reviewer, "unchanged");
  assert.equal(byAgent.implementer, "unchanged");

  const planner = await readFile(join(dir, "planner.md"), "utf8");
  assert.match(planner, /^model: "claude-bridge\/claude-opus-5-5"$/m);
});

test("a real run rewrites the frontmatter and nothing else", async () => {
  const dir = await fixture({
    planner: "claude-bridge/claude-opus-5-5",
    reviewer: "openai-codex/gpt-6-astra",
    implementer: "deepseek/deepseek-flash",
  });
  const d = dispatcherFor(dir, 90, 10);

  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;
  assert.equal(planner.outcome, "written");

  const after = await readFile(join(dir, "planner.md"), "utf8");
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
  assert.match(after, /^thinking: high$/m);
  assert.match(after, /^Body\.$/m);

  // Untouched agents are byte-identical.
  const reviewer = await readFile(join(dir, "reviewer.md"), "utf8");
  assert.equal(reviewer, TEMPLATE("reviewer", "openai-codex/gpt-6-astra"));
});

test("re-evaluation is idempotent and reports unchanged", async () => {
  const dir = await fixture({ planner: "openai-codex/gpt-6-sol" });
  const d = dispatcherFor(dir, 90, 10);
  const results = await d.evaluate({ force: true });
  assert.equal(results.find((r) => r.decision.agent === "planner")!.outcome, "unchanged");
});

test("a missing agent file is skipped, not created", async () => {
  const dir = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const d = dispatcherFor(dir, 10, 10);
  const results = await d.evaluate({ force: true });
  const impl = results.find((r) => r.decision.agent === "implementer")!;
  assert.equal(impl.outcome, "skipped (no file)");
});

test("an unreadable api holds every agent in place", async () => {
  const dir = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const failing = createDispatcher(
    { ...DEFAULT_CONFIG, agentDir: dir },
    {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    },
  );
  const lines = await failing.report({ force: true });
  assert.ok(lines.some((l) => l.includes("planner -> claude-bridge/claude-opus-5-5")));
  assert.ok(lines.some((l) => l.includes("unreadable")));
});

test("limit_reached on codex moves the reviewer onto claude", async () => {
  const dir = await fixture({ reviewer: "openai-codex/gpt-6-astra" });
  const d = dispatcherFor(dir, 10, 20, true);
  const results = await d.evaluate({ force: true });
  const reviewer = results.find((r) => r.decision.agent === "reviewer")!;
  assert.equal(reviewer.decision.model, "claude-bridge/claude-opus-5-5");
  assert.equal(reviewer.outcome, "written");
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
