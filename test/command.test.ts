import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.ts";

// The package does not re-export ENV_AGENT_DIR from its root, so use the
// documented literal directly.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const CONFIG_FILE_NAME = "quota-dispatch.json";

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

interface Fixture {
  agentDir: string;
  projectDir: string;
  plannerFile: string;
}

/**
 * The routes the command fixture names. `planner` is claude-primary, so a tight
 * claude session moves it to its codex alternate. `reviewer` is configured but
 * deliberately has no file, so it must be reported as skipped rather than crash.
 */
const CONFIGURED_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  },
  reviewer: {
    primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
    alternates: [{ model: "claude-bridge/claude-opus-5-5", rail: "claude" }],
  },
};

/**
 * A self-contained project: a relocated agent dir (so nothing reads the
 * developer's real `~/.pi/agent`) and a project dir to `chdir` into. The global
 * config pins `claudeCredsPath` at a fixture file and lifts `pollMs` to the
 * timer maximum so the background poll never fires during the test. The
 * `agents` table defaults to the names the command tests route; passing `{}`
 * makes an unconfigured install.
 */
async function fixture(
  pollMs = 2_147_483_647,
  agents: Record<string, unknown> = CONFIGURED_AGENTS,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-cmd-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const agentsDir = join(agentDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });

  const claudeCredsPath = join(root, "claude-credentials.json");
  await writeFile(
    claudeCredsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 } }),
    "utf8",
  );

  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct-test" } }),
    "utf8",
  );

  // The shipped config names no agents, so the fixture has to name them itself.
  await writeFile(
    join(agentDir, CONFIG_FILE_NAME),
    JSON.stringify({
      claudeCredsPath,
      pollMs,
      agents,
    }),
    "utf8",
  );
  await writeFile(join(projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), JSON.stringify({ margin: 10 }), "utf8");

  const plannerFile = join(agentsDir, "planner.md");
  await writeFile(plannerFile, TEMPLATE("planner", "claude-bridge/claude-opus-5-5"), "utf8");

  return { agentDir, projectDir, plannerFile };
}

interface RailReadings {
  claudeSession: number;
  claudeWeekly: number;
  codexSession: number;
  codexWeekly: number;
}

/**
 * The only network boundary. The default readings make a real switch: claude
 * session at 90% is tight, codex session at 10% is more than `margin`
 * healthier and not tight on its week, so the claude-primary planner moves to
 * its codex alternate. Two requests only: deepseek is metered and never
 * fetched.
 */
function stubFetch(overrides: Partial<RailReadings> = {}): typeof fetch {
  const r: RailReadings = {
    claudeSession: 90,
    claudeWeekly: 0,
    codexSession: 10,
    codexWeekly: 0,
    ...overrides,
  };
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("anthropic.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: r.claudeSession },
          seven_day: { utilization: r.claudeWeekly },
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
            primary_window: { used_percent: r.codexSession, limit_window_seconds: 18000, reset_after_seconds: 3600 },
            secondary_window: { used_percent: r.codexWeekly, limit_window_seconds: 604800, reset_after_seconds: 400000 },
          },
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

interface Ui {
  notify: (text: string, level?: string) => void;
  setStatus: (key: string, text?: string) => void;
}

/** The one piece of the real `ExtensionContext` this extension reads. */
interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
}

/**
 * The slice of pi's extension context the handlers see. `modelRegistry` is
 * real pi's; a test opts into it so every existing test keeps exercising a
 * context that has none (the feature-detected, unchanged path).
 */
interface Ctx {
  hasUI: boolean;
  ui: Ui;
  modelRegistry?: ModelRegistryLike;
}

type CommandHandler = (args: string, ctx: Ctx) => Promise<void>;
type EventHandler = (event: { reason: string }, ctx: Ctx) => Promise<void>;

