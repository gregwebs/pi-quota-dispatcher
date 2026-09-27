import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type AgentRoute,
  type Decision,
  type DispatcherConfig,
  type Rail,
  type RailState,
  type RailWindow,
  type ThinkingLevel,
  DEFAULT_CONFIG,
  applyDecision,
  budgetUsed,
  createDispatcher,
  decide,
  describeDecision,
  describeDecisionLines,
  parseClaudeUsage,
  parseCodexUsage,
  upsertModel,
  upsertThinking,
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

// The formatting of a model that already names the target is not a reason to
// rewrite the file. `applyDecision` keys `unchanged` off byte equality, so a
// quoted `model:` line and a bare one both have to compare equal to the target.
test("upsertModel treats a matching model as no change, quoting aside", () => {
  const quoted = `---\nname: x\nmodel: "claude-bridge/claude-opus-5-5"\n---\n`;
  assert.equal(upsertModel(quoted, "claude-bridge/claude-opus-5-5"), quoted);

  const bare = `---\nname: x\nmodel: claude-bridge/claude-opus-5-5\n---\n`;
  assert.equal(upsertModel(bare, "claude-bridge/claude-opus-5-5"), bare);

  // Single quotes are a YAML-legal way to write the same value, so they name
  // the same model and must not force a rewrite either.
  const single = `---\nname: x\nmodel: 'claude-bridge/claude-opus-5-5'\n---\n`;
  assert.equal(upsertModel(single, "claude-bridge/claude-opus-5-5"), single);
});

// The model is compared as *decoded*, so every YAML spelling of the same id — a
// trailing comment, a JSON `\/` escape — is a no-op rather than a rewrite.
test("upsertModel decodes a comment or an escape before comparing", () => {
  for (const line of [
    `model: claude-bridge/claude-opus-5-5`,
    `model: "claude-bridge/claude-opus-5-5"`,
    `model: 'claude-bridge/claude-opus-5-5'`,
    `model: claude-bridge/claude-opus-5-5 # moved here`,
    `model: "claude-bridge/claude-opus-5-5" # moved here`,
    `model: "claude-bridge\\/claude-opus-5-5"`,
  ]) {
    const src = `---\nname: x\n${line}\n---\n`;
    assert.equal(upsertModel(src, "claude-bridge/claude-opus-5-5"), src, `must be unchanged: ${line}`);
  }
});

// An ambiguous value is not evidence the file already points at the target, so
// it is rewritten rather than assumed equal.
test("upsertModel rewrites a model line it cannot decode", () => {
  for (const line of [
    `model: "claude-bridge/claude-opus-5-5`, // unterminated quote
    `model: "claude-bridge\\q/x"`, // an escape JSON rejects
  ]) {
    const src = `---\nname: x\n${line}\n---\n`;
    const out = upsertModel(src, "claude-bridge/claude-opus-5-5");
    assert.notEqual(out, src, `must be rewritten: ${line}`);
    assert.match(out ?? "", /^model: "claude-bridge\/claude-opus-5-5"$/m, line);
  }
});

// A `#` opens a comment only at line start or after whitespace, so one inside a
// model id is part of the value rather than the start of a comment.
test("upsertModel only strips a # that starts a comment", () => {
  const hashId = `---\nname: x\nmodel: weird/a#b\n---\n`;
  assert.equal(upsertModel(hashId, "weird/a#b"), hashId, "a#b is the whole value");

  const commented = `---\nname: x\nmodel: weird/a #b\n---\n`;
  assert.notEqual(upsertModel(commented, "weird/a#b"), commented, "a space before # starts a comment");
});

test("upsertModel still rewrites when the active model differs", () => {
  const src = `---\nname: x\nmodel: "claude-bridge/claude-opus-5-5"\n---\n`;
  const out = upsertModel(src, "openai-codex/gpt-6-sol");
  assert.ok(out);
  assert.match(out, /^model: "openai-codex\/gpt-6-sol"$/m);
  assert.notEqual(out, src);
});

test("upsertModel still inserts a model line when there is none", () => {
  const src = `---\nname: x\nthinking: high\n---\n`;
  const out = upsertModel(src, "openai-codex/gpt-6-sol");
  assert.ok(out);
  assert.match(out, /^model: "openai-codex\/gpt-6-sol"$/m);
});

