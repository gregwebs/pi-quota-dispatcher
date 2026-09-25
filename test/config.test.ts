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
    routes: {
      planner: {
        primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
        alternate: { model: "openai-codex/gpt-6-sol", rail: "codex" },
      },
      reviewer: {
        primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
        alternate: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      },
      implementer: {
        primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
        alternate: { model: "openai-codex/gpt-6-luna", rail: "codex" },
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

test("defaultConfig ships the three documented routes and their models", () => {
  const c = defaultConfig("/opt/pi/agent");
  assert.deepEqual(c.routes, {
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternate: { model: "openai-codex/gpt-6-sol", rail: "codex" },
    },
    reviewer: {
      primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
      alternate: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    },
    implementer: {
      primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
      alternate: { model: "openai-codex/gpt-6-luna", rail: "codex" },
    },
  });
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
  assert.equal(r.sources["routes.planner.primary.model"], "built-in");
  assert.equal(r.sources["routes.reviewer.alternate.rail"], "built-in");
});

test("mergeConfig applies later layers over earlier ones", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: {
        sessionSwitchAt: 60,
        routes: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } },
      },
    },
    { source: "project", data: { sessionSwitchAt: 50 } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.sessionSwitchAt, 50);
  assert.equal(r.sources.sessionSwitchAt, "project");
  assert.equal(r.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-6");
  assert.equal(r.sources["routes.planner.primary.model"], "global");
  // A candidate that names only `model` keeps the base rail.
  assert.equal(r.config.routes.planner.primary.rail, "claude");
  assert.equal(r.sources["routes.planner.primary.rail"], "built-in");
});

test("mergeConfig deep-merges per route, leaving unnamed routes and scalars alone", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        routes: { implementer: { alternate: { model: "openai-codex/gpt-7", rail: "codex" } } },
      },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.sessionSwitchAt, 75);
  assert.deepEqual(r.config.routes.planner, base().routes.planner);
  assert.deepEqual(r.config.routes.reviewer, base().routes.reviewer);
  assert.equal(r.config.routes.implementer.primary.model, "deepseek/deepseek-flash");
  assert.equal(r.config.routes.implementer.alternate?.model, "openai-codex/gpt-7");
  assert.equal(r.sources["routes.implementer.alternate.model"], "project");
});

test("mergeConfig treats null as an eraser for a route", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { routes: { implementer: null } } }]);
  assert.equal("implementer" in r.config.routes, false);
  assert.equal(r.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-5");
});

test("mergeConfig treats null as an eraser for a candidate", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { routes: { planner: { alternate: null } } } }]);
  assert.equal(r.config.routes.planner.alternate, undefined);
  assert.equal(r.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-5");
});

test("mergeConfig never mutates the base config", () => {
  const b = base();
  const snapshot = structuredClone(b);
  mergeConfig(b, [{ source: "project", data: { sessionSwitchAt: 1, routes: { planner: null } } }]);
  assert.deepEqual(b, snapshot);
});

// ---------------------------------------------------------------- validation

test("mergeConfig warns about an unknown top-level key and ignores it", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { bogusKey: true } }]);
  assert.ok(r.warnings.some((w) => w.includes("bogusKey")), r.warnings.join("\n"));
  assert.deepEqual(r.config, base());
});

test("mergeConfig warns about unknown keys inside a route and a candidate", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { routes: { planner: { bogusRoute: 1, primary: { bogusCandidate: 2 } } } } },
  ]);
  assert.ok(r.warnings.some((w) => w.includes("bogusRoute")), r.warnings.join("\n"));
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
    { source: "project", data: { routes: { planner: { primary: { model: 123 } } } } },
  ]);
  assert.equal(notString.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.ok(notString.warnings.some((w) => w.includes("model")), notString.warnings.join("\n"));

  const noSlash = mergeConfig(base(), [
    { source: "project", data: { routes: { planner: { primary: { model: "gpt-6-sol" } } } } },
  ]);
  assert.equal(noSlash.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.ok(noSlash.warnings.some((w) => w.includes("model")), noSlash.warnings.join("\n"));
});

