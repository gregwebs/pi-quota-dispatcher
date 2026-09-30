import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  type AgentRoute, type DispatcherConfig,
  DEFAULT_CONFIG, agentKey, agentTableSnippet, checkAgentFiles, checkModels,
  contestedDecision, createDispatcher, decide, describeAgentFiles, heldDecision,
  readAgentDirectory, readAgentFiles, resolveAgent,
} from "../src/index.ts";
import { agentNameRejection, configFilesFor, describeConfig, globalConfigPath, loadConfig, mergeConfig } from "../src/config.ts";

const MODEL = "deepseek/deepseek-flash";
const route: AgentRoute = { primary: { model: MODEL, rail: "deepseek" }, alternates: [] };
const text = (name?: string, model = "deepseek/old") =>
  `---\n${name === undefined ? "" : `name: ${name}\n`}model: "${model}"\n---\n\nBody.\n`;
const config = (dir: string, names: string[]): DispatcherConfig => ({
  ...DEFAULT_CONFIG, agentDir: dir, agents: Object.fromEntries(names.map((n) => [n, route])),
});
async function fixture(t: TestContext, entries: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "pqd-names-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(entries)) await writeFile(join(dir, file), contents);
  return dir;
}
// The oracle is S1, not an OS-dependent filename validator.
test("the seam accepts every safe segment and rejects only paths and prototype keys", () => {
  for (const name of ["Plan", "Explore", "9lives", "v1.2", "snake_case", "Code Reviewer", "a:b", "é", " a ", "a\nb"]) {
    assert.equal(agentNameRejection(name), undefined, JSON.stringify(name));
  }
  for (const name of ["", ".", "..", "../outside", "a/b", "a\\b", "a\0b"]) {
    assert.equal(agentNameRejection(name), `agent ${JSON.stringify(name)} is not a valid agent name (a name is also a filename, so it must be a single path segment: not empty, not "." or "..", and with no "/", "\\" or NUL character)`);
  }
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(agentNameRejection(name), `agent "${name}" shadows Object.prototype and is not manageable`);
  }
});

test("Plan and Explore survive real config loading with plain provenance", async (t) => {
  const dir = await fixture(t, {});
  const cwd = join(dir, "project");
  await mkdir(cwd);
  await writeFile(globalConfigPath(dir), JSON.stringify({ agents: { Plan: route, Explore: route } }));
  const logged: string[] = [];
  const loaded = await loadConfig({ agentDir: dir, cwd, warn: (w) => logged.push(w) });
  assert.deepEqual(Object.keys(loaded.config.agents).sort(), ["Explore", "Plan"]);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(logged, []);
  for (const name of ["Plan", "Explore"]) assert.equal(loaded.sources[`agents.${name}.primary.model`], "global");
});

for (const declared of ["Architect", '"  Architect  "', "' Architect '", "Architect # comment"]) {
  test(`a declared name ${declared} writes its defining file, not the path /agents would create`, async (t) => {
    const dir = await fixture(t, { "plan-work.md": text(declared) });
    const cfg = config(dir, ["Architect"]);
    assert.deepEqual(resolveAgent(await readAgentDirectory(dir), "Architect"), { kind: "defined", definition: { agent: "Architect", file: join(dir, "plan-work.md") } });
    assert.deepEqual(checkAgentFiles(cfg, await readAgentDirectory(dir), () => {}), []);
    const [result] = await createDispatcher(cfg).evaluate({ dry: false });
    assert.equal(result.outcome, "written");
    assert.equal(result.decision.kind === "assign" ? result.decision.file : undefined, join(dir, "plan-work.md"));
    assert.equal(await readFile(join(dir, "plan-work.md"), "utf8"), text(declared, MODEL));
    await assert.rejects(readFile(join(dir, "Architect.md")), { code: "ENOENT" });
  });
}

test("an occupied route path is missing, never clobbered, and warns about its real agent", async (t) => {
  const before = text("Architect");
  const dir = await fixture(t, { "plan-work.md": before });
  const cfg = config(dir, ["plan-work"]);
  const d = await readAgentDirectory(dir);
  const resolution = resolveAgent(d, "plan-work");
  assert.equal(resolution.kind, "missing");
  assert.equal(resolution.kind === "missing" ? resolution.occupant : undefined, d.files[0]);
  const [warning] = checkAgentFiles(cfg, d, () => {});
  assert.ok(warning.includes(join(dir, "plan-work.md")), warning);
  assert.ok(warning.includes('has no file (the file there is agent "Architect")'), warning);
  assert.equal(warning.includes("/agents"), false, warning);
  assert.ok(warning.includes("name the route after that agent, or rename that file"), warning);
  const [result] = await createDispatcher(cfg).evaluate({ dry: false });
  assert.equal(result.outcome, "skipped (no file)");
  assert.equal(await readFile(join(dir, "plan-work.md"), "utf8"), before);
});

