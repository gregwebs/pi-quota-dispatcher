import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type AgentRoute,
  type AgentDefinition,
  type Candidate,
  type DispatcherConfig,
  type ModelLookup,
  type Rail,
  type RailState,
  type RailWindow,
  DEFAULT_CONFIG,
  checkModels,
  createDispatcher,
  decide,
  heldDecision,
  modelLookup,
} from "../src/index.ts";

const definitionOf = (agent: string, cfg: DispatcherConfig): AgentDefinition => ({ agent, file: join(cfg.agentDir, `${agent}.md`) });

// ---------------------------------------------------------------- helpers

// The em dash the agreed wording pins (U+2014), kept as a named constant so a
// careless hyphen cannot slip into an assertion.
const DASH = "\u2014";

/** One model on one rail, as a route's candidate. */
function candidate(model: string, rail: Rail): Candidate {
  return { model, rail };
}

/** A config rooted at a fake agent dir, so nothing here reads a real one. */
function config(agents: Record<string, AgentRoute>, extra: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return { ...DEFAULT_CONFIG, agentDir: "/agents", agents, ...extra };
}

/** A lookup that answers `true` exactly for the model ids passed in. */
function lookupFor(...models: string[]): ModelLookup {
  const known = new Set(models);
  return (provider, modelId) => known.has(`${provider}/${modelId}`);
}

/** A `warn` that records every line, so "once per occurrence" is checkable. */
function warnRecorder(): { lines: string[]; warn: (message: string) => void } {
  const lines: string[] = [];
  return { lines, warn: (message) => lines.push(message) };
}

/** The agreed warning for one unknown candidate at its dotted config path. */
function unknownLine(path: string, model: string): string {
  return `${path}: this pi does not know model ${model} ${DASH} a newer pi may`;
}

/** One rail's readings, as a policy test describes them. */
function railState(rail: Rail, r: { session?: number; weekly?: number } = {}): RailState {
  const windows: RailWindow[] = [];
  if (r.session !== undefined) windows.push({ label: "5h", used: r.session, budget: "session" });
  if (r.weekly !== undefined) windows.push({ label: "7d", used: r.weekly, budget: "weekly" });
  return { rail, ok: true, windows };
}

function railMap(...states: RailState[]): Map<Rail, RailState> {
  return new Map(states.map((s) => [s.rail, s]));
}

// ---------------------------------------------------------------- feature detection

// The whole feature is opt-in: an older pi that has no `ctx.modelRegistry` must
// keep today's behaviour, which is what makes this safe to ship without editing
// every existing test.
test("modelLookup returns undefined when the running pi has no registry", () => {
  assert.equal(modelLookup({}), undefined);
  assert.equal(modelLookup({ modelRegistry: undefined }), undefined);
});

test("checkModels without a lookup skips silently: unchanged config, nothing held, no warn", () => {
  const cfg = config({
    planner: {
      primary: candidate("claude-bridge/claude-sol-9", "claude"),
      alternates: [candidate("openai-codex/gpt-6-sol", "codex")],
    },
  });
  const snapshot = structuredClone(cfg);
  const { lines, warn } = warnRecorder();

  const result = checkModels(cfg, undefined, warn);

  assert.deepEqual(result.config, snapshot, "without a lookup the config is returned as it came in");
  assert.deepEqual(result.held, {});
  assert.deepEqual(result.droppedAlternates, {});
  assert.deepEqual(result.misses, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(lines.length, 0, "the check must not warn when it is skipped");
});

// ---------------------------------------------------------------- the registry call shape

test("modelLookup asks the registry for the provider and id it was handed", () => {
  const calls: Array<[string, string]> = [];
  const registry = {
    find(provider: string, modelId: string): unknown {
      calls.push([provider, modelId]);
      return modelId === "gpt-6-sol" ? { provider, modelId } : undefined;
    },
  };

  const lookup = modelLookup({ modelRegistry: registry });
  assert.ok(lookup, "a context with a registry must produce a lookup");

  assert.equal(lookup("openai-codex", "gpt-6-sol"), true, "a found model is spawnable");
  assert.equal(lookup("openai-codex", "gpt-6-missing"), false, "an undefined result is not spawnable");
  assert.deepEqual(calls, [
    ["openai-codex", "gpt-6-sol"],
    ["openai-codex", "gpt-6-missing"],
  ]);
});

test("checkModels splits the model on the first / before asking the lookup", () => {
  // Spelled out rather than via lookupFor, because the split is the thing under
  // test: provider = before the first `/`, id = everything after it.
  const seen: Array<[string, string]> = [];
  const lookup: ModelLookup = (provider, modelId) => {
    seen.push([provider, modelId]);
    return true;
  };

  const cfg = config({
    planner: {
      primary: candidate("openai-codex/gpt-6-sol", "codex"),
      alternates: [candidate("a/b/c", "claude")],
    },
  });

  const result = checkModels(cfg, lookup);

  assert.deepEqual(result.warnings, [], "both were accepted");
  assert.deepEqual(
    seen,
    [
      ["openai-codex", "gpt-6-sol"],
      ["a", "b/c"],
    ],
    "the id keeps every slash after the first",
  );
});

// A model id without a `/` cannot name a pi model at all, so it is unresolvable
// by definition — the lookup must not even be asked.
test("a model with no / is unknown without being put to the lookup", () => {
  const lookup: ModelLookup = () => {
    throw new Error("the lookup must not be called for a model with no provider");
  };
  const { lines, warn } = warnRecorder();
  const cfg = config({
    planner: { primary: candidate("nomodel", "claude"), alternates: [] },
  });

  const result = checkModels(cfg, lookup, warn);

  assert.deepEqual(result.held, { planner: "nomodel" });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0], unknownLine("agents.planner.primary.model", "nomodel"));
  assert.deepEqual(lines, result.warnings);
});

