import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_GENERATOR_TIMEOUT_MS,
  loadConfig,
  loadConfigReplacingLayer,
  parseGeneratorDeclaration,
} from "../src/config.ts";
import {
  type BashRunInput,
  GENERATOR_STDERR_CAP_BYTES,
  GENERATOR_STDERR_LINES,
  GENERATOR_STDOUT_CAP_BYTES,
  describeStderr,
  generateConfig,
  runBash,
} from "../src/generator.ts";

// ---------------------------------------------------------------- helpers

const AGENT_DIR = "/x/agent";
const CWD = "/x/project";
const GLOBAL_PATH = join(AGENT_DIR, "quota-dispatch.json");
const PROJECT_PATH = join(CWD, CONFIG_DIR_NAME, "quota-dispatch.json");

function fakeRead(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    if (Object.prototype.hasOwnProperty.call(files, path)) return files[path];
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
    err.code = "ENOENT";
    throw err;
  };
}

/** One route that is valid whatever layer it sits in. */
const VALID_ROUTE = {
  primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
  alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
};

async function replaceGlobal(
  layer: Record<string, unknown>,
  other: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof loadConfigReplacingLayer>>> {
  return loadConfigReplacingLayer({
    source: "global",
    path: GLOBAL_PATH,
    data: layer,
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fakeRead(other),
  });
}

// ---------------------------------------------------------------- declaration

test("a generator declaration needs a non-blank command and nothing else", () => {
  assert.deepEqual(parseGeneratorDeclaration({ command: " true" }), {
    declaration: { command: " true" },
  });
  assert.deepEqual(parseGeneratorDeclaration({ command: "true", timeoutMs: 1 }), {
    declaration: { command: "true", timeoutMs: 1 },
  });
  assert.deepEqual(parseGeneratorDeclaration({ command: "true", timeoutMs: 2_147_483_647 }), {
    declaration: { command: "true", timeoutMs: 2_147_483_647 },
  });
  assert.equal(DEFAULT_GENERATOR_TIMEOUT_MS, 5_000);
});

test("a malformed declaration is rejected with every reason at once", () => {
  const parsed = parseGeneratorDeclaration({ command: "  ", timeoutMs: 0, extra: true });
  assert.ok("rejections" in parsed);
  assert.equal(parsed.rejections.length, 3, parsed.rejections.join("\n"));
  assert.ok(parsed.rejections.some((r) => r.includes("command")));
  assert.ok(parsed.rejections.some((r) => r.includes("timeoutMs") && r.includes("1, 2147483647")));
  assert.ok(parsed.rejections.some((r) => r.includes('unknown key "generator.extra"')));
});

test("a declaration that is not an object is one rejection, not a crash", () => {
  const parsed = parseGeneratorDeclaration("true");
  assert.ok("rejections" in parsed);
  assert.equal(parsed.rejections.length, 1);
});

// ------------------------------------------------------- tolerant load

test("a valid generator declaration loads silently and never enters the config", async () => {
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fakeRead({
      [GLOBAL_PATH]: JSON.stringify({
        generator: { command: "true", timeoutMs: 1000 },
        margin: 10,
      }),
    }),
  });
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.sources.generator, undefined);
  assert.ok(!("generator" in loaded.config));
  assert.equal(loaded.config.margin, 10);
});

test("a malformed generator declaration warns and leaves the file's routes running", async () => {
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fakeRead({
      [GLOBAL_PATH]: JSON.stringify({ generator: { command: "" }, margin: 20 }),
    }),
  });
  assert.ok(
    loaded.warnings.some((w) => w.includes("generator.command")),
    loaded.warnings.join("\n"),
  );
  assert.equal(loaded.config.margin, 20);
  assert.ok(!("generator" in loaded.config));
});

test("an unknown key inside the declaration is reported as a generator key", async () => {
  const loaded = await loadConfig({
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fakeRead({ [GLOBAL_PATH]: JSON.stringify({ generator: { command: "true", typo: 1 } }) }),
  });
  assert.ok(
    loaded.warnings.some((w) => w.includes('unknown key "generator.typo"')),
    loaded.warnings.join("\n"),
  );
});

// ------------------------------------------------------- strict replacement

/**
 * The first fenced JSON block after an anchor, so the examples the docs ship
 * are checked as data rather than trusted to stay valid by hand.
 */
