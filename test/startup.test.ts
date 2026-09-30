import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension, {
  type AgentFile,
  type NamedAgentFile,
  type ConfigFile,
  type ConfigFileFault,
  type ModelMiss,
  agentTableSnippet,
  describeAgentFiles,
  readAgentFiles,
  unconfiguredNotice,
  unknownModelsNotice,
  unusableConfigNotice,
} from "../src/index.ts";

// The package does not re-export ENV_AGENT_DIR from its root, so use the
// documented literal directly.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const CONFIG_FILE_NAME = "quota-dispatch.json";

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

// The em dash the agreed wording pins (U+2014), kept as a named constant so a
// careless hyphen cannot slip into an assertion.
const DASH = "\u2014";

// These fixtures define agents; fail rather than silently dropping a scoped result.
function named(file: AgentFile): NamedAgentFile {
  assert.equal(file.kind, "agent");
  if (file.kind !== "agent") assert.fail("expected an agent definition");
  return file;
}

// ---------------------------------------------------------------- readAgentFiles

test("readAgentFiles lists only *.md files, sorted, with the active model unquoted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-read-"));
  await writeFile(join(dir, "zulu.md"), TEMPLATE("zulu", "deepseek/deepseek-flash"), "utf8");
  await writeFile(join(dir, "alpha.md"), TEMPLATE("alpha", "claude-bridge/claude-opus-5-5"), "utf8");
  // Neither is a `*.md` regular file, so neither is an agent.
  await writeFile(join(dir, "notes.txt"), "not an agent", "utf8");
  await mkdir(join(dir, "folder.md"), { recursive: true });

  const files = await readAgentFiles(dir);

  assert.deepEqual(
    files.map((f) => named(f).name),
    ["alpha", "zulu"],
    "only *.md regular files, sorted by name",
  );
  assert.equal(files[0].file, join(dir, "alpha.md"));
  assert.equal(named(files[0]).model, "claude-bridge/claude-opus-5-5", "the value is unquoted");
});

test("readAgentFiles leaves model absent when the file declares none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-read-"));
  await writeFile(join(dir, "nomodel.md"), `---\nname: nomodel\nthinking: high\n---\n\nBody.\n`, "utf8");
  // Only a commented model: the active line is what counts.
  await writeFile(join(dir, "commented.md"), `---\nname: commented\n# model: "a/b"\n---\n`, "utf8");

  const files = await readAgentFiles(dir);
  const byName = Object.fromEntries(files.map((f) => [named(f).name, named(f)]));

  assert.equal(byName.nomodel.model, undefined);
  assert.equal(byName.commented.model, undefined, "a commented model is not the active one");
  assert.equal(files.length, 2, "a file without a model is still listed");
});

