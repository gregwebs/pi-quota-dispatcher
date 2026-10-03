import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  type ConfigFileFault,
  type Candidate,
  type DispatcherConfig,
  type LoadedConfig,
  type MergeLayer,
  type SkipFlag,
  type ThinkingLevel,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  configFilesFor,
  defaultConfig,
  describeConfig,
  describeConfigLayers,
  describeConfigWarnings,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  notJsonFault,
  projectConfigPath,
  skillKey,
  thinkingFor,
  unusableConfigFileLines,
} from "../src/config.ts";

// The package does not re-export ENV_AGENT_DIR from its root, so use the
// documented literal directly.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

const AGENT_DIR = "/home/tester/.pi/agent";
const CWD = "/home/tester/work/proj";

const GLOBAL_PATH = globalConfigPath(AGENT_DIR);
const PROJECT_PATH = projectConfigPath(CWD);

// ---------------------------------------------------------------- helpers

interface FakeFs {
  readFile: (path: string) => Promise<string>;
  reads: string[];
}

/**
 * An in-memory `readFile`. A path absent from `files` rejects with ENOENT, which
 * is how the loader recognises a missing file. Records every path it is asked
 * for so a test can assert which files were consulted.
 */
function fakeFs(files: Record<string, string>): FakeFs {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path: string): Promise<string> => {
      reads.push(path);
      if (Object.prototype.hasOwnProperty.call(files, path)) return files[path];
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    },
  };
}

/**
 * A fully specified built-in layer, written out by hand so these tests do not
 * depend on `defaultConfig()` agreeing with `mergeConfig()`.
 *
 * Each agent route has a non-empty `alternates`, so tests that say "the
 * previous list stands" have something to stand.
 */
function base(): DispatcherConfig {
  return {
    agentDir: "/root/agents",
    claudeCredsPath: "/root/.claude/.credentials.json",
    claudeRefresh: "off",
    piAuthPath: "/root/auth.json",
    readingsPath: "/root/quota-dispatch-readings.json",
    ttlMs: 180000,
    pollMs: 300000,
    sessionSwitchAt: 75,
    weeklySwitchAt: 90,
    margin: 10,
    models: {},
    skills: {},
    agents: {
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
    },
  };
}

// ---------------------------------------------------------------- defaults

test("defaultConfig derives agentDir and piAuthPath from the agent directory", () => {
  const c = defaultConfig("/opt/pi/agent");
  assert.equal(c.agentDir, join("/opt/pi/agent", "agents"));
  assert.equal(c.piAuthPath, join("/opt/pi/agent", "auth.json"));
});

test("defaultConfig keeps claudeCredsPath under the real home directory", () => {
  const c = defaultConfig("/opt/pi/agent");
  assert.equal(c.claudeCredsPath, join(homedir(), ".claude", ".credentials.json"));
});

test("defaultConfig documents the scalar defaults", () => {
  const c = defaultConfig("/opt/pi/agent");
  assert.equal(c.ttlMs, 180000);
  assert.equal(c.pollMs, 300000);
  assert.equal(c.sessionSwitchAt, 75);
  assert.equal(c.weeklySwitchAt, 90);
  assert.equal(c.margin, 10);
});

// No agent is managed until the configuration names it, so a fresh install
// manages nothing and edits no file the user has not named.
test("defaultConfig ships no agents", () => {
  const c = defaultConfig("/opt/pi/agent");
  assert.deepEqual(c.agents, {});
});

test("defaultConfig honours PI_CODING_AGENT_DIR at call time", () => {
  const previous = process.env[ENV_AGENT_DIR];
  try {
    process.env[ENV_AGENT_DIR] = "/tmp/pqd-relocated";
    const c = defaultConfig();
    assert.equal(c.agentDir, join("/tmp/pqd-relocated", "agents"));
    assert.equal(c.piAuthPath, join("/tmp/pqd-relocated", "auth.json"));
  } finally {
    if (previous === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previous;
  }
});

test("DEFAULT_CONFIG is the default snapshot for the agent dir at module load", () => {
  assert.deepEqual(DEFAULT_CONFIG, defaultConfig());
});

// ---------------------------------------------------------------- paths

test("globalConfigPath is <agentDir>/quota-dispatch.json", () => {
  assert.equal(globalConfigPath("/x"), join("/x", CONFIG_FILE_NAME));
  assert.equal(globalConfigPath("/x"), join("/x", "quota-dispatch.json"));
  assert.equal(globalConfigPath(), join(getAgentDir(), CONFIG_FILE_NAME));
});

test("projectConfigPath is <cwd>/<CONFIG_DIR_NAME>/quota-dispatch.json", () => {
  assert.equal(projectConfigPath("/y"), join("/y", CONFIG_DIR_NAME, CONFIG_FILE_NAME));
  assert.equal(projectConfigPath(), join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME));
});

// ---------------------------------------------------------------- mergeConfig

test("mergeConfig with no layers returns the base and marks every key built-in", () => {
  const r = mergeConfig(base(), []);
  assert.deepEqual(r.config, base());
  assert.deepEqual(r.warnings, []);
  assert.equal(r.sources.sessionSwitchAt, "built-in");
  assert.equal(r.sources.margin, "built-in");
  assert.equal(r.sources["agents.planner.primary.model"], "built-in");
  assert.equal(r.sources["agents.reviewer.alternates[0].rail"], "built-in");
});

test("mergeConfig applies later layers over earlier ones", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: {
        sessionSwitchAt: 60,
        agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } },
      },
    },
    { source: "project", data: { sessionSwitchAt: 50 } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.sessionSwitchAt, 50);
  assert.equal(r.sources.sessionSwitchAt, "project");
  assert.equal(r.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-6");
  assert.equal(r.sources["agents.planner.primary.model"], "global");
  // A candidate that names only `model` keeps the base rail: `primary` merges
  // field-wise.
  assert.equal(r.config.agents.planner.primary.rail, "claude");
  assert.equal(r.sources["agents.planner.primary.rail"], "built-in");
});

test("mergeConfig deep-merges per agent, leaving unnamed agents and scalars alone", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { implementer: { primary: { model: "deepseek/deepseek-v3" } } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.sessionSwitchAt, 75);
  assert.deepEqual(r.config.agents.planner, base().agents.planner);
  assert.deepEqual(r.config.agents.reviewer, base().agents.reviewer);
  assert.equal(r.config.agents.implementer.primary.model, "deepseek/deepseek-v3");
  assert.equal(r.config.agents.implementer.primary.rail, "deepseek");
  assert.equal(r.sources["agents.implementer.primary.model"], "project");
});

// ------------------------------------------------------ alternates are a list

test("a layer that mentions alternates replaces the whole list", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        agents: {
          planner: {
            alternates: [
              { model: "deepseek/deepseek-flash", rail: "deepseek" },
              { model: "openai-codex/gpt-6-astra", rail: "codex" },
            ],
          },
        },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(
    r.config.agents.planner.alternates.map((c) => c.model),
    ["deepseek/deepseek-flash", "openai-codex/gpt-6-astra"],
  );
  assert.equal(r.sources["agents.planner.alternates[0].model"], "project");
  assert.equal(r.sources["agents.planner.alternates[1].rail"], "project");
  // `primary` is untouched: only the list was mentioned.
  assert.deepEqual(r.config.agents.planner.primary, base().agents.planner.primary);
  assert.equal(r.sources["agents.planner.primary.model"], "built-in");
});

test("a shorter replacement list drops provenance for the index it no longer has", () => {
  const b = base();
  b.agents.planner.alternates = [
    { model: "openai-codex/gpt-6-sol", rail: "codex" },
    { model: "deepseek/deepseek-flash", rail: "deepseek" },
  ];
  const r = mergeConfig(b, [
    {
      source: "project",
      data: { agents: { planner: { alternates: [{ model: "openai-codex/gpt-6-luna", rail: "codex" }] } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.planner.alternates.length, 1);
  assert.equal(r.sources["agents.planner.alternates[0].model"], "project");
  assert.equal("agents.planner.alternates[1].model" in r.sources, false);
});

test("an empty alternates list is accepted and pins the agent to its primary", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { alternates: [] } } } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.config.agents.planner.alternates, []);
  // The primary is left exactly as the lower layer had it.
  assert.deepEqual(r.config.agents.planner.primary, base().agents.planner.primary);
});

test("an unusable element rejects the whole alternates list and the previous list stands", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        agents: {
          planner: {
            alternates: [
              { model: "openai-codex/gpt-6-luna", rail: "codex" },
              { model: "missing-slash" },
            ],
          },
        },
      },
    },
  ]);
  assert.ok(r.warnings.length >= 1, r.warnings.join("\n"));
  assert.deepEqual(r.config.agents.planner.alternates, base().agents.planner.alternates);
  assert.equal(r.sources["agents.planner.alternates[0].model"], "built-in");
});