/** What a test can drive once the extension is installed. */
interface Harness {
  /** Run the `quota-dispatch` command and return the text it notified. */
  run: (args: string) => Promise<string>;
  /** As `run`, but every notification in order — a warning may be its own. */
  runAll: (args: string) => Promise<string[]>;
  /** Fire the `session_start` handler the extension registered. */
  sessionStart: (reason?: string) => Promise<void>;
  /** Everything the extension pushed to the UI, in order. */
  notifications: Array<{ text: string; level: string }>;
  statuses: Array<{ key: string; text: string | undefined }>;
}

/**
 * Install the extension under a relocated agent dir and cwd, stub the network,
 * and hand the caller the handlers. Everything global is restored in a
 * `finally`, including a final `session_shutdown` to clear the poll timer.
 */
async function withExtension(
  fx: Fixture,
  body: (h: Harness) => Promise<void>,
  fetchFactory: () => typeof fetch = stubFetch,
  opts: { hasUI?: boolean; modelRegistry?: ModelRegistryLike } = {},
): Promise<void> {
  const previousEnv = process.env[ENV_AGENT_DIR];
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;

  process.env[ENV_AGENT_DIR] = fx.agentDir;
  process.chdir(fx.projectDir);
  globalThis.fetch = fetchFactory();

  const hasUI = opts.hasUI ?? true;
  const notifications: Array<{ text: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const eventHandlers: Record<string, EventHandler> = {};
  let command: CommandHandler | undefined;

  const makeCtx = (): Ctx => ({
    hasUI,
    ui: {
      notify: (text: string, level?: string) => notifications.push({ text, level: level ?? "" }),
      setStatus: (key: string, text?: string) => statuses.push({ key, text }),
    },
    ...(opts.modelRegistry ? { modelRegistry: opts.modelRegistry } : {}),
  });

  const api = {
    registerCommand: (_name: string, spec: { handler: CommandHandler }) => {
      command = spec.handler;
    },
    on: (event: string, handler: EventHandler) => {
      eventHandlers[event] = handler;
    },
  } as unknown as ExtensionAPI;

  try {
    extension(api);
    const handler = command;
    assert.ok(handler, "the extension must register the quota-dispatch command");

    const harness: Harness = {
      notifications,
      statuses,
      run: async (args: string) => {
        notifications.length = 0;
        await handler(args, makeCtx());
        assert.equal(notifications.length, 1, "the command should notify exactly once");
        return notifications[0].text;
      },
      runAll: async (args: string) => {
        notifications.length = 0;
        await handler(args, makeCtx());
        return notifications.map((n) => n.text);
      },
      sessionStart: async (reason = "startup") => {
        await eventHandlers.session_start?.({ reason }, makeCtx());
      },
    };

    await body(harness);
  } finally {
    await eventHandlers.session_shutdown?.({ reason: "shutdown" }, makeCtx());
    globalThis.fetch = previousFetch;
    if (previousEnv === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previousEnv;
    process.chdir(previousCwd);
  }
}

// ---------------------------------------------------------------- commands

test("the plain command reports where each value came from and writes nothing", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("");
    const projectFile = join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    assert.ok(text.includes("config: built-in < global"), text);
    assert.ok(text.includes(projectFile), text);
    assert.ok(!text.includes("[applied]"), text);
  });

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "the plain report must not write");
});

test("the refresh command reports provenance and still writes nothing", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("refresh");
    const projectFile = join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    assert.ok(text.includes("config: built-in < global"), text);
    assert.ok(text.includes(projectFile), text);
    assert.ok(!text.includes("[applied]"), text);
  });

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "refresh must not write");
});

test("the apply command reports provenance, writes the decision, and skips missing files", async () => {
  const fx = await fixture();

  await withExtension(fx, async ({ run }) => {
    const text = await run("apply");
    const projectFile = join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    // Provenance reaches the user through the apply branch too: deleting the
    // `describeConfig` push from that branch must fail this test.
    assert.ok(text.includes("config: built-in < global"), text);
    assert.ok(text.includes(projectFile), text);

    assert.ok(text.includes("[applied]"), text);
    assert.ok(text.includes("planner -> openai-codex/gpt-6-sol"), text);
    assert.ok(text.includes("[skipped (no file)]"), text);
  });

  const after = await readFile(fx.plannerFile, "utf8");
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
  assert.match(after, /^thinking: high$/m);
  assert.match(after, /^Body\.$/m);
});