test("applyDecision reports unchanged, and writes nothing, when only the quoting differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-unchanged-"));
  const file = join(dir, "agent.md");
  // The active line is quoted; the target is bare. They name the same model, so
  // the difference is punctuation only and the file must be left alone.
  const src = `---\nname: agent\nmodel: 'claude-bridge/claude-opus-5-5'\n---\n\nBody.\n`;
  await writeFile(file, src, "utf8");

  assert.equal(await applyDecision(file, "claude-bridge/claude-opus-5-5", undefined, false), "unchanged");
  assert.equal(await readFile(file, "utf8"), src, "an unchanged pass must not touch the file");
});

// The same decoding runs through `applyDecision`, so a commented line the
// policy already agrees with is left byte-for-byte alone.
test("applyDecision leaves a commented model line alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-unchanged-"));
  const file = join(dir, "agent.md");
  const src = `---\nname: agent\nmodel: claude-bridge/claude-opus-5-5 # pinned\n---\n\nBody.\n`;
  await writeFile(file, src, "utf8");

  assert.equal(await applyDecision(file, "claude-bridge/claude-opus-5-5", undefined, false), "unchanged");
  assert.equal(await readFile(file, "utf8"), src, "a commented line already naming the model must not change");
});

test("applyDecision reports would-write on a dry run when the model differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-unchanged-"));
  const file = join(dir, "agent.md");
  const src = `---\nname: agent\nmodel: "claude-bridge/claude-opus-5-5"\n---\n\nBody.\n`;
  await writeFile(file, src, "utf8");

  assert.equal(await applyDecision(file, "openai-codex/gpt-6-sol", undefined, true), "would-write");
  assert.equal(await readFile(file, "utf8"), src);
});

// ---------------------------------------------------------------- thinking

test("upsertThinking puts the level beside the model line", () => {
  const src = `---\nname: x\nmodel: "a/b"\ntools: read\n---\n\nBody.\n`;
  assert.equal(
    upsertThinking(src, "high"),
    `---\nname: x\nmodel: "a/b"\nthinking: high\ntools: read\n---\n\nBody.\n`,
  );
});

test("upsertThinking replaces the active level and leaves a commented one alone", () => {
  const src = `---\nname: x\n# thinking: low\nthinking: minimal\n---\n`;
  assert.equal(upsertThinking(src, "high"), `---\nname: x\n# thinking: low\nthinking: high\n---\n`);
});

test("upsertThinking writes nothing when no layer stated a level", () => {
  const src = `---\nname: x\nmodel: "a/b"\nthinking: low\n---\n\nBody.\n`;
  assert.equal(upsertThinking(src, undefined), src);
});

test("upsertThinking is idempotent and respects quoting it did not write", () => {
  const once = upsertThinking(`---\nname: x\n---\n`, "high");
  assert.equal(upsertThinking(once, "high"), once);
  // `thinking: "high"` names the same level, so the punctuation is left as it is
  // rather than rewritten into a change the pass would then report.
  const quoted = `---\nname: x\nthinking: "high"\n---\n`;
  assert.equal(upsertThinking(quoted, "high"), quoted);
});

test("upsertThinking leaves a `thinking:` in the body alone", () => {
  const src = `---\nname: x\nmodel: "a/b"\n---\n\nthinking: low in the body\n`;
  const out = upsertThinking(src, "high");
  assert.match(out, /^thinking: high$/m);
  assert.match(out, /thinking: low in the body/);
  assert.equal((out.match(/thinking:/g) ?? []).length, 2);
});

test("upsertThinking has nothing to write without usable frontmatter", () => {
  assert.equal(upsertThinking("no frontmatter here", "high"), "no frontmatter here");
  assert.equal(upsertThinking("---\nother: 1\n---\n", "high"), "---\nother: 1\n---\n");
});

test("applyDecision writes the model and its level together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-thinking-"));
  const file = join(dir, "agent.md");
  await writeFile(file, `---\nname: agent\nmodel: "a/b"\nthinking: low\n---\n\nBody.\n`, "utf8");

  assert.equal(await applyDecision(file, "openai-codex/gpt-6-sol", "high", false), "written");
  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
  assert.match(after, /^thinking: high$/m);
  assert.match(after, /Body\./);
});

test("applyDecision is unchanged when the file already says both", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-thinking-"));
  const file = join(dir, "agent.md");
  const src = `---\nname: agent\nmodel: "a/b"\nthinking: high\n---\n\nBody.\n`;
  await writeFile(file, src, "utf8");

  assert.equal(await applyDecision(file, "a/b", "high", false), "unchanged");
  assert.equal(await readFile(file, "utf8"), src);
  // The same pass with no level resolves writes nothing either — including for
  // an agent whose file already states one, which is the whole of the "no
  // restore" contract: the dispatcher has no opinion, so it does not remove it.
  assert.equal(await applyDecision(file, "a/b", undefined, false), "unchanged");
  assert.equal(await readFile(file, "utf8"), src);
});