test("a non-array alternates is rejected and the previous list stands", () => {
  // A lone candidate object is deliberately not shorthand for a one-element
  // list; `alternates` is a list or it is nothing.
  const rejected: unknown[] = [
    { model: "openai-codex/gpt-6-luna", rail: "codex" },
    "openai-codex/gpt-6-luna",
    42,
    { "0": { model: "openai-codex/gpt-6-luna", rail: "codex" } },
  ];
  for (const bad of rejected) {
    const r = mergeConfig(base(), [
      { source: "project", data: { agents: { planner: { alternates: bad } } } },
    ]);
    assert.ok(r.warnings.length >= 1, `${JSON.stringify(bad)}: ${r.warnings.join("\n")}`);
    assert.deepEqual(
      r.config.agents.planner.alternates,
      base().agents.planner.alternates,
      `${JSON.stringify(bad)}`,
    );
    assert.equal(r.sources["agents.planner.alternates[0].model"], "built-in", `${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- skip flags

// The `disable` / `ignore` matrix. Both are consumed while the layers are
// folded and never survive into the effective config.

const SKIP_FLAGS: readonly SkipFlag[] = ["disable", "ignore"];

test("disable: true removes the agent whatever lower layers said and records it once", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { disable: true } } } },
  ]);
  assert.equal("planner" in r.config.agents, false);
  assert.equal(r.sources["agents.planner"], "project");
  // The removal is recorded once, and no candidate provenance survives it.
  assert.deepEqual(
    Object.keys(r.sources).filter((k) => k.startsWith("agents.planner")),
    ["agents.planner"],
  );
  // Other agents are untouched.
  assert.deepEqual(r.config.agents.reviewer, base().agents.reviewer);
});

test("disable: true with nothing to remove removes nothing and records nothing", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { ghost: { disable: true } } } },
  ]);
  assert.equal("ghost" in r.config.agents, false);
  assert.deepEqual(
    Object.keys(r.sources).filter((k) => k.startsWith("agents.ghost")),
    [],
  );
  assert.equal(r.warnings.some((w) => w.includes("ghost")), false, r.warnings.join("\n"));
});

test("a higher layer re-adding a disabled agent clears the removal marker", () => {
  // Reachable only through a caller-supplied base now that the built-ins ship
  // no agents, but `mergeConfig` is exported and the invariant is about the
  // effective config, not about which layer happened to supply the base.
  const r = mergeConfig(base(), [
    { source: "global", data: { agents: { planner: { disable: true } } } },
    {
      source: "project",
      data: {
        agents: {
          planner: { primary: { model: "deepseek/deepseek-flash", rail: "deepseek" } },
        },
      },
    },
  ]);

  assert.equal(r.config.agents.planner.primary.model, "deepseek/deepseek-flash");
  assert.equal(r.sources["agents.planner.primary.model"], "project");
  assert.deepEqual(r.warnings, []);
  // The marker is a claim about the effective config, so it must not outlive
  // the removal it records: an agent that is managed cannot also be reported as
  // disabled, which is what a stale `agents.planner` key would render.
  assert.equal("agents.planner" in r.sources, false);
  const lines = describeConfig({ config: r.config, files: [], sources: r.sources, warnings: r.warnings });
  assert.equal(
    lines.some((l) => l.includes("agents.planner = disabled")),
    false,
    lines.join("\n"),
  );
  assert.ok(
    lines.some((l) => l.includes("agents.planner.primary.model = deepseek/deepseek-flash")),
    lines.join("\n"),
  );
});

test("ignore: true contributes nothing, warns nothing and is absent from provenance", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        agents: {
          planner: {
            ignore: true,
            primary: { model: "claude-bridge/claude-opus-5-6" },
          },
        },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  // The whole entry is skipped, so even its primary does not govern.
  assert.deepEqual(r.config.agents.planner, base().agents.planner);
  assert.equal("agents.planner" in r.sources, false);
  assert.equal(r.sources["agents.planner.primary.model"], "built-in");
});

test("ignore: true on an agent no lower layer configured leaves it unmanaged", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        agents: {
          newbie: {
            ignore: true,
            primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
          },
        },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal("newbie" in r.config.agents, false);
});

test("disable and ignore together is legal and ignore wins", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { disable: true, ignore: true } } } },
  ]);
  assert.deepEqual(r.warnings, []);
  // ignore governs nothing, so there is nothing for disable to turn off; the
  // lower layer's route stands uncancelled.
  assert.deepEqual(r.config.agents.planner, base().agents.planner);
  assert.equal("agents.planner" in r.sources, false);
});

test("disable: false alone is a no-op that leaves a lower layer's route standing", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { disable: false } } } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.config.agents.planner, base().agents.planner);
  assert.equal("agents.planner" in r.sources, false);
});

// The boundary #16 draws: `has no primary` reports an agent route that could not
// be finished, so it is owed only to an entry that named a route field. An entry
// that carries flags and nothing else names no agent route — and on an agent no
// lower layer defines there is nothing for it to leave standing — so it must
// change nothing and say nothing. The provenance block is the whole answer: the
// agent is simply unmanaged.
test("a flag-only entry on an agent nothing defines is silent and defines nothing", () => {
  const untouched = mergeConfig(base(), []);
  for (const flag of SKIP_FLAGS) {
    const r = mergeConfig(base(), [
      { source: "project", data: { agents: { ghost: { [flag]: false } } } },
    ]);
    assert.deepEqual(r.warnings, [], `${flag}: ${r.warnings.join("\n")}`);
    // Nothing moved anywhere: not the table, and not a provenance entry for the
    // agent this layer named and then said nothing about.
    assert.deepEqual(r.config, base(), flag);
    assert.deepEqual(r.sources, untouched.sources, flag);
  }
});

// The same silent path by two other roads: an entry that names nothing at all,
// and one whose only key is rejected on its own terms. Neither tried to build an
// agent route, so neither has one to report as incomplete.
test("an empty entry, and one naming only an unknown key, say nothing about a primary", () => {
  const empty = mergeConfig(base(), [{ source: "project", data: { agents: { ghost: {} } } }]);
  assert.deepEqual(empty.warnings, []);
  assert.equal("ghost" in empty.config.agents, false);

  const unknownKey = mergeConfig(base(), [
    { source: "project", data: { agents: { ghost: { primry: { model: "openai-codex/gpt-6-sol" } } } } },
  ]);
  assert.ok(
    unknownKey.warnings.some((w) => w.includes("agents.ghost.primry")),
    `the unknown key is what warns: ${unknownKey.warnings.join("\n")}`,
  );
  assert.equal(
    unknownKey.warnings.some((w) => w.includes("has no primary")),
    false,
    `a misspelled key is not a failed agent route: ${unknownKey.warnings.join("\n")}`,
  );
  assert.equal("ghost" in unknownKey.config.agents, false);
});

// A non-boolean flag has already warned about itself and is then treated as
// absent, which leaves the entry a statement about flags — and so, still, no
// agent route.
test("a non-boolean flag on an agent nothing defines warns only about the flag", () => {
  const untouched = mergeConfig(base(), []);
  for (const flag of SKIP_FLAGS) {
    const r = mergeConfig(base(), [
      { source: "project", data: { agents: { ghost: { [flag]: "yes" } } } },
    ]);
    assert.ok(
      r.warnings.some((w) => w.includes(`agents.ghost.${flag}`)),
      `${flag}: ${r.warnings.join("\n")}`,
    );
    assert.equal(
      r.warnings.some((w) => w.includes("has no primary")),
      false,
      `${flag}: ${r.warnings.join("\n")}`,
    );
    // The value warns for itself and is then absent, so the entry defines
    // nothing and moves nothing.
    assert.deepEqual(r.config, base(), flag);
    assert.deepEqual(r.sources, untouched.sources, flag);
  }
});

// The other side of the boundary, so the silence above cannot be bought by
// dropping the warning altogether: an entry that named a route field and could
// not complete one is reported however it failed.
test("naming a route field that cannot complete still reports no primary", () => {
  // A primary whose rail is stated nowhere: the model is named, so the entry
  // did try to build an agent route.
  const badRail = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { ghost: { primary: { model: "openai-codex/gpt-6-sol" } } } },
    },
  ]);
  assert.ok(badRail.warnings.some((w) => w.includes("needs a rail")), badRail.warnings.join("\n"));
  assert.ok(
    badRail.warnings.some((w) => w.includes('agent "ghost" has no primary')),
    badRail.warnings.join("\n"),
  );
  assert.equal("ghost" in badRail.config.agents, false);

  // An alternates-only entry names a route field without naming a primary.
  const alternatesOnly = mergeConfig(base(), [
    { source: "project", data: { agents: { ghost: { alternates: [] } } } },
  ]);
  assert.deepEqual(alternatesOnly.warnings, ['project: agent "ghost" has no primary']);
  assert.equal("ghost" in alternatesOnly.config.agents, false);

  // `thinking` is a field of a route rather than a statement about the entry, so
  // an entry naming only a level has tried to define a route and is told what it
  // is missing — including when the level itself is rejected, because naming the
  // field is what makes the entry an attempt.
  const levelOnly = mergeConfig(base(), [
    { source: "project", data: { agents: { ghost: { thinking: "high" } } } },
  ]);
  assert.deepEqual(levelOnly.warnings, ['project: agent "ghost" has no primary']);
  assert.equal("ghost" in levelOnly.config.agents, false);

  const badLevel = mergeConfig(base(), [
    { source: "project", data: { agents: { ghost: { thinking: "deeply" } } } },
  ]);
  assert.ok(
    badLevel.warnings.some((w) => w.includes("agents.ghost.thinking")),
    badLevel.warnings.join("\n"),
  );
  assert.ok(
    badLevel.warnings.some((w) => w.includes('agent "ghost" has no primary')),
    badLevel.warnings.join("\n"),
  );
});

test("a non-boolean skip flag warns and is treated as absent", () => {
  for (const flag of SKIP_FLAGS) {
    for (const bad of ["yes", 1, null, {}, 0]) {
      const r = mergeConfig(base(), [
        {
          source: "project",
          data: {
            agents: {
              planner: {
                [flag]: bad,
                primary: { model: "claude-bridge/claude-opus-5-6" },
              },
            },
          },
        },
      ]);
      const label = `${flag}=${JSON.stringify(bad)}`;
      assert.ok(
        r.warnings.some((w) => w.includes(flag)),
        `${label}: ${r.warnings.join("\n")}`,
      );
      // Treated as absent, so the rest of the entry still applies.
      assert.equal(r.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-6", label);
      assert.equal(r.sources["agents.planner.primary.model"], "project", label);
    }
  }
});

// -------------------------------------------------------------------- null

// `null` is no longer an eraser anywhere. It warns and leaves the previous
// layer's value standing.

test("a route-level null warns and leaves the previous route standing", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { implementer: null } } },
  ]);
  assert.ok(r.warnings.some((w) => w.includes("implementer")), r.warnings.join("\n"));
  assert.deepEqual(r.config.agents.implementer, base().agents.implementer);
  assert.equal(r.sources["agents.implementer.primary.model"], "built-in");
});

test("a candidate-level null warns and leaves the previous candidate standing", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { primary: null } } } },
  ]);
  assert.ok(r.warnings.some((w) => w.includes("planner")), r.warnings.join("\n"));
  assert.deepEqual(r.config.agents.planner, base().agents.planner);
  assert.equal(r.sources["agents.planner.primary.model"], "built-in");
});

test("a null inside alternates warns and leaves the whole previous list standing", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { alternates: [null] } } } },
  ]);
  assert.ok(r.warnings.length >= 1, r.warnings.join("\n"));
  assert.deepEqual(r.config.agents.planner.alternates, base().agents.planner.alternates);
  assert.equal(r.sources["agents.planner.alternates[0].model"], "built-in");
});

// ---------------------------------------------------------------- the routes hint

test('"routes" warns with a rename hint to "agents" and is not an alias', () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { routes: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } } },
    },
  ]);
  assert.ok(
    r.warnings.some((w) => w.includes("routes") && w.includes("agents")),
    r.warnings.join("\n"),
  );
  // A hint, not an alias: the old spelling changes nothing.
  assert.deepEqual(r.config.agents, base().agents);
});

// ---------------------------------------------------------------- validation

test("mergeConfig warns about an unknown top-level key and ignores it", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { bogusKey: true } }]);
  assert.ok(r.warnings.some((w) => w.includes("bogusKey")), r.warnings.join("\n"));
  assert.deepEqual(r.config, base());
});

test("mergeConfig warns about unknown keys inside an agent and a candidate", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { bogusAgent: 1, primary: { bogusCandidate: 2 } } } } },
  ]);
  assert.ok(r.warnings.some((w) => w.includes("bogusAgent")), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => w.includes("bogusCandidate")), r.warnings.join("\n"));
});

test("mergeConfig warns and keeps the previous value for a wrong-typed scalar", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { sessionSwitchAt: "75" } }]);
  assert.equal(r.config.sessionSwitchAt, 75);
  assert.equal(r.sources.sessionSwitchAt, "built-in");
  assert.ok(r.warnings.some((w) => w.includes("sessionSwitchAt")), r.warnings.join("\n"));
});

test("mergeConfig applies claudeCredsPath but rejects the agent-dir-owned path scalars", () => {
  const defaults = base();
  for (const source of ["global", "project"] as const) {
    const r = mergeConfig(base(), [
      { source, data: { claudeCredsPath: "/custom/claude-credentials.json" } },
    ]);
    assert.deepEqual(r.warnings, [], r.warnings.join("\n"));
    assert.equal(r.config.claudeCredsPath, "/custom/claude-credentials.json", `${source} claudeCredsPath value`);
    assert.equal(r.sources.claudeCredsPath, source, `${source} claudeCredsPath source`);
    // The two path scalars this layer did not name stay built-in.
    for (const other of ["agentDir", "piAuthPath"] as const) {
      assert.equal(r.config[other], defaults[other], `${source}: ${other} should be untouched`);
      assert.equal(r.sources[other], "built-in", `${source}: ${other} source`);
    }

    // `agentDir` and `piAuthPath` are pi's paths, not the file's: they warn and
    // the built-in value stands.
    for (const key of ["agentDir", "piAuthPath"] as const) {
      const rejected = mergeConfig(base(), [{ source, data: { [key]: "/custom/x" } }]);
      assert.equal(rejected.config[key], defaults[key], `${source} ${key} value`);
      assert.equal(rejected.sources[key], "built-in", `${source} ${key} source`);
      assert.ok(
        rejected.warnings.some((w) => w.includes(key) && w.includes(source)),
        `${source} ${key}: ${rejected.warnings.join("\n")}`,
      );
    }
  }
});

test("mergeConfig warns and keeps the previous value for a wrong-typed path scalar", () => {
  for (const wrong of [42, null, true]) {
    const r = mergeConfig(base(), [{ source: "project", data: { claudeCredsPath: wrong } }]);
    assert.equal(r.config.claudeCredsPath, base().claudeCredsPath);
    assert.equal(r.sources.claudeCredsPath, "built-in");
    assert.ok(
      r.warnings.some((w) => w.includes("claudeCredsPath")),
      `for ${String(wrong)}: ${r.warnings.join("\n")}`,
    );
  }
});

test("an invalid project path scalar does not clobber a valid global one", () => {
  const r = mergeConfig(base(), [
    { source: "global", data: { claudeCredsPath: "/global/creds.json" } },
    { source: "project", data: { claudeCredsPath: 42 } },
  ]);
  assert.equal(r.config.claudeCredsPath, "/global/creds.json");
  assert.equal(r.sources.claudeCredsPath, "global");
  assert.ok(r.warnings.some((w) => w.includes("claudeCredsPath")), r.warnings.join("\n"));
});

test("mergeConfig warns on a non-finite number and keeps the previous value", () => {
  // `1e400` is the JSON spelling of Infinity: `Number.isFinite` alone is not
  // enough, and neither null nor an overflowed literal may land on the config.
  for (const raw of ["null", "1e400", "-1e400"]) {
    const data = JSON.parse(`{"margin": ${raw}}`);
    const r = mergeConfig(base(), [{ source: "project", data }]);
    assert.equal(r.config.margin, 10, `for margin: ${raw}`);
    assert.equal(r.sources.margin, "built-in", `for margin: ${raw}`);
    assert.ok(r.warnings.some((w) => w.includes("margin")), `for margin: ${raw}: ${r.warnings.join("\n")}`);
  }
});

test("mergeConfig warns when a model is not a string or lacks a slash", () => {
  const notString = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { primary: { model: 123 } } } } },
  ]);
  assert.equal(notString.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.ok(notString.warnings.some((w) => w.includes("model")), notString.warnings.join("\n"));

  const noSlash = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { primary: { model: "gpt-6-sol" } } } } },
  ]);
  assert.equal(noSlash.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.ok(noSlash.warnings.some((w) => w.includes("model")), noSlash.warnings.join("\n"));
});

test("mergeConfig warns on an unknown rail and keeps the previous one", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { primary: { rail: "openai" } } } } },
  ]);
  assert.equal(r.config.agents.planner.primary.rail, "claude");
  assert.ok(r.warnings.some((w) => w.includes("rail")), r.warnings.join("\n"));
});

test("mergeConfig rejects a new agent proposed without a primary", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { newbie: { alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }] } } },
    },
  ]);
  assert.equal("newbie" in r.config.agents, false);
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("primary")), r.warnings.join("\n"));
  assert.deepEqual(
    Object.keys(r.sources).filter((k) => k.startsWith("agents.newbie")),
    [],
  );
});

test("mergeConfig warns but applies a model whose prefix names a different rail", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "claude" } } } },
    },
  ]);
  assert.equal(r.config.agents.planner.primary.model, "openai-codex/gpt-6-sol");
  assert.equal(r.config.agents.planner.primary.rail, "claude");
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("rail")), r.warnings.join("\n"));
});

test("mergeConfig does not warn when a model's prefix matches its declared rail", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.planner.primary.model, "openai-codex/gpt-6-sol");
  assert.equal(r.config.agents.planner.primary.rail, "codex");
});

test("mergeConfig accepts the claude-bridge model on the claude rail", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { implementer: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
});

test("mergeConfig rejects numeric scalars outside their documented range", () => {
  const invalid: Array<[string, unknown]> = [
    ["ttlMs", 0],
    ["ttlMs", 2_147_483_648],
    ["ttlMs", 1.5],
    ["pollMs", -1],
    ["pollMs", 2_147_483_648],
    ["sessionSwitchAt", 101],
    ["sessionSwitchAt", -0.5],
    ["weeklySwitchAt", 100.5],
    ["margin", -1],
    ["margin", 101],
    ["margin", Number.POSITIVE_INFINITY],
  ];
  for (const [key, value] of invalid) {
    const r = mergeConfig(base(), [{ source: "project", data: { [key]: value } }]);
    const read = (r.config as unknown as Record<string, unknown>)[key];
    assert.equal(read, (base() as unknown as Record<string, unknown>)[key], `${key}=${String(value)} value`);
    assert.equal(r.sources[key], "built-in", `${key}=${String(value)} source`);
    assert.ok(r.warnings.some((w) => w.includes(key)), `${key}=${String(value)}: ${r.warnings.join("\n")}`);
  }

  // The boundaries themselves are inside the range, not rejected.
  const valid: Array<[string, number]> = [
    ["ttlMs", 1],
    ["pollMs", 2_147_483_647],
    ["sessionSwitchAt", 0],
    ["weeklySwitchAt", 100],
    ["margin", 0],
  ];
  for (const [key, value] of valid) {
    const r = mergeConfig(base(), [{ source: "project", data: { [key]: value } }]);
    assert.deepEqual(r.warnings, [], `${key}=${value}`);
    assert.equal((r.config as unknown as Record<string, unknown>)[key], value, `${key}=${value}`);
  }
});

test("mergeConfig rejects an agent name that is not a safe filename", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { "../outside": { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } } },
    },
  ]);
  assert.equal("../outside" in r.config.agents, false, "a traversal name must not become an agent");
  assert.ok(r.warnings.some((w) => w.includes("../outside")), r.warnings.join("\n"));
  // The base agents are untouched.
  assert.deepEqual(Object.keys(r.config.agents).sort(), ["implementer", "planner", "reviewer"]);
});

test("mergeConfig drops a programmatically built base route whose name is unsafe", () => {
  const built = base();
  // A base config does not have to have come from `defaultConfig()`: a caller
  // can hand `mergeConfig` anything, so the base's own keys are validated too.
  built.agents["../outside"] = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [],
  };
  built.agents["constructor"] = {
    primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
    alternates: [],
  };
  built.agents["toString"] = {
    primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
    alternates: [],
  };
  built.agents["code-reviewer"] = {
    primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
    alternates: [],
  };

  const r = mergeConfig(built, []);
  assert.equal(Object.hasOwn(r.config.agents, "../outside"), false);
  assert.equal(Object.hasOwn(r.config.agents, "constructor"), false);
  assert.equal(Object.hasOwn(r.config.agents, "toString"), false);
  assert.ok(
    r.warnings.some((w) => w.startsWith("built-in:") && w.includes("../outside")),
    r.warnings.join("\n"),
  );
  assert.ok(
    r.warnings.some((w) => w.startsWith("built-in:") && w.includes("constructor")),
    r.warnings.join("\n"),
  );
  assert.ok(
    r.warnings.some((w) => w.startsWith("built-in:") && w.includes("toString")),
    r.warnings.join("\n"),
  );
  assert.deepEqual(
    Object.keys(r.sources).filter((k) => k.includes("../outside") || k.includes("constructor") || k.includes("toString")),
    [],
  );

  // The control: a legitimate dashed name in the same base is still managed.
  assert.equal(r.config.agents["code-reviewer"].primary.model, "deepseek/deepseek-flash");
  assert.equal(r.sources["agents.code-reviewer.primary.model"], "built-in");
});

test("a layer-level null on an unsafe base name leaves it absent", () => {
  const built = base();
  built.agents["../outside"] = {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [],
  };
  built.agents["constructor"] = {
    primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
    alternates: [],
  };

  const r = mergeConfig(built, [
    { source: "project", data: { agents: { "../outside": null, constructor: null } } },
  ]);
  assert.equal(Object.hasOwn(r.config.agents, "../outside"), false);
  assert.equal(Object.hasOwn(r.config.agents, "constructor"), false);
  assert.ok(r.warnings.some((w) => w.includes("../outside")), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => w.includes("constructor")), r.warnings.join("\n"));
});

test("mergeConfig accepts a dashed agent name", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { agents: { "agent-2": { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" } } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents["agent-2"].primary.model, "openai-codex/gpt-6-astra");
  assert.deepEqual(r.config.agents["agent-2"].alternates, []);
});

test("mergeConfig prefixes warnings with the layer's label, defaulting to its source", () => {
  const r = mergeConfig(base(), [
    { source: "project", label: "/work/proj/.pi/quota-dispatch.json", data: { bogusKey: true } },
    { source: "global", data: { alsoBogus: true } },
  ]);
  assert.ok(
    r.warnings.some((w) => w.startsWith("/work/proj/.pi/quota-dispatch.json: ")),
    r.warnings.join("\n"),
  );
  assert.ok(r.warnings.some((w) => w.startsWith("global: ")), r.warnings.join("\n"));
});

test("across layer permutations, a project-set key always wins", () => {
  const values = [11, 22, 33, 44];
  for (const globalValue of values) {
    for (const projectValue of values) {
      // Distinct per layer so a precedence bug cannot hide behind identical
      // values: if the global value were applied while labelled project (or
      // vice versa), the value assertion catches it, not just the source.
      if (globalValue === projectValue) continue;
      for (const setGlobal of [false, true]) {
        for (const setProject of [false, true]) {
          const layers: MergeLayer[] = [];
          if (setGlobal) layers.push({ source: "global", data: { sessionSwitchAt: globalValue } });
          if (setProject) layers.push({ source: "project", data: { sessionSwitchAt: projectValue } });
          const r = mergeConfig(base(), layers);
          const expectedSource = setProject ? "project" : setGlobal ? "global" : "built-in";
          const expectedValue = setProject ? projectValue : setGlobal ? globalValue : 75;
          assert.equal(r.config.sessionSwitchAt, expectedValue);
          assert.equal(r.sources.sessionSwitchAt, expectedSource);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- loadConfig

test("loadConfig reads exactly the global and project paths derived from deps", async () => {
  const fs = fakeFs({});
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile });
  assert.deepEqual(fs.reads.slice().sort(), [GLOBAL_PATH, PROJECT_PATH].sort());

  assert.equal(loaded.files.length, 2);
  const bySource = new Map(loaded.files.map((f) => [f.source, f] as const));
  assert.equal(bySource.get("global")?.path, GLOBAL_PATH);
  assert.equal(bySource.get("project")?.path, PROJECT_PATH);
});

test("loadConfig skips missing files silently and uses the built-in defaults", async () => {
  const fs = fakeFs({});
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile });
  assert.deepEqual(loaded.warnings, []);
  assert.ok(loaded.files.every((f) => f.state.kind === "absent"));
  assert.deepEqual(loaded.config, defaultConfig(AGENT_DIR));
  assert.equal(loaded.sources.sessionSwitchAt, "built-in");
});

test("loadConfig warns on unparseable JSON, reports it unusable, and uses defaults", async () => {
  const fs = fakeFs({ [GLOBAL_PATH]: "{ this is not json" });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.files.find((f) => f.source === "global")?.state.kind, "unusable");
  assert.ok(loaded.warnings.some((w) => w.includes(GLOBAL_PATH)), loaded.warnings.join("\n"));
  assert.deepEqual(loaded.config, defaultConfig(AGENT_DIR));
});

// What the reader is told about a file that did not parse. The engine's message
// alone names a byte offset in a file nobody has opened; the warning has to name
// the file, put the failure on a line that can be gone to, and say that nothing
// from the file is in force — a skipped layer leaves the ones below it running,
// which looks exactly like a config that worked.
//
// The trailing comma is the everyday case, and it is also the one where the
// engine's own wording is the diagnosis: "Expected double-quoted property
// name" is what a comma before a `}` looks like.
test("a file that is not JSON is reported at its line and column, and says it was skipped", async () => {
  const fs = fakeFs({ [GLOBAL_PATH]: '{\n  "sessionSwitchAt": 55,\n}' });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  const warning = loaded.warnings.find((w) => w.includes(GLOBAL_PATH));

  assert.ok(warning, loaded.warnings.join("\n"));
  assert.ok(warning.startsWith(`${GLOBAL_PATH}: not valid JSON (`), warning);
  assert.ok(warning.includes("line 3, column 1"), warning);
  // The engine says "in JSON at position 12" here. The offset is left out
  // rather than printed beside the line: it is the same fact, and it is the
  // spelling that makes the reader count their way through the file.
  assert.ok(!warning.includes("position"), warning);
  assert.ok(warning.endsWith("— the file is skipped whole, so the layers below it still apply"), warning);
});

// The engine has a second shape: newer V8 quotes the offending text back at the
// reader — `Unexpected token 'x', "x" is not valid JSON` — which repeats the
// verdict and, for a file whose text spans lines, would carry newlines into a
// message every surface renders as one line.
test("a rejected token is reported without the engine quoting the file back", async () => {
  const fs = fakeFs({ [PROJECT_PATH]: '{\n  // comment\n  "sessionSwitchAt": 55\n}' });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  const warning = loaded.warnings.find((w) => w.includes(PROJECT_PATH));

  assert.ok(warning, loaded.warnings.join("\n"));
  assert.equal(warning.split("\n").length, 1, warning);
  assert.ok(warning.startsWith(`${PROJECT_PATH}: not valid JSON (`), warning);
  assert.ok(!warning.includes("is not valid JSON)"), warning);
  assert.ok(warning.includes("line 2, column 3"), warning);
});

// An empty file — the shape a `touch`ed config has — is the realistic way to
// reach an engine error that names no place at all: `Unexpected end of JSON
// input` is its whole message. Inventing line 1 column 1 would be pointing
// somewhere the reader is not.
test("a file the parser ran out of is reported without a made-up location", async () => {
  const fs = fakeFs({ [PROJECT_PATH]: "" });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });

  assert.deepEqual(loaded.warnings, [
    `${PROJECT_PATH}: not valid JSON (Unexpected end of JSON input) — the file is skipped whole, so the layers below it still apply`,
  ]);
});

// The promise the warning makes, checked against what the loader did: a skipped
// project layer leaves the global one in force, so the numbers on screen are the
// lower layer's even though the file names other ones.
test("a skipped layer leaves the layers below it in force, as the warning says", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({ sessionSwitchAt: 55 }),
    [PROJECT_PATH]: "{ broken",
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });

  assert.equal(loaded.config.sessionSwitchAt, 55);
  assert.equal(loaded.sources.sessionSwitchAt, "global");
  assert.equal(loaded.files.find((f) => f.source === "project")?.state.kind, "unusable");
  assert.equal(loaded.files.find((f) => f.source === "global")?.state.kind, "applied");
  assert.ok(
    loaded.warnings.every((w) => w.includes("the layers below it still apply")),
    loaded.warnings.join("\n"),
  );
});