// ---------------------------------------------------------------- session_start

/**
 * `session_start` is awaited before the session can spawn anything, so it is
 * what makes the first spawn of a session see current frontmatter. A handler
 * that never evaluates would pass every command-level test above.
 */
test("session_start writes the decided model so the first spawn sees it", async () => {
  const fx = await fixture();

  await withExtension(fx, async ({ sessionStart }) => {
    assert.match(
      await readFile(fx.plannerFile, "utf8"),
      /^model: "claude-bridge\/claude-opus-5-5"$/m,
      "precondition: the fixture starts on the claude primary",
    );
    await sessionStart();
  });

  assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
});

test("session_start leaves a file alone when no switch is due", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(
    fx,
    async ({ sessionStart }) => {
      await sessionStart();
    },
    () => stubFetch({ claudeSession: 10, codexSession: 10 }),
  );

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "no switch is due, so nothing may change");
});

/**
 * The reason gates the fresh-install *ask*, not the dispatcher. A configured
 * install evaluates and writes on every reason, including the two the ask stays
 * silent on.
 */
for (const reason of ["resume", "fork"]) {
  test(`a configured session_start still writes on ${reason}`, async () => {
    const fx = await fixture();
    // Each reason gets a fresh file on the primary, so an inert handler cannot
    // pass by observing the model a previous reason already wrote.
    assert.match(
      await readFile(fx.plannerFile, "utf8"),
      /claude-opus-5-5/,
      "the fixture must start on the primary",
    );

    await withExtension(fx, async ({ sessionStart }) => {
      await sessionStart(reason);
      assert.match(
        await readFile(fx.plannerFile, "utf8"),
        /^model: "openai-codex\/gpt-6-sol"$/m,
        `session_start(${reason}) must still evaluate and write`,
      );
    });
  });
}

// ---------------------------------------------------------------- cache and refresh

/**
 * The plain form reads a cache warmed within `ttlMs`; `refresh` is the one that
 * forces a re-fetch. `createDispatcher` caches each rail's reading and
 * `railState` returns the cached state unless `force` is set, so a cold report
 * makes two fetches (claude + codex; deepseek is metered) and a second plain
 * report makes none, while `refresh` makes two more. The cold-only test above
 * would pass an implementation that ignored the flag, so the readings are
 * changed between calls here.
 */
test("refresh forces a re-fetch while the plain form reuses the cache", async () => {
  const fx = await fixture();
  let claudeSession = 90;
  let codexSession = 10;
  let fetches = 0;

  const countingFetch = (async (url: string | URL) => {
    fetches++;
    const u = String(url);
    if (u.includes("anthropic.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: claudeSession }, seven_day: { utilization: 0 } }),
      };
    }
    if (u.includes("chatgpt.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            limit_reached: false,
            primary_window: { used_percent: codexSession, limit_window_seconds: 18000, reset_after_seconds: 3600 },
            secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 400000 },
          },
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ run }) => {
      const first = await run("");
      assert.equal(fetches, 2, "a cold plain report fetches both live rails");
      assert.ok(first.includes("claude: 5h 90%"), first);

      // Change what the endpoint would report. Within `ttlMs` the plain form
      // must still show the reading it already has.
      claudeSession = 40;
      codexSession = 5;
      const second = await run("");
      assert.equal(fetches, 2, "the plain form reuses the cached reading within ttlMs");
      assert.ok(second.includes("claude: 5h 90%"), second);
      assert.ok(!second.includes("claude: 5h 40%"), second);

      const refreshed = await run("refresh");
      assert.equal(fetches, 4, "refresh forces a re-fetch of both live rails");
      assert.ok(refreshed.includes("claude: 5h 40%"), refreshed);
    },
    () => countingFetch,
  );
});

// ---------------------------------------------------------------- poll timer

const PRIMARY = TEMPLATE("planner", "claude-bridge/claude-opus-5-5");