test("a level already in the file survives a pass that resolves none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-thinking-"));
  const file = join(dir, "agent.md");
  await writeFile(file, `---\nname: agent\nmodel: "a/b"\n---\n\nBody.\n`, "utf8");

  assert.equal(await applyDecision(file, "a/b", "low", false), "written");
  assert.match(await readFile(file, "utf8"), /^thinking: low$/m);
  // A pass with no level to resolve changes the model and leaves the line where
  // it was — the one case where the file does not converge on the decision.
  // Deliberate, and documented: only a forward guarantee is made.
  assert.equal(await applyDecision(file, "c/d", undefined, false), "written");
  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "c\/d"$/m);
  assert.match(after, /^thinking: low$/m);
});

test("a level that has to be inserted lands beside the model line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-thinking-"));
  const file = join(dir, "agent.md");
  await writeFile(file, `---\nname: agent\nmodel: "a/b"\ntools: read\n---\n\nBody.\n`, "utf8");

  assert.equal(await applyDecision(file, "c/d", "max", true), "would-write");
  assert.equal(await applyDecision(file, "c/d", "max", false), "written");
  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "c\/d"\nthinking: max$/m);
  assert.match(after, /^tools: read$/m);
});

// ---------------------------------------------------------------- decision rendering

// The acceptance criterion for multi-alternate routes is about substance, not
// layout: every candidate that was passed over is named, and the reason it lost
// its place survives. The renderer is free to wrap or to put one candidate per
// line, so this asserts nothing was dropped rather than a line count.
test("describeDecisionLines drops no passed-over candidate or reason", () => {
  const decision: Decision = {
    agent: "planner",
    file: "/a/planner.md",
    kind: "assign",
    model: "openai-codex/gpt-6-sol",
    why: [
      "claude session 90% >= 75%, choosing openai-codex/gpt-6-sol on codex",
      "rejected deepseek/deepseek-flash on deepseek (weekly 100% is itself tight)",
      "openai-codex/gpt-5.6-luna on codex not consulted (lower priority than the winner)",
    ].join("\n"),
  };

  const lines = describeDecisionLines(decision, "unchanged");
  const text = lines.join("\n");

  assert.ok(lines[0].includes("[unchanged]"), lines[0]);
  assert.ok(lines[0].includes("openai-codex/gpt-6-sol"), lines[0]);

  // Each rejected/never-consulted candidate, and why it lost its place.
  assert.ok(text.includes("deepseek/deepseek-flash"), text);
  assert.ok(text.includes("weekly 100% is itself tight"), text);
  assert.ok(text.includes("gpt-5.6-luna"), text);
  assert.ok(text.includes("not consulted"), text);
});

// The rendering a reader actually sees: the level a write will use is named on
// the decision line, beside the model it applies to.
test("describeDecision names the level it will write", () => {
  const assign = (thinking?: ThinkingLevel): Decision => ({
    agent: "planner",
    file: "/a/planner.md",
    kind: "assign",
    model: "claude-bridge/claude-opus-5-5",
    ...(thinking !== undefined ? { thinking } : {}),
    why: "claude ok (session 0%, weekly 0%)",
  });

  assert.equal(describeDecision(assign("high")), "planner -> claude-bridge/claude-opus-5-5 (thinking: high)");
  // No level is not rendered as one: the line stays what it always was.
  assert.equal(describeDecision(assign()), "planner -> claude-bridge/claude-opus-5-5");

  const hold: Decision = { agent: "planner", file: "/a/planner.md", kind: "hold", why: "claude unreadable — holding" };
  assert.equal(describeDecision(hold), "planner -> (left as is)");
});

test("describeDecisionLines renders a hold as a headline plus its reasoning", () => {
  const decision: Decision = {
    agent: "planner",
    file: "/a/planner.md",
    kind: "hold",
    why: "claude unreadable (HTTP 401) — holding",
  };

  const lines = describeDecisionLines(decision, "held");
  const text = lines.join("\n");

  assert.ok(lines[0].includes("[held]"), lines[0]);
  assert.ok(text.includes("unreadable"), text);
});