test("resolution is exact-case and recomputed after a name changes between passes", async (t) => {
  const dir = await fixture(t, { "work.md": text("Plan") });
  const cfg = config(dir, ["Plan", "plan"]);
  const dispatcher = createDispatcher(cfg);
  assert.equal(resolveAgent(await readAgentDirectory(dir), "plan").kind, "missing");
  const first = await dispatcher.evaluate({ dry: false });
  assert.deepEqual(first.map((r) => [r.decision.agent, r.outcome]), [["Plan", "written"], ["plan", "skipped (no file)"]]);
  await writeFile(join(dir, "work.md"), text("plan"));
  const second = await dispatcher.evaluate({ dry: false });
  assert.deepEqual(second.map((r) => [r.decision.agent, r.outcome]), [["Plan", "skipped (no file)"], ["plan", "written"]]);
});

for (const order of [["z.md", "A.md"], ["A.md", "z.md"]]) {
  test(`duplicate claimants hold in filename order regardless of creation order ${order}`, async (t) => {
    const before = text("reviewer", MODEL);
    const dir = await fixture(t, Object.fromEntries(order.map((f) => [f, before])));
    const cfg = config(dir, ["reviewer"]);
    const d = await readAgentDirectory(dir);
    const resolution = resolveAgent(d, "reviewer");
    assert.equal(resolution.kind, "contested");
    if (resolution.kind !== "contested") assert.fail("expected contest");
    assert.deepEqual(resolution.files.map((f) => basename(f.file)), ["A.md", "z.md"]);
    const why = '2 agent files claim the name "reviewer" (A.md, z.md) and pi spawns whichever it loads last — holding';
    assert.deepEqual(contestedDecision(resolution), { agent: "reviewer", kind: "hold", why });
    const warnings = checkAgentFiles(cfg, d, () => {});
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('is contested: 2 agent files claim the name "reviewer" (A.md, z.md)'), warnings[0]);
    assert.ok(warnings[0].endsWith("give each file its own name"), warnings[0]);
    assert.equal(warnings[0].endsWith(":"), false);
    assert.equal(warnings[0].includes("ambiguous"), false);
    const [result] = await createDispatcher(cfg).evaluate({ dry: false });
    assert.equal(result.outcome, "held");
    assert.deepEqual(result.decision, { agent: "reviewer", kind: "hold", why });
    assert.equal("file" in result.decision, false);
    assert.equal(result.decision.why.includes("ambiguous"), false);
    for (const f of order) assert.equal(await readFile(join(dir, f), "utf8"), before);
    assert.deepEqual(JSON.parse(agentTableSnippet([...d.files]).join("\n")).agents, {});
  });
}

test("discovery sorts filenames, decodes names, falls back on empty, and distinguishes scoped files", async (t) => {
  const dir = await fixture(t, {
    "z.md": text("Alpha", MODEL), "A.md": text("Zulu", MODEL),
    "empty.md": text('"  "', MODEL), "bare.md": text("", MODEL),
    "none.md": text(undefined, MODEL), "a:b.md": text(undefined, MODEL),
    "scoped.md": text('" acme:scout "', MODEL), "unsafe.md": text("a/b", MODEL),
  });
  const files = await readAgentFiles(dir);
  assert.deepEqual(files.map((f) => [basename(f.file), f.kind, f.kind === "agent" ? f.name : f.declared]), [
    ["A.md", "agent", "Zulu"], ["a:b.md", "agent", "a:b"], ["bare.md", "agent", "bare"], ["empty.md", "agent", "empty"],
    ["none.md", "agent", "none"], ["scoped.md", "scoped", "acme:scout"], ["unsafe.md", "agent", "a/b"], ["z.md", "agent", "Alpha"],
  ]);
  const proposed = JSON.parse(agentTableSnippet(files).join("\n")).agents;
  assert.deepEqual(Object.keys(proposed).sort(), ["Alpha", "Zulu", "a:b", "bare", "empty", "none"]);
  assert.equal(proposed.Zulu.primary.model, MODEL);
  assert.equal(resolveAgent({ dir, files }, "acme:scout").kind, "missing");
});