/**
 * Pump the real event loop until `planner.md` stops matching `original`, or a
 * bounded number of turns elapse. `tick` only *starts* the interval's
 * fire-and-forget `evaluate()`, which then does async file I/O; this waits for
 * that to land without a wall-clock sleep. `setInterval` is mocked but
 * `setImmediate` is real, and the bound means a broken interval body fails the
 * assertion instead of hanging the test.
 */
async function settle(read: () => Promise<string>, original: string, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if ((await read()) !== original) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The interval is what keeps frontmatter current between session start and the
 * next spawn: workflow `agent()` calls and `@agent` mentions spawn through the
 * manager and bypass the `Agent` tool. `tick` makes it deterministic — only
 * `setInterval` is mocked, so the real `setImmediate` can await the async work
 * the tick kicked off.
 */
test("the poll timer re-evaluates and writes the switch it decides", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fx = await fixture(50);

  await withExtension(fx, async ({ run }) => {
    // Boot the extension so the interval is scheduled; the plain report itself
    // is read-only.
    await run("");
    assert.equal(await readFile(fx.plannerFile, "utf8"), PRIMARY, "the boot report must not write");

    t.mock.timers.tick(50);
    await settle(() => readFile(fx.plannerFile, "utf8"), PRIMARY);

    assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
  });
});

test("the poll timer leaves files alone when no switch is due", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fx = await fixture(50);

  await withExtension(
    fx,
    async ({ run }) => {
      await run("");
      t.mock.timers.tick(50);
      // Give an interval that wrongly wrote every chance to show up before
      // asserting that nothing changed.
      await settle(() => readFile(fx.plannerFile, "utf8"), PRIMARY);
    },
    () => stubFetch({ claudeSession: 10, codexSession: 10 }),
  );

  assert.equal(await readFile(fx.plannerFile, "utf8"), PRIMARY, "no switch is due, so nothing may change");
});

// ---------------------------------------------------------------- unmanaged files

/**
 * A configured install still has agent files it does not route. `scribe.md` is
 * a real file no route names, so `/quota-dispatch` has to say so — otherwise a
 * user cannot tell the file exists, or that it is deliberately untouched.
 */
test("the read-only forms report the files no route names", async () => {
  const fx = await fixture();
  await writeFile(join(fx.agentDir, "agents", "scribe.md"), TEMPLATE("scribe", "deepseek/deepseek-flash"), "utf8");

  await withExtension(fx, async ({ run }) => {
    for (const form of ["", "refresh"]) {
      const text = await run(form);
      // Scope the assertions to the unmanaged listing itself — its header line is
      // followed by one `  <name>.md — model: …` line per file. The config dump
      // further down also names `planner`, so slicing to the end of the text
      // would report a routed file as unmanaged.
      const header = "unmanaged agent files";
      const at = text.indexOf(header);
      assert.notEqual(at, -1, `${form || "plain"} must have an unmanaged section:\n${text}`);
      const listed: string[] = [];
      for (const line of text.slice(at).split("\n").slice(1)) {
        if (!line.startsWith("  ") || !line.includes(".md")) break;
        listed.push(line);
      }
      assert.ok(listed.some((l) => l.includes("scribe")), `${form || "plain"} must name the unmanaged file:\n${text}`);
      assert.ok(
        !listed.some((l) => l.includes("planner")),
        `${form || "plain"} must not list a routed file as unmanaged:\n${text}`,
      );
      assert.ok(text.includes("claude: 5h 90%"), text);
    }
  });
});

/**
 * `apply` is the one form that writes, and it writes only decisions. Narrating
 * files it does not manage there would blur "what did it touch?" into a list of
 * files it did not.
 */
test("the apply form does not narrate unmanaged files", async () => {
  const fx = await fixture();
  await writeFile(join(fx.agentDir, "agents", "scribe.md"), TEMPLATE("scribe", "deepseek/deepseek-flash"), "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("apply");
    assert.ok(text.includes("[applied]"), text);
    assert.ok(!text.includes("scribe"), `apply must not list unmanaged files:\n${text}`);
  });
});