// One rendering of one fact: the startup notice prints these same lines, and it
// is handed the files rather than the warnings precisely so that it does not
// have to take the warning text back apart to find them.
test("the warning for an unusable file is exactly the line the notice prints", async () => {
  const fs = fakeFs({ [GLOBAL_PATH]: "{ broken", [PROJECT_PATH]: "[1,2]" });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  const lines = unusableConfigFileLines(loaded.files);

  assert.equal(lines.length, 2);
  assert.deepEqual(lines, loaded.warnings);
  assert.ok(lines[0].startsWith(`${GLOBAL_PATH}: not valid JSON`), lines[0]);
  // Valid JSON, and still not a config: said in the same shape, with the same
  // consequence, because the layer was dropped either way.
  assert.equal(
    lines[1],
    `${PROJECT_PATH}: config must be a JSON object — the file is skipped whole, so the layers below it still apply`,
  );
});

test("an unreadable file is reported as unreadable rather than as absent or unparseable", async () => {
  const readFile = async (path: string): Promise<string> => {
    const err = new Error(`EACCES: permission denied, open '${path}'`);
    (err as NodeJS.ErrnoException).code = "EACCES";
    throw err;
  };
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile, warn: () => {} });

  for (const file of loaded.files) assert.equal(file.state.kind, "unusable");
  assert.ok(loaded.warnings.some((w) => w.startsWith(`${GLOBAL_PATH}: could not be read (`)), loaded.warnings.join("\n"));
});

// The engine's message is not ours to control: its shape has changed across V8
// versions, and it reports the place in the file in one of two spellings — or,
// when it quotes the offending character, in none at all. Synthetic messages pin
// the whole table, so what a run of Node happens to say does not decide what is
// asserted.
test("a parse failure is understood whatever spelling of it the engine uses", () => {
  const text = '{\n  "a": 1,\n}';
  const fault = (message: string): ConfigFileFault => notJsonFault(text, new SyntaxError(message));

  // The current spelling: a line and a column, with the offset beside it.
  assert.deepEqual(fault("Expected double-quoted property name in JSON at position 12 (line 3 column 1)"), {
    kind: "not-json",
    detail: "Expected double-quoted property name",
    at: { line: 3, column: 1 },
  });
  // The older spelling: the offset is all there is, so it is converted against
  // the file's own text.
  assert.deepEqual(fault("Expected double-quoted property name in JSON at position 12"), {
    kind: "not-json",
    detail: "Expected double-quoted property name",
    at: { line: 3, column: 1 },
  });
  // A failure on the first line, where there is no newline to count from.
  assert.deepEqual(fault("Unexpected token 'x' in JSON at position 0"), {
    kind: "not-json",
    detail: "Unexpected token 'x'",
    at: { line: 1, column: 1 },
  });
  // The spelling that quotes the file back instead of naming a place: the quote
  // goes, and no place is invented to replace it. V8 truncates that quote on
  // either side or both, which is why it is cut rather than matched whole.
  for (const quote of ['"[1,]"', '..." "a/b" }, ] } } }"', '"...",13,14,15,], "b": 2 "...']) {
    assert.deepEqual(fault(`Unexpected token ']', ${quote} is not valid JSON`), {
      kind: "not-json",
      detail: "Unexpected token ']'",
    });
  }
  // The tail that does not say ` in JSON`, and the file's own words for a place.
  assert.deepEqual(fault("Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)"), {
    kind: "not-json",
    detail: "Unexpected non-whitespace character after JSON",
    at: { line: 1, column: 8 },
  });
  assert.deepEqual(fault('Unexpected token \']\', "[\"at position 5\",]" is not valid JSON'), {
    kind: "not-json",
    detail: "Unexpected token ']'",
  });
  // A file that ends before its JSON does names no place either, and none is
  // invented.
  assert.deepEqual(fault("Unexpected end of JSON input"), {
    kind: "not-json",
    detail: "Unexpected end of JSON input",
  });
  // A message that is nothing but the quote says nothing about the fault, and
  // the rendering still gives the verdict.
  assert.deepEqual(fault('"NaN" is not valid JSON'), { kind: "not-json", detail: "" });
});