// The shape the issue asked for end to end: the winner stays on the headline
// line, and every candidate the walk passed over gets its own line. The
// substance test above cannot catch this — it is handed a hand-built `why` — so
// this drives a real `decide` through the renderer, where `withNotes` is what
// puts the candidates on separate lines.
test("a real multi-alternate decision puts each passed-over candidate on its own line", () => {
  const route: AgentRoute = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [
      { model: "openai-codex/gpt-6-sol", rail: "codex" },
      { model: "openai-codex/gpt-5.6-luna", rail: "codex" },
      { model: "deepseek/deepseek-flash", rail: "deepseek" },
    ],
  };
  const decided = decide(
    "planner",
    route,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 20, weekly: 0 }),
      railState("deepseek", { session: 0, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(assignedModel(decided), "openai-codex/gpt-6-sol");

  const lines = describeDecisionLines(decided, "written");
  const headline = lines[0];
  assert.ok(headline.includes("openai-codex/gpt-6-sol"), headline);

  for (const passedOver of ["gpt-5.6-luna", "deepseek/deepseek-flash"]) {
    const on = lines.filter((l) => l.includes(passedOver));
    assert.equal(on.length, 1, `expected one line naming ${passedOver}:\n${lines.join("\n")}`);
    assert.notEqual(on[0], headline, `${passedOver} belongs on its own line, not the headline`);
  }
});

// ---------------------------------------------------------------- policy

/** One rail's readings, as a policy test wants to describe them. */
interface Readings {
  session?: number;
  weekly?: number;
  ok?: boolean;
  metered?: boolean;
  note?: string;
}

function railState(rail: Rail, r: Readings = {}): RailState {
  if (r.metered) return { rail, ok: true, windows: [], metered: true, note: r.note ?? "metered" };
  if (r.ok === false) return { rail, ok: false, windows: [], note: r.note };
  const windows: RailWindow[] = [];
  if (r.session !== undefined) windows.push({ label: "5h", used: r.session, budget: "session" });
  if (r.weekly !== undefined) windows.push({ label: "7d", used: r.weekly, budget: "weekly" });
  return { rail, ok: true, windows, ...(r.note ? { note: r.note } : {}) };
}

function railMap(...states: RailState[]): Map<Rail, RailState> {
  return new Map(states.map((s) => [s.rail, s]));
}

function rails(claude: Readings, codex: Readings): Map<Rail, RailState> {
  return railMap(
    railState("claude", claude),
    railState("codex", codex),
    // Metered, so it reports no budgets rather than unreported ones.
    railState("deepseek", { metered: true }),
  );
}

/**
 * Agent routes for the policy and dispatcher tests. The shipped config has no
 * agents, so every test that needs a route writes its own.
 */
const AGENT_ROUTES: Record<string, AgentRoute> = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  },
  reviewer: {
    primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
    alternates: [{ model: "claude-bridge/claude-opus-5-5", rail: "claude" }],
  },
  implementer: {
    primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
    alternates: [{ model: "openai-codex/gpt-6-luna", rail: "codex" }],
  },
};

const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/agents", agents: AGENT_ROUTES };

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
  return decide("planner", AGENT_ROUTES.planner, rails(claude, codex), cfg);
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

/**
 * Narrow an assign-decision to its level, failing loudly if the dispatcher held.
 * Whether the key is present at all is asserted separately, because "no opinion"
 * is the absence of the key rather than a value of `undefined`.
 */
function assignedThinking(d: Decision): ThinkingLevel | undefined {
  assert.equal(d.kind, "assign", `expected an assignment, got a hold: ${d.why}`);
  return d.kind === "assign" ? d.thinking : undefined;
}

test("an assignment carries no level when no layer states one", () => {
  const d = plannerDecision({ session: 0, weekly: 0 }, { session: 0, weekly: 0 });
  assert.equal(d.kind === "assign" && Object.hasOwn(d, "thinking"), false);
});

// The three places a level can be stated, resolved against the same decision: a
// model default is the weakest, so a route that says something about the *work*
// overrides it, and a candidate overrides both.
test("decide resolves the candidate over the route over the model", () => {
  const route: AgentRoute = {
    thinking: "medium",
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex", thinking: "off" }],
  };
  const withModelDefault: DispatcherConfig = {
    ...cfg,
    models: { "claude-bridge/claude-opus-5-5": { thinking: "low" } },
  };
  const headroom = rails({ session: 0, weekly: 0 }, { session: 0, weekly: 0 });
  const tight = rails({ session: 95, weekly: 0 }, { session: 0, weekly: 0 });

  assert.equal(assignedThinking(decide("planner", route, headroom, withModelDefault)), "medium");
  assert.equal(assignedThinking(decide("planner", route, tight, withModelDefault)), "off");

  // With no route default, the model's own entry is what is left.
  const modelOnly: AgentRoute = { ...route, thinking: undefined };
  assert.equal(assignedThinking(decide("planner", modelOnly, headroom, withModelDefault)), "low");

  // And the pinned-to-primary case resolves it the same way, with no reading.
  const pinned: AgentRoute = { thinking: "max", primary: route.primary, alternates: [] };
  assert.equal(assignedThinking(decide("planner", pinned, headroom, cfg)), "max");
});