test("snippet proposes the declared identity, omits every contestant even if only one has a usable model", async (t) => {
  const dir = await fixture(t, {
    "plan-work.md": text("Architect", MODEL), "one.md": text("reviewer", MODEL),
    "two.md": text("reviewer", "custom/unknown"), "scoped.md": text("acme:scout", MODEL),
  });
  const files = await readAgentFiles(dir);
  assert.deepEqual(JSON.parse(agentTableSnippet(files).join("\n")).agents, { Architect: { primary: { model: MODEL } } });
  assert.deepEqual(describeAgentFiles(files), [
    `  one.md (name: reviewer) — model: ${MODEL}`,
    `  plan-work.md (name: Architect) — model: ${MODEL}`,
    '  scoped.md — not an agent: its declared name "acme:scout" is scoped',
    "  two.md (name: reviewer) — model: custom/unknown",
  ]);
});

test("an unreadable file defines and contests nothing; its route skips without rejecting the pass", async (t) => {
  if (process.getuid?.() === 0) { t.skip("root can read mode-000 files"); return; }
  const dir = await fixture(t, { "secret.md": text("other", MODEL), "ok.md": text("ok") });
  const secret = join(dir, "secret.md");
  await chmod(secret, 0);
  t.after(() => chmod(secret, 0o600).catch(() => {}));
  const d = await readAgentDirectory(dir);
  const unreadable = d.files.find((f) => f.kind === "agent" && f.name === "secret");
  assert.deepEqual(unreadable, { kind: "agent", name: "secret", file: secret, unreadable: true });
  const resolution = resolveAgent(d, "secret");
  assert.equal(resolution.kind, "missing");
  assert.equal(resolution.kind === "missing" ? resolution.occupant : undefined, unreadable);
  const cfg = config(dir, ["secret", "ok"]);
  const [warning] = checkAgentFiles(cfg, d, () => {});
  assert.ok(warning.includes("the file there could not be read"), warning);
  assert.equal(warning.includes("/agents"), false, warning);
  assert.ok(warning.includes("make that file readable, or remove it"), warning);
  assert.ok(describeAgentFiles([...d.files]).includes("  secret.md — unreadable"));
  const results = await createDispatcher(cfg).evaluate({ dry: false });
  assert.equal(results.find((r) => r.decision.agent === "secret")?.outcome, "skipped (no file)");
  assert.equal(results.find((r) => r.decision.agent === "ok")?.outcome, "written");
  const withReadable = { dir, files: [...d.files, { kind: "agent" as const, name: "secret", file: join(dir, "readable.md"), model: MODEL }] };
  assert.equal(resolveAgent(withReadable, "secret").kind, "defined");
});

test("boot check warns once per unresolved route in name order and survives a throwing sink", async (t) => {
  const dir = await fixture(t, { "ok.md": text("ok"), "z.md": text("dup"), "A.md": text("dup") });
  const cfg = config(dir, ["zMissing", "ok", "dup", "aMissing"]);
  const d = await readAgentDirectory(dir);
  const logged: string[] = [];
  const warnings = checkAgentFiles(cfg, d, (w) => logged.push(w));
  assert.deepEqual(logged, warnings);
  assert.equal(warnings.length, 3);
  assert.ok(warnings[0].includes('configured agent "aMissing" has no file'));
  assert.ok(warnings[0].startsWith(join(dir, "aMissing.md") + ":"));
  assert.ok(warnings[0].includes("run the /agents command to create a new agent"));
  assert.equal(resolveAgent(d, "aMissing").kind, "missing");
  assert.ok(warnings[1].includes('configured agent "dup" is contested'));
  assert.ok(warnings[2].includes('configured agent "zMissing" has no file'));
  assert.deepEqual(checkAgentFiles(cfg, d, () => { throw new Error("sink"); }), warnings);
});