// ---------------------------------------------------------------- unknown primary holds

test("an unknown primary holds its agent in the table and names it with the model id", () => {
  const route: AgentRoute = {
    primary: candidate("claude-bridge/claude-sol-9", "claude"),
    alternates: [candidate("openai-codex/gpt-6-sol", "codex")],
  };
  const cfg = config({ planner: route });
  const { lines, warn } = warnRecorder();

  const result = checkModels(cfg, lookupFor("openai-codex/gpt-6-sol"), warn);

  assert.deepEqual(result.held, { planner: "claude-bridge/claude-sol-9" });
  assert.ok(result.config.agents.planner, "a held agent stays in the table");
  assert.deepEqual(result.config.agents.planner.primary, candidate("claude-bridge/claude-sol-9", "claude"));
  assert.deepEqual(result.config.agents.planner.alternates, [candidate("openai-codex/gpt-6-sol", "codex")]);
  assert.deepEqual(result.warnings, [
    unknownLine("agents.planner.primary.model", "claude-bridge/claude-sol-9"),
  ]);
  assert.deepEqual(lines, result.warnings, "warn sees the same line that comes back in warnings");
});

// ---------------------------------------------------------------- unknown alternate is skipped

test("an unknown alternate is removed and the alternates after it keep their order", () => {
  const route: AgentRoute = {
    primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
    alternates: [
      candidate("openai-codex/gpt-sol-6", "codex"), // transposed: unknown
      candidate("openai-codex/gpt-6-sol", "codex"), // known
      candidate("deepseek/deepseek-flash", "deepseek"), // known
    ],
  };
  const cfg = config({ planner: route });
  const { lines, warn } = warnRecorder();

  const result = checkModels(
    cfg,
    lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol", "deepseek/deepseek-flash"),
    warn,
  );

  assert.deepEqual(
    result.config.agents.planner.alternates.map((c) => c.model),
    ["openai-codex/gpt-6-sol", "deepseek/deepseek-flash"],
    "the unknown alternate is gone; the rest keep priority order",
  );
  assert.deepEqual(result.held, {}, "an alternate miss must not hold the agent");
  assert.deepEqual(result.warnings, [
    unknownLine("agents.planner.alternates[0].model", "openai-codex/gpt-sol-6"),
  ]);
  assert.deepEqual(lines, result.warnings);
});

