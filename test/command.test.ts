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
 * A self-contained project: a relocated agent dir (so nothing reads the
 * developer's real `~/.pi/agent`) and a project dir to `chdir` into. The global
 * config pins `claudeCredsPath` at a fixture file and lifts `pollMs` to the
 * timer maximum so the background poll never fires during the test.
 */
async function fixture(pollMs = 2_147_483_647): Promise<Fixture> {
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

  await writeFile(
    join(agentDir, CONFIG_FILE_NAME),
    JSON.stringify({ claudeCredsPath, pollMs }),
    "utf8",
  );
  await writeFile(join(projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), JSON.stringify({ margin: 10 }), "utf8");

  // planner is claude-primary, so a tight claude session moves it to its codex
  // alternate. reviewer and implementer deliberately have no file, so one of
  // them must be reported as skipped rather than crash.
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

type CommandHandler = (
  args: string,
  ctx: { ui: { notify: (text: string) => void } },
) => Promise<void>;

/** What a test can drive once the extension is installed. */
interface Harness {
  /** Run the `quota-dispatch` command and return the text it notified. */
  run: (args: string) => Promise<string>;
  /** Fire the `session_start` handler the extension registered. */
  sessionStart: () => Promise<void>;
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
): Promise<void> {
  const previousEnv = process.env[ENV_AGENT_DIR];
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;

  process.env[ENV_AGENT_DIR] = fx.agentDir;
  process.chdir(fx.projectDir);
  globalThis.fetch = fetchFactory();

  const notifications: string[] = [];
  const eventHandlers: Record<string, () => Promise<void>> = {};
  let command: CommandHandler | undefined;

  const api = {
    registerCommand: (_name: string, spec: { handler: CommandHandler }) => {
      command = spec.handler;
    },
    on: (event: string, handler: () => Promise<void>) => {
      eventHandlers[event] = handler;
    },
  } as unknown as ExtensionAPI;

  try {
    extension(api);
    const handler = command;
    assert.ok(handler, "the extension must register the quota-dispatch command");

    const harness: Harness = {
      run: async (args: string) => {
        notifications.length = 0;
        await handler(args, { ui: { notify: (text: string) => notifications.push(text) } });
        assert.equal(notifications.length, 1, "the command should notify exactly once");
        return notifications[0];
      },
      sessionStart: async () => {
        await eventHandlers.session_start?.();
      },
    };

    await body(harness);
  } finally {
    await eventHandlers.session_shutdown?.();
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