/**
 * Explicit invocation is a diagnostic, not the install-time ask: even with an
 * empty table `/quota-dispatch` reads the rails and prints them. It stays
 * read-only, so the agents it found are not touched.
 */
test("an empty table still reports one line per rail and writes nothing", async () => {
  const fx = await fixture(2_147_483_647, {});
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("");
    assert.ok(text.includes("claude: 5h 90%"), text);
    assert.ok(text.includes("codex: 5h 10%"), text);
    assert.ok(text.includes("deepseek:"), text);
    assert.ok(!text.includes("[applied]"), text);
  });

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "the diagnostic must be read-only");
});

// ---------------------------------------------------------------- model registry (issue #14)

/**
 * The running pi's model registry. `find` is the only method this extension
 * reads: it answers the model, or undefined when this pi cannot spawn it.
 */
function registry(known: Record<string, string[]>): ModelRegistryLike {
  return {
    find: (provider, modelId) => (known[provider]?.includes(modelId) ? { provider, id: modelId } : undefined),
  };
}

/**
 * A route whose primary this pi does not know. The fixture's `planner.md` stays
 * on the claude primary, so the plain report has something concrete to hold
 * over: claude session 90 would otherwise switch to the codex alternate.
 */
const UNKNOWN_PRIMARY_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-sol-9", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  },
};

test("an unknown primary is held, and named in the command output", async () => {
  const fx = await fixture(2_147_483_647, UNKNOWN_PRIMARY_AGENTS);

  await withExtension(
    fx,
    async ({ runAll }) => {
      const text = (await runAll("")).join("\n");
      assert.ok(text.includes("planner -> (left as is)"), text);
      assert.ok(text.includes("[held]"), text);
      assert.ok(text.includes("this pi does not know model claude-bridge/claude-sol-9"), text);
    },
    stubFetch,
    { modelRegistry: registry({ "openai-codex": ["gpt-6-sol"] }) },
  );
});

// The other half of feature detection, end to end: with no registry on the
// context the same install is decided exactly as it was before this ticket.
test("without a model registry the same install still reports the switch", async () => {
  const fx = await fixture(2_147_483_647, UNKNOWN_PRIMARY_AGENTS);

  await withExtension(fx, async ({ runAll }) => {
    const text = (await runAll("")).join("\n");
    assert.ok(text.includes("planner -> openai-codex/gpt-6-sol"), text);
    assert.ok(!text.includes("this pi does not know model"), text);
  });
});

/**
 * A route whose *alternate* this pi does not know. The primary is fine, so the
 * check must thread the cleaned config: dropping the unknown alternate and
 * letting the next one win. If the extension used only the `held` record and
 * ignored `result.config`, `session_start` would select and *write* the model
 * this pi cannot spawn — the exact regression issue #14 is about.
 */
const SKIPPED_ALTERNATE_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [
      { model: "openai-codex/gpt-sol-6", rail: "codex" }, // unknown to this pi
      { model: "openai-codex/gpt-6-sol", rail: "codex" }, // known
    ],
  },
};

test("session_start never writes an unknown alternate: the next alternate wins", async () => {
  const fx = await fixture(2_147_483_647, SKIPPED_ALTERNATE_AGENTS);
  assert.match(
    await readFile(fx.plannerFile, "utf8"),
    /^model: "claude-bridge\/claude-opus-5-5"$/m,
    "precondition: the fixture starts on the known claude primary",
  );

  await withExtension(
    fx,
    async ({ sessionStart }) => {
      await sessionStart();
    },
    stubFetch,
    {
      modelRegistry: registry({
        "claude-bridge": ["claude-opus-5-5"],
        "openai-codex": ["gpt-6-sol"],
      }),
    },
  );

  const after = await readFile(fx.plannerFile, "utf8");
  assert.ok(!after.includes("gpt-sol-6"), `the unknown model must never be written:\n${after}`);
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m, after);
});

