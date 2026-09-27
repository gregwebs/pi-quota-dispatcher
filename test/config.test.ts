import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  type DispatcherConfig,
  type LoadedConfig,
  type MergeLayer,
  type SkipFlag,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  defaultConfig,
  describeConfig,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  projectConfigPath,
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
    piAuthPath: "/root/auth.json",
    ttlMs: 180000,
    pollMs: 300000,
    sessionSwitchAt: 75,
    weeklySwitchAt: 90,
    margin: 10,
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
  assert.ok(loaded.files.every((f) => f.present === false));
  assert.deepEqual(loaded.config, defaultConfig(AGENT_DIR));
  assert.equal(loaded.sources.sessionSwitchAt, "built-in");
});

test("loadConfig warns on unparseable JSON, still reports it present, and uses defaults", async () => {
  const fs = fakeFs({ [GLOBAL_PATH]: "{ this is not json" });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.files.find((f) => f.source === "global")?.present, true);
  assert.ok(loaded.warnings.some((w) => w.includes(GLOBAL_PATH)), loaded.warnings.join("\n"));
  assert.deepEqual(loaded.config, defaultConfig(AGENT_DIR));
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
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {}, fileExists: () => true });
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.config.sessionSwitchAt, 75);
  assert.deepEqual(Object.keys(loaded.config.agents), ["planner"]);
  // No `alternates` was named, so the agent is pinned to its primary.
  assert.deepEqual(loaded.config.agents.planner.alternates, []);
  assert.equal(loaded.sources["agents.planner.primary.model"], "project");
});

// A configured agent with no file would otherwise silently do nothing: it is
// reported at load, and it stays configured so a file can be created later.
test("loadConfig warns about a configured agent whose file is absent and keeps it configured", async () => {
  const missing = join(AGENT_DIR, "agents", "planner.md");
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
    fileExists: (path) => path !== missing,
  });
  assert.ok(
    loaded.warnings.some((w) => w.includes(missing) && w.includes("planner")),
    loaded.warnings.join("\n"),
  );
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
    fileExists: () => true,
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
  // A file that is there but cannot be read is reported present, alongside the
  // warning naming it; "absent" would send someone looking for a file that is
  // exactly where they left it.
  assert.ok(loaded.files.every((f) => f.present === true), JSON.stringify(loaded.files));
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
    assert.equal(global?.present, true);
    assert.equal(project?.present, false);
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
    fileExists: () => true,
  });
}

test("describeConfig's first line names the layers and both files' presence", async () => {
  const loaded = await loadedWithProjectOverride();
  const lines = describeConfig(loaded);
  const first = lines[0];
  assert.ok(first.startsWith("config:"), first);
  assert.ok(first.includes("built-in"), first);
  assert.ok(first.includes(`global ${GLOBAL_PATH} (absent)`), first);
  assert.ok(first.includes(`project ${PROJECT_PATH} (present)`), first);
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
    fileExists: () => true,
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