// The record a dropped alternate leaves behind, and the whole reason it exists:
// a route that lost every alternate comes back looking exactly like one the user
// pinned with `[]`, so `decide` cannot tell the two apart from the config alone.
// Each key is indexed in the list as *written*, not in the list that survived —
// it is the line the reader has to go and fix.
//
// Dropping the middle of three is the case that pins that down: an implementation
// that re-indexed the survivors, or that read the keys off `config`, gets 0 and 1
// where the user's third alternate is really `[2]`.
test("checkModels records each dropped alternate under the key its warning named", () => {
  const route: AgentRoute = {
    primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
    alternates: [
      candidate("openai-codex/gpt-sol-6", "codex"), // transposed: unknown
      candidate("openai-codex/gpt-6-sol", "codex"), // known: kept
      candidate("openai-codex/gpt-astra-6", "codex"), // transposed: unknown
    ],
  };
  const { lines, warn } = warnRecorder();

  const result = checkModels(
    config({ planner: route }),
    lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"),
    warn,
  );

  assert.deepEqual(result.droppedAlternates, {
    planner: [
      { key: "agents.planner.alternates[0].model", model: "openai-codex/gpt-sol-6" },
      { key: "agents.planner.alternates[2].model", model: "openai-codex/gpt-astra-6" },
    ],
  });
  // The record and the warning say the same thing in the same words, which is
  // what lets `decide` quote the log line in the report rather than invent a
  // second wording for one fact.
  assert.deepEqual(
    lines,
    result.droppedAlternates.planner.map((dropped) => unknownLine(dropped.key, dropped.model)),
  );
});

/**
 * An alternate dropped from a route that kept another one is still recorded:
 * the record is "what did boot drop?", and the decision is free to ignore it.
 */
test("checkModels records a drop even when the route still has an alternate", () => {
  const route: AgentRoute = {
    primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
    alternates: [
      candidate("openai-codex/gpt-sol-6", "codex"), // unknown
      candidate("openai-codex/gpt-6-sol", "codex"), // known
    ],
  };

  const result = checkModels(
    config({ planner: route }),
    lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"),
  );

  assert.deepEqual(result.droppedAlternates, {
    planner: [{ key: "agents.planner.alternates[0].model", model: "openai-codex/gpt-sol-6" }],
  });
});

// ---------------------------------------------------------------- one warning per occurrence

test("the same unknown id twice warns twice and holds only the primary's agent", () => {
  const unknown = "openai-codex/gpt-sol-6";
  const cfg = config({
    alpha: { primary: candidate(unknown, "codex"), alternates: [] },
    zebra: {
      primary: candidate("openai-codex/gpt-6-sol", "codex"),
      alternates: [candidate(unknown, "codex")],
    },
  });
  const { lines, warn } = warnRecorder();

  const result = checkModels(cfg, lookupFor("openai-codex/gpt-6-sol"), warn);

  assert.equal(result.warnings.length, 2, "one per occurrence, never deduped");
  assert.equal(result.warnings[0], unknownLine("agents.alpha.primary.model", unknown));
  assert.equal(result.warnings[1], unknownLine("agents.zebra.alternates[0].model", unknown));
  assert.deepEqual(result.held, { alpha: unknown }, "only the unknown *primary* is held");
  assert.deepEqual(lines, result.warnings);
  // The occurrences as data: the same two, in the same order, so a caller that
  // has to list them itself never has to parse a rendered sentence.
  assert.deepEqual(result.misses, [
    { key: "agents.alpha.primary.model", model: unknown },
    { key: "agents.zebra.alternates[0].model", model: unknown },
  ]);
});