test("session_start with a registry holds an unknown primary, leaving the file alone", async () => {
  const fx = await fixture(2_147_483_647, UNKNOWN_PRIMARY_AGENTS);
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(
    fx,
    async ({ sessionStart }) => {
      await sessionStart();
      assert.equal(await readFile(fx.plannerFile, "utf8"), before, "a held primary must not be written");
    },
    stubFetch,
    { modelRegistry: registry({ "openai-codex": ["gpt-6-sol"] }) },
  );

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "a held primary must not be written");
});

/**
 * Every alternate of `planner` unknown to this pi, which leaves that route with
 * the same empty list a route pinned with `"alternates": []` arrives in. `scribe`
 * is pinned exactly that way, so one pass produces both cases and the report has
 * to tell them apart without letting either borrow the other's reasons.
 */
const ALL_ALTERNATES_UNKNOWN_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [
      { model: "openai-codex/gpt-sol-6", rail: "codex" },
      { model: "openai-codex/gpt-astra-6", rail: "codex" },
    ],
  },
  scribe: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [],
  },
};

// The wiring this record needs end to end: `checkModels` returns the drops, and
// only `bootOnce` can hand them to the dispatcher. An extension that threaded
// `held` alone would leave the config identical to a pinned route and print "no
// alternate configured" to a user who wrote two — the exact confusion issue #21
// is about. Asserted through the command, because the dropped record has no other
// path to the report.
test("the decision line names the alternates boot dropped instead of claiming none were configured", async () => {
  const fx = await fixture(2_147_483_647, ALL_ALTERNATES_UNKNOWN_AGENTS);

  await withExtension(
    fx,
    async ({ runAll }) => {
      const text = (await runAll("")).join("\n");
      const lines = text.split("\n");
      const decision = lines.find((line) => line.startsWith("planner -> "));
      assert.ok(decision, text);
      assert.ok(!decision.includes("no alternate configured"), decision);
      // Nothing else could be the answer, so the agent is assigned its primary
      // rather than held — the pinning itself is unchanged by the explanation.
      assert.ok(decision.includes("planner -> claude-bridge/claude-opus-5-5"), decision);
      assert.ok(decision.includes("[unchanged]"), decision);
      assert.ok(decision.includes("every alternate was dropped"), decision);

      // The notes, whole and in order: one per dropped model, in the wording the
      // boot warning used, and none belonging to the other agent — a record
      // applied to the wrong agent adds a line here, and a borrowed or reworded
      // one is not equal to what is expected.
      assert.deepEqual(
        lines.filter((line) => line.startsWith("  agents.") && line.includes("this pi does not know model")),
        [
          "  agents.planner.alternates[0].model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may",
          "  agents.planner.alternates[1].model: this pi does not know model openai-codex/gpt-astra-6 — a newer pi may",
        ],
        text,
      );

      // `scribe` wrote no alternates at all, and says so.
      const scribe = lines.find((line) => line.startsWith("scribe -> "));
      assert.ok(scribe, text);
      assert.ok(scribe.includes("(no alternate configured)"), scribe);

      // The boot warning is still replayed in the provenance block, which is the
      // duplication ADR 0008 argues for: the decision explains the agent, the
      // block stays a faithful log of every warning. Filtering the replay because
      // a decision already said it is the tempting tidy-up this pins against.
      assert.ok(
        lines.includes(
          "  warning: agents.planner.alternates[0].model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may",
        ),
        text,
      );
    },
    stubFetch,
    { modelRegistry: registry({ "claude-bridge": ["claude-opus-5-5"] }) },
  );
});

// ---------------------------------------------------------------- unknown models at startup (issue #22)

/**
 * One route with two ids this pi does not know — the primary and the second
 * alternate — so the startup warning has to name each of them at its own key
 * rather than stopping at the first. The registry knows the model `planner.md`
 * already carries and the first alternate, so the plan for the agent is not
 * wholly broken: the check has work to do either way.
 */
const TWO_UNKNOWN_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-sol-9", rail: "claude" }, // transposed: unknown
    alternates: [
      { model: "claude-bridge/claude-opus-5-5", rail: "claude" }, // known
      { model: "openai-codex/gpt-sol-6", rail: "codex" }, // transposed: unknown
    ],
  },
};