test("mergeConfig warns on an unknown rail and keeps the previous one", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { routes: { planner: { primary: { rail: "openai" } } } } },
  ]);
  assert.equal(r.config.routes.planner.primary.rail, "claude");
  assert.ok(r.warnings.some((w) => w.includes("rail")), r.warnings.join("\n"));
});

test("mergeConfig warns about a route left without a primary and keeps the old route", () => {
  const r = mergeConfig(base(), [{ source: "project", data: { routes: { planner: { primary: null } } } }]);
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("primary")), r.warnings.join("\n"));
  // A primary of null is invalid, not deletion: the previous route stands.
  assert.equal(r.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.equal(r.config.routes.planner.alternate?.model, "openai-codex/gpt-6-sol");
});

test("mergeConfig warns but applies a model whose prefix names a different rail", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { routes: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "claude" } } } },
    },
  ]);
  assert.equal(r.config.routes.planner.primary.model, "openai-codex/gpt-6-sol");
  assert.equal(r.config.routes.planner.primary.rail, "claude");
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("rail")), r.warnings.join("\n"));
});

test("mergeConfig does not warn when a model's prefix matches its declared rail", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { routes: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.routes.planner.primary.model, "openai-codex/gpt-6-sol");
  assert.equal(r.config.routes.planner.primary.rail, "codex");
});

test("mergeConfig accepts the shipped claude-bridge model on the claude rail", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        routes: { implementer: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } },
      },
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
      data: { routes: { "../outside": { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } } },
    },
  ]);
  assert.equal("../outside" in r.config.routes, false, "a traversal name must not become a route");
  assert.ok(r.warnings.some((w) => w.includes("../outside")), r.warnings.join("\n"));
  // The shipped routes are untouched.
  assert.deepEqual(Object.keys(r.config.routes).sort(), ["implementer", "planner", "reviewer"]);
});

test("mergeConfig drops a programmatically built base route whose name is unsafe", () => {
  const built = base();
  // A base config does not have to have come from `defaultConfig()`: a caller
  // can hand `mergeConfig` anything, so the base's own keys are validated too.
  built.routes["../outside"] = { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } };
  built.routes["constructor"] = { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" } };
  built.routes["toString"] = { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" } };
  built.routes["code-reviewer"] = { primary: { model: "deepseek/deepseek-flash", rail: "deepseek" } };

  const r = mergeConfig(built, []);
  assert.equal(Object.hasOwn(r.config.routes, "../outside"), false);
  assert.equal(Object.hasOwn(r.config.routes, "constructor"), false);
  assert.equal(Object.hasOwn(r.config.routes, "toString"), false);
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
  assert.equal(r.config.routes["code-reviewer"].primary.model, "deepseek/deepseek-flash");
  assert.equal(r.sources["routes.code-reviewer.primary.model"], "built-in");
});

test("a layer-level null cannot resurrect a base route with an unsafe name", () => {
  const built = base();
  built.routes["../outside"] = { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } };
  built.routes["constructor"] = { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" } };

  const r = mergeConfig(built, [
    { source: "project", data: { routes: { "../outside": null, constructor: null } } },
  ]);
  assert.equal(Object.hasOwn(r.config.routes, "../outside"), false);
  assert.equal(Object.hasOwn(r.config.routes, "constructor"), false);
  assert.ok(r.warnings.some((w) => w.includes("../outside")), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => w.includes("constructor")), r.warnings.join("\n"));
});

test("mergeConfig accepts a dashed agent name", () => {
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: { routes: { "agent-2": { primary: { model: "openai-codex/gpt-6-astra", rail: "codex" } } } },
    },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.routes["agent-2"].primary.model, "openai-codex/gpt-6-astra");
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