function firstJsonBlockAfter(text: string, anchor: string): string {
  const start = text.indexOf(anchor);
  assert.notEqual(start, -1, `missing anchor: ${anchor}`);
  const match = text.slice(start).match(/```json\n([\s\S]*?)```/);
  assert.ok(match, `no JSON block after ${anchor}`);
  return match[1]!;
}

test("the README and ADR generator examples are valid configuration", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const adr = await readFile(new URL("../docs/adr/0015-configuration-generation.md", import.meta.url), "utf8");
  const examples: Array<[string, string, string]> = [
    ["README", readme, "### Generating configuration"],
    ["ADR 0015", adr, "# Configuration can be generated"],
  ];
  for (const [label, text, anchor] of examples) {
    const block = firstJsonBlockAfter(text, anchor);
    // As a config file it must load without a warning and route the planner.
    const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fakeRead({ [GLOBAL_PATH]: block }) });
    assert.deepEqual(loaded.warnings, [], label);
    assert.equal(loaded.config.agents.planner?.primary.model, "claude-bridge/claude-opus-5-5", label);
    // As generated output its ordinary part must pass the strict check.
    const ordinary: Record<string, unknown> = { ...JSON.parse(block) };
    delete ordinary.generator;
    const strict = await replaceGlobal(ordinary);
    assert.equal(strict.kind, "accepted", `${label}: ${JSON.stringify(strict)}`);
  }
});

test("a plain valid replacement is accepted with no warnings", async () => {
  const result = await replaceGlobal({ agents: { planner: VALID_ROUTE } });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.equal(result.loaded.config.agents.planner.primary.model, "claude-bridge/claude-opus-5-5");
  assert.equal(result.loaded.sources["agents.planner.primary.model"], "global");
  assert.deepEqual(result.loaded.warnings, []);
});

test("any invalid top-level or nested value rejects the whole output", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["unknown top-level key", { bogus: true }],
    ["out-of-range scalar", { pollMs: 0 }],
    ["unknown agent key", { agents: { planner: { ...VALID_ROUTE, primry: {} } } }],
    ["candidate with no rail", { agents: { planner: { primary: { model: "claude-bridge/x" } } } }],
    ["unknown candidate key", { agents: { planner: { primary: { ...VALID_ROUTE.primary, extra: 1 } } } }],
    ["unknown models key", { models: { "claude-bridge/x": { rail: "claude", bogus: 1 } } }],
    ["models entry not an object", { models: { "claude-bridge/x": 5 } }],
    ["skill binding not a string", { skills: { "code-review": 5 } }],
    ["null primary", { agents: { planner: { ...VALID_ROUTE, primary: null } } }],
  ];
  for (const [label, layer] of cases) {
    const result = await replaceGlobal(layer);
    assert.equal(result.kind, "rejected", label);
    if (result.kind === "rejected") assert.ok(result.rejections.length > 0, label);
  }
});

test("a skip instruction cannot hide an invalid nested value", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "unknown agent key under ignore",
      { agents: { planner: { ignore: true, ...VALID_ROUTE, primry: {} } } },
    ],
    [
      "unknown candidate key under disable",
      {
        agents: {
          planner: { disable: true, ...VALID_ROUTE, primary: { ...VALID_ROUTE.primary, extra: 1 } },
        },
      },
    ],
    ["bad thinking under ignore", { agents: { planner: { ignore: true, thinking: "bogus" } } }],
    ["bad disable beside ignore", { agents: { planner: { ignore: true, disable: "bad" } } }],
    ["null primary under ignore", { agents: { planner: { ignore: true, primary: null } } }],
    ["wrong-shaped candidate under disable", { agents: { planner: { disable: true, primary: 5 } } }],
    ["non-array alternates under ignore", { agents: { planner: { ignore: true, alternates: "no" } } }],
  ];
  for (const [label, layer] of cases) {
    const result = await replaceGlobal(layer);
    assert.equal(result.kind, "rejected", `${label}: ${JSON.stringify(result)}`);
  }
});

test("an empty supplied alternate rejects even over an existing list", async () => {
  const action = await replaceGlobal({ agents: { planner: { alternates: [{}] } } });
  assert.equal(action.kind, "rejected");
  if (action.kind === "rejected") {
    assert.ok(
      action.rejections.some((r) => r.includes('"agents.planner.alternates[0]" needs a "model" and a "rail"')),
      action.rejections.join("\n"),
    );
  }
});