/** The registry for `TWO_UNKNOWN_AGENTS`: everything but the two transpositions. */
const TWO_UNKNOWN_REGISTRY = registry({
  "claude-bridge": ["claude-opus-5-5"],
  "openai-codex": ["gpt-6-sol"],
});

/** The two sentences the boot warning for `TWO_UNKNOWN_AGENTS` is made of. */
const TWO_UNKNOWN_LINES = [
  `agents.planner.primary.model: this pi does not know model claude-bridge/claude-sol-9 — a newer pi may`,
  `agents.planner.alternates[1].model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may`,
];

for (const reason of ["startup", "new", "reload"]) {
  test(`a config naming models this pi does not know notifies once, at warning level, on ${reason}`, async () => {
    const fx = await fixture(2_147_483_647, TWO_UNKNOWN_AGENTS);

    await withExtension(
      fx,
      async ({ notifications, statuses, sessionStart }) => {
        await sessionStart(reason);

        assert.equal(notifications.length, 1, `expected exactly one notify on ${reason}`);
        assert.equal(notifications[0].level, "warning");

        const text = notifications[0].text;
        const lines = text.split("\n");
        assert.ok(
          text.includes(join(fx.agentDir, CONFIG_FILE_NAME)),
          `the notice must name the file to edit:\n${text}`,
        );
        // Each miss once, whole, in the wording the log and the report use.
        assert.deepEqual(
          lines.filter((line) => line.includes("this pi does not know model")),
          TWO_UNKNOWN_LINES,
          text,
        );
        // The footer carries the state on every reason, and its words are the
        // notify's own headline: the interruption and the standing fact are one
        // sentence, so a surface that disagrees cannot pass by accident.
        assert.deepEqual(
          statuses,
          [{ key: "quota-dispatch", text: "quota-dispatcher: a configured model is unknown to this pi." }],
          `the footer must hold the unknown model on ${reason}: ${JSON.stringify(statuses)}`,
        );
        assert.equal(lines[0], statuses[0].text, "the warning's headline and the footer are the same words");
      },
      stubFetch,
      { modelRegistry: TWO_UNKNOWN_REGISTRY },
    );
  });
}

for (const reason of ["resume", "fork"]) {
  test(`an unknown model is not notified on ${reason}, but the footer holds it`, async () => {
    const fx = await fixture(2_147_483_647, TWO_UNKNOWN_AGENTS);

    await withExtension(
      fx,
      async ({ notifications, statuses, sessionStart }) => {
        await sessionStart(reason);

        assert.equal(notifications.length, 0, `the warning must not interrupt ${reason}`);
        // The footer describes the install, not the reason, so it still reports
        // the state — which on `resume` is the only place the state is said.
        assert.deepEqual(
          statuses,
          [{ key: "quota-dispatch", text: "quota-dispatcher: a configured model is unknown to this pi." }],
          `the footer must carry the unknown model on ${reason}: ${JSON.stringify(statuses)}`,
        );
      },
      stubFetch,
      { modelRegistry: TWO_UNKNOWN_REGISTRY },
    );
  });
}

// Every model in this table is one the registry answers for, so the check finds
// nothing — which is the same shape as a check that never ran, and both have to
// leave the footer the configured install has always had: cleared.
test("a clean config notifies nothing and clears the footer", async () => {
  const fx = await fixture(2_147_483_647, {
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
    },
  });

  await withExtension(
    fx,
    async ({ notifications, statuses, sessionStart }) => {
      await sessionStart("startup");

      assert.equal(notifications.length, 0, "a usable config must not be interrupted");
      assert.deepEqual(statuses, [{ key: "quota-dispatch", text: undefined }], JSON.stringify(statuses));
    },
    stubFetch,
    { modelRegistry: TWO_UNKNOWN_REGISTRY },
  );
});