test("a hold carries no level to write", () => {
  const d = decide("planner", AGENT_ROUTES.planner, rails({ ok: false, note: "HTTP 500" }, { session: 0, weekly: 0 }), cfg);
  assert.equal(d.kind, "hold");
  assert.equal(Object.hasOwn(d, "thinking"), false);
});

test("decide moves planner off claude when the session budget is tight", () => {
  const d = plannerDecision({ session: 90, weekly: 0 }, { session: 10, weekly: 0 });
  assert.equal(d.kind, "assign");
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
});

test("decide moves reviewer off codex when the session budget is tight", () => {
  const d = decide(
    "reviewer",
    AGENT_ROUTES.reviewer,
    rails({ session: 10, weekly: 0 }, { session: 90, weekly: 0 }),
    cfg,
  );
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
});

test("a tight weekly is compared against the alternate's weekly, not its session", () => {
  // Claude's week is nearly spent. Codex has a full session budget but a busier
  // week than Claude, so weekly-to-weekly it is not healthier and we stay put.
  const d = plannerDecision({ session: 0, weekly: 95 }, { session: 0, weekly: 88 });
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("decide does not switch when the margin is not met", () => {
  // codex 85 is >= sessionSwitchAt but only 5 points below claude's 90.
  const reviewer = decide(
    "reviewer",
    AGENT_ROUTES.reviewer,
    rails({ session: 90, weekly: 0 }, { session: 85, weekly: 0 }),
    cfg,
  );
  assert.equal(assignedModel(reviewer), "openai-codex/gpt-6-astra");

  const planner = plannerDecision({ session: 90, weekly: 0 }, { session: 85, weekly: 0 });
  assert.equal(assignedModel(planner), "claude-bridge/claude-opus-5-5");
});

// The README used to call this "at least margin" points healthier. The
// comparator is strict, so exactly `margin` is not enough.
test("exactly margin points healthier is not enough to switch", () => {
  const exactly = decide(
    "reviewer",
    AGENT_ROUTES.reviewer,
    rails({ session: 85, weekly: 0 }, { session: 95, weekly: 0 }),
    cfg,
  );
  assert.equal(assignedModel(exactly), "openai-codex/gpt-6-astra");

  const beyond = decide(
    "reviewer",
    AGENT_ROUTES.reviewer,
    rails({ session: 84, weekly: 0 }, { session: 95, weekly: 0 }),
    cfg,
  );
  assert.equal(assignedModel(beyond), "claude-bridge/claude-opus-5-5");
});

test("decide switches on a session budget of 100", () => {
  const d = decide(
    "reviewer",
    AGENT_ROUTES.reviewer,
    rails({ session: 10, weekly: 0 }, { session: 100, weekly: 0 }),
    cfg,
  );
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("the session budget is the one reported when both are tight", () => {
  const d = plannerDecision({ session: 80, weekly: 99 }, { session: 1, weekly: 1 });
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
});

test("a metered primary is never tight, so it is left where it is", () => {
  const d = decide(
    "implementer",
    AGENT_ROUTES.implementer,
    rails({ session: 99, weekly: 99 }, { session: 99, weekly: 99 }),
    cfg,
  );
  assert.equal(assignedModel(d), "deepseek/deepseek-flash");
});

// ------------------------------------------------- alternates in priority order

const MULTI: AgentRoute = {
  primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
  alternates: [
    { model: "openai-codex/gpt-6-sol", rail: "codex" },
    { model: "deepseek/deepseek-flash", rail: "deepseek" },
  ],
};

test("decide walks alternates in priority order and takes the first usable one", () => {
  // Both alternates are usable; the first in order wins, not the roomiest.
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 20, weekly: 0 }),
      railState("deepseek", { session: 0, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
  // The decision names the rejected alternate and why it lost its place.
  assert.ok(d.why.includes("deepseek/deepseek-flash"), d.why);
});

test("two alternates on one rail are told apart by model, not just rail", () => {
  // Both candidates draw on codex, so they see the same reading. Rail-only text
  // would print the same sentence twice, or name a rail the winner also sits on,
  // and the reader could not tell which candidate was passed over — which is why
  // rejections and "not consulted" notes name the model.
  const sameRail: AgentRoute = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [
      { model: "openai-codex/gpt-6-sol", rail: "codex" },
      { model: "openai-codex/gpt-5.6-luna", rail: "codex" },
    ],
  };
  const d = decide(
    "planner",
    sameRail,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 20, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
  assert.ok(d.why.includes("openai-codex/gpt-5.6-luna on codex not consulted"), d.why);
});

test("an alternate within margin is passed over for a later usable one", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 85, weekly: 0 }), // within margin: 90 - 85 = 5 <= 10
      railState("deepseek", { session: 20, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(assignedModel(d), "deepseek/deepseek-flash");
  assert.ok(d.why.includes("openai-codex/gpt-6-sol"), d.why);
});

test("an alternate tight on its other budget is passed over for a later usable one", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 20, weekly: 100 }), // itself tight on the week
      railState("deepseek", { session: 30, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(assignedModel(d), "deepseek/deepseek-flash");
  assert.ok(d.why.includes("openai-codex/gpt-6-sol"), d.why);
});

test("when every readable alternate is rejected and none is unreadable, the primary is assigned", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 85, weekly: 0 }),
      railState("deepseek", { session: 88, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
  assert.ok(d.why.includes("openai-codex/gpt-6-sol"), d.why);
  assert.ok(d.why.includes("deepseek/deepseek-flash"), d.why);
});

// ------------------------------------- empty alternates pin to the primary

test("an empty alternates list pins the agent to its primary with no readability check", () => {
  const pinned: AgentRoute = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [],
  };
  // The primary rail is unreadable; an agent with nothing else to move to is
  // still assigned, because there is nothing else the answer could be.
  const d = decide("planner", pinned, railMap(railState("claude", { ok: false, note: "HTTP 500" })), cfg);
  assert.equal(d.kind, "assign");
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("an empty alternates list assigns the primary even when no rail was read at all", () => {
  const pinned: AgentRoute = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [],
  };
  const d = decide("planner", pinned, new Map(), cfg);
  assert.equal(d.kind, "assign");
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

// ---------------------------------------------------------------- sensitivity

// A reading the dispatcher does not have must not be guessed at: it holds when
// the missing number could have changed the answer, and otherwise proceeds.

test("a readable primary below every threshold is assigned even when every alternate is unreadable", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 10, weekly: 10 }),
      railState("codex", { ok: false, note: "HTTP 500" }),
      railState("deepseek", { ok: false, note: "HTTP 500" }),
    ),
    cfg,
  );
  assert.equal(d.kind, "assign");
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("an unreadable alternate earlier in order than a usable one holds instead", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { ok: false, note: "HTTP 500" }),
      railState("deepseek", { session: 20, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(d.kind, "hold");
  assert.ok(d.why.includes("codex"), d.why);
});