test("valid flag-only skips and empty entries stay legal no-ops", async () => {
  const accepted = await replaceGlobal({
    agents: {
      // A flag-only entry names no route field, so it is not a half-built route.
      ghost: { ignore: true },
      gone: { disable: true },
      parked: { disable: false },
      // An empty entry is an empty entry, not a failure.
      hollow: {},
    },
  });
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind === "accepted") assert.deepEqual(accepted.loaded.warnings, []);
});

test("a partial project primary override may inherit the lower global primary", async () => {
  const result = await loadConfigReplacingLayer({
    source: "project",
    path: PROJECT_PATH,
    data: { agents: { planner: { primary: { thinking: "high" } } } },
    agentDir: AGENT_DIR,
    cwd: CWD,
    readFile: fakeRead({
      // The lower layer already carries the primary and its rail.
      [GLOBAL_PATH]: JSON.stringify({ agents: { planner: VALID_ROUTE } }),
    }),
  });
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    const primary = result.loaded.config.agents.planner.primary;
    assert.equal(primary.model, "claude-bridge/claude-opus-5-5");
    assert.equal(primary.thinking, "high");
    assert.equal(result.loaded.sources["agents.planner.primary.thinking"], "project");
    assert.equal(result.loaded.sources["agents.planner.primary.model"], "global");
  }
});

test("a model rail registered in either layer completes a candidate", async () => {
  const result = await replaceGlobal(
    { agents: { planner: { primary: { model: "openai-codex/gpt-6-sol" } } } },
    {
      [PROJECT_PATH]: JSON.stringify({
        models: { "openai-codex/gpt-6-sol": { rail: "codex" } },
      }),
    },
  );
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.equal(result.loaded.config.agents.planner.primary.rail, "codex");
    assert.equal(result.loaded.sources["agents.planner.primary.rail"], "project");
  }
});

test("a warning from the other layer is visible without rejecting the replacement", async () => {
  const result = await replaceGlobal(
    { agents: { planner: VALID_ROUTE } },
    { [PROJECT_PATH]: "{ this is not json" },
  );
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") {
    assert.ok(
      result.loaded.warnings.some((w) => w.includes("skipped whole")),
      result.loaded.warnings.join("\n"),
    );
  }
});

test("a threshold conflict rejects when the replacement supplies either value", async () => {
  const rejected = await replaceGlobal(
    { sessionSwitchAt: 95 },
    { [PROJECT_PATH]: JSON.stringify({ sessionAlwaysSwitchAt: 90 }) },
  );
  assert.equal(rejected.kind, "rejected");
  if (rejected.kind === "rejected") {
    assert.ok(rejected.rejections.some((r) => r.includes("sessionAlwaysSwitchAt")), rejected.rejections.join("\n"));
  }

  // Both conflicting values from the other layer: the replacement is innocent,
  // so the conflict is reported but does not reject it.
  const accepted = await replaceGlobal(
    { agents: { planner: VALID_ROUTE } },
    { [PROJECT_PATH]: JSON.stringify({ sessionSwitchAt: 95, sessionAlwaysSwitchAt: 90 }) },
  );
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind === "accepted") {
    assert.ok(
      accepted.loaded.warnings.some((w) => w.includes("sessionAlwaysSwitchAt")),
      accepted.loaded.warnings.join("\n"),
    );
  }
});

test("the accepted configuration is what a later ordinary load produces", async () => {
  const layer = {
    agents: { planner: VALID_ROUTE },
    models: { "claude-bridge/claude-opus-5-5": { thinking: "high" } },
  };
  const result = await replaceGlobal(layer);
  assert.equal(result.kind, "accepted");

  const files: Record<string, string> = { [GLOBAL_PATH]: JSON.stringify(layer) };
  const loaded = await loadConfig({ agentDir: AGENT_DIR, cwd: CWD, readFile: fakeRead(files) });
  if (result.kind !== "accepted") return;
  assert.deepEqual(loaded.config, result.loaded.config);
  assert.deepEqual(loaded.sources, result.loaded.sources);
});

// ------------------------------------------------------- generateConfig orchestration