// A pi with no registry cannot answer, so the check is skipped and there is no
// state to report. This is the path every existing install keeps until pi grows
// the field, and it must stay silent rather than guess.
test("a registryless context notifies nothing, even for ids nothing could resolve", async () => {
  const fx = await fixture(2_147_483_647, TWO_UNKNOWN_AGENTS);

  await withExtension(fx, async ({ notifications, statuses, sessionStart }) => {
    await sessionStart("startup");

    assert.equal(notifications.length, 0, "a check that did not run reports nothing");
    assert.deepEqual(statuses, [{ key: "quota-dispatch", text: undefined }], JSON.stringify(statuses));
  });
});

test("an unknown model renders nothing at all when ctx.hasUI is false", async () => {
  const fx = await fixture(2_147_483_647, TWO_UNKNOWN_AGENTS);

  await withExtension(
    fx,
    async ({ notifications, statuses, sessionStart }) => {
      await sessionStart("startup");

      assert.equal(notifications.length, 0, "no notify without a UI");
      assert.equal(statuses.length, 0, "no status without a UI");
    },
    stubFetch,
    { hasUI: false, modelRegistry: TWO_UNKNOWN_REGISTRY },
  );
});

// The file to edit is the layer the id was written in. A notice that always
// named the global config would send a user with a project-layer typo to a file
// that does not contain it.
test("the notice names the project layer when that is where the unknown id is written", async () => {
  const fx = await fixture(2_147_483_647, {
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternates: [],
    },
  });
  const projectConfig = join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  // The fixture's project file carries a scalar only; this layer names the route
  // that replaces the global one whole, in the model this pi cannot spawn.
  await writeFile(
    projectConfig,
    JSON.stringify({
      margin: 10,
      agents: { planner: { primary: { model: "claude-bridge/claude-sol-9", rail: "claude" } } },
    }),
    "utf8",
  );

  await withExtension(
    fx,
    async ({ notifications, sessionStart }) => {
      await sessionStart("startup");

      assert.equal(notifications.length, 1, "the project-layer miss must be surfaced");
      const text = notifications[0].text;
      assert.ok(text.includes(projectConfig), `the notice must name the project file:\n${text}`);
      assert.ok(
        !text.includes(join(fx.agentDir, CONFIG_FILE_NAME)),
        `the global file does not hold this id and must not be named:\n${text}`,
      );
    },
    stubFetch,
    { modelRegistry: registry({ "claude-bridge": ["claude-opus-5-5"] }) },
  );
});

// Two layers can hold a miss at once, and each names its own file. A notice
// that collapsed them to one path would send the reader to the wrong file for
// one of the ids, and one that deduped by model id would hide an occurrence.
test("a miss in each layer names both config files, each occurrence once", async () => {
  const fx = await fixture(2_147_483_647, {
    planner: {
      primary: { model: "claude-bridge/claude-sol-9", rail: "claude" }, // global miss
      alternates: [],
    },
  });
  const globalConfig = join(fx.agentDir, CONFIG_FILE_NAME);
  const projectConfig = join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  // A different agent, so the project route adds to the table rather than
  // replacing the global one: both misses survive into the effective config.
  await writeFile(
    projectConfig,
    JSON.stringify({
      margin: 10,
      agents: {
        reviewer: {
          primary: { model: "openai-codex/gpt-sol-6", rail: "codex" }, // project miss
          alternates: [],
        },
      },
    }),
    "utf8",
  );

  await withExtension(
    fx,
    async ({ notifications, sessionStart }) => {
      await sessionStart("startup");

      assert.equal(notifications.length, 1, "one notice for the whole install, however many layers are wrong");
      const text = notifications[0].text;
      assert.ok(text.includes(globalConfig), `the notice must name the global file:\n${text}`);
      assert.ok(text.includes(projectConfig), `the notice must name the project file:\n${text}`);
      assert.deepEqual(
        text.split("\n").filter((line) => line.includes("this pi does not know model")),
        [
          `agents.planner.primary.model: this pi does not know model claude-bridge/claude-sol-9 — a newer pi may`,
          `agents.reviewer.primary.model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may`,
        ],
        text,
      );
    },
    stubFetch,
    { modelRegistry: registry({ "claude-bridge": ["claude-opus-5-5"], "openai-codex": ["gpt-6-sol"] }) },
  );
});