// Two alternates can share a rail. A missing reading must name each model, or
// "codex unreadable" twice would not say which candidate went unread.
test("a hold names both models when two alternates share a rail", () => {
  const route: AgentRoute = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [
      { model: "openai-codex/gpt-6-sol", rail: "codex" },
      { model: "openai-codex/gpt-5.6-luna", rail: "codex" },
    ],
  };
  const d = decide(
    "planner",
    route,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { ok: false, note: "HTTP 500" }),
    ),
    cfg,
  );
  assert.equal(d.kind, "hold");
  assert.ok(d.why.includes("openai-codex/gpt-6-sol"), d.why);
  assert.ok(d.why.includes("openai-codex/gpt-5.6-luna"), d.why);
});

// A hold is still a walk report: candidates after the provisional winner were
// passed over too, and dropping them would hide why the hold did not choose one
// of them.
test("a hold still names the candidates after the provisional winner", () => {
  const route: AgentRoute = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [
      { model: "openai-codex/gpt-6-sol", rail: "codex" }, // unreadable, ahead of the winner
      { model: "deepseek/deepseek-flash", rail: "deepseek" }, // the provisional winner
      { model: "deepseek/deepseek-r1", rail: "deepseek" }, // never consulted
    ],
  };
  const d = decide(
    "planner",
    route,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { ok: false, note: "HTTP 500" }),
      railState("deepseek", { session: 0, weekly: 0 }),
    ),
    cfg,
  );
  assert.equal(d.kind, "hold");
  assert.ok(d.why.includes("openai-codex/gpt-6-sol"), d.why);
  assert.ok(d.why.includes("deepseek/deepseek-r1"), d.why);
  assert.match(d.why, /not consulted/, d.why);
});