test("decide preserves a resolved definition verbatim and containment depends on file, not agent", () => {
  const cfg = config("/tmp/agents", ["Plan"]);
  const definition = { agent: "Plan", file: "/tmp/agents/plan-work.md" };
  const d = decide(definition, route, new Map(), cfg);
  assert.equal(d.kind, "assign");
  assert.equal(d.kind === "assign" ? d.file : undefined, definition.file);
  const outside = decide({ agent: "Plan", file: "/tmp/agents-evil/Plan.md" }, route, new Map(), cfg);
  assert.equal("file" in outside, false);
  assert.deepEqual(outside, { agent: "Plan", kind: "hold", why: '"Plan" resolves outside the agents directory (/tmp/agents-evil/Plan.md) — holding' });
});

test("agent keys quote punctuation without conflating adjacent agents or disabled markers", () => {
  for (const [name, key] of [["planner", "agents.planner"], ["Plan", "agents.Plan"], ["9lives", "agents.9lives"], ["snake_case", "agents.snake_case"], ["v1.2", 'agents["v1.2"]'], ["Code Reviewer", 'agents["Code Reviewer"]'], ["a:b", 'agents["a:b"]'], ['a"b', 'agents["a\\"b"]']]) assert.equal(agentKey(name), key);
  const merged = mergeConfig(config("/tmp/agents", []), [
    { source: "global", data: { agents: { a: route, "a.b": route, Plan: route, "v1.2": route } } },
    { source: "project", data: { agents: { a: { disable: true }, Plan: { disable: true }, "v1.2": { disable: true } } } },
  ]);
  assert.equal(merged.sources['agents["a.b"].primary.model'], "global");
  assert.equal(merged.sources['agents["a.b"].primary.rail'], "global");
  assert.deepEqual(Object.keys(merged.config.agents), ["a.b"]);
  const lines = describeConfig({ ...merged, files: [] });
  assert.ok(lines.includes("  agents.Plan = disabled  [project]"), lines.join("\n"));
  assert.ok(lines.includes('  agents["v1.2"] = disabled  [project]'), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes('agents["a.b"].primary.model') && l.includes("[global]")), lines.join("\n"));
});

test("quoted model misses and dropped alternates retain config-file provenance", () => {
  const cfg = config("/tmp/agents", []);
  const merged = mergeConfig(cfg, [{ source: "global", data: { agents: {
    "v1.2": { primary: { model: "deepseek/missing", rail: "deepseek" }, alternates: [{ model: "deepseek/unknown", rail: "deepseek" }] },
  } } }]);
  const checked = checkModels(merged.config, () => false, () => {});
  assert.deepEqual(checked.misses.map((m) => m.key), ['agents["v1.2"].primary.model', 'agents["v1.2"].alternates[0].model']);
  assert.equal(checked.droppedAlternates["v1.2"][0].key, 'agents["v1.2"].alternates[0].model');
  const loaded = { ...merged, files: [{ source: "global" as const, path: "/tmp/global.json", state: { kind: "applied" as const } }] };
  assert.deepEqual(configFilesFor(loaded, checked.misses.map((m) => m.key)), ["/tmp/global.json"]);
  const hold = heldDecision({ agent: "v1.2", model: "deepseek/missing" });
  assert.deepEqual(hold, { agent: "v1.2", kind: "hold", why: 'agents["v1.2"].primary.model: this pi does not know model deepseek/missing — a newer pi may; holding' });
});

test("quoted provenance isolates a route name that looks like another route's value path", () => {
  const merged = mergeConfig(config("/tmp/agents", []), [
    { source: "global", data: { agents: {
      a: { ...route, thinking: "high" },
      "a.primary": { ...route, thinking: "low", alternates: [{ model: MODEL, rail: "deepseek", thinking: "off" }] },
    } } },
    { source: "project", data: { agents: { a: { disable: true } } } },
  ]);
  assert.equal(merged.sources['agents["a.primary"].thinking'], "global");
  assert.equal(merged.sources['agents["a.primary"].primary.model'], "global");
  assert.equal(merged.sources['agents["a.primary"].alternates[0].thinking'], "global");
  assert.equal(merged.sources['agents["a.primary"].alternates[0].rail'], "global");
  assert.equal(merged.sources["agents.a.primary.model"], undefined);
  assert.equal(merged.sources["agents.a.thinking"], undefined);
  assert.equal(merged.sources["agents.a"], "project");
});