interface Sandbox {
  root: string;
  agentDir: string;
  projectDir: string;
  target: string;
}

async function sandbox(contents: string, project = "global"): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pqd-generate-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
  const target =
    project === "global" ? join(agentDir, "quota-dispatch.json") : join(projectDir, CONFIG_DIR_NAME, "quota-dispatch.json");
  await writeFile(target, contents, "utf8");
  return { root, agentDir, projectDir, target };
}

/** A runner that answers with fixed bytes and records its input. */
function cannedRunner(stdout: string, stderr = "", failure?: string) {
  const calls: BashRunInput[] = [];
  return {
    calls,
    run: async (input: BashRunInput) => {
      calls.push(input);
      return {
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(stderr),
        ...(failure !== undefined ? { failure } : {}),
      };
    },
  };
}

function declarationText(command: string, timeoutMs?: number): string {
  return JSON.stringify({ generator: { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } });
}

async function generate(
  sandboxed: Sandbox,
  stdout: string,
  opts: { stderr?: string; failure?: string; prepare?: (loaded: any) => Promise<any>; scope?: "global" | "project" } = {},
) {
  const canned = cannedRunner(stdout, opts.stderr ?? "", opts.failure);
  const result = await generateConfig({
    source: opts.scope ?? "global",
    path: sandboxed.target,
    agentDir: sandboxed.agentDir,
    cwd: sandboxed.projectDir,
    run: canned.run,
    prepare: opts.prepare ?? (async (loaded) => ({ tag: "prepared", loaded })),
  });
  return { result, calls: canned.calls };
}

test("a successful run writes the ordinary output and preserves the declaration", async () => {
  const box = await sandbox(declarationText("true", 2500));
  const generated = JSON.stringify({ agents: { planner: VALID_ROUTE }, margin: 12 }, null, 2);
  const { result, calls } = await generate(box, generated);
  assert.equal(result.kind, "generated");
  if (result.kind !== "generated") return;

  assert.equal(calls[0].command, "true");
  assert.equal(calls[0].timeoutMs, 2500);
  // The target file's own directory is the working directory.
  assert.equal(calls[0].cwd, dirname(box.target));

  const written = JSON.parse(await readFile(box.target, "utf8"));
  assert.deepEqual(written.generator, { command: "true", timeoutMs: 2500 });
  assert.equal(written.margin, 12);
  assert.equal(result.loaded.config.margin, 12);
  assert.equal(result.prepared.tag, "prepared");
});

test("the default timeout is used when the declaration states none", async () => {
  const box = await sandbox(declarationText("true"));
  const { calls } = await generate(box, JSON.stringify({}));
  assert.equal(calls[0].timeoutMs, DEFAULT_GENERATOR_TIMEOUT_MS);
});

test("the stdout generator is ignored even when invalid, and the original is kept", async () => {
  const box = await sandbox(declarationText("true", 1234));
  const generated = JSON.stringify({ generator: "not a declaration at all", margin: 7 });
  const { result } = await generate(box, generated);
  assert.equal(result.kind, "generated");
  const written = JSON.parse(await readFile(box.target, "utf8"));
  assert.deepEqual(written.generator, { command: "true", timeoutMs: 1234 });
  assert.equal(written.margin, 7);
});

test("a failed run preserves the file, reports stderr, and never prepares", async () => {
  const box = await sandbox(declarationText("false"));
  let prepared = false;
  const { result } = await generate(box, "", {
    stderr: "the script exploded\n",
    failure: "exited with code 2",
    prepare: async () => {
      prepared = true;
      return {};
    },
  });
  assert.equal(result.kind, "failed");
  assert.ok(!prepared);
  if (result.kind === "failed") {
    const text = result.lines.join("\n");
    assert.ok(text.includes("exited with code 2"), text);
    assert.ok(text.includes("the script exploded"), text);
    assert.ok(text.includes("This run did not change"), text);
  }
  assert.equal(await readFile(box.target, "utf8"), declarationText("false"));
});