// The asymmetry that makes the rule a rule: an unreadable alternate *later* in
// order than a usable winner cannot change the answer, because the earlier
// alternate already won. Holding here anyway would be the old blunt "any
// unreadable rail on the route holds" behaviour, which drags work off a healthy
// primary on the strength of a reading that was never consulted.
test("an unreadable alternate later in order than a usable winner does not hold", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 20, weekly: 0 }),
      railState("deepseek", { ok: false, note: "HTTP 500" }),
    ),
    cfg,
  );
  assert.equal(d.kind, "assign");
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
});

test("when no readable alternate qualifies, an unreadable one holds rather than falling back to the primary", () => {
  const d = decide(
    "planner",
    MULTI,
    railMap(
      railState("claude", { session: 90, weekly: 0 }),
      railState("codex", { session: 85, weekly: 0 }), // readable, but within margin
      railState("deepseek", { ok: false, note: "HTTP 500" }),
    ),
    cfg,
  );
  assert.equal(d.kind, "hold");
});

// ---------------------------------------------------------------- containment

// The guarantee: a write never lands outside `cfg.agentDir`. The config seam
// validates names, but `decide` is handed a `DispatcherConfig` that need not
// have come through `mergeConfig`, so it re-checks the resolved path and holds
// rather than assigning when it escapes.

test("decide holds rather than assigning when the agent resolves outside agentDir", () => {
  const confined: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/tmp/agents", agents: AGENT_ROUTES };
  const healthy = rails({ session: 0, weekly: 0 }, { session: 0, weekly: 0 });

  const escaped = decide("../outside", AGENT_ROUTES.planner, healthy, confined);
  assert.equal(escaped.kind, "hold");
  assert.equal("model" in escaped, false, "a hold must carry no model to write");
  assert.equal(escaped.file, "/tmp/outside.md");
  assert.ok(escaped.why.includes("/tmp/outside.md"), escaped.why);
});

test("decide holds for a sibling directory that merely shares agentDir's prefix", () => {
  // `/tmp/agents-evil` starts with the string `/tmp/agents`, so a naive
  // `file.startsWith(agentDir)` would accept it. Only a resolved,
  // separator-aware check rejects it.
  const confined: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/tmp/agents", agents: AGENT_ROUTES };
  const healthy = rails({ session: 0, weekly: 0 }, { session: 0, weekly: 0 });

  const d = decide("../agents-evil/agent", AGENT_ROUTES.planner, healthy, confined);
  assert.equal(d.kind, "hold");
  assert.equal("model" in d, false, "a hold must carry no model to write");
  assert.equal(d.file, "/tmp/agents-evil/agent.md");
  assert.ok(d.why.includes("/tmp/agents-evil/agent.md"), d.why);
});

test("decide assigns normally for a well-behaved name", () => {
  const confined: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/tmp/agents", agents: AGENT_ROUTES };
  const healthy = rails({ session: 0, weekly: 0 }, { session: 0, weekly: 0 });

  const d = decide("planner", AGENT_ROUTES.planner, healthy, confined);
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
  assert.equal(d.file, "/tmp/agents/planner.md");
});

test("decide treats a name that normalizes back inside agentDir as contained", () => {
  // The guarantee is containment, not filename shape: `sub/../planner` joins to
  // `/tmp/agents/planner.md`, which is inside, so it is an ordinary assign.
  const confined: DispatcherConfig = { ...DEFAULT_CONFIG, agentDir: "/tmp/agents", agents: AGENT_ROUTES };
  const healthy = rails({ session: 0, weekly: 0 }, { session: 0, weekly: 0 });

  const d = decide("sub/../planner", AGENT_ROUTES.planner, healthy, confined);
  assert.equal(d.kind, "assign");
  assert.equal(d.file, "/tmp/agents/planner.md");
});

// ------------------------------------------------- destination eligibility

// The run that exposed this moved the planner *onto* codex on the session rule
// while moving the reviewer *off* codex on the weekly rule, in the same pass.
test("an alternate that is tight on its other budget is not a destination", () => {
  const d = plannerDecision({ session: 80, weekly: 0 }, { session: 10, weekly: 100 });
  assert.equal(assignedModel(d), "claude-bridge/claude-opus-5-5");
});