test("disabled markers round-trip JSON-escaped accepted names without disappearing", () => {
  const names = ['Code Reviewer', 'a:b', 'a"b', 'line\nbreak', 'a\u2028b', 'a\u2029b'];
  const merged = mergeConfig(config("/tmp/agents", names), [{ source: "project", data: {
    agents: Object.fromEntries(names.map((name) => [name, { disable: true }])),
  } }]);
  const lines = describeConfig({ ...merged, files: [] });
  for (const name of names) {
    assert.equal(merged.sources[agentKey(name)], "project");
    assert.ok(lines.includes(`  ${agentKey(name)} = disabled  [project]`), lines.join("\n"));
  }
});

test("a whitespace-declared Plan does not fall back to its stem or create Plan.md", async (t) => {
  const dir = await fixture(t, { "plan-work.md": text('"  Plan  "') });
  const cfg = config(dir, ["Plan"]);
  const [result] = await createDispatcher(cfg).evaluate({ dry: false });
  assert.equal(result.decision.agent, "Plan");
  assert.equal(result.outcome, "written");
  assert.equal(await readFile(join(dir, "plan-work.md"), "utf8"), text('"  Plan  "', MODEL));
  await assert.rejects(readFile(join(dir, "Plan.md")), { code: "ENOENT" });
});

test("a scoped file stays visible as a non-agent occupant and a stem route cannot overwrite it", async (t) => {
  const before = text('" acme:scout "', MODEL);
  const dir = await fixture(t, { "scoped.md": before });
  const file = join(dir, "scoped.md");
  const scoped = { kind: "scoped", declared: "acme:scout", file };
  assert.deepEqual(await readAgentFiles(dir), [scoped]);
  const d = await readAgentDirectory(dir);
  assert.deepEqual(d, { dir, files: [scoped] });
  assert.deepEqual(describeAgentFiles([...d.files]), ['  scoped.md — not an agent: its declared name "acme:scout" is scoped']);
  assert.deepEqual(JSON.parse(agentTableSnippet([...d.files]).join("\n")).agents, {});
  const resolution = resolveAgent(d, "scoped");
  assert.equal(resolution.kind, "missing");
  assert.deepEqual(resolution.kind === "missing" ? resolution.occupant : undefined, scoped);
  assert.equal(resolveAgent(d, "acme:scout").kind, "missing");
  const cfg = config(dir, ["scoped"]);
  const warnings = checkAgentFiles(cfg, d, () => {});
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith(`${file}:`), warnings[0]);
  assert.ok(warnings[0].includes('the file there is not an agent: its declared name "acme:scout" is scoped'), warnings[0]);
  // The occupied path must not be described as a bare missing-file/create remedy.
  assert.equal(warnings[0].includes("/agents"), false, warnings[0]);
  assert.ok(warnings[0].includes("give that file a name pi registers, or drop this route"), warnings[0]);
  const [result] = await createDispatcher(cfg).evaluate({ dry: false });
  assert.equal(result.outcome, "skipped (no file)");
  assert.equal(await readFile(file, "utf8"), before);
});

test("scoped declarations neither define nor contest a colon-named stem agent", async (t) => {
  const dir = await fixture(t, {
    "a:b.md": text(undefined, MODEL),
    "one.md": text("a:b", MODEL),
    "two.md": text("a:b", MODEL),
  });
  const d = await readAgentDirectory(dir);
  assert.deepEqual(d.files.map((f) => f.kind), ["agent", "scoped", "scoped"]);
  assert.deepEqual(resolveAgent(d, "a:b"), { kind: "defined", definition: { agent: "a:b", file: join(dir, "a:b.md") } });
  assert.deepEqual(checkAgentFiles(config(dir, ["a:b"]), d, () => {}), []);
  assert.deepEqual(JSON.parse(agentTableSnippet([...d.files]).join("\n")).agents, { "a:b": { primary: { model: MODEL } } });
});

for (const separator of ["\u2028", "\u2029"]) {
  test(`disabled marker retains raw U+${separator.charCodeAt(0).toString(16).toUpperCase()}`, () => {
    const name = `a${separator}b`;
    const merged = mergeConfig(config("/tmp/agents", [name]), [
      { source: "project", data: { agents: { [name]: { disable: true } } } },
    ]);
    const key = `agents["${name}"]`;
    assert.equal(agentKey(name), key, "the separator is raw, not a JSON newline escape");
    assert.equal(merged.sources[key], "project");
    assert.ok(describeConfig({ ...merged, files: [] }).includes(`  ${key} = disabled  [project]`));
  });
}