// Discovery decodes the same way `upsertModel` compares, so a snippet proposes
// the model id itself — never the comment someone glued to it.
test("readAgentFiles decodes a commented or escaped model to the bare id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-read-"));
  await writeFile(
    join(dir, "comment.md"),
    `---\nname: comment\nmodel: claude-bridge/claude-opus-5-5 # pinned\n---\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "escape.md"),
    `---\nname: escape\nmodel: "openai-codex\\/gpt-6-sol"\n---\n`,
    "utf8",
  );

  const files = await readAgentFiles(dir);
  const byName = Object.fromEntries(files.map((f) => [named(f).name, named(f)]));
  assert.equal(byName.comment.model, "claude-bridge/claude-opus-5-5");
  assert.equal(byName.escape.model, "openai-codex/gpt-6-sol");

  const { agents } = JSON.parse(agentTableSnippet(files).join("\n"));
  assert.equal(agents.comment.primary.model, "claude-bridge/claude-opus-5-5");
  assert.equal(agents.escape.primary.model, "openai-codex/gpt-6-sol");
});

test("readAgentFiles reads a missing directory as no files", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "pqd-read-")), "does-not-exist");
  assert.deepEqual(await readAgentFiles(dir), []);
});

test("readAgentFiles skips a file it cannot read rather than throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-read-"));
  await writeFile(join(dir, "ok.md"), TEMPLATE("ok", "deepseek/deepseek-flash"), "utf8");
  // A dangling symlink is a `*.md` name whose read rejects.
  await symlink(join(dir, "missing.md"), join(dir, "broken.md"));

  const files = await readAgentFiles(dir);
  assert.deepEqual(
    files.map((f) => named(f).name),
    ["ok"],
  );
});

// An agent file may be a symlink, but a directory, a FIFO, or a symlink to
// either is not an agent definition. `stat` follows the first and rejects the
// rest without opening a FIFO, which is why it is used instead of `readdir`'s
// file type.
test("readAgentFiles skips non-regular files and follows a symlink to one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-read-"));
  await writeFile(join(dir, "ok.md"), TEMPLATE("ok", "deepseek/deepseek-flash"), "utf8");
  await writeFile(join(dir, "target.md"), TEMPLATE("target", "deepseek/deepseek-flash"), "utf8");
  await symlink(join(dir, "target.md"), join(dir, "link.md")); // symlink to a regular file: an agent
  await mkdir(join(dir, "folder.md"), { recursive: true });
  await symlink(join(dir, "folder.md"), join(dir, "dirlink.md"));
  await symlink(join(dir, "gone.md"), join(dir, "dangling.md"));
  try {
    execFileSync("mkfifo", [join(dir, "pipe.md")]);
  } catch {
    t.skip("mkfifo is unavailable on this platform");
    return;
  }

  const files = await readAgentFiles(dir);
  assert.deepEqual(files.map((f) => named(f).name), ["target", "ok", "target"]);
  assert.equal(
    named(files.find((f) => f.file === join(dir, "link.md"))!).model,
    "deepseek/deepseek-flash",
    "a symlink to a regular file is read through",
  );
});

// A regular file that is present but cannot be opened is still a file the user
// has, so it is listed — flagged as unreadable rather than silently dropped.
test("readAgentFiles lists a present-but-unreadable file and says so", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read a mode-000 file");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "pqd-read-"));
  const secret = join(dir, "secret.md");
  await writeFile(secret, TEMPLATE("secret", "deepseek/deepseek-flash"), "utf8");
  await chmod(secret, 0o000);

  try {
    const files = await readAgentFiles(dir);
    assert.equal(files.length, 1, "an unreadable file is still listed");
    assert.equal(named(files[0]).name, "secret");
    assert.equal(named(files[0]).unreadable, true);
    assert.equal(named(files[0]).model, undefined);
    assert.deepEqual(describeAgentFiles(files), ["  secret.md — unreadable"]);
  } finally {
    await chmod(secret, 0o600);
  }
});

// ---------------------------------------------------------------- agentTableSnippet

const SNIPPET_FILES: AgentFile[] = [
  { kind: "agent", name: "planner", file: "/a/planner.md", model: "claude-bridge/claude-opus-5-5" },
  { kind: "agent", name: "reviewer", file: "/a/reviewer.md", model: "openai-codex/gpt-6-astra" },
  { kind: "agent", name: "writer", file: "/a/writer.md", model: "anthropic/claude-sonnet" },
  { kind: "agent", name: "rest", file: "/a/rest.md", model: "deepseek/deepseek-flash" },
  { kind: "agent", name: "mystery", file: "/a/mystery.md", model: "mystery/thing" },
  { kind: "agent", name: "blank", file: "/a/blank.md" },
  // A name the config would reject: not a safe filename.
  { kind: "agent", name: "a/b", file: "/a/unsafe.md", model: "openai-codex/gpt-6-sol" },
];

test("agentTableSnippet registers each rail once and names only models in the routes", () => {
  // Paste-ready means the config fragment as it would go in the file: each
  // model's rail is registered once under `models`, and each route names only
  // the model it points at.
  const { models, agents } = JSON.parse(agentTableSnippet(SNIPPET_FILES).join("\n"));

  assert.deepEqual(models, {
    "claude-bridge/claude-opus-5-5": { rail: "claude" },
    "openai-codex/gpt-6-astra": { rail: "codex" },
    // Two names for the same rail; both must derive it.
    "anthropic/claude-sonnet": { rail: "claude" },
    "deepseek/deepseek-flash": { rail: "deepseek" },
  });
  assert.deepEqual(agents, {
    planner: { primary: { model: "claude-bridge/claude-opus-5-5" } },
    reviewer: { primary: { model: "openai-codex/gpt-6-astra" } },
    writer: { primary: { model: "anthropic/claude-sonnet" } },
    rest: { primary: { model: "deepseek/deepseek-flash" } },
  });
});

test("agentTableSnippet drops a file with no model, an unknown prefix, or an unusable name", () => {
  const { agents } = JSON.parse(agentTableSnippet(SNIPPET_FILES).join("\n"));
  for (const excluded of ["mystery", "blank", "a/b"]) {
    assert.equal(excluded in agents, false, `${excluded} must contribute nothing`);
  }
});

// ---------------------------------------------------------------- describeAgentFiles

test("describeAgentFiles names each file and the model it declares", () => {
  const files: AgentFile[] = [
    { kind: "agent", name: "planner", file: "/a/planner.md", model: "claude-bridge/claude-opus-5-5" },
    { kind: "agent", name: "blank", file: "/a/blank.md" },
  ];

  const lines = describeAgentFiles(files);
  assert.equal(lines.length, 2, "one line per file, including the modelless one");
  assert.ok(lines[0].includes("planner"), lines[0]);
  assert.ok(lines[0].includes("claude-bridge/claude-opus-5-5"), lines[0]);
  assert.ok(lines[1].includes("blank"), lines[1]);
});

// ---------------------------------------------------------------- unconfiguredNotice

test("unconfiguredNotice names the config file, lists the files, and carries the snippet", () => {
  const files: AgentFile[] = [
    { kind: "agent", name: "planner", file: "/a/planner.md", model: "claude-bridge/claude-opus-5-5" },
    { kind: "agent", name: "reviewer", file: "/a/reviewer.md", model: "openai-codex/gpt-6-astra" },
  ];
  const configPath = "/a/quota-dispatch.json";

  const text = unconfiguredNotice(configPath, "/a", files).join("\n");

  assert.ok(text.includes(configPath), text);
  assert.ok(text.includes("planner"), text);
  assert.ok(text.includes("reviewer"), text);
  // The snippet's candidates: each file's model, with the rail registered for
  // it under `models`.
  assert.ok(text.includes("claude-bridge/claude-opus-5-5"), text);
  assert.ok(text.includes("openai-codex/gpt-6-astra"), text);
  assert.match(text, /"rail"\s*:\s*"claude"/, text);
  assert.match(text, /"rail"\s*:\s*"codex"/, text);
});

test("unconfiguredNotice still points at the config file when no agent files were found", () => {
  const configPath = "/a/quota-dispatch.json";
  const lines = unconfiguredNotice(configPath, "/a", []);
  assert.ok(lines.join("\n").includes(configPath), lines.join("\n"));
});

// A file with no model, or with an unknown prefix, is listed but cannot seed a
// candidate. Offering `{"agents": {}}` would be a snippet that configures
// nothing, so the notice must say why there is nothing to paste instead.
test("unconfiguredNotice gives no snippet when no file can seed one", () => {
  const files: AgentFile[] = [
    { kind: "agent", name: "blank", file: "/a/blank.md" },
    { kind: "agent", name: "mystery", file: "/a/mystery.md", model: "mystery/thing" },
  ];

  const text = unconfiguredNotice("/a/quota-dispatch.json", "/a", files).join("\n");

  assert.ok(!text.includes('"agents"'), `no empty snippet may be offered:\n${text}`);
  assert.ok(text.includes("blank") && text.includes("mystery"), text);
  assert.match(text, /no snippet to paste/, text);
});

// ---------------------------------------------------------------- unusableConfigNotice

/** A config file that is there and produced no layer. */
function unusable(path: string, fault: ConfigFileFault): ConfigFile {
  return { source: "global", path, state: { kind: "unusable", fault } };
}

// The install this notice exists for: the file is right there and names agents,
// so `unconfiguredNotice` would tell the reader to name agents in a file they
// have already written. The fault lines are the log's and the report's own, so
// the notice is a shortcut to that record rather than a third wording of it.
test("unusableConfigNotice leads with the fault lines verbatim and ends with the fix", () => {
  const configPath = "/a/quota-dispatch.json";
  const lines = unusableConfigNotice([
    unusable(configPath, { kind: "not-json", detail: "Expected double-quoted property name", at: { line: 3, column: 1 } }),
  ]);

  assert.ok(lines[0].includes("could not be used"), lines[0]);
  assert.ok(
    lines.includes(
      `${configPath}: not valid JSON (line 3, column 1: Expected double-quoted property name) — ` +
        "the file is skipped whole, so the layers below it still apply",
    ),
    lines.join("\n"),
  );
  assert.match(lines.at(-1) ?? "", /\/reload/, lines.join("\n"));

  const text = lines.join("\n");
  assert.ok(!text.includes("no agents are configured"), `the ask must not be repeated:\n${text}`);
  assert.ok(!text.includes('"agents"'), `no paste-ready snippet belongs here:\n${text}`);
});

// Both layers can be unusable at once, and each has to be named: a reader who
// repairs one and reloads has to know the other is still costing them routes.
test("unusableConfigNotice names every file that was skipped", () => {
  const text = unusableConfigNotice([
    unusable("/home/g/quota-dispatch.json", { kind: "unreadable", detail: "EACCES: permission denied" }),
    unusable("/repo/.pi/quota-dispatch.json", { kind: "not-an-object" }),
  ]).join("\n");

  assert.ok(text.includes("/home/g/quota-dispatch.json"), text);
  assert.ok(text.includes("/repo/.pi/quota-dispatch.json"), text);
});

// ---------------------------------------------------------------- unknownModelsNotice

test("unknownModelsNotice names every miss once, at its key, and the file to edit", () => {
  const misses: ModelMiss[] = [
    { key: "agents.reviewer.primary.model", model: "openai-codex/gpt-astra-6" },
    { key: "agents.reviewer.alternates[0].model", model: "openai-codex/gpt-sol-6" },
  ];

  const lines = unknownModelsNotice(misses, ["/a/quota-dispatch.json"]);

  assert.deepEqual(lines, [
    "quota-dispatcher: a configured model is unknown to this pi.",
    `agents.reviewer.primary.model: this pi does not know model openai-codex/gpt-astra-6 ${DASH} a newer pi may`,
    `agents.reviewer.alternates[0].model: this pi does not know model openai-codex/gpt-sol-6 ${DASH} a newer pi may`,
    "Edit /a/quota-dispatch.json, then /reload, or upgrade pi.",
  ]);

  const text = lines.join("\n");
  assert.match(text, /unknown to this pi/, "the id is unknown here, not bad everywhere");
  assert.ok(!/invalid/i.test(text), `the notice must not call an id invalid:\n${text}`);
});

// A miss can be written in either layer, so the notice may have two files to
// name — and a reader who edits the wrong one has not fixed anything.
test("unknownModelsNotice names both config layers when the misses came from both", () => {
  const misses: ModelMiss[] = [
    { key: "agents.planner.primary.model", model: "a/x" },
    { key: "agents.writer.primary.model", model: "b/y" },
  ];

  const text = unknownModelsNotice(misses, ["/home/g/quota-dispatch.json", "/repo/.pi/quota-dispatch.json"]).join(
    "\n",
  );

  assert.ok(text.includes("/home/g/quota-dispatch.json"), text);
  assert.ok(text.includes("/repo/.pi/quota-dispatch.json"), text);
});

// ---------------------------------------------------------------- fresh install (integration)

interface FreshFixture {
  agentDir: string;
  projectDir: string;
  agentsDir: string;
  configPath: string;
}

/**
 * A fresh install: relocated agent dir, a project dir to `chdir` into, valid
 * credentials (so a *wrongful* fetch would actually reach the stub), and an
 * `agents` table under the caller's control. The default is the shipped empty
 * table.
 */
async function freshFixture(agents: Record<string, unknown> = {}): Promise<FreshFixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-startup-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const agentsDir = join(agentDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });

  const claudeCredsPath = join(root, "claude-credentials.json");
  await writeFile(
    claudeCredsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } }),
    "utf8",
  );
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ "openai-codex": { access: "tok", accountId: "acct" } }),
    "utf8",
  );

  const configPath = join(agentDir, CONFIG_FILE_NAME);
  await writeFile(configPath, JSON.stringify({ claudeCredsPath, pollMs: 2_147_483_647, agents }), "utf8");

  await writeFile(join(agentsDir, "planner.md"), TEMPLATE("planner", "claude-bridge/claude-opus-5-5"), "utf8");
  await writeFile(join(agentsDir, "reviewer.md"), TEMPLATE("reviewer", "openai-codex/gpt-6-astra"), "utf8");
  await writeFile(join(agentsDir, "notes.txt"), "not an agent", "utf8");

  return { agentDir, projectDir, agentsDir, configPath };
}

interface Notify {
  text: string;
  level: string;
}

interface Ctx {
  hasUI: boolean;
  ui: {
    notify: (text: string, level?: string) => void;
    setStatus: (key: string, text?: string) => void;
  };
}

type SessionStartHandler = (event: { reason: string }, ctx: Ctx) => Promise<void>;

interface Harness {
  notify: Notify[];
  statuses: Array<{ key: string; text: string | undefined }>;
  /** Fire `session_start` on `reason` with a fresh, recording context. */
  start: (reason: string) => Promise<void>;
  fetchCalls: () => number;
  intervals: () => number;
}

/** Let the microtask queue drain so a stray fire-and-forget schedule shows up. */
async function pump(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Install the extension under a relocated agent dir and cwd, recording every UI
 * call. `setInterval` is replaced with a counter so "no poll scheduled" is
 * observable without a wall clock, and `fetch` counts instead of reaching the
 * network.
 */
async function withExtension(
  fx: FreshFixture,
  body: (h: Harness) => Promise<void>,
  opts: { hasUI?: boolean; statuses?: Array<{ key: string; text: string | undefined }> } = {},
): Promise<void> {
  const previousEnv = process.env[ENV_AGENT_DIR];
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;

  process.env[ENV_AGENT_DIR] = fx.agentDir;
  process.chdir(fx.projectDir);

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("no network expected");
  }) as unknown as typeof fetch;

  const intervals: number[] = [];
  globalThis.setInterval = ((_fn: () => void, ms?: number) => {
    intervals.push(ms ?? 0);
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;

  const notify: Notify[] = [];
  const statuses = opts.statuses ?? [];
  const hasUI = opts.hasUI ?? true;
  const makeCtx = (): Ctx => ({
    hasUI,
    ui: {
      notify: (text, level) => notify.push({ text, level: level ?? "" }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  });

  const handlers: Record<string, SessionStartHandler> = {};
  const api = {
    registerCommand: () => {},
    on: (event: string, handler: SessionStartHandler) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;

  try {
    extension(api);

    await body({
      notify,
      statuses,
      start: async (reason) => {
        await handlers.session_start?.({ reason }, makeCtx());
        await pump();
      },
      fetchCalls: () => fetchCalls,
      intervals: () => intervals.length,
    });
  } finally {
    await handlers.session_shutdown?.({ reason: "shutdown" }, makeCtx());
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
    if (previousEnv === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previousEnv;
    process.chdir(previousCwd);
  }
}

test("a fresh install makes no HTTP call, writes nothing, and schedules no poll", async () => {
  const fx = await freshFixture();
  const before = await readFile(join(fx.agentsDir, "planner.md"), "utf8");

  await withExtension(fx, async (h) => {
    await h.start("startup");
    assert.equal(h.fetchCalls(), 0, "an empty table must not fetch a quota");
    assert.equal(h.intervals(), 0, "an empty table must not schedule the poll");
  });

  assert.equal(
    await readFile(join(fx.agentsDir, "planner.md"), "utf8"),
    before,
    "a fresh install must write nothing",
  );
});

// The common fresh install has no config file yet — that is why it is being
// asked to make one. The path named must come from the fallback, not from a
// loaded file the install does not have.
test("a fresh install with no config file still names the file to create", async () => {
  const fx = await freshFixture();
  await unlink(fx.configPath);

  await withExtension(fx, async (h) => {
    await h.start("startup");
    assert.equal(h.fetchCalls(), 0, "no config is still nothing to fetch");
    assert.equal(h.notify.length, 1);
    const expected = join(fx.agentDir, CONFIG_FILE_NAME);
    assert.ok(
      h.notify[0].text.includes(expected),
      `the ask must name ${expected}:\n${h.notify[0].text}`,
    );
  });
});

for (const reason of ["startup", "new", "reload"]) {
  test(`an empty table notifies once, at warning level, on ${reason}`, async () => {
    const fx = await freshFixture();

    await withExtension(fx, async (h) => {
      await h.start(reason);

      assert.equal(h.notify.length, 1, `expected exactly one notify on ${reason}`);
      assert.equal(h.notify[0].level, "warning");

      const text = h.notify[0].text;
      assert.ok(text.includes(fx.configPath), `the notice must name ${fx.configPath}:\n${text}`);
      // The files found, including one the snippet cannot build a candidate for.
      assert.ok(text.includes("planner"), text);
      assert.ok(text.includes("reviewer"), text);
      // The snippet: each file's current model, with the rail registered for it.
      assert.ok(text.includes("claude-bridge/claude-opus-5-5"), text);
      assert.ok(text.includes("openai-codex/gpt-6-astra"), text);
      assert.match(text, /"rail"\s*:\s*"claude"/, text);
      assert.match(text, /"rail"\s*:\s*"codex"/, text);
      // A non-`*.md` file is not an agent and must not be listed.
      assert.ok(!text.includes("notes.txt"), text);
    });
  });
}

for (const reason of ["resume", "fork"]) {
  test(`an empty table stays silent on ${reason}`, async () => {
    const fx = await freshFixture();

    await withExtension(fx, async (h) => {
      await h.start(reason);
      assert.equal(h.notify.length, 0, `the ask must not fire on ${reason}`);
      // The footer describes the install, not the reason, so it still reports
      // the unconfigured state even when the ask is suppressed.
      assert.ok(
        h.statuses.some((s) => s.text !== undefined && s.text.length > 0),
        `the unconfigured footer must still be set on ${reason}: ${JSON.stringify(h.statuses)}`,
      );
    });
  });
}

// The message this install most needs is not "you have no config": the file is
// there, it names agents, and a stray comma threw the whole thing away. Saying
// "no agents are configured" would send its owner off to write what they
// already wrote, and the table being empty is the only symptom they would
// otherwise see — the parse error goes to a console line that scrolls past at
// session start.
test("an unparseable config file is reported instead of the unconfigured ask", async () => {
  const fx = await freshFixture();
  await writeFile(fx.configPath, '{ "agents": {\n  "planner": {,}\n}', "utf8");

  await withExtension(fx, async (h) => {
    await h.start("startup");

    assert.equal(h.fetchCalls(), 0, "an unusable file is not something to fetch quota for");
    assert.equal(h.notify.length, 1, "expected exactly one notify");
    assert.equal(h.notify[0].level, "warning");

    const text = h.notify[0].text;
    assert.ok(text.includes(fx.configPath), `the notice must name ${fx.configPath}:\n${text}`);
    assert.ok(text.includes("not valid JSON"), text);
    assert.ok(text.includes("line 2"), `the line to go to is the point:\n${text}`);
    assert.ok(!text.includes("no agents are configured"), `the ask is the wrong answer here:\n${text}`);
    assert.ok(!text.includes('"agents"'), `no paste-ready snippet belongs here:\n${text}`);
    // The table is empty either way, so the footer is still the unconfigured one:
    // the notice has said why, and the ask's status is the standing fact.
    assert.ok(
      h.statuses.some((s) => s.text !== undefined && s.text.includes("no agents configured")),
      `expected the unconfigured footer: ${JSON.stringify(h.statuses)}`,
    );
  });
});

// A skipped layer is not the whole config: the routes below it still manage
// agents, so the only symptom is a route that is quietly not the one the reader
// wrote. That is the state ADR 0009 raised for a model this pi cannot spawn, and
// it gets the same notification rather than a console line that scrolls past.
test("a skipped project layer is reported even though the global one still manages agents", async () => {
  const fx = await freshFixture({
    planner: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } },
  });
  await writeFile(join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), "[1,2]", "utf8");

  await withExtension(fx, async (h) => {
    await h.start("startup");

    assert.equal(h.notify.length, 1, `expected one notify: ${JSON.stringify(h.notify)}`);
    assert.equal(h.notify[0].level, "warning");

    const text = h.notify[0].text;
    assert.ok(text.includes(join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME)), text);
    assert.ok(text.includes("config must be a JSON object"), text);
    assert.ok(!text.includes("no agents are configured"), `this install is configured:\n${text}`);
  });
});

// The notification asks for setup, so it obeys the same reasons the ask does: a
// session resuming work does not want to be interrupted about a file it read
// yesterday, and there is a report for asking.
for (const reason of ["resume", "fork"]) {
  test(`a skipped config file stays silent on ${reason}`, async () => {
    const fx = await freshFixture();
    await writeFile(fx.configPath, "{ broken", "utf8");

    await withExtension(fx, async (h) => {
      await h.start(reason);
      assert.equal(h.notify.length, 0, `no notify on ${reason}: ${JSON.stringify(h.notify)}`);
    });
  });
}

// The notification is a rendering, so it obeys `hasUI` exactly as the ask does.
// A parse error is the case where it would be easiest to forget: the fault is
// reported from a helper of its own, not from the branch that guards the ask.
test("no notify for a skipped config file when ctx.hasUI is false", async () => {
  const fx = await freshFixture();
  await writeFile(fx.configPath, "{ broken", "utf8");

  await withExtension(
    fx,
    async (h) => {
      await h.start("startup");
      assert.equal(h.notify.length, 0, "no notify without a UI");
      assert.equal(h.statuses.length, 0, "no status without a UI");
    },
    { hasUI: false },
  );
});

test("the footer status is set while the table is empty", async () => {
  const fx = await freshFixture();

  await withExtension(fx, async (h) => {
    await h.start("startup");
    assert.ok(
      h.statuses.some((s) => s.text !== undefined && s.text.length > 0),
      `an unconfigured install must set a footer status: ${JSON.stringify(h.statuses)}`,
    );
  });
});

test("once the table is non-empty the footer is cleared, not left showing unconfigured", async () => {
  const fx = await freshFixture({
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
    },
  });

  await withExtension(
    fx,
    async (h) => {
      await h.start("startup");
      // reviewer.md exists but no route names it: a configured install does not
      // narrate the files it deliberately does not manage.
      assert.equal(h.notify.length, 0, "a configured install must not emit the ask");
      // `some`, not `every`: an install that issued no status call at all must
      // not pass on a vacuous quantification — the clear has to actually happen.
      assert.ok(
        h.statuses.some((s) => s.text === undefined),
        `a configured session_start must actually clear the footer: ${JSON.stringify(h.statuses)}`,
      );
    },
    { hasUI: true },
  );
});

// The clear must target the status the ask set, so it is observed across two
// installs writing to one recorded list rather than assumed from an empty one.
test("a configured install clears the footer an unconfigured one set", async () => {
  const shared: Array<{ key: string; text: string | undefined }> = [];

  const empty = await freshFixture();
  await withExtension(empty, async (h) => {
    await h.start("startup");
  }, { statuses: shared });
  const set = shared.find((s) => s.text !== undefined && s.text.length > 0);
  assert.ok(set, `the empty install must set the footer: ${JSON.stringify(shared)}`);

  const configured = await freshFixture({
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
    },
  });
  const before = shared.length;
  await withExtension(configured, async (h) => {
    await h.start("startup");
    // Asserted inside the body, before shutdown: everything appended here is the
    // configured session_start's own status calls.
    const clear = shared.slice(before).find((s) => s.text === undefined);
    assert.ok(
      clear,
      `the configured install must clear the footer: ${JSON.stringify(shared.slice(before))}`,
    );
    assert.equal(clear.key, set.key, "the clear must target the status the ask set");
  }, { statuses: shared });
});

test("nothing is rendered at all when ctx.hasUI is false", async () => {
  const fx = await freshFixture();

  await withExtension(
    fx,
    async (h) => {
      await h.start("startup");
      assert.equal(h.notify.length, 0, "no notify without a UI");
      assert.equal(h.statuses.length, 0, "no status without a UI");
    },
    { hasUI: false },
  );
});