test("one pass never moves an agent onto a rail it moves another agent off", () => {
  // Codex's week is nearly spent and claude's session is nearly spent, so
  // neither rail is a clear improvement. Swapping the two agents would leave
  // both rails exactly as constrained as they were, minus the churn.
  const claude = { session: 80, weekly: 0 };
  const codex = { session: 10, weekly: 95 };

  const planner = plannerDecision(claude, codex);
  assert.equal(assignedModel(planner), "claude-bridge/claude-opus-5-5");

  const reviewer = decide("reviewer", AGENT_ROUTES.reviewer, rails(claude, codex), cfg);
  assert.equal(assignedModel(reviewer), "openai-codex/gpt-6-astra");
});

test("a destination may be tight on the compared budget, as long as it is better", () => {
  // Both session budgets are over the threshold, but codex is 14 points better,
  // which is a real improvement, so the switch still happens.
  const d = plannerDecision({ session: 90, weekly: 0 }, { session: 76, weekly: 5 });
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
});

test("a tight weekly is still acted on when the session rule cannot fire", () => {
  // Session is tight but codex is not margin better, so the session rule falls
  // through; the weekly rule then finds codex far healthier on the week, and its
  // session is healthy enough to be used.
  const d = plannerDecision({ session: 80, weekly: 95 }, { session: 70, weekly: 10 });
  assert.equal(assignedModel(d), "openai-codex/gpt-6-sol");
});

// ------------------------------------- unreadable and unreported readings

test("an unreported budget is held, not read as idle", () => {
  // The bug: a rail that omitted its 5-hour window read as 0% session, so a
  // blocked rail looked like the roomiest place to send work. The reading that
  // is missing is the one that would decide, so the dispatcher holds.
  const d = plannerDecision({ session: 80, weekly: 0 }, { weekly: 100 });
  assert.equal(d.kind, "hold");
  assert.ok(d.why.includes("codex"), d.why);
  assert.match(d.why, /session/, d.why);
});

test("a metered rail reports no budgets rather than unreported ones", () => {
  const metered = railState("deepseek", { metered: true });
  assert.equal(budgetUsed(metered, "session"), 0);
  assert.equal(budgetUsed(metered, "weekly"), 0);

  const partial = railState("codex", { weekly: 10 });
  assert.equal(budgetUsed(partial, "session"), undefined);
  assert.equal(budgetUsed(partial, "weekly"), 10);
});

// A hold is not "assign the primary". These decisions carry no model at all,
// because naming one is what let an unreadable quota drag agents back onto the
// rail that was under pressure.
test("decide makes no assignment when the primary rail is unreadable", () => {
  const d = plannerDecision({ ok: false, note: "HTTP 401" }, { session: 1, weekly: 0 });
  assert.equal(d.kind, "hold");
  assert.match(d.why, /unreadable/);
});

test("decide makes no assignment when the alternate rail is unreadable", () => {
  const d = plannerDecision({ session: 99, weekly: 0 }, { ok: false, note: "HTTP 500" });
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
  /** Omit the 5-hour window entirely, reproducing a partial reading. */
  codexOmitSession?: boolean;
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
            ...(opts.codexOmitSession
              ? {}
              : {
                  primary_window: {
                    used_percent: opts.codex?.session ?? 0,
                    limit_window_seconds: 18000,
                    reset_after_seconds: 3600,
                  },
                }),
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
  return createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(opts) },
  );
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
    { ...DEFAULT_CONFIG, ...fx, agents: AGENT_ROUTES },
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
 * Regression: a partial reading used to read as headroom. Codex omitting its
 * 5-hour window made `budgetUsed(codex, "session")` return 0, so a rail that
 * was blocked outright looked like the roomiest place to send work — and the
 * planner was duly moved onto it, reporting "codex session 0%".
 */
test("a partial reading is held rather than read as headroom", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const d = dispatcherFor(fx, {
    claude: { session: 80 },
    codex: { weekly: 100 },
    codexOmitSession: true,
  });
  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;

  assert.equal(planner.decision.kind, "hold");
  assert.ok(planner.decision.why.includes("codex"), planner.decision.why);
  assert.equal(planner.outcome, "held");
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
    { ...DEFAULT_CONFIG, ...fx, claudeCredsPath: join(fx.agentDir, "absent.json"), agents: AGENT_ROUTES },
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
    { ...DEFAULT_CONFIG, ...fx, claudeCredsPath: join(fx.agentDir, "absent.json"), agents: AGENT_ROUTES },
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
    { ...DEFAULT_CONFIG, ...fx, agents: AGENT_ROUTES },
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