test("a config whose models are all known produces no warnings and is returned unchanged", () => {
  const cfg = config({
    planner: {
      primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
      alternates: [candidate("openai-codex/gpt-6-sol", "codex")],
    },
  });
  const snapshot = structuredClone(cfg);
  const { lines, warn } = warnRecorder();

  const result = checkModels(cfg, lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"), warn);

  assert.deepEqual(result.config, snapshot);
  assert.deepEqual(result.held, {});
  assert.deepEqual(result.droppedAlternates, {});
  assert.deepEqual(result.misses, [], "a clean config has nothing to surface");
  assert.deepEqual(result.warnings, []);
  assert.equal(lines.length, 0);
});

// The check is about candidate model ids. Everything else on a route — a level,
// most of all — has to come out of the rebuilt table exactly as it went in, or a
// session's first boot would quietly undo every configured level.
test("checkModels carries a route's level and the models table through the rebuild", () => {
  const route: AgentRoute = {
    thinking: "medium",
    primary: { ...candidate("claude-bridge/claude-opus-5-5", "claude"), thinking: "xhigh" },
    alternates: [
      { ...candidate("openai-codex/gpt-sol-6", "codex"), thinking: "off" }, // unknown
      { ...candidate("openai-codex/gpt-6-sol", "codex"), thinking: "low" }, // known
    ],
  };
  const cfg = config({ planner: route }, { models: { "openai-codex/gpt-6-sol": { thinking: "minimal" } } });

  const result = checkModels(cfg, lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"));

  assert.equal(result.config.agents.planner.thinking, "medium");
  assert.equal(result.config.agents.planner.primary.thinking, "xhigh");
  assert.equal(result.config.agents.planner.alternates.length, 1);
  assert.equal(result.config.agents.planner.alternates[0].thinking, "low");
  assert.deepEqual(result.config.models, { "openai-codex/gpt-6-sol": { thinking: "minimal" } });
});

// ---------------------------------------------------------------- purity

test("checkModels does not mutate the config it is handed", () => {
  const route: AgentRoute = {
    primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
    alternates: [
      candidate("openai-codex/gpt-sol-6", "codex"), // unknown
      candidate("openai-codex/gpt-6-sol", "codex"), // known
    ],
  };
  const cfg = config({ planner: route });
  const snapshot = structuredClone(cfg);
  const callerAlternates = cfg.agents.planner.alternates;

  const result = checkModels(cfg, lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"));

  assert.deepEqual(cfg, snapshot, "the caller's config must be untouched");
  assert.equal(callerAlternates.length, 2, "the caller's alternates array keeps every element");
  assert.equal(callerAlternates[0].model, "openai-codex/gpt-sol-6", "its elements are untouched");
  assert.notEqual(result.config, cfg, "the result is a new config, not the caller's object");
  assert.notEqual(
    result.config.agents.planner.alternates,
    callerAlternates,
    "the returned route gets a fresh list, not the caller's array",
  );
  assert.deepEqual(
    result.config.agents.planner.alternates.map((c) => c.model),
    ["openai-codex/gpt-6-sol"],
  );
});

test("re-checking is idempotent", () => {
  const cfg = config({
    planner: {
      primary: candidate("claude-bridge/claude-sol-9", "claude"),
      alternates: [
        candidate("openai-codex/gpt-sol-6", "codex"), // unknown, removed
        candidate("openai-codex/gpt-6-sol", "codex"),
      ],
    },
  });
  const lookup = lookupFor("openai-codex/gpt-6-sol");

  const first = checkModels(cfg, lookup);
  const again = checkModels(cfg, lookup);
  assert.deepEqual(again.config, first.config, "the same input checks the same way twice");
  assert.deepEqual(again.held, first.held);
  assert.deepEqual(again.warnings, first.warnings);

  const second = checkModels(first.config, lookup);
  assert.deepEqual(second.config, first.config, "checking the result again changes nothing more");
  assert.deepEqual(second.held, first.held);
});

// ---------------------------------------------------------------- ordering

// The order is the contract the report relies on, and the agent keys are listed
// out of alphabetical order here so an implementation that merely walks the
// object's insertion order cannot pass.
test("warnings come out agents by name, then primary, then alternates in index order", () => {
  const cfg = config({
    zulu: {
      primary: candidate("claude-bridge/claude-zulu-primary", "claude"),
      alternates: [
        candidate("openai-codex/gpt-6-sol", "codex"), // known
        candidate("claude-bridge/claude-zulu-alt1", "claude"), // unknown
      ],
    },
    alpha: {
      primary: candidate("claude-bridge/claude-alpha-primary", "claude"),
      alternates: [
        candidate("claude-bridge/claude-alpha-alt0", "claude"), // unknown
        candidate("claude-bridge/claude-alpha-alt1", "claude"), // unknown
      ],
    },
  });

  const result = checkModels(cfg, lookupFor("openai-codex/gpt-6-sol"));

  assert.deepEqual(result.warnings, [
    unknownLine("agents.alpha.primary.model", "claude-bridge/claude-alpha-primary"),
    unknownLine("agents.alpha.alternates[0].model", "claude-bridge/claude-alpha-alt0"),
    unknownLine("agents.alpha.alternates[1].model", "claude-bridge/claude-alpha-alt1"),
    unknownLine("agents.zulu.primary.model", "claude-bridge/claude-zulu-primary"),
    unknownLine("agents.zulu.alternates[1].model", "claude-bridge/claude-zulu-alt1"),
  ]);
  assert.deepEqual(result.held, {
    alpha: "claude-bridge/claude-alpha-primary",
    zulu: "claude-bridge/claude-zulu-primary",
  });
  // One list, two renderings: the misses are the occurrences the lines were
  // built from, so a caller can pick out the keys and models without reversing
  // the wording.
  assert.deepEqual(
    result.warnings,
    result.misses.map((miss) => unknownLine(miss.key, miss.model)),
    "every warning is a miss, at the key and in the order the miss records",
  );
  assert.deepEqual(
    result.misses.map((miss) => miss.key),
    [
      "agents.alpha.primary.model",
      "agents.alpha.alternates[0].model",
      "agents.alpha.alternates[1].model",
      "agents.zulu.primary.model",
      "agents.zulu.alternates[1].model",
    ],
  );
});

// ---------------------------------------------------------------- transposed-ids fixture

// The two transposed ids found in the operator's config (issue #14). The pi
// knows the real ids, so both transpositions are reported — one as a held
// primary, one as a skipped alternate.
test("the transposed gpt-sol-6 / gpt-astra-6 ids are both reported", () => {
  const cfg = config({
    reviewer: {
      primary: candidate("openai-codex/gpt-sol-6", "codex"),
      alternates: [candidate("openai-codex/gpt-astra-6", "codex")],
    },
  });
  const { lines, warn } = warnRecorder();

  const result = checkModels(cfg, lookupFor("openai-codex/gpt-6-sol", "openai-codex/gpt-6-astra"), warn);

  assert.equal(result.warnings.length, 2, "both transposed ids must be reported");
  assert.deepEqual(result.warnings, [
    unknownLine("agents.reviewer.primary.model", "openai-codex/gpt-sol-6"),
    unknownLine("agents.reviewer.alternates[0].model", "openai-codex/gpt-astra-6"),
  ]);
  assert.deepEqual(lines, result.warnings);
  assert.deepEqual(result.held, { reviewer: "openai-codex/gpt-sol-6" });
  assert.deepEqual(result.config.agents.reviewer.alternates, [], "the unknown alternate is skipped");
});

// ---------------------------------------------------------------- heldDecision

test("heldDecision is a hold that names the unknown model and leaves no model to write", () => {
  const cfg = config({});
  const d = heldDecision({ agent: "planner", model: "claude-bridge/claude-sol-9" });

  assert.equal(d.kind, "hold");
  assert.equal("file" in d, false, "a hold has no file to write");
  assert.equal(d.agent, "planner");
  assert.equal(
    d.why,
    `agents.planner.primary.model: this pi does not know model claude-bridge/claude-sol-9 ${DASH} a newer pi may; holding`,
    "the hold names the primary's own key, in the same wording a dropped candidate gets",
  );
  assert.equal("model" in d, false, "a hold must carry no model to write");
});

// ---------------------------------------------------------------- integration: the file is not written

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

interface Fixture {
  agentDir: string;
  claudeCredsPath: string;
  piAuthPath: string;
}

/**
 * A self-contained fixture: agent files and fake credential files, so a wrong
 * or missing stub cannot fall through to the developer's real
 * `~/.claude/.credentials.json` or `~/.pi/agent/auth.json`.
 */
async function fixture(models: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-models-"));
  const agentDir = join(root, "agents");
  await mkdir(agentDir, { recursive: true });
  for (const [name, model] of Object.entries(models)) {
    await writeFile(join(agentDir, `${name}.md`), TEMPLATE(name, model), "utf8");
  }

  const claudeCredsPath = join(root, "claude-credentials.json");
  await writeFile(
    claudeCredsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 } }),
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

/** Readings the stub endpoints should report, per live rail. */
interface StubReadings {
  claude?: { session?: number; weekly?: number };
  codex?: { session?: number; weekly?: number };
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
            limit_reached: false,
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

test("a held unknown primary leaves the agent's file byte-for-byte alone even when a switch is due", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  const cfg: DispatcherConfig = {
    ...DEFAULT_CONFIG,
    ...fx,
    agents: {
      planner: {
        primary: candidate("claude-bridge/claude-sol-9", "claude"),
        alternates: [candidate("openai-codex/gpt-6-sol", "codex")],
      },
    },
  };

  const checked = checkModels(cfg, lookupFor("openai-codex/gpt-6-sol"));
  assert.deepEqual(checked.held, { planner: "claude-bridge/claude-sol-9" });

  const path = join(fx.agentDir, "planner.md");
  const before = await readFile(path, "utf8");

  // Claude's session is tight and codex is healthy, so without the hold this
  // pass would switch planner onto its codex alternate. `applyDecision` must
  // never be reached for a held agent.
  const dispatcher = createDispatcher(checked.config, {
    held: checked.held,
    fetchImpl: stubFetch({ claude: { session: 90 }, codex: { session: 10 } }),
  });
  const results = await dispatcher.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;

  assert.equal(planner.outcome, "held");
  assert.equal(planner.decision.kind, "hold");
  assert.equal("file" in planner.decision, false, "a hold has no file to write");
  assert.equal(await readFile(path, "utf8"), before, "a held agent's file must not be touched");
  assert.match(before, /^model: "claude-bridge\/claude-opus-5-5"$/m);
});

// The asymmetry the issue is about: an unknown alternate is *known bad* and is
// dropped, so the policy never sees it and the next alternate wins. An
// unreadable rail in that same slot would hold instead (see dispatch.test.ts).
test("a skipped unknown alternate does not hold: the next alternate is assigned", () => {
  const route: AgentRoute = {
    primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
    alternates: [
      candidate("openai-codex/gpt-sol-6", "codex"), // unknown: skipped
      candidate("openai-codex/gpt-6-sol", "codex"), // known: the winner
    ],
  };
  const cfg = config({ planner: route });

  const checked = checkModels(cfg, lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-sol"));
  assert.deepEqual(
    checked.config.agents.planner.alternates.map((c) => c.model),
    ["openai-codex/gpt-6-sol"],
  );
  assert.deepEqual(checked.held, {}, "a skipped alternate must not hold the agent");

  const d = decide(
    definitionOf("planner", checked.config),
    checked.config.agents.planner,
    railMap(railState("claude", { session: 90, weekly: 0 }), railState("codex", { session: 10, weekly: 0 })),
    checked.config,
  );
  assert.equal(d.kind, "assign", `expected an assign, got a hold: ${d.why}`);
  assert.equal(d.kind === "assign" ? d.model : "", "openai-codex/gpt-6-sol");
});

// The asymmetry pinned in one place, which neither side's own test can do: the
// *same route* under the two kinds of unusable candidate. A model-id miss is
// known bad, so it is dropped and the walk continues; a missing rail reading is
// unknown, so the walk stops. An implementation that unifies the two — e.g.
// holding on any unusable candidate, or dropping unreadable rails too — fails
// one half of this even though each half's own test might still pass.
test("a model-id miss is dropped while an unreadable rail holds — the asymmetry side by side", () => {
  const route = (): AgentRoute => ({
    primary: candidate("claude-bridge/claude-opus-5-5", "claude"),
    alternates: [
      candidate("openai-codex/gpt-sol-6", "codex"),
      candidate("deepseek/deepseek-flash", "deepseek"),
    ],
  });
  const cfg = config({ planner: route() });
  const tightPrimary = railState("claude", { session: 90, weekly: 0 });
  const healthyDeepseek = railState("deepseek", { session: 5, weekly: 0 });

  // A. The codex reading is fine; this pi just does not know the model. Known
  // bad: dropped, so the second alternate wins.
  const checkedA = checkModels(cfg, lookupFor("claude-bridge/claude-opus-5-5", "deepseek/deepseek-flash"));
  assert.deepEqual(
    checkedA.config.agents.planner.alternates.map((c) => c.model),
    ["deepseek/deepseek-flash"],
    "the unknown model is dropped from the route",
  );
  const a = decide(
    definitionOf("planner", checkedA.config),
    checkedA.config.agents.planner,
    railMap(tightPrimary, railState("codex", { session: 10, weekly: 0 }), healthyDeepseek),
    checkedA.config,
  );
  assert.equal(a.kind, "assign", `an unknown model must be dropped, not held: ${a.kind} — ${a.why}`);
  assert.equal(a.kind === "assign" ? a.model : "", "deepseek/deepseek-flash");

  // B. Every model is known; codex's reading is missing. Unknown: the earlier
  // alternate holds, even though a later one would otherwise win.
  const checkedB = checkModels(
    cfg,
    lookupFor("claude-bridge/claude-opus-5-5", "openai-codex/gpt-sol-6", "deepseek/deepseek-flash"),
  );
  assert.deepEqual(
    checkedB.config.agents.planner.alternates.map((c) => c.model),
    ["openai-codex/gpt-sol-6", "deepseek/deepseek-flash"],
    "a known model is not dropped",
  );
  const unreadableCodex: RailState = { rail: "codex", ok: false, windows: [], note: "HTTP 500" };
  const b = decide(
    definitionOf("planner", checkedB.config),
    checkedB.config.agents.planner,
    railMap(tightPrimary, unreadableCodex, healthyDeepseek),
    checkedB.config,
  );
  assert.equal(b.kind, "hold", `an unreadable rail must hold, got ${b.kind}: ${b.why}`);
  assert.equal("file" in b, false, "a hold has no file to write");
});