test("invalid output preserves the file and still shows the run's stderr", async () => {
  const box = await sandbox(declarationText("true"));
  const before = await readFile(box.target, "utf8");
  for (const [label, stdout] of [
    ["not json", "hello"],
    ["an array", "[]"],
    ["a BOM", "\uFEFF{}"],
    ["a number that re-serializes to null", '{"pollMs": 1e400}'],
  ] as Array<[string, string]>) {
    const fresh = await sandbox(declarationText("true"));
    const { result } = await generate(fresh, stdout, { stderr: "warning: noisy\n" });
    assert.equal(result.kind, "failed", label);
    if (result.kind === "failed") {
      assert.ok(result.lines.join("\n").includes("warning: noisy"), `${label}: ${result.lines.join("\n")}`);
    }
    assert.equal(await readFile(fresh.target, "utf8"), before, label);
  }
});

test("invalid UTF-8 on stdout is a failure", async () => {
  const box = await sandbox(declarationText("true"));
  const canned = cannedRunner("");
  const result = await generateConfig({
    source: "global",
    path: box.target,
    agentDir: box.agentDir,
    cwd: box.projectDir,
    run: async (input) => {
      canned.calls.push(input);
      return { stdout: Buffer.from([0x7b, 0xff, 0x7d]), stderr: Buffer.alloc(0) };
    },
    prepare: async () => ({}),
  });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.ok(result.lines.join("\n").includes("UTF-8"), result.lines.join("\n"));
});

test("a configuration that cannot be prepared fails before the file is touched", async () => {
  const box = await sandbox(declarationText("true"));
  const before = await readFile(box.target, "utf8");
  const { result } = await generate(box, JSON.stringify({ margin: 9 }), {
    stderr: "context\n",
    prepare: async () => {
      throw new Error("no dispatcher today");
    },
  });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    const text = result.lines.join("\n");
    assert.ok(text.includes("no dispatcher today"), text);
    assert.ok(text.includes("context"), text);
  }
  assert.equal(await readFile(box.target, "utf8"), before);
});

test("a target edited while the generator ran is not clobbered", async () => {
  const box = await sandbox(declarationText("true"));
  const external = declarationText("true").replace("}", ', "margin": 3}');
  const canned = cannedRunner(JSON.stringify({ margin: 42 }));
  const result = await generateConfig({
    source: "global",
    path: box.target,
    agentDir: box.agentDir,
    cwd: box.projectDir,
    run: async (input) => {
      // The external edit lands after our read and before the lock re-read.
      await writeFile(box.target, external, "utf8");
      canned.calls.push(input);
      return { stdout: Buffer.from(JSON.stringify({ margin: 42 })), stderr: Buffer.alloc(0) };
    },
    prepare: async () => ({}),
  });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.ok(result.lines.join("\n").includes("changed"), result.lines.join("\n"));
  assert.equal(await readFile(box.target, "utf8"), external);
});

test("a held lock is a failure, not permission to write", async () => {
  const box = await sandbox(declarationText("true"));
  const before = await readFile(box.target, "utf8");
  const lockPath = join(dirname(box.target), `.${"quota-dispatch.json"}.lock`);
  const lockRecord = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() });
  await writeFile(lockPath, lockRecord, "utf8");
  try {
    const canned = cannedRunner(JSON.stringify({ margin: 42 }));
    const result = await generateConfig({
      source: "global",
      path: box.target,
      agentDir: box.agentDir,
      cwd: box.projectDir,
      run: canned.run,
      // Wait zero time so the held lock is answered at once rather than slept over.
      coordination: { pacing: { waitMs: 1, pollMs: 1 } },
      prepare: async () => ({}),
    });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.ok(result.lines.join("\n").includes("lock"), result.lines.join("\n"));
    assert.equal(await readFile(box.target, "utf8"), before);

    // The other writer's lock, and the directory around it, are left exactly
    // as found: no own lock and no temporary file from this run.
    assert.equal(await readFile(lockPath, "utf8"), lockRecord, "the foreign lock must survive");
    const names = await readdir(dirname(box.target));
    assert.ok(!names.some((name) => name.includes(".tmp")), `no temporary file may be left: ${names.join(", ")}`);
    assert.deepEqual(
      names.filter((name) => name.endsWith(".lock")),
      [`.${basename(box.target)}.lock`],
      "no lock of this run's own may be left",
    );
  } finally {
    await rm(lockPath, { force: true });
  }
});