/**
 * The rendered warning for one fault, through the same renderer the log, the
 * report and the startup notice use.
 */
function faultLine(fault: ConfigFileFault): string {
  return unusableConfigFileLines([
    { source: "global", path: GLOBAL_PATH, state: { kind: "unusable", fault } },
  ])[0];
}

/** The real error `JSON.parse` throws for `text`, so the engine's own wording is
 * under test rather than our guess at it. */
function parseError(text: string): unknown {
  try {
    JSON.parse(text);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${JSON.stringify(text)} not to parse`);
}

// A fault has to be one line, and it must not carry the file's own text: the
// parser quotes that text back, and a config is the user's. Every case asserts
// the exact line, because a line that merely *lacks* the file's text can also be
// one that invented a position instead.
test("a fault is one line, and never quotes the file back", () => {
  const expected = (detail: string): string =>
    `${GLOBAL_PATH}: not valid JSON (${detail}) — the file is skipped whole, so the layers below it still apply`;
  const cases: Array<[string, string, string]> = [
    // The engine's window around a `/` carries the file's own newline and the
    // beginning of a path, which is what the reader must not get back.
    [
      '{ "claudeCredsPath": "/home/me/.credentials.json",\n  "x": /home/me/.credentials.json\n}',
      "home/me",
      "Unexpected token '/'",
    ],
    // The engine's own words for a place, as a value in the file. Read out of the
    // quote, they would be a position the file never failed at.
    ['["at position 5",]', "at position 5", "Unexpected token ']'"],
  ];

  for (const [text, fileText, detail] of cases) {
    const err = parseError(text) as Error;
    // The premise, asserted rather than assumed: the parser really does repeat
    // the file back here, so the line below is not passing for want of anything
    // to strip.
    assert.ok(err.message.includes(fileText), `the engine must quote ${fileText}: ${err.message}`);

    const line = faultLine(notJsonFault(text, err));
    assert.equal(line.split("\n").length, 1, line);
    assert.equal(line, expected(detail), text);
  }
});

// The verdict is said once: the engine's `"…" is not valid JSON` tail repeats
// what the line has already said.
test("the engine's verdict is not repeated back", () => {
  const text = '{ "a": [1,] }';
  const line = faultLine(notJsonFault(text, parseError(text)));

  assert.ok(line.includes("not valid JSON"), line);
  assert.ok(!line.includes("is not valid JSON"), line);
});

// A stray `}` at the end of an otherwise finished document is a common edit
// mistake, and it is the one engine message that does not say ` in JSON` before
// its offset: the offset and the line-and-column are the same fact, and only one
// of them belongs on the line.
test("an offset is not printed beside the position it duplicates", () => {
  const text = '{"a":1}}';
  assert.equal(
    faultLine(notJsonFault(text, parseError(text))),
    `${GLOBAL_PATH}: not valid JSON (line 1, column 8: Unexpected non-whitespace character after JSON) — ` +
      "the file is skipped whole, so the layers below it still apply",
  );
});

// A token the reader cannot see is a token they cannot act on. The parser quotes
// the character that stopped it, and that character is whatever the file holds.
test("an invisible offending character is spelled out", () => {
  for (const [text, spelled] of [
    ["\uFEFF{}", "\\uFEFF"],
    ["\u00A0{}", "\\u00A0"],
    ["\u000B{}", "\\u000B"],
    ["\u2028{}", "\\u2028"],
  ] as const) {
    const line = faultLine(notJsonFault(text, parseError(text)));
    assert.ok(line.includes(spelled), `${JSON.stringify(text)} -> ${line}`);
    assert.equal(line.split("\n").length, 1, line);
  }
});

test("a thrown value that is not an Error still yields a fault", () => {
  assert.deepEqual(notJsonFault("{}", "a string was thrown"), {
    kind: "not-json",
    detail: "a string was thrown",
  });
});

// Every fault is rendered as a warning line, so no fault may bring a line break
// with it — from a quoted character, or from an operating system message that
// happens to wrap. One place escapes them, and this is what says so.
test("every fault renders as one line, whatever it carries", () => {
  const faults: ConfigFileFault[] = [
    { kind: "unreadable", detail: "EACCES: permission denied,\nopen 'x'" },
    { kind: "not-json", detail: "Expected\nproperty name" },
    { kind: "not-an-object" },
  ];

  for (const fault of faults) {
    const line = faultLine(fault);
    assert.equal(line.split("\n").length, 1, JSON.stringify(line));
  }
});

// A code point above the basic plane needs five hex digits, and four cannot hold
// it: `\uE0041` reads as `\uE004` and then a `1`.
test("an invisible character above the basic plane is escaped unambiguously", () => {
  const line = faultLine({ kind: "unreadable", detail: "a\u{E0041}b" });
  assert.ok(line.includes("a\\u{E0041}b"), line);
});

// The engine's own words are kept where they diagnose: "Expected double-quoted
// property name" is what a trailing comma looks like.
test("the rendering keeps the parser's diagnosis and places it in the file", () => {
  const text = '{\n  "a": 1,\n}';
  assert.equal(
    faultLine(notJsonFault(text, parseError(text))),
    `${GLOBAL_PATH}: not valid JSON (line 3, column 1: Expected double-quoted property name) — ` +
      "the file is skipped whole, so the layers below it still apply",
  );
});

test("loadConfig warns and skips non-object JSON", async () => {
  for (const raw of ["[1,2]", "null", "42", '"a string"', "true"]) {
    const fs = fakeFs({ [PROJECT_PATH]: raw });
    const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
    assert.ok(
      loaded.warnings.some((w) => w.includes(PROJECT_PATH)),
      `expected a warning for ${raw}: ${loaded.warnings.join(" | ")}`,
    );
    assert.deepEqual(loaded.config, defaultConfig(AGENT_DIR));
  }
});

test("loadConfig applies a global-only override", async () => {
  const fs = fakeFs({ [GLOBAL_PATH]: JSON.stringify({ sessionSwitchAt: 55 }) });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.config.sessionSwitchAt, 55);
  assert.equal(loaded.sources.sessionSwitchAt, "global");
});

test("loadConfig applies a project-only override", async () => {
  const fs = fakeFs({ [PROJECT_PATH]: JSON.stringify({ sessionSwitchAt: 40 }) });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.config.sessionSwitchAt, 40);
  assert.equal(loaded.sources.sessionSwitchAt, "project");
});

test("loadConfig lets the project layer win over the global one", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({ sessionSwitchAt: 55, margin: 20 }),
    [PROJECT_PATH]: JSON.stringify({ sessionSwitchAt: 40 }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.config.sessionSwitchAt, 40);
  assert.equal(loaded.sources.sessionSwitchAt, "project");
  assert.equal(loaded.config.margin, 20);
  assert.equal(loaded.sources.margin, "global");
});

test("a project layer can name an agent, leaving the scalars at their defaults", async () => {
  const fs = fakeFs({
    [PROJECT_PATH]: JSON.stringify({
      agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } },
    }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.config.sessionSwitchAt, 75);
  assert.deepEqual(Object.keys(loaded.config.agents), ["planner"]);
  // No `alternates` was named, so the agent is pinned to its primary.
  assert.deepEqual(loaded.config.agents.planner.alternates, []);
  assert.equal(loaded.sources["agents.planner.primary.model"], "project");
});

// Agent-file diagnostics belong to the boot check, not config-file loading.
test("loadConfig keeps an absent configured agent without emitting an agent-file warning", async () => {
  const fs = fakeFs({
    [PROJECT_PATH]: JSON.stringify({
      agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } },
    }),
  });
  const logged: string[] = [];
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: (w) => logged.push(w) });
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(logged, []);
  assert.ok(loaded.config.agents.planner, "the agent stays configured");
  assert.equal(loaded.sources["agents.planner.primary.model"], "project");
});

test("loadConfig stays silent when a configured agent's file exists", async () => {
  const fs = fakeFs({
    [PROJECT_PATH]: JSON.stringify({
      agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } },
    }),
  });
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: () => {},
  });
  assert.deepEqual(loaded.warnings, []);
});

test("an invalid project value does not clobber a valid global value", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({ sessionSwitchAt: 55 }),
    [PROJECT_PATH]: JSON.stringify({ sessionSwitchAt: "not-a-number" }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.config.sessionSwitchAt, 55);
  assert.equal(loaded.sources.sessionSwitchAt, "global");
  assert.ok(loaded.warnings.some((w) => w.includes(PROJECT_PATH)), loaded.warnings.join("\n"));
});

test("a validation warning names the file it came from", async () => {
  const fs = fakeFs({ [PROJECT_PATH]: JSON.stringify({ bogus: 1 }) });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.ok(
    loaded.warnings.some((w) => w.includes(PROJECT_PATH) && w.includes("bogus")),
    loaded.warnings.join("\n"),
  );
});

test("loadConfig returns warnings and also hands each to the injected warn sink", async () => {
  const seen: string[] = [];
  const fs = fakeFs({ [GLOBAL_PATH]: "{ bad json" });
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: (m) => {
      seen.push(m);
    },
  });
  assert.ok(loaded.warnings.length >= 1);
  assert.deepEqual(seen, loaded.warnings);
});

test("loadConfig routes warnings to console.error when no warn is injected", async () => {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const fs = fakeFs({ [GLOBAL_PATH]: "{ bad json" });
    await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile });
  } finally {
    console.error = original;
  }
  assert.ok(calls.length >= 1, "expected console.error to be called");
  assert.ok(
    calls.some((args) => String(args[0]).includes(GLOBAL_PATH)),
    JSON.stringify(calls),
  );
});

test("loadConfig never rejects when readFile fails with a non-ENOENT error", async () => {
  const readFile = async (path: string): Promise<string> => {
    const err = new Error(`EACCES: permission denied, open '${path}'`);
    (err as NodeJS.ErrnoException).code = "EACCES";
    throw err;
  };
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile, warn: () => {} });
  assert.deepEqual(loaded.config, defaultConfig(AGENT_DIR));
  assert.ok(loaded.warnings.length >= 1, "expected a warning for the unreadable files");
  // A file that is there but cannot be read is unusable, not absent: "absent"
  // would send someone looking for a file that is exactly where they left it.
  assert.ok(loaded.files.every((f) => f.state.kind === "unusable"), JSON.stringify(loaded.files));
  assert.ok(loaded.warnings.some((w) => w.includes(GLOBAL_PATH)), loaded.warnings.join("\n"));
  assert.ok(loaded.warnings.some((w) => w.includes(PROJECT_PATH)), loaded.warnings.join("\n"));
});

test("loadConfig with no deps resolves the relocated agent dir from PI_CODING_AGENT_DIR", async () => {
  const root = await mkdtemp(join(tmpdir(), "pqd-load-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ sessionSwitchAt: 33 }), "utf8");

  const previousEnv = process.env[ENV_AGENT_DIR];
  const previousCwd = process.cwd();
  process.env[ENV_AGENT_DIR] = agentDir;
  process.chdir(projectDir);
  try {
    // The only test that exercises the default read path: real `getAgentDir()`
    // and real `readFile`, with no `deps` to point them anywhere.
    assert.equal(globalConfigPath(), join(agentDir, CONFIG_FILE_NAME));

    const loaded = await loadConfig({ warn: () => {} });
    const global = loaded.files.find((f) => f.source === "global");
    const project = loaded.files.find((f) => f.source === "project");
    assert.equal(global?.path, join(agentDir, CONFIG_FILE_NAME));
    assert.equal(global?.state.kind, "applied");
    assert.equal(project?.state.kind, "absent");
    assert.equal(loaded.config.sessionSwitchAt, 33);
    assert.equal(loaded.sources.sessionSwitchAt, "global");
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previousEnv;
  }
});

// ---------------------------------------------------------------- describeConfig

async function loadedWithProjectOverride(): Promise<LoadedConfig> {
  const fs = fakeFs({ [PROJECT_PATH]: JSON.stringify({ sessionSwitchAt: 42 }) });
  return loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
}

/** A loaded config with two configured agents and a two-element alternate list. */
async function loadedWithAgents(): Promise<LoadedConfig> {
  const fs = fakeFs({
    [PROJECT_PATH]: JSON.stringify({
      agents: {
        planner: {
          primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
          alternates: [
            { model: "openai-codex/gpt-6-sol", rail: "codex" },
            { model: "deepseek/deepseek-flash", rail: "deepseek" },
          ],
        },
        reviewer: {
          primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
          alternates: [],
        },
      },
    }),
  });
  return loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: () => {},
  });
}

/**
 * The layers line and the warnings are the two pieces the report carries in
 * place of the block — "which files am I reading?" and "what went wrong?" —
 * so they are named apart from it and pinned on their own. `describeConfig`
 * composes them; a change that dropped one from the block would otherwise fail
 * only the block's tests.
 */
test("describeConfigLayers names the layers and both files' presence, and opens the block", async () => {
  const loaded = await loadedWithProjectOverride();
  const line = describeConfigLayers(loaded);

  assert.ok(line.startsWith("config:"), line);
  assert.ok(line.includes("built-in"), line);
  assert.ok(line.includes(`global ${GLOBAL_PATH} (absent)`), line);
  assert.ok(line.includes(`project ${PROJECT_PATH} (present)`), line);
  assert.equal(describeConfig(loaded)[0], line, "the block must open with the same line");
});

test("describeConfigWarnings renders one prefixed line per warning and none when there are none", async () => {
  const clean = await loadedWithProjectOverride();
  assert.deepEqual(describeConfigWarnings(clean), []);

  const fs = fakeFs({ [GLOBAL_PATH]: "{ broken" });
  const dirty = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.ok(dirty.warnings.length >= 1);
  assert.deepEqual(
    describeConfigWarnings(dirty),
    dirty.warnings.map((warning) => `  warning: ${warning}`),
  );
  // The block reproduces them rather than wording them a second time.
  for (const line of describeConfigWarnings(dirty)) assert.ok(describeConfig(dirty).includes(line), line);
});

test("describeConfig renders one sourced line per value and marks the project override", async () => {
  const loaded = await loadedWithProjectOverride();
  const lines = describeConfig(loaded);

  const overridden = lines.find((l) => l.includes("sessionSwitchAt"));
  assert.ok(overridden, lines.join("\n"));
  assert.ok(overridden.includes("42"), overridden);
  assert.ok(overridden.includes("[project]"), overridden);

  const untouched = lines.find((l) => l.includes("ttlMs"));
  assert.ok(untouched, lines.join("\n"));
  assert.ok(untouched.includes("180000"), untouched);
  assert.ok(untouched.includes("[built-in]"), untouched);
});

test("describeConfig emits agents.<name>.primary.model and agents.<name>.alternates[N].model", async () => {
  const loaded = await loadedWithAgents();
  const lines = describeConfig(loaded);
  const lineFor = (key: string): string | undefined => lines.find((l) => l.startsWith(`  ${key} = `));

  const primary = lineFor("agents.planner.primary.model");
  assert.ok(primary, lines.join("\n"));
  assert.ok(primary.includes("claude-bridge/claude-opus-5-5"), primary);
  assert.ok(primary.includes("[project]"), primary);

  for (const index of [0, 1]) {
    const line = lineFor(`agents.planner.alternates[${index}].model`);
    assert.ok(line, `missing alternates[${index}]\n${lines.join("\n")}`);
    assert.ok(line.includes("[project]"), line);
  }
  assert.ok(
    lineFor("agents.planner.alternates[0].model")!.includes("openai-codex/gpt-6-sol"),
    lines.join("\n"),
  );
  assert.ok(
    lineFor("agents.planner.alternates[1].rail")!.includes("deepseek"),
    lines.join("\n"),
  );
});

test("describeConfig shows a disabled agent once as agents.<name> = disabled [<layer>]", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({
      agents: {
        planner: {
          primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
          alternates: [],
        },
      },
    }),
    [PROJECT_PATH]: JSON.stringify({ agents: { planner: { disable: true } } }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  const lines = describeConfig(loaded);

  const disabled = lines.filter((l) => l.includes("agents.planner = disabled"));
  assert.equal(disabled.length, 1, lines.join("\n"));
  assert.match(disabled[0], /agents\.planner = disabled\s+\[project\]/);
  // The agent is gone from the effective table, so no candidate lines remain.
  assert.equal(
    lines.some((l) => l.startsWith("  agents.planner.primary")),
    false,
    lines.join("\n"),
  );
});

test("describeConfig lists the path scalars with their sources", async () => {
  const fs = fakeFs({ [PROJECT_PATH]: JSON.stringify({ claudeCredsPath: "/custom/claude-credentials.json" }) });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  const lines = describeConfig(loaded);
  const lineFor = (key: string): string | undefined => lines.find((l) => l.includes(key) && l.includes(" = "));

  const creds = lineFor("claudeCredsPath");
  assert.ok(creds, lines.join("\n"));
  assert.ok(creds.includes("/custom/claude-credentials.json"), creds);
  assert.ok(creds.includes("[project]"), creds);

  for (const key of ["agentDir", "piAuthPath"]) {
    const line = lineFor(key);
    assert.ok(line, `missing ${key}\n${lines.join("\n")}`);
    assert.ok(line.includes("[built-in]"), line);
  }
});

test("describeConfig lists scalars before agents and sorts agents by name", async () => {
  const loaded = await loadedWithAgents();
  const lines = describeConfig(loaded);

  const firstAgent = lines.findIndex((l) => l.includes("agents."));
  assert.ok(firstAgent > 0, lines.join("\n"));
  for (const scalar of ["agentDir", "claudeCredsPath", "piAuthPath", "ttlMs", "pollMs", "sessionSwitchAt", "weeklySwitchAt", "margin"]) {
    const i = lines.findIndex((l) => l.includes(scalar));
    assert.ok(i >= 0, `missing ${scalar}`);
    assert.ok(i < firstAgent, `${scalar} should come before the agent lines`);
  }

  const planner = lines.findIndex((l) => l.includes("agents.planner."));
  const reviewer = lines.findIndex((l) => l.includes("agents.reviewer."));
  assert.ok(planner >= 0 && reviewer >= 0, lines.join("\n"));
  assert.ok(planner < reviewer, `agents out of order: ${lines.join(" | ")}`);

  for (const l of lines.slice(1).filter((l) => l.includes(" = "))) {
    assert.match(l, /\[(?:built-in|global|project)\]\s*$/);
  }
});

test("describeConfig includes a warning line per warning and none when there are none", async () => {
  const clean = await loadedWithProjectOverride();
  assert.ok(!describeConfig(clean).some((l) => l.includes("warning:")));

  const fs = fakeFs({ [GLOBAL_PATH]: "{ broken" });
  const dirty = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  const dirtyLines = describeConfig(dirty);
  assert.ok(dirty.warnings.length >= 1);
  assert.ok(
    dirtyLines.some((l) => l.includes("warning:") && l.includes(GLOBAL_PATH)),
    dirtyLines.join("\n"),
  );
});

// ---------------------------------------------------------------- provenance

/**
 * Resolve a dotted `sources` key against the config it claims to describe.
 * `exists` is false when the route or candidate the key names is not present,
 * which is exactly what a stale provenance entry violates.
 */
function resolveDotted(config: DispatcherConfig, key: string): { exists: boolean; value: unknown } {
  let current: unknown = config;
  // A segment is `name` or `name[<index>]`; `alternates[0]` is the array
  // element at index 0, not a property literally named `alternates[0]`.
  for (const segment of key.split(".")) {
    const indexed = /^(.*)\[(\d+)\]$/.exec(segment);
    const steps: Array<string | number> = indexed ? [indexed[1], Number(indexed[2])] : [segment];
    for (const step of steps) {
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, step)) {
        return { exists: false, value: undefined };
      }
      current = (current as Record<string | number, unknown>)[step];
    }
  }
  return { exists: true, value: current };
}

/**
 * `agents.<name>` (two segments, no candidate suffix) is the one `sources` key
 * that is not a value: it records the layer that removed the agent with
 * `disable`. Everything else must resolve.
 */
function isDisabledKey(key: string): boolean {
  return /^agents\.[^.]+$/.test(key);
}

// Regression guard: `mergeConfig` used to write `sources` while validating, so
// a route or candidate that was later rejected (or erased and not replaced)
// left provenance claiming a layer supplied a value `config` did not hold.
test("a rejected candidate proposal leaves the lower layer's provenance intact", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        agents: {
          planner: {
            primary: { model: 123 },
            alternates: [{ model: "openai-codex/gpt-6-luna" }],
          },
        },
      },
    },
  ]);
  assert.ok(r.warnings.length >= 1, r.warnings.join("\n"));
  assert.deepEqual(r.config.agents.planner, base().agents.planner);
  assert.equal(r.sources["agents.planner.primary.model"], "built-in");
  assert.equal(r.sources["agents.planner.alternates[0].model"], "built-in");
  assert.equal(r.sources["agents.planner.alternates[0].rail"], "built-in");
});

test("a rejected new agent leaves no provenance keys at all", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { newbie: { primary: { model: "claude-bridge/x" } } } } },
  ]);
  assert.equal(Object.hasOwn(r.config.agents, "newbie"), false);
  assert.ok(r.warnings.some((w) => w.includes("newbie")), r.warnings.join("\n"));
  assert.deepEqual(
    Object.keys(r.sources).filter((key) => key.startsWith("agents.newbie")),
    [],
  );
});

test("a rejected override leaves the lower layer's value and source standing", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: { agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } } },
    },
    { source: "project", data: { agents: { planner: { primary: { model: 123 } } } } },
  ]);
  assert.equal(r.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-6");
  assert.equal(r.sources["agents.planner.primary.model"], "global");
});

test("a rejected alternates list leaves the lower list's provenance standing", () => {
  // The global replaces the planner alternates with an empty list; the project
  // offers a model-only replacement, which cannot complete a candidate. The
  // list is rejected as a unit, so the empty list and its (absent) provenance
  // stand.
  const r = mergeConfig(base(), [
    { source: "global", data: { agents: { planner: { alternates: [] } } } },
    { source: "project", data: { agents: { planner: { alternates: [{ model: "openai-codex/gpt-6-luna" }] } } } },
  ]);
  assert.deepEqual(r.config.agents.planner.alternates, []);
  assert.deepEqual(
    Object.keys(r.sources).filter((key) => key.startsWith("agents.planner.alternates")),
    [],
  );
});

/**
 * Property: `sources` describes the merged config, no more and no less.
 *
 *   (a) every key in `sources` resolves to a value that exists in `config`,
 *       except the special `agents.<name>` removal key, which names an agent
 *       that is deliberately absent;
 *   (b) every candidate field present in `config` has a `sources` entry.
 *
 * A merge that records provenance for a rejected route or candidate breaks
 * (a); one that commits a value without its source breaks (b).
 */
test("sources never names a value the merged config does not hold", () => {
  const nasty: Array<{ name: string; layers: MergeLayer[] }> = [
    {
      name: "rejected new agent (no rail)",
      layers: [{ source: "project", data: { agents: { newbie: { primary: { model: "claude-bridge/x" } } } } }],
    },
    {
      name: "rejected alternates list (bad element)",
      layers: [
        {
          source: "project",
          data: {
            agents: {
              planner: {
                alternates: [
                  { model: "openai-codex/gpt-6-sol", rail: "codex" },
                  { model: "missing-slash" },
                ],
              },
            },
          },
        },
      ],
    },
    {
      name: "rejected primary (bad rail)",
      layers: [{ source: "project", data: { agents: { planner: { primary: { rail: "openai" } } } } }],
    },
    {
      name: "no-slash model",
      layers: [{ source: "project", data: { agents: { planner: { primary: { model: "gpt-6-sol" } } } } }],
    },
    {
      name: "path traversal agent name",
      layers: [
        {
          source: "project",
          data: { agents: { "../outside": { primary: { model: "claude-bridge/x", rail: "claude" } } } },
        },
      ],
    },
    {
      name: "agent named constructor (valid)",
      layers: [
        {
          source: "project",
          data: { agents: { constructor: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } } } },
        },
      ],
    },
    { name: "route-level null", layers: [{ source: "project", data: { agents: { implementer: null } } }] },
    { name: "candidate-level null", layers: [{ source: "project", data: { agents: { planner: { primary: null } } } }] },
    {
      name: "alternates null element",
      layers: [{ source: "project", data: { agents: { planner: { alternates: [null] } } } }],
    },
    {
      name: "alternate list replaced by a shorter, level-less one",
      layers: [
        {
          source: "global",
          data: {
            agents: {
              planner: {
                alternates: [
                  { model: "openai-codex/gpt-6-sol", rail: "codex", thinking: "low" },
                  { model: "openai-codex/gpt-6-luna", rail: "codex", thinking: "off" },
                ],
              },
            },
          },
        },
        {
          source: "project",
          data: {
            agents: { planner: { alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }] } },
          },
        },
      ],
    },
    {
      name: "model of the wrong type",
      layers: [{ source: "project", data: { agents: { planner: { primary: { model: 123 } } } } }],
    },
    { name: "disable removes an agent", layers: [{ source: "project", data: { agents: { planner: { disable: true } } } }] },
    { name: "ignore contributes nothing", layers: [{ source: "project", data: { agents: { planner: { ignore: true } } } }] },
  ];

  for (const { name, layers } of nasty) {
    const r = mergeConfig(base(), layers);
    for (const key of Object.keys(r.sources)) {
      if (isDisabledKey(key)) {
        const agent = key.slice("agents.".length);
        assert.equal(
          Object.hasOwn(r.config.agents, agent),
          false,
          `${name}: "${key}" marks a removed agent but config still holds it`,
        );
        continue;
      }
      assert.ok(resolveDotted(r.config, key).exists, `${name}: sources has "${key}" but config does not`);
    }
    for (const [agent, route] of Object.entries(r.config.agents)) {
      const slots: Array<[string, { model: string; rail: string }]> = [
        ["primary", route.primary],
        ...route.alternates.map(
          (candidate, index): [string, { model: string; rail: string }] => [`alternates[${index}]`, candidate],
        ),
      ];
      for (const [slot, candidate] of slots) {
        for (const field of ["model", "rail"] as const) {
          const key = `agents.${agent}.${slot}.${field}`;
          assert.ok(key in r.sources, `${name}: config has ${key} but sources does not`);
          assert.equal(typeof candidate[field], "string", `${name}: ${key}`);
        }
      }
    }
  }
});

test("the value a rejected override leaves standing keeps its real source in describeConfig", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({
      agents: {
        planner: { primary: { model: "claude-bridge/claude-opus-5-6", rail: "claude" } },
      },
    }),
    [PROJECT_PATH]: JSON.stringify({ agents: { planner: { primary: { model: 123 } } } }),
  });
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: () => {},
  });
  assert.equal(loaded.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-6");
  assert.equal(loaded.sources["agents.planner.primary.model"], "global");

  const lines = describeConfig(loaded);
  const line = lines.find((l) => l.includes("agents.planner.primary.model"));
  assert.ok(line, lines.join("\n"));
  assert.ok(line.includes("claude-bridge/claude-opus-5-6"), line);
  assert.ok(line.includes("[global]"), line);
  assert.ok(!line.includes("[built-in]"), line);
});

test("configFilesFor names each key's layer file, deduped in layer order", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({
      agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } },
    }),
    [PROJECT_PATH]: JSON.stringify({
      agents: { reviewer: { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" } } },
    }),
  });
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: () => {},
  });

  // Each key names the file that wrote it, and a key no layer set names none.
  assert.deepEqual(configFilesFor(loaded, ["agents.planner.primary.model"]), [GLOBAL_PATH]);
  assert.deepEqual(configFilesFor(loaded, ["agents.reviewer.primary.model"]), [PROJECT_PATH]);
  assert.deepEqual(configFilesFor(loaded, ["sessionSwitchAt"]), []);

  // Two keys, one file each: deduped, and in the layer order the config was
  // read in rather than the order the keys were passed.
  assert.deepEqual(
    configFilesFor(loaded, ["agents.reviewer.primary.model", "agents.planner.primary.model"]),
    [GLOBAL_PATH, PROJECT_PATH],
  );
  assert.deepEqual(
    configFilesFor(loaded, ["agents.planner.primary.model", "agents.planner.primary.model"]),
    [GLOBAL_PATH],
  );
});

// ---------------------------------------------------------------- thinking

/**
 * A base with a level stated at each of the five places one can be stated, so
 * that the precedence and merge tests have something at every rung. Separate
 * from `base()` because most tests assert whole-config equality against it.
 */
function thinkingBase(): DispatcherConfig {
  return {
    ...base(),
    models: {
      "claude-bridge/claude-opus-5-5": { thinking: "low" },
      "openai-codex/gpt-6-sol": { thinking: "minimal" },
    },
    agents: {
      ...base().agents,
      planner: {
        thinking: "medium",
        primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude", thinking: "xhigh" },
        // The level lives here rather than on `base()`'s alternate, so the "a
        // list replacement keeps nothing from the old list" assertions have a
        // real level to lose.
        alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex", thinking: "minimal" }],
      },
    },
  };
}

test("a level can be stated on a model, a route and a candidate, each with provenance", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: {
        models: { "claude-bridge/claude-opus-5-5": { thinking: "low" } },
        agents: {
          planner: {
            thinking: "medium",
            primary: { thinking: "xhigh" },
            alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex", thinking: "off" }],
          },
        },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.models["claude-bridge/claude-opus-5-5"].thinking, "low");
  assert.equal(r.sources["models.claude-bridge/claude-opus-5-5.thinking"], "global");
  assert.equal(r.config.agents.planner.thinking, "medium");
  assert.equal(r.sources["agents.planner.thinking"], "global");
  assert.equal(r.config.agents.planner.primary.thinking, "xhigh");
  assert.equal(r.sources["agents.planner.primary.thinking"], "global");
  assert.equal(r.config.agents.planner.alternates[0].thinking, "off");
  assert.equal(r.sources["agents.planner.alternates[0].thinking"], "global");

  // A candidate nothing said anything about gains no key at all: "no level" is
  // the absence of a value, not a value of `undefined`.
  assert.equal(Object.hasOwn(r.config.agents.reviewer.primary, "thinking"), false);
  assert.equal(Object.hasOwn(r.sources, "agents.reviewer.primary.thinking"), false);
});

test("mergeConfig carries a base level through, marked built-in", () => {
  const r = mergeConfig(thinkingBase(), []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.sources["models.claude-bridge/claude-opus-5-5.thinking"], "built-in");
  assert.equal(r.sources["agents.planner.thinking"], "built-in");
  assert.equal(r.sources["agents.planner.primary.thinking"], "built-in");
});

test("a layer that changes only a model keeps the base level beneath it", () => {
  const r = mergeConfig(thinkingBase(), [
    { source: "project", data: { agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } } } },
  ]);
  assert.deepEqual(r.warnings, []);
  // `primary` merges field-wise, so the level survives a move to another model
  // on the same route — and it is still the base layer that supplied it.
  assert.equal(r.config.agents.planner.primary.thinking, "xhigh");
  assert.equal(r.sources["agents.planner.primary.thinking"], "built-in");
  assert.equal(r.config.agents.planner.thinking, "medium");
});

test("a route's thinking is replaced whole by the highest layer that states one", () => {
  const r = mergeConfig(thinkingBase(), [
    { source: "project", data: { agents: { planner: { thinking: "max" } } } },
  ]);
  assert.equal(r.config.agents.planner.thinking, "max");
  assert.equal(r.sources["agents.planner.thinking"], "project");
});

test("a level on the old list does not survive its replacement", () => {
  const r = mergeConfig(thinkingBase(), [
    {
      source: "project",
      data: { agents: { planner: { alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }] } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(Object.hasOwn(r.config.agents.planner.alternates[0], "thinking"), false);
  // The source goes with the value: the old element's level is no longer
  // something the effective config holds, so provenance may not name it.
  assert.equal(Object.hasOwn(r.sources, "agents.planner.alternates[0].thinking"), false);
  // The new element's own fields are present and attributed to the new layer.
  assert.equal(r.config.agents.planner.alternates[0].model, "openai-codex/gpt-6-sol");
  assert.equal(r.sources["agents.planner.alternates[0].model"], "project");
});

test("a shorter replacement list leaves no provenance for the tail it dropped", () => {
  const twoLevels: DispatcherConfig = {
    ...base(),
    agents: {
      ...base().agents,
      planner: {
        primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
        alternates: [
          { model: "openai-codex/gpt-6-sol", rail: "codex", thinking: "low" },
          { model: "openai-codex/gpt-6-luna", rail: "codex", thinking: "off" },
        ],
      },
    },
  };
  const r = mergeConfig(twoLevels, [
    {
      source: "project",
      data: { agents: { planner: { alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }] } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.planner.alternates.length, 1);
  assert.deepEqual(
    Object.keys(r.sources)
      .filter((key) => key.startsWith("agents.planner.alternates[1]"))
      .sort(),
    [],
    "the dropped index must carry no provenance at all",
  );
  assert.equal(Object.hasOwn(r.sources, "agents.planner.alternates[0].thinking"), false);
});

test("a mistyped level warns and leaves the lower layer's level standing", () => {
  const route = mergeConfig(thinkingBase(), [
    { source: "project", data: { agents: { planner: { thinking: "hgih" } } } },
  ]);
  assert.equal(route.config.agents.planner.thinking, "medium");
  assert.equal(route.sources["agents.planner.thinking"], "built-in");
  assert.ok(
    route.warnings.some((w) => w.includes('"agents.planner.thinking" must be one of')),
    route.warnings.join("\n"),
  );

  const candidate = mergeConfig(thinkingBase(), [
    { source: "project", data: { agents: { planner: { primary: { thinking: "hgih" } } } } },
  ]);
  assert.equal(candidate.config.agents.planner.primary.thinking, "xhigh");
  assert.equal(candidate.sources["agents.planner.primary.thinking"], "built-in");
  assert.ok(
    candidate.warnings.some((w) => w.includes('"agents.planner.primary.thinking" must be one of')),
    candidate.warnings.join("\n"),
  );
});

test("the rejection names every level pi accepts", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { planner: { thinking: "hgih" } } } },
  ]);
  const warning = r.warnings.find((w) => w.includes("agents.planner.thinking"));
  assert.ok(warning, r.warnings.join("\n"));
  for (const level of THINKING_LEVELS) assert.ok(warning.includes(`"${level}"`), warning);
});

test("the models table rejects a shapeless key, a shapeless entry and an unknown key", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        models: {
          "gpt-6-sol": { thinking: "low" },
          "openai-codex/gpt-6-sol": "low",
          "openai-codex/gpt-6-luna": { thinkng: "low" },
        },
      },
    },
  ]);
  const text = r.warnings.join("\n");
  assert.ok(text.includes('model "gpt-6-sol" is not a provider/model id'), text);
  assert.ok(text.includes('model "openai-codex/gpt-6-sol" must be an object'), text);
  assert.ok(text.includes('unknown key "models.openai-codex/gpt-6-luna.thinkng"'), text);
  assert.deepEqual(r.config.models, {});
  assert.deepEqual(Object.keys(r.sources).filter((k) => k.startsWith("models.")), []);
});

test("a models entry that is not an object warns without taking the table down", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: { models: { "claude-bridge/claude-opus-5-5": { thinking: "low" } } },
    },
    { source: "project", data: { models: { "openai-codex/gpt-6-sol": 7 } } },
  ]);
  assert.ok(r.warnings.some((w) => w.includes('model "openai-codex/gpt-6-sol" must be an object')));
  // The entry a lower layer supplied is untouched: a bad value never removes a
  // valid one.
  assert.equal(r.config.models["claude-bridge/claude-opus-5-5"].thinking, "low");
});

test("a bad model key in a programmatic base is dropped with a built-in warning", () => {
  const bad: DispatcherConfig = { ...base(), models: { "gpt-6-sol": { thinking: "low" } } };
  const r = mergeConfig(bad, []);
  assert.ok(r.warnings.some((w) => w.startsWith("built-in: ") && w.includes("gpt-6-sol")), r.warnings.join("\n"));
  assert.deepEqual(r.config.models, {});
});

test("thinkingFor prefers the candidate, then the route, then the model", () => {
  const cfg: DispatcherConfig = { ...base(), models: { "claude-bridge/claude-opus-5-5": { thinking: "low" } } };
  const primary: Candidate = { model: "claude-bridge/claude-opus-5-5", rail: "claude" };
  const unmodelled: Candidate = { model: "deepseek/deepseek-flash", rail: "deepseek" };
  const route = (thinking?: ThinkingLevel) => ({
    ...(thinking !== undefined ? { thinking } : {}),
    primary,
    alternates: [],
  });

  assert.equal(thinkingFor(cfg, route("medium"), { ...primary, thinking: "xhigh" }), "xhigh");
  assert.equal(thinkingFor(cfg, route("medium"), primary), "medium");
  assert.equal(thinkingFor(cfg, route(), primary), "low");
  // Nothing states one for this model, so the honest answer is "no opinion".
  assert.equal(thinkingFor(cfg, route("medium"), unmodelled), "medium");
  assert.equal(thinkingFor(cfg, route(), unmodelled), undefined);
});

test("describeConfig renders a level only where something states one", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({
      models: { "openai-codex/gpt-6-sol": { thinking: "low" } },
      agents: {
        planner: {
          thinking: "medium",
          primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude", thinking: "xhigh" },
        },
      },
    }),
  });
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: () => {},
  });

  const lines = describeConfig(loaded);
  assert.ok(lines.includes("  models.openai-codex/gpt-6-sol.thinking = low  [global]"), lines.join("\n"));
  assert.ok(lines.includes("  agents.planner.thinking = medium  [global]"), lines.join("\n"));
  assert.ok(lines.includes("  agents.planner.primary.thinking = xhigh  [global]"), lines.join("\n"));
  // reviewer kept the base candidates, none of which states a level.
  assert.ok(!lines.some((l) => l.includes("agents.reviewer.primary.thinking")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("agents.planner.alternates[0].thinking")), lines.join("\n"));
  // The model line comes before the agent block, because routes read it.
  assert.ok(lines.indexOf("  models.openai-codex/gpt-6-sol.thinking = low  [global]") < lines.indexOf("  agents.planner.thinking = medium  [global]"));
});

test("describeConfig marks a base level built-in", () => {
  const r = mergeConfig(thinkingBase(), []);
  const lines = describeConfig({ config: r.config, files: [], sources: r.sources, warnings: r.warnings });
  assert.ok(lines.includes("  agents.planner.primary.thinking = xhigh  [built-in]"), lines.join("\n"));
  assert.ok(lines.includes("  models.claude-bridge/claude-opus-5-5.thinking = low  [built-in]"), lines.join("\n"));
});

// ---------------------------------------------------------------- model rails

test("a candidate that names only a model inherits the rail registered for it", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        models: { "claude-bridge/claude-opus-5-6": { rail: "claude" } },
        agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.planner.primary.rail, "claude");
  // The rail is attributed to the layer that registered it, not the route's.
  assert.equal(r.sources["agents.planner.primary.rail"], "project");
  assert.equal(r.config.models["claude-bridge/claude-opus-5-6"].rail, "claude");
  assert.equal(r.sources["models.claude-bridge/claude-opus-5-6.rail"], "project");
});

test("a rail registered in one layer completes a candidate in another, whatever the order", () => {
  // The route is global and the registration is project: the models table is
  // folded first, over every layer, so the two need not live in one file.
  const r = mergeConfig(base(), [
    { source: "global", data: { agents: { newbie: { primary: { model: "deepseek/deepseek-v3" } } } } },
    { source: "project", data: { models: { "deepseek/deepseek-v3": { rail: "deepseek" } } } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.newbie.primary.rail, "deepseek");
  assert.equal(r.sources["agents.newbie.primary.model"], "global");
  assert.equal(r.sources["agents.newbie.primary.rail"], "project");
});

test("a models key written after agents in the same layer still completes the candidate", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        // JSON preserves this order, and the rail pass runs before any agent.
        agents: { newbie: { primary: { model: "deepseek/deepseek-v3" } } },
        models: { "deepseek/deepseek-v3": { rail: "deepseek" } },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.newbie.primary.rail, "deepseek");
});

test("a candidate that states its own rail outranks the registered one", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        models: { "openai-codex/gpt-6-sol": { rail: "codex" } },
        agents: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "claude" } } },
      },
    },
  ]);
  assert.equal(r.config.agents.planner.primary.rail, "claude");
  assert.equal(r.sources["agents.planner.primary.rail"], "project");
  // The stated rail disagrees with the model's prefix, so it warns as before.
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("rail")), r.warnings.join("\n"));
});

test("a layer that moves a candidate to another model re-resolves the registered rail", () => {
  // The base primary carries the claude rail; moving to a model registered on
  // codex must take codex rather than dragging claude along.
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        models: { "openai-codex/gpt-6-sol": { rail: "codex" } },
        agents: { planner: { primary: { model: "openai-codex/gpt-6-sol" } } },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.planner.primary.rail, "codex");
  assert.equal(r.sources["agents.planner.primary.rail"], "project");
});

test("a layer can register a rail without restating the model's level", () => {
  const r = mergeConfig(thinkingBase(), [
    { source: "project", data: { models: { "claude-bridge/claude-opus-5-5": { rail: "claude" } } } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.models["claude-bridge/claude-opus-5-5"].rail, "claude");
  assert.equal(r.config.models["claude-bridge/claude-opus-5-5"].thinking, "low");
  assert.equal(r.sources["models.claude-bridge/claude-opus-5-5.thinking"], "built-in");
  assert.equal(r.sources["models.claude-bridge/claude-opus-5-5.rail"], "project");
});

test("the models table rejects an unknown rail and keeps the previous entry", () => {
  const r = mergeConfig(
    { ...base(), models: { "openai-codex/gpt-6-sol": { rail: "codex" } } },
    [{ source: "project", data: { models: { "openai-codex/gpt-6-sol": { rail: "openai" } } } }],
  );
  assert.equal(r.config.models["openai-codex/gpt-6-sol"].rail, "codex");
  assert.equal(r.sources["models.openai-codex/gpt-6-sol.rail"], "built-in");
  assert.ok(
    r.warnings.some((w) => w.includes('"models.openai-codex/gpt-6-sol.rail" must be one of')),
    r.warnings.join("\n"),
  );
});

test("a registered rail that reads as another account's model warns once, at the entry", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        models: { "openai-codex/gpt-6-sol": { rail: "claude" } },
        agents: {
          planner: { primary: { model: "openai-codex/gpt-6-sol" } },
          reviewer: { primary: { model: "openai-codex/gpt-6-sol" } },
        },
      },
    },
  ]);
  // Both routes name the model, but the mistake is in one place, so it is
  // reported once there rather than on every candidate that inherits it.
  const mismatches = r.warnings.filter((w) => w.includes("reads as"));
  assert.equal(mismatches.length, 1, r.warnings.join("\n"));
  assert.ok(mismatches[0].includes('"openai-codex/gpt-6-sol"'), mismatches[0]);
  assert.equal(r.config.agents.planner.primary.rail, "claude");
  assert.equal(r.config.agents.reviewer.primary.rail, "claude");
});

test("a candidate with neither its own rail nor a registered one is still rejected", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { agents: { newbie: { primary: { model: "claude-bridge/x" } } } } },
  ]);
  assert.equal(Object.hasOwn(r.config.agents, "newbie"), false);
  const warning = r.warnings.find((w) => w.includes("newbie"));
  assert.ok(warning, r.warnings.join("\n"));
  assert.ok(warning.includes("needs a rail"), warning);
});

test("mergeConfig carries a base model rail through, marked built-in", () => {
  const b: DispatcherConfig = {
    ...base(),
    models: { "claude-bridge/claude-opus-5-5": { rail: "claude" } },
  };
  const r = mergeConfig(b, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.sources["models.claude-bridge/claude-opus-5-5.rail"], "built-in");
});

test("a base model rail that mismatches its key warns built-in", () => {
  const b: DispatcherConfig = {
    ...base(),
    models: { "openai-codex/gpt-6-sol": { rail: "claude" } },
  };
  const r = mergeConfig(b, []);
  assert.ok(
    r.warnings.some((w) => w.startsWith("built-in: ") && w.includes("reads as")),
    r.warnings.join("\n"),
  );
});

test("describeConfig renders a registered rail with the model and per candidate", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({
      models: { "claude-bridge/claude-opus-5-6": { rail: "claude" } },
      agents: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } },
    }),
  });
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fs.readFile,
    warn: () => {},
  });

  const lines = describeConfig(loaded);
  assert.ok(
    lines.includes("  models.claude-bridge/claude-opus-5-6.rail = claude  [global]"),
    lines.join("\n"),
  );
  // The candidate's rail names the layer that registered it, where the model
  // line names the layer that named the route.
  assert.ok(lines.includes("  agents.planner.primary.rail = claude  [global]"), lines.join("\n"));
  assert.ok(lines.includes("  agents.planner.primary.model = claude-bridge/claude-opus-5-6  [global]"), lines.join("\n"));
  assert.ok(
    lines.indexOf("  models.claude-bridge/claude-opus-5-6.rail = claude  [global]") <
      lines.indexOf("  agents.planner.primary.rail = claude  [global]"),
  );
});

test("an inherited rail is not carried to an unregistered replacement model", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: {
        models: { "custom/a": { rail: "claude" } },
        agents: { newbie: { primary: { model: "custom/a" } } },
      },
    },
    { source: "project", data: { agents: { newbie: { primary: { model: "custom/b" } } } } },
  ]);
  // The rail belonged to custom/a, and custom/b registers none, so the move is
  // rejected rather than silently pointing custom/b at claude.
  assert.equal(r.config.agents.newbie.primary.model, "custom/a");
  assert.equal(r.config.agents.newbie.primary.rail, "claude");
  assert.ok(
    r.warnings.some((w) => w.includes("needs a rail") && w.includes("custom/b")),
    r.warnings.join("\n"),
  );
});

test("restating the same model keeps a rail the candidate stated itself", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: {
        models: { "custom/a": { rail: "codex" } },
        agents: { planner: { primary: { model: "custom/a", rail: "claude" } } },
      },
    },
    { source: "project", data: { agents: { planner: { primary: { model: "custom/a", thinking: "high" } } } } },
  ]);
  // The override survives a layer that restates the same model; only an actual
  // move re-resolves the rail.
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.agents.planner.primary.rail, "claude");
});

test("a layer that changes only a level does not re-warn a registered mismatch", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: {
        models: { "openai-codex/gpt-6-sol": { rail: "claude" } },
        agents: { planner: { primary: { model: "openai-codex/gpt-6-sol" } } },
      },
    },
    { source: "project", data: { agents: { planner: { primary: { thinking: "high" } } } } },
  ]);
  // The mistake is at the models entry, so an unrelated level edit must not
  // produce a second warning pointing at the project file.
  const mismatches = r.warnings.filter((w) => w.includes("reads as"));
  assert.equal(mismatches.length, 1, r.warnings.join("\n"));
  assert.ok(mismatches[0].startsWith("global: "), mismatches[0]);
});

// ---------------------------------------------------------------- #47 optional session override
function sessionOverrideLines(r: ReturnType<typeof mergeConfig>): string[] {
  return describeConfig({ ...r, files: [] }).filter((line) => line.includes("sessionAlwaysSwitchAt ="));
}
test("omitted scalar has no effective value or source and reports disabled", () => {
  const r = mergeConfig(base(), []);
  assert.equal(r.config.sessionAlwaysSwitchAt, undefined);
  assert.equal("sessionAlwaysSwitchAt" in r.config, false);
  assert.equal("sessionAlwaysSwitchAt" in r.sources, false);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(sessionOverrideLines(r), ["  sessionAlwaysSwitchAt = disabled  [built-in]"]);
});
for (const value of [0, 70, 90.5, 100]) {
  test(`valid override scalar ${value} and exact provenance`, () => {
    const r = mergeConfig(base(), [{ source: "project", data: { sessionSwitchAt: 0, sessionAlwaysSwitchAt: value } }]);
    assert.equal(r.config.sessionAlwaysSwitchAt, value);
    assert.equal(r.sources.sessionAlwaysSwitchAt, "project");
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(sessionOverrideLines(r), [`  sessionAlwaysSwitchAt = ${value}  [project]`]);
  });
}
for (const [label, value] of [
  ["string", "90"], ["boolean", true], ["null", null], ["object", {}],
  ["negative", -0.1], ["above 100", 100.1], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
] as const) {
  test(`invalid upper scalar ${label} retains valid inherited override`, () => {
    const r = mergeConfig(base(), [
      { source: "global", data: { sessionSwitchAt: 70, sessionAlwaysSwitchAt: 90 } },
      { source: "project", label: "project-file", data: { sessionAlwaysSwitchAt: value } },
    ]);
    assert.equal(r.config.sessionAlwaysSwitchAt, 90);
    assert.equal(r.sources.sessionAlwaysSwitchAt, "global");
    assert.equal(r.warnings.length, 1);
    for (const text of ["sessionAlwaysSwitchAt", "[0, 100]", "project-file"]) assert.ok(r.warnings[0].includes(text), r.warnings[0]);
    assert.deepEqual(sessionOverrideLines(r), ["  sessionAlwaysSwitchAt = 90  [global]"]);
  });
}
test("invalid scalar without lower value remains omitted", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { sessionAlwaysSwitchAt: "90" } }]);
  assert.equal(r.config.sessionAlwaysSwitchAt, undefined);
  assert.equal("sessionAlwaysSwitchAt" in r.sources, false);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(sessionOverrideLines(r), ["  sessionAlwaysSwitchAt = disabled  [built-in]"]);
});
test("project override wins and project omission inherits global", () => {
  for (const [data, value, source] of [[{ sessionAlwaysSwitchAt: 95 }, 95, "project"], [{ margin: 25 }, 90, "global"]] as const) {
    const r = mergeConfig(base(), [
      { source: "global", data: { sessionSwitchAt: 70, sessionAlwaysSwitchAt: 90 } },
      { source: "project", data },
    ]);
    assert.equal(r.config.sessionAlwaysSwitchAt, value);
    assert.equal(r.sources.sessionAlwaysSwitchAt, source);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(sessionOverrideLines(r), [`  sessionAlwaysSwitchAt = ${value}  [${source}]`]);
  }
});
test("final ordering ignores same-object key order including equality", () => {
  for (const value of [70, 80]) for (const data of [
    { sessionAlwaysSwitchAt: value, sessionSwitchAt: 70 },
    { sessionSwitchAt: 70, sessionAlwaysSwitchAt: value },
  ]) {
    const r = mergeConfig(base(), [{ source: "project", data }]);
    assert.equal(r.config.sessionAlwaysSwitchAt, value);
    assert.deepEqual(r.warnings, []);
  }
});
test("validation waits for later layer to repair temporarily invalid ordering", () => {
  const r = mergeConfig(base(), [
    { source: "global", data: { sessionAlwaysSwitchAt: 60 } },
    { source: "project", data: { sessionSwitchAt: 50 } },
  ]);
  assert.equal(r.config.sessionAlwaysSwitchAt, 60);
  assert.equal(r.sources.sessionAlwaysSwitchAt, "global");
  assert.deepEqual(r.warnings, []);
});
for (const reverse of [false, true]) {
  test(`invalid same-object ordering disables only override key order ${reverse}`, () => {
    const data = reverse ? { sessionAlwaysSwitchAt: 60, sessionSwitchAt: 70, margin: 30 }
      : { sessionSwitchAt: 70, sessionAlwaysSwitchAt: 60, margin: 30 };
    const r = mergeConfig(base(), [{ source: "project", label: "project-file", data }]);
    assert.equal(r.config.sessionAlwaysSwitchAt, undefined);
    assert.equal("sessionAlwaysSwitchAt" in r.sources, false);
    assert.equal(r.config.sessionSwitchAt, 70);
    assert.equal(r.sources.sessionSwitchAt, "project");
    assert.equal(r.config.margin, 30);
    assert.equal(r.config.weeklySwitchAt, base().weeklySwitchAt);
    assert.deepEqual(r.config.agents, base().agents);
    assert.equal(r.warnings.length, 1);
    for (const text of ["sessionAlwaysSwitchAt", "sessionSwitchAt", "60", "70", "project-file", "disabled"]) assert.ok(r.warnings[0].includes(text), r.warnings[0]);
    assert.deepEqual(sessionOverrideLines(r), ["  sessionAlwaysSwitchAt = disabled  [built-in]"]);
  });
}
test("inherited global 90 below project normal 95 disables override with both file labels", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({ sessionSwitchAt: 70, sessionAlwaysSwitchAt: 90, margin: 30 }),
    [PROJECT_PATH]: JSON.stringify({ sessionSwitchAt: 95 }),
  });
  const r = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(r.config.sessionAlwaysSwitchAt, undefined);
  assert.equal("sessionAlwaysSwitchAt" in r.sources, false);
  assert.equal(r.config.sessionSwitchAt, 95);
  assert.equal(r.sources.sessionSwitchAt, "project");
  assert.equal(r.config.margin, 30);
  assert.equal(r.sources.margin, "global");
  assert.equal(r.warnings.length, 1);
  for (const text of ["sessionAlwaysSwitchAt", "sessionSwitchAt", "90", "95", GLOBAL_PATH, PROJECT_PATH, "disabled"]) assert.ok(r.warnings[0].includes(text), r.warnings[0]);
  const lines = describeConfig(r);
  assert.ok(lines.includes("  sessionSwitchAt = 95  [project]"));
  assert.deepEqual(lines.filter((line) => line.includes("sessionAlwaysSwitchAt =")), ["  sessionAlwaysSwitchAt = disabled  [built-in]"]);
  assert.ok(lines.some((line) => line.includes("warning:") && line.includes("disabled")));
});
test("ordering conflict with built-in normal names built-in label", () => {
  const r = mergeConfig(base(), [{ source: "global", label: "global-file", data: { sessionAlwaysSwitchAt: 60 } }]);
  assert.equal(r.config.sessionAlwaysSwitchAt, undefined);
  assert.equal(r.warnings.length, 1);
  for (const text of ["60", "75", "built-in", "global-file", "disabled"]) assert.ok(r.warnings[0].includes(text), r.warnings[0]);
});
test("loadConfig applies project override with exact active provenance", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({ sessionSwitchAt: 70, sessionAlwaysSwitchAt: 90 }),
    [PROJECT_PATH]: JSON.stringify({ sessionAlwaysSwitchAt: 95 }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.config.sessionAlwaysSwitchAt, 95);
  assert.equal(loaded.sources.sessionAlwaysSwitchAt, "project");
  assert.equal(loaded.config.sessionSwitchAt, 70);
  assert.equal(loaded.sources.sessionSwitchAt, "global");
  assert.deepEqual(loaded.warnings, []);
  assert.ok(describeConfig(loaded).includes("  sessionAlwaysSwitchAt = 95  [project]"));
});

// ---------------------------------------------------------------- skill bindings (issue #52)

/** Load the two layers named, each as JSON, from the fake filesystem. */
async function loadedSkillLayers(global?: unknown, project?: unknown): Promise<LoadedConfig> {
  const files: Record<string, string> = {};
  if (global !== undefined) files[GLOBAL_PATH] = JSON.stringify(global);
  if (project !== undefined) files[PROJECT_PATH] = JSON.stringify(project);
  const fs = fakeFs(files);
  return loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
}

/** Every `sources` key a skill binding owns, with the layer that supplied it. */
function skillSources(loaded: { sources: Record<string, string> }): Record<string, string> {
  return Object.fromEntries(Object.entries(loaded.sources).filter(([key]) => key.startsWith("skills")));
}

test("defaultConfig ships no skill bindings", () => {
  assert.deepEqual(defaultConfig("/opt/pi/agent").skills, {});
});

test("a global skill binding loads with its source", async () => {
  const loaded = await loadedSkillLayers({ skills: { "implementation-plan": "planner" } });
  assert.deepEqual(loaded.config.skills, { "implementation-plan": "planner" });
  assert.equal(loaded.sources["skills.implementation-plan"], "global");
  assert.deepEqual(loaded.warnings, []);
});

test("a project binding replaces the global one for that skill and inherits the rest", async () => {
  const loaded = await loadedSkillLayers(
    { skills: { a: "planner", b: "reviewer" } },
    { skills: { a: "implementer" } },
  );
  assert.deepEqual(loaded.config.skills, { a: "implementer", b: "reviewer" });
  assert.deepEqual(skillSources(loaded), { "skills.a": "project", "skills.b": "global" });
  assert.deepEqual(loaded.warnings, []);
});

const NO_SKILL = "names no skill (an explicit invocation names a skill up to the first space)";
const NOT_A_ROUTE_STRING = "must be a string naming an agent route";

/**
 * Every rejection §3.1(g) of the plan names, each over a valid lower binding.
 *
 * A value row overrides a binding the global layer already holds, so "the lower
 * binding stands" is checked against that very binding. A key row names a skill
 * no layer can bind, so it is checked against an unrelated binding and a quoted
 * one: neither may move, and no `sources` key may appear for the bad name.
 */
const INVALID_SKILL_ROWS: Array<{ name: string; global: Record<string, string>; bad: Record<string, unknown>; text: string }> = [
  ...([3, null, {}, true, ""] as const).map((value) => ({
    name: `a ${JSON.stringify(value)} route`,
    global: { "code-review": "reviewer" },
    bad: { "code-review": value },
    text: `"skills.code-review" ${NOT_A_ROUTE_STRING}`,
  })),
  {
    name: "a model id where a route belongs",
    global: { "code-review": "reviewer" },
    bad: { "code-review": "claude-bridge/claude-opus-5-5" },
    text:
      `"skills.code-review" must name an agent route: agent "claude-bridge/claude-opus-5-5" is not a valid agent name ` +
      `(a name is also a filename, so it must be a single path segment: not empty, not "." or "..", and with no "/", "\\" or NUL character)`,
  },
  {
    name: "a route named after Object.prototype",
    global: { "code-review": "reviewer" },
    bad: { "code-review": "constructor" },
    text: `"skills.code-review" must name an agent route: agent "constructor" shadows Object.prototype and is not manageable`,
  },
  {
    name: "a quoted skill's non-string route",
    global: { "v1.2": "reviewer" },
    bad: { "v1.2": 3 },
    text: `"skills["v1.2"]" ${NOT_A_ROUTE_STRING}`,
  },
  {
    name: "an empty skill name",
    global: { "implementation-plan": "planner", "v1.2": "reviewer" },
    bad: { "": "planner" },
    text: `"skills" entry "" ${NO_SKILL}`,
  },
  {
    name: "a skill name holding a space",
    global: { "implementation-plan": "planner", "v1.2": "reviewer" },
    bad: { "pdf tools": "planner" },
    text: `"skills" entry "pdf tools" ${NO_SKILL}`,
  },
];

for (const row of INVALID_SKILL_ROWS) {
  test(`each invalid skills entry warns and leaves the lower binding standing: ${row.name}`, async () => {
    const lower = await loadedSkillLayers({ skills: row.global });
    assert.deepEqual(lower.warnings, [], "the baseline must be valid");

    const loaded = await loadedSkillLayers({ skills: row.global }, { skills: row.bad });
    assert.deepEqual(loaded.warnings, [`${PROJECT_PATH}: ${row.text}`]);
    assert.deepEqual(loaded.config.skills, row.global);
    // Provenance membership is exactly the lower layer's: nothing for the bad
    // entry, and every surviving binding still owned by the global file.
    assert.deepEqual(skillSources(loaded), skillSources(lower));
    for (const source of Object.values(skillSources(loaded))) assert.equal(source, "global");
  });
}

test('"skills" that is not an object warns and leaves every binding standing', async () => {
  const global = { skills: { "implementation-plan": "planner", "code-review": "reviewer" } };
  for (const bad of [[], "x", null]) {
    const loaded = await loadedSkillLayers(global, { skills: bad });
    assert.deepEqual(loaded.warnings, [`${PROJECT_PATH}: "skills" must be an object`], JSON.stringify(bad));
    assert.deepEqual(loaded.config.skills, global.skills);
    assert.deepEqual(skillSources(loaded), {
      "skills.implementation-plan": "global",
      "skills.code-review": "global",
    });
  }
});

test("a binding to a route agents does not configure loads without a warning", async () => {
  const loaded = await loadedSkillLayers({ skills: { "code-review": "ghost" } });
  assert.deepEqual(loaded.config.agents, {});
  assert.deepEqual(loaded.config.skills, { "code-review": "ghost" });
  assert.equal(loaded.sources["skills.code-review"], "global");
  assert.deepEqual(loaded.warnings, []);
});

test('"skills" is a known top-level key', async () => {
  const loaded = await loadedSkillLayers({ skills: {} }, { skills: { a: "planner" } });
  assert.ok(!loaded.warnings.some((w) => w.includes('unknown key "skills"')), loaded.warnings.join("\n"));
  assert.deepEqual(loaded.warnings, []);
});

test("a skill outside the plain name class is quoted in sources and in the report", async () => {
  assert.equal(skillKey("v1.2"), 'skills["v1.2"]');
  assert.equal(skillKey("code-review"), "skills.code-review");

  const loaded = await loadedSkillLayers({ skills: { "v1.2": "reviewer" } }, { skills: { "code-review": "planner" } });
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(skillSources(loaded), { 'skills["v1.2"]': "global", "skills.code-review": "project" });
  // The dotted spelling would name a different, nonexistent key.
  assert.equal("skills.v1.2" in loaded.sources, false);

  const lines = describeConfig(loaded);
  assert.ok(lines.includes('  skills["v1.2"] = reviewer  [global]'), lines.join("\n"));
  assert.ok(lines.includes("  skills.code-review = planner  [project]"), lines.join("\n"));
  assert.deepEqual(configFilesFor(loaded, ['skills["v1.2"]']), [GLOBAL_PATH]);
  assert.deepEqual(configFilesFor(loaded, ["skills.code-review"]), [PROJECT_PATH]);
});

test("a skill named __proto__ is kept as its own binding", () => {
  const data: unknown = JSON.parse('{"skills":{"__proto__":"planner"}}');
  assert.ok(isRecord(data));
  const r = mergeConfig(base(), [{ source: "global", data }]);
  assert.deepEqual(r.warnings, []);
  assert.ok(Object.hasOwn(r.config.skills, "__proto__"));
  assert.equal(Object.getOwnPropertyDescriptor(r.config.skills, "__proto__")?.value, "planner");
  assert.equal(r.sources["skills.__proto__"], "global");
  assert.equal(Object.getPrototypeOf(r.config.skills), Object.prototype);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("a base skill binding is cloned, validated and marked built-in", () => {
  const b: DispatcherConfig = { ...base(), skills: { ok: "planner", "x y": "planner" } };
  const r = mergeConfig(b, []);
  assert.deepEqual(r.config.skills, { ok: "planner" });
  assert.deepEqual(r.warnings, [`built-in: "skills" entry "x y" ${NO_SKILL}`]);
  assert.equal(r.sources["skills.ok"], "built-in");
  assert.deepEqual(skillSources(r), { "skills.ok": "built-in" });

  // `deepEqual` narrows `r.config.skills`; mutate it through its declared type.
  const merged: Record<string, string> = r.config.skills;
  merged.ok = "reviewer";
  merged.added = "reviewer";
  assert.deepEqual(b.skills, { ok: "planner", "x y": "planner" }, "the base table must not be shared");
});

/** Models, both skill layers and two routes, so the block has every section. */
async function loadedWithSkills(): Promise<LoadedConfig> {
  const loaded = await loadedSkillLayers(
    {
      models: { "claude-bridge/claude-opus-5-5": { rail: "claude" } },
      skills: { "implementation-plan": "planner" },
    },
    {
      skills: { "code-review": "reviewer" },
      agents: {
        planner: {
          primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
          alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
        },
        reviewer: { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" }, alternates: [] },
      },
    },
  );
  assert.deepEqual(loaded.warnings, []);
  return loaded;
}

test("describeConfig lists skill bindings sorted, between the models and the agents", async () => {
  const lines = describeConfig(await loadedWithSkills());
  const skillLines = lines.filter((l) => l.startsWith("  skills"));
  assert.deepEqual(skillLines, [
    "  skills.code-review = reviewer  [project]",
    "  skills.implementation-plan = planner  [global]",
  ]);

  const lastModel = lines.findLastIndex((l) => l.startsWith("  models."));
  const firstSkill = lines.findIndex((l) => l.startsWith("  skills"));
  const lastSkill = lines.findLastIndex((l) => l.startsWith("  skills"));
  const firstAgent = lines.findIndex((l) => l.startsWith("  agents."));
  assert.ok(lastModel >= 0 && firstAgent >= 0, lines.join("\n"));
  assert.ok(lastModel < firstSkill, lines.join("\n"));
  assert.ok(lastSkill < firstAgent, lines.join("\n"));
});

test("describeConfig keeps scalars first, agents sorted and every value sourced with skill bindings present", async () => {
  const lines = describeConfig(await loadedWithSkills());

  const firstAgent = lines.findIndex((l) => l.includes("agents."));
  assert.ok(firstAgent > 0, lines.join("\n"));
  for (const scalar of ["agentDir", "claudeCredsPath", "piAuthPath", "ttlMs", "pollMs", "sessionSwitchAt", "weeklySwitchAt", "margin"]) {
    const i = lines.findIndex((l) => l.includes(scalar));
    assert.ok(i >= 0, `missing ${scalar}`);
    assert.ok(i < firstAgent, `${scalar} should come before the agent lines`);
  }
  const planner = lines.findIndex((l) => l.includes("agents.planner."));
  const reviewer = lines.findIndex((l) => l.includes("agents.reviewer."));
  assert.ok(planner >= 0 && reviewer > planner, lines.join("\n"));

  for (const l of lines.slice(1).filter((l) => l.includes(" = "))) {
    assert.match(l, /\[(?:built-in|global|project)\]\s*$/);
  }
});

test("an install with no skill bindings merges to the base unchanged", async () => {
  const r = mergeConfig(base(), []);
  assert.deepEqual(r.config, base());
  assert.deepEqual(r.config.skills, {});
  assert.deepEqual(skillSources(r), {});

  const loaded = await loadedSkillLayers({ sessionSwitchAt: 60 });
  assert.deepEqual(loaded.config.skills, {});
  assert.ok(!describeConfig(loaded).some((l) => l.startsWith("  skills")));
});