test("a project override of one agent leaves the others and the scalars intact", async () => {
  const defaults = defaultConfig(AGENT_DIR);
  const fs = fakeFs({
    [PROJECT_PATH]: JSON.stringify({
      routes: { implementer: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } } },
    }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.config.sessionSwitchAt, 75);
  assert.deepEqual(loaded.config.routes.planner, defaults.routes.planner);
  assert.deepEqual(loaded.config.routes.reviewer, defaults.routes.reviewer);
  assert.equal(loaded.config.routes.implementer.primary.model, "claude-bridge/claude-opus-5-5");
  assert.equal(loaded.config.routes.implementer.alternate?.model, "openai-codex/gpt-6-luna");
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

  const routeField = lines.find((l) => l.includes("routes.planner.primary.model"));
  assert.ok(routeField, lines.join("\n"));
  assert.ok(routeField.includes("claude-bridge/claude-opus-5-5"), routeField);
  assert.ok(routeField.includes("[built-in]"), routeField);
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

test("describeConfig lists scalars before routes and sorts routes by agent", async () => {
  const loaded = await loadedWithProjectOverride();
  const lines = describeConfig(loaded);

  const firstRoute = lines.findIndex((l) => l.includes("routes."));
  assert.ok(firstRoute > 0, lines.join("\n"));
  for (const scalar of ["agentDir", "claudeCredsPath", "piAuthPath", "ttlMs", "pollMs", "sessionSwitchAt", "weeklySwitchAt", "margin"]) {
    const i = lines.findIndex((l) => l.includes(scalar));
    assert.ok(i >= 0, `missing ${scalar}`);
    assert.ok(i < firstRoute, `${scalar} should come before the route lines`);
  }

  const impl = lines.findIndex((l) => l.includes("routes.implementer."));
  const planner = lines.findIndex((l) => l.includes("routes.planner."));
  const reviewer = lines.findIndex((l) => l.includes("routes.reviewer."));
  assert.ok(impl >= 0 && planner >= 0 && reviewer >= 0, lines.join("\n"));
  assert.ok(impl < planner && planner < reviewer, `routes out of order: ${lines.join(" | ")}`);

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
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

// Regression guard: `mergeConfig` used to write `sources` while validating, so
// a route or candidate that was later rejected (or erased and not replaced)
// left provenance claiming a layer supplied a value `config` did not hold.
test("a rejected route leaves no provenance for its candidates", () => {
  // The project erases the primary (invalid) but offers a replacement
  // alternate. The whole route is rejected, so the built-in alternate stays in
  // force and must still be attributed to the built-in layer.
  const r = mergeConfig(base(), [
    {
      source: "project",
      data: {
        routes: {
          planner: { primary: null, alternate: { model: "openai-codex/gpt-6-luna", rail: "codex" } },
        },
      },
    },
  ]);
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes("primary")), r.warnings.join("\n"));
  assert.equal(r.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.equal(r.config.routes.planner.alternate?.model, "openai-codex/gpt-6-sol");
  assert.equal(r.sources["routes.planner.primary.model"], "built-in");
  assert.equal(r.sources["routes.planner.alternate.model"], "built-in");
});

test("a rejected new route leaves no provenance keys at all", () => {
  const r = mergeConfig(base(), [
    { source: "project", data: { routes: { newbie: { primary: { model: "claude-bridge/x" } } } } },
  ]);
  assert.equal(Object.hasOwn(r.config.routes, "newbie"), false);
  assert.ok(r.warnings.some((w) => w.includes("newbie")), r.warnings.join("\n"));
  // Not merely "not project": no `routes.newbie.*` key may exist at all.
  assert.deepEqual(
    Object.keys(r.sources).filter((key) => key.startsWith("routes.newbie")),
    [],
  );
});

test("erasing a route with an invalid primary keeps the lower layer's value and source", () => {
  const r = mergeConfig(base(), [
    {
      source: "global",
      data: { routes: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } } },
    },
    { source: "project", data: { routes: { planner: { primary: null } } } },
  ]);
  assert.equal(r.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-6");
  assert.equal(r.sources["routes.planner.primary.model"], "global");
});

test("a rejected candidate inside an accepted route leaves no provenance for it", () => {
  // The global drops the planner alternate; the project offers a model-only
  // replacement, which cannot complete a candidate from nothing. The route is
  // still accepted (its primary survives), but the alternate is absent and must
  // leave no trace in `sources`.
  const r = mergeConfig(base(), [
    { source: "global", data: { routes: { planner: { alternate: null } } } },
    { source: "project", data: { routes: { planner: { alternate: { model: "openai-codex/gpt-6-luna" } } } } },
  ]);
  assert.equal(r.config.routes.planner.alternate, undefined);
  assert.deepEqual(
    Object.keys(r.sources).filter((key) => key.startsWith("routes.planner.alternate")),
    [],
  );
});

/**
 * Property: `sources` describes the merged config, no more and no less.
 *
 *   (a) every key in `sources` resolves to a value that exists in `config`;
 *   (b) every candidate field present in `config` has a `sources` entry.
 *
 * A merge that records provenance for a rejected route or candidate breaks
 * (a); one that commits a value without its source breaks (b).
 */
test("sources never names a value the merged config does not hold", () => {
  const nasty: Array<{ name: string; layers: MergeLayer[] }> = [
    {
      name: "rejected route (primary null)",
      layers: [
        {
          source: "project",
          data: { routes: { planner: { primary: null, alternate: { model: "openai-codex/gpt-6-sol", rail: "codex" } } } },
        },
      ],
    },
    {
      name: "rejected new route",
      layers: [{ source: "project", data: { routes: { newbie: { primary: { model: "claude-bridge/x" } } } } }],
    },
    {
      name: "route erased then lower layer's value survives",
      layers: [
        { source: "global", data: { routes: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } } } },
        { source: "project", data: { routes: { planner: { primary: null } } } },
      ],
    },
    {
      name: "candidate erased then model-only replacement rejected",
      layers: [
        { source: "global", data: { routes: { planner: { alternate: null } } } },
        { source: "project", data: { routes: { planner: { alternate: { model: "openai-codex/gpt-6-luna" } } } } },
      ],
    },
    {
      name: "bad rail",
      layers: [{ source: "project", data: { routes: { planner: { primary: { rail: "openai" } } } } }],
    },
    {
      name: "no-slash model",
      layers: [{ source: "project", data: { routes: { planner: { primary: { model: "gpt-6-sol" } } } } }],
    },
    {
      name: "path traversal agent name",
      layers: [
        { source: "project", data: { routes: { "../outside": { primary: { model: "claude-bridge/x", rail: "claude" } } } } },
      ],
    },
    {
      name: "route named constructor (null)",
      layers: [{ source: "project", data: { routes: { constructor: null } } }],
    },
    {
      name: "route named constructor (valid)",
      layers: [
        {
          source: "project",
          data: { routes: { constructor: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } } } },
        },
      ],
    },
    { name: "route-level null", layers: [{ source: "project", data: { routes: { implementer: null } } }] },
    { name: "candidate-level null", layers: [{ source: "project", data: { routes: { planner: { alternate: null } } } }] },
    {
      name: "model of the wrong type",
      layers: [{ source: "project", data: { routes: { planner: { primary: { model: 123 } } } } }],
    },
  ];

  for (const { name, layers } of nasty) {
    const r = mergeConfig(base(), layers);
    for (const key of Object.keys(r.sources)) {
      assert.ok(resolveDotted(r.config, key).exists, `${name}: sources has "${key}" but config does not`);
    }
    for (const [agent, route] of Object.entries(r.config.routes)) {
      for (const slot of ["primary", "alternate"] as const) {
        const candidate = route[slot];
        if (!candidate) continue;
        for (const field of ["model", "rail"] as const) {
          const key = `routes.${agent}.${slot}.${field}`;
          assert.ok(key in r.sources, `${name}: config has ${key} but sources does not`);
        }
      }
    }
  }
});

test("the surviving value from a lower layer keeps its real source in describeConfig", async () => {
  const fs = fakeFs({
    [GLOBAL_PATH]: JSON.stringify({ routes: { planner: { primary: { model: "claude-bridge/claude-opus-5-6" } } } }),
    [PROJECT_PATH]: JSON.stringify({ routes: { planner: { primary: null } } }),
  });
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fs.readFile, warn: () => {} });
  assert.equal(loaded.config.routes.planner.primary.model, "claude-bridge/claude-opus-5-6");
  assert.equal(loaded.sources["routes.planner.primary.model"], "global");

  const lines = describeConfig(loaded);
  const line = lines.find((l) => l.includes("routes.planner.primary.model"));
  assert.ok(line, lines.join("\n"));
  assert.ok(line.includes("claude-bridge/claude-opus-5-6"), line);
  assert.ok(line.includes("[global]"), line);
  assert.ok(!line.includes("[built-in]"), line);
});