test("a committed change whose lock release failed is reported as a note, not as unchanged", async () => {
  const box = await sandbox(declarationText("true"));
  const lockPath = join(dirname(box.target), `.${basename(box.target)}.lock`);
  // The path the lock resolves to; the compare-and-swap re-read names it, and it
  // is the last hook before the rename.
  const resolvedTarget = await realpath(box.target);
  const result = await generateConfig({
    source: "global",
    path: box.target,
    agentDir: box.agentDir,
    cwd: box.projectDir,
    run: async () => ({ stdout: Buffer.from(JSON.stringify({ margin: 5 })), stderr: Buffer.alloc(0) }),
    // The seam: on the compare-and-swap re-read, turn the lock file into a
    // directory, so the release's `readFile` fails after the rename has landed.
    readFile: async (path: string) => {
      const text = await readFile(path, "utf8");
      if (path === resolvedTarget) {
        await rm(lockPath, { force: true });
        await mkdir(lockPath, { recursive: true });
      }
      return text;
    },
    prepare: async () => ({}),
  });
  try {
    assert.equal(result.kind, "generated");
    if (result.kind !== "generated") return;
    assert.ok(result.cleanupNote !== undefined, "the committed change must carry a cleanup note");
    assert.equal(JSON.parse(await readFile(box.target, "utf8")).margin, 5);
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
});

test("a symlinked target keeps its link and writes through to the file", async () => {
  const box = await sandbox(declarationText("true"));
  const real = join(box.root, "real.json");
  await writeFile(real, await readFile(box.target, "utf8"), "utf8");
  await rm(box.target);
  await symlink(real, box.target);
  const { result } = await generate(box, JSON.stringify({ margin: 8 }));
  assert.equal(result.kind, "generated");
  assert.ok((await lstat(box.target)).isSymbolicLink());
  assert.equal(JSON.parse(await readFile(real, "utf8")).margin, 8);
});

test("only the target layer is written; the other file is untouched", async () => {
  const box = await sandbox(declarationText("true"));
  const other = join(box.projectDir, CONFIG_DIR_NAME, "quota-dispatch.json");
  await writeFile(other, JSON.stringify({ margin: 1 }), "utf8");
  const { result } = await generate(box, JSON.stringify({ margin: 2 }));
  assert.equal(result.kind, "generated");
  assert.equal(JSON.parse(await readFile(other, "utf8")).margin, 1);
});

// ------------------------------------------------------- runBash process behavior

function runOrFail(input: BashRunInput): Promise<Awaited<ReturnType<typeof runBash>>> {
  return runBash(input);
}

test("real Bash: exact stdout, cwd and EOF stdin", async () => {
  const box = await sandbox(declarationText("true"));
  const cwd = await realpath(dirname(box.target));
  const ran = await runOrFail({
    command: "cat >/dev/null; pwd; printf '{\"ok\":true}'",
    cwd,
    timeoutMs: 5_000,
  });
  assert.equal(ran.failure, undefined);
  assert.equal(ran.stdout.toString("utf8"), `${cwd}\n{"ok":true}`);
});

test("real Bash: a non-zero exit reports code and stderr", async () => {
  const ran = await runOrFail({ command: "printf 'boom' >&2; exit 3", cwd: tmpdir(), timeoutMs: 5_000 });
  assert.equal(ran.failure, "exited with code 3");
  assert.equal(ran.stderr.toString("utf8"), "boom");
});

test("real Bash: signal death is a failure", async () => {
  const ran = await runOrFail({ command: "kill -TERM $$", cwd: tmpdir(), timeoutMs: 5_000 });
  assert.ok(ran.failure?.startsWith("was killed by"), ran.failure);
});

test("real Bash: a timeout kills the run and settles promptly", async () => {
  const started = Date.now();
  const ran = await runOrFail({ command: "sleep 30", cwd: tmpdir(), timeoutMs: 200 });
  assert.ok(ran.failure?.includes("did not finish within"), ran.failure);
  assert.ok(Date.now() - started < 5_000, "the timeout must settle without waiting out the command");
});

test("real Bash: a background pipe-holder cannot hold the run open past the timeout", async () => {
  const started = Date.now();
  // The shell exits at once, but the backgrounded sleep inherits the stdout
  // pipe, so a runner that waited for the pipes to close would hang.
  const ran = await runOrFail({ command: "sleep 30 & printf '{\"ok\":true}'", cwd: tmpdir(), timeoutMs: 300 });
  assert.ok(ran.failure?.includes("exited with code 0"), ran.failure);
  assert.ok(ran.failure?.includes("background process kept its output open"), ran.failure);
  assert.ok(Date.now() - started < 5_000);
});

test("real Bash: a held pipe keeps the exit status in the diagnostic", async () => {
  // The background process redirects its stdout but still holds stderr, so the
  // shell's nonzero exit is reached without `close`; the diagnostic must carry
  // the code rather than reporting only that the run did not finish.
  const ran = await runOrFail({ command: "(sleep 3 >/dev/null) & printf '{}'; exit 2", cwd: tmpdir(), timeoutMs: 300 });
  assert.ok(ran.failure?.includes("exited with code 2"), ran.failure);
  assert.ok(ran.failure?.includes("background process kept its output open"), ran.failure);
});

test("real Bash: stdout over the cap is a failure", async () => {
  const ran = await runOrFail({
    command: `head -c ${GENERATOR_STDOUT_CAP_BYTES + 1024} /dev/zero | tr '\\0' 'a'`,
    cwd: tmpdir(),
    timeoutMs: 10_000,
  });
  assert.ok(ran.failure?.includes("stdout"), ran.failure);
});

test("real Bash: stderr is bounded to its tail", async () => {
  const ran = await runOrFail({
    command: `i=0; while [ $i -lt 4000 ]; do echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; i=$((i+1)); done`,
    cwd: tmpdir(),
    timeoutMs: 10_000,
  });
  assert.equal(ran.failure, undefined);
  assert.ok(ran.stderr.length <= GENERATOR_STDERR_CAP_BYTES, String(ran.stderr.length));
});

test("a rejected layer is never prepared and never written", async () => {
  const box = await sandbox(declarationText("true"));
  const before = await readFile(box.target, "utf8");
  let prepared = false;
  const { result } = await generate(box, JSON.stringify({ agents: { planner: { primary: {} } } }), {
    stderr: "noise\n",
    prepare: async () => {
      prepared = true;
      return {};
    },
  });
  assert.equal(result.kind, "failed");
  assert.equal(prepared, false, "a rejected layer must not reach preparation");
  if (result.kind === "failed") assert.ok(result.lines.join("\n").includes("noise"), result.lines.join("\n"));
  assert.equal(await readFile(box.target, "utf8"), before);
});

test("the replaced file keeps its mode", async () => {
  const box = await sandbox(declarationText("true"));
  await chmod(box.target, 0o600);
  const { result } = await generate(box, JSON.stringify({ margin: 6 }));
  assert.equal(result.kind, "generated");
  assert.equal((await stat(box.target)).mode & 0o777, 0o600);
});

test("real Bash: a missing working directory is a spawn failure", async () => {
  const ran = await runOrFail({ command: "true", cwd: join(tmpdir(), "pqd-does-not-exist"), timeoutMs: 5_000 });
  assert.ok(ran.failure?.includes("could not be started"), ran.failure);
});

test("real Bash: a grandchild is killed with the group on timeout", async () => {
  const box = await sandbox(declarationText("true"));
  const marker = join(box.root, "orphan-alive");
  // The child backgrounds a writer, then sleeps past the timeout. If the group
  // is killed, the writer never fires; the direct child alone would leave it.
  const ran = await runOrFail({
    command: `( sleep 0.8; touch '${marker}' ) & sleep 30`,
    cwd: tmpdir(),
    timeoutMs: 200,
  });
  assert.ok(ran.failure?.includes("did not finish within"), ran.failure);
  await new Promise((done) => setTimeout(done, 1_200));
  await assert.rejects(readFile(marker, "utf8"), "the group kill must reach the descendant");
});

// ------------------------------------------------------- stderr rendering

test("describeStderr renders the last lines, escaped", () => {
  const buffer = Buffer.from(
    Array.from({ length: GENERATOR_STDERR_LINES + 5 }, (_, i) => `line ${i}`).join("\n"),
    "utf8",
  );
  const lines = describeStderr(buffer);
  assert.equal(lines[0], "stderr:");
  const rendered = lines.slice(1);
  assert.equal(rendered.length, GENERATOR_STDERR_LINES);
  assert.ok(rendered[0].includes(`line 5`), rendered[0]);
  assert.equal(describeStderr(Buffer.alloc(0)).length, 0);
});
