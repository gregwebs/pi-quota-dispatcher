import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ThinkingLevel } from "../src/config.ts";
import { agentTable, candidateOf } from "./helpers/identifiers.ts";
import extension, {
  checkAgentFiles,
  DEFAULT_CONFIG,
  evaluationFence,
  explicitSkill,
  fencedEvaluation,
  parseInvocation,
  readAgentDirectory,
  unknownFormNotice,
} from "../src/index.ts";

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
  extraGlobal: Record<string, unknown> = {},
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
    JSON.stringify({
      "openai-codex": { access: "test-token", accountId: "acct-test" },
      // The one credential all three Antigravity pools are read under, so a
      // complete read of them is one request, not three.
      antigravity: { access: "test-token", expires: Date.now() + 3_600_000, projectId: "test-project" },
    }),
    "utf8",
  );

  // The shipped config names no agents, so the fixture has to name them itself.
  await writeFile(
    join(agentDir, CONFIG_FILE_NAME),
    JSON.stringify({
      claudeCredsPath,
      pollMs,
      agents,
      ...extraGlobal,
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
  /** Antigravity's Argon pool: a week, and no session cap at all. */
  argonWeekly: number;
  geminiSession: number;
  geminiWeekly: number;
  threePartySession: number;
  threePartyWeekly: number;
}

/**
 * The only network boundary. The default readings make a real switch: claude
 * session at 90% is tight, codex session at 10% is more than `margin`
 * healthier and not tight on its week, so the claude-primary planner moves to
 * its codex alternate. Three requests only: claude, codex, and the one
 * Antigravity summary that answers for all three of its pools; deepseek is
 * metered and never fetched.
 */
const DEFAULT_READINGS: RailReadings = {
  claudeSession: 90,
  claudeWeekly: 0,
  codexSession: 10,
  codexWeekly: 0,
  argonWeekly: 0,
  geminiSession: 20,
  geminiWeekly: 0,
  threePartySession: 30,
  threePartyWeekly: 0,
};

/**
 * The reset instants the stub's Antigravity body reports.
 *
 * Fixed rather than computed from `Date.now()`, because a test asserts the pool's
 * projected `resetsAt` exactly: an instant derived at response time can land a
 * millisecond after the reading's own `readAt`, which would make the assertion
 * depend on how long the fetch took rather than on the projection being right.
 */
const ANTIGRAVITY_WEEKLY_RESET = "2026-11-05T16:46:22Z";
const ANTIGRAVITY_SESSION_RESET = "2026-10-29T21:46:22Z";

/**
 * One `retrieveUserQuotaSummary` body for those readings: three pools, told
 * apart by bucket id. The display names and the group order are deliberately not
 * the partition — the parser must not depend on either.
 */
function antigravityBody(r: RailReadings): unknown {
  // The vendor reports what is left of a window, so a used percentage is a fraction.
  const remaining = (used: number) => 1 - used / 100;
  const bucket = (bucketId: string, window: string, used: number, resetTime: string) => ({
    bucketId,
    window,
    resetTime,
    remainingFraction: remaining(used),
  });
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          bucket("gemini-weekly", "weekly", r.geminiWeekly, ANTIGRAVITY_WEEKLY_RESET),
          bucket("gemini-5h", "5h", r.geminiSession, ANTIGRAVITY_SESSION_RESET),
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          bucket("3p-weekly", "weekly", r.threePartyWeekly, ANTIGRAVITY_WEEKLY_RESET),
          bucket("3p-5h", "5h", r.threePartySession, ANTIGRAVITY_SESSION_RESET),
        ],
      },
      {
        // Last in the body: an ordering the partition must ignore.
        displayName: "Gemini 4 Argon",
        buckets: [bucket("gemini-argon-wtu-weekly", "weekly", r.argonWeekly, ANTIGRAVITY_WEEKLY_RESET)],
      },
    ],
  };
}

function stubFetch(overrides: Partial<RailReadings> = {}): typeof fetch {
  const r: RailReadings = { ...DEFAULT_READINGS, ...overrides };
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
    if (u.includes("cloudcode-pa.googleapis.com")) {
      return { ok: true, status: 200, json: async () => antigravityBody(r) };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

interface Ui {
  notify: (text: string, level?: string) => void;
  setStatus: (key: string, text?: string) => void;
  /** pi's theme; the gauge colors through it, so a test can read the tone off the text. */
  theme: { fg: (color: string, text: string) => string };
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
  /** The session's model; present only when a test supplies a `FakeSession`. */
  readonly model?: FakeModel;
}

/** A model as the fake registry answers it and the fake session holds it. */
interface FakeModel {
  provider: string;
  id: string;
}

/** What one `setModel` call does. */
type SetModelResult = boolean | Error | { moved: true; error: Error };

/**
 * The session pi's model and thinking setters act on. The extension reaches it
 * through `ctx.model` and the `pi.setModel`/`getThinkingLevel`/`setThinkingLevel`
 * API; every access is recorded in `calls` so a test can pin the order.
 */
interface FakeSession {
  /** In order: "getModel", "getThinkingLevel", "setModel:<provider>/<id>", "setThinkingLevel:<level>". */
  calls: string[];
  model?: string;
  thinking: ThinkingLevel;
  /** What pi's own setModel resets the level to (its per-model/default rule), so "retained" is proven. */
  switchLevel: ThinkingLevel;
  /** pi clamps to what the target supports; the fake stands in for that. */
  clamp?: (asked: ThinkingLevel) => ThinkingLevel;
  /** What the first setModel does: resolve true/false, reject before moving, or move and then reject. */
  setModelResult: SetModelResult;
  /** What every later setModel does — the restore's. Defaults to `true`. */
  laterSetModelResult?: SetModelResult;
  /** Thrown by the first setThinkingLevel after it has already applied the level. */
  thinkingThrows?: Error;
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    calls: [],
    model: "deepseek/deepseek-flash",
    thinking: "medium",
    switchLevel: "minimal",
    setModelResult: true,
    ...overrides,
  };
}

/**
 * One object per `provider/id` for the whole file. pi returns the *same* model
 * object while the session stays on the same model, and `pi.setModel` does not
 * short-circuit re-selecting the model already in place — the same-object
 * movement check depends on seeing that (issue #52 F1). A fresh `{ provider, id
 * }` on every read would make even an unmoved model look like a move by
 * identity, so the registry's `find` and the fake `ctx.model` both hand back the
 * one object this map memoizes.
 */
const MODEL_OBJECTS = new Map<string, FakeModel>();

function modelOf(spec: string | undefined): FakeModel | undefined {
  if (spec === undefined) return undefined;
  const existing = MODEL_OBJECTS.get(spec);
  if (existing !== undefined) return existing;
  const slash = spec.indexOf("/");
  const model = { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
  MODEL_OBJECTS.set(spec, model);
  return model;
}

/**
 * The extension API's session-selection methods over a `FakeSession`, with
 * pi's order of effects: a rejection before the move changes nothing, `false`
 * changes nothing, and a successful (or moved-then-failed) switch assigns the
 * model first and resets the level by pi's own rule, as `AgentSession.setModel`
 * does before its later steps can throw.
 */
function sessionApi(session: FakeSession) {
  let setModels = 0;
  let thinkingSets = 0;
  return {
    setModel: async (model: FakeModel): Promise<boolean> => {
      session.calls.push(`setModel:${model.provider}/${model.id}`);
      const result = setModels++ === 0 ? session.setModelResult : (session.laterSetModelResult ?? true);
      if (result === false) return false;
      if (result instanceof Error) throw result;
      session.model = `${model.provider}/${model.id}`;
      session.thinking = session.clamp?.(session.switchLevel) ?? session.switchLevel;
      if (result !== true) throw result.error;
      return true;
    },
    getThinkingLevel: (): ThinkingLevel => {
      session.calls.push("getThinkingLevel");
      return session.thinking;
    },
    setThinkingLevel: (level: ThinkingLevel): void => {
      session.calls.push(`setThinkingLevel:${level}`);
      session.thinking = session.clamp?.(level) ?? level;
      if (thinkingSets++ === 0 && session.thinkingThrows) throw session.thinkingThrows;
    },
  };
}

/**
 * The events this harness fires, discriminated by `type`, so an input event
 * cannot be passed where a lifecycle handler expects a reason.
 */
type HarnessEvent =
  | { type: "session_start" | "session_shutdown"; reason: string }
  | { type: "input"; text: string; source: "interactive" };

type CommandHandler = (args: string, ctx: Ctx) => Promise<void>;
type EventHandler = (event: HarnessEvent, ctx: Ctx) => Promise<unknown>;

/** What a test can drive once the extension is installed. */
interface Harness {
  /** Run the `quota-dispatch` command and return the text it notified. */
  run: (args: string) => Promise<string>;
  /** As `run`, but every notification in order — a warning may be its own. */
  runAll: (args: string) => Promise<string[]>;
  /**
   * Invoke the command with a fresh context and touch nothing else, so a test
   * can race two invocations without `run`'s one-notification assertion.
   */
  invoke: (args: string) => Promise<void>;
  /** Fire the `session_start` handler the extension registered. */
  sessionStart: (reason?: string) => Promise<void>;
  /** Fire the registered `input` handler with typed text and return what it returned. */
  input: (text: string) => Promise<unknown>;
  /**
   * Fire `session_shutdown` and then make every context handed out so far
   * stale, the way pi's runner does once a session is replaced. Idempotent, so a
   * test may call it and the `finally` block will not call it a second time.
   */
  shutdown: () => Promise<void>;
  /** The events the extension registered a handler for, in registration order. */
  events: string[];
  /** Everything the extension pushed to the UI, in order. */
  notifications: Array<{ text: string; level: string }>;
  statuses: Array<{ key: string; text: string | undefined }>;
  /** The help text pi lists the command under. */
  description: string | undefined;
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
  opts: {
    hasUI?: boolean;
    modelRegistry?: ModelRegistryLike;
    session?: FakeSession;
    notifyThrows?: boolean;
    /** A footer sink that refuses one key, for the gauge's failure handler. */
    statusThrows?: (key: string) => boolean;
  } = {},
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
  let description: string | undefined;

  const events: string[] = [];
  const session = opts.session;

  // pi invalidates the contexts of a replaced session: their getters throw from
  // then on. Nothing here may be read after `shutdown`.
  let invalidated = false;
  const assertLive = () => {
    if (invalidated) throw new Error("stale ctx");
  };

  const makeCtx = (): Ctx => {
    const ui: Ui = {
      notify: (text: string, level?: string) => {
        notifications.push({ text, level: level ?? "" });
        if (opts.notifyThrows) throw new Error("notify failed");
      },
      setStatus: (key: string, text?: string) => {
        if (opts.statusThrows?.(key)) throw new Error("status sink failed");
        statuses.push({ key, text });
      },
      // Dim is the identity so an expected gauge string reads like the plain
      // text; the warning tone keeps its marker.
      theme: { fg: (color: string, text: string) => (color === "warning" ? `<${text}>` : text) },
    };
    const ctx = {
      ...(opts.modelRegistry ? { modelRegistry: opts.modelRegistry } : {}),
    } as Ctx;
    // pi's runner throws from these getters once the session has been replaced,
    // which is what makes "a pass in flight across a shutdown draws nothing" a
    // testable property rather than a hope.
    Object.defineProperty(ctx, "hasUI", {
      enumerable: true,
      get: () => {
        assertLive();
        return hasUI;
      },
    });
    Object.defineProperty(ctx, "ui", { enumerable: true, get: () => (assertLive(), ui) });
    if (session) {
      Object.defineProperty(ctx, "model", {
        enumerable: true,
        get: () => {
          session.calls.push("getModel");
          // `MODEL_OBJECTS` is the one object per `provider/id`: the same object
          // the registry's `find` returns, so a same-model re-selection compares
          // equal by identity and a real move does not.
          return modelOf(session.model);
        },
      });
    }
    return ctx;
  };

  const unexpected = (name: string) => () => {
    throw new Error(`${name} called without a FakeSession`);
  };

  const api = {
    registerCommand: (_name: string, spec: { description?: string; handler: CommandHandler }) => {
      command = spec.handler;
      description = spec.description;
    },
    on: (event: string, handler: EventHandler) => {
      events.push(event);
      eventHandlers[event] = handler;
    },
    ...(session
      ? sessionApi(session)
      : {
          setModel: unexpected("setModel"),
          getThinkingLevel: unexpected("getThinkingLevel"),
          setThinkingLevel: unexpected("setThinkingLevel"),
        }),
  } as unknown as ExtensionAPI;

  let shutDown = false;
  const shutdown = async (): Promise<void> => {
    if (shutDown) return;
    shutDown = true;
    try {
      await eventHandlers.session_shutdown?.({ type: "session_shutdown", reason: "shutdown" }, makeCtx());
    } finally {
      // pi invalidates the contexts of a replaced session whether or not the
      // handler threw, so the harness does too — a failure here must not leave a
      // later assertion reading a context that should be dead.
      invalidated = true;
    }
  };

  try {
    extension(api);
    const handler = command;
    assert.ok(handler, "the extension must register the quota-dispatch command");

    const harness: Harness = {
      notifications,
      statuses,
      description,
      shutdown,
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
      invoke: async (args: string) => {
        await handler(args, makeCtx());
      },
      sessionStart: async (reason = "startup") => {
        await eventHandlers.session_start?.({ type: "session_start", reason }, makeCtx());
      },
      input: async (text: string) => {
        const handler = eventHandlers.input;
        assert.ok(handler, "the extension must register an input handler");
        return handler({ type: "input", text, source: "interactive" }, makeCtx());
      },
      events,
    };

    await body(harness);
  } finally {
    // Nested so a throwing shutdown — or a failed assertion above that left a
    // sink armed — still restores the process globals every later test depends
    // on, and the original failure is the one reported.
    try {
      await shutdown();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnv === undefined) delete process.env[ENV_AGENT_DIR];
      else process.env[ENV_AGENT_DIR] = previousEnv;
      process.chdir(previousCwd);
    }
  }
}

// ---------------------------------------------------------------- commands

/** The gauge's footer key, kept here so a filter cannot misspell it. */
const GAUGE_KEY = "quota-dispatch-gauge";
/** The warning footer's key, for the one test that makes that sink refuse it. */
const WARNING_KEY = "quota-dispatch";
/** The warning key's statuses, so a gauge entry can neither satisfy nor break them. */
const warningStatuses = (statuses: Array<{ key: string; text: string | undefined }>) =>
  statuses.filter((status) => status.key !== GAUGE_KEY);
/** The gauge's statuses, for the assertions that are about the gauge itself. */
const gaugeStatuses = (statuses: Array<{ key: string; text: string | undefined }>) =>
  statuses.filter((status) => status.key === GAUGE_KEY);

/**
 * The per-value provenance lines the report must never carry. `sessionSwitchAt`
 * is a built-in scalar and `agents.planner.primary.model` a global agent slot,
 * so a report that leaked any part of the block trips one of them.
 *
 * `describeConfig` still renders both — `/quota-dispatch config` is the form
 * that prints it, and its own test below pins the lines whole.
 */
function assertNoProvenance(text: string): void {
  assert.ok(!text.includes("sessionSwitchAt ="), text);
  assert.ok(!text.includes("agents.planner.primary.model ="), text);
}

test("the plain command reports the state and the layers, and writes nothing", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("");
    const projectFile = join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    // Which files were read is part of the state, so the layers line stays.
    // Where each value came from is a question asked deliberately, and this form
    // is not where it is answered.
    assert.ok(text.includes("config: built-in < global"), text);
    assert.ok(text.includes(projectFile), text);
    assertNoProvenance(text);
    assert.ok(!text.includes("[applied]"), text);
  });

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "the plain report must not write");
});

test("the refresh command reports the state and still writes nothing", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("refresh");
    const projectFile = join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);

    assert.ok(text.includes("config: built-in < global"), text);
    assert.ok(text.includes(projectFile), text);
    assertNoProvenance(text);
    assert.ok(!text.includes("[applied]"), text);
  });

  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "refresh must not write");
});

/**
 * `/quota-dispatch config` is the provenance form: the per-value lines the
 * report refuses to carry, and nothing else. The counting fetch that throws
 * pins the other half of "local" — answering where a value came from must not
 * cost a vendor request, which is what makes it safe to run off-network.
 */
test("the config command prints where each value came from without reading a quota", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");
  let fetches = 0;
  const refused = (async (url: string | URL) => {
    fetches++;
    throw new Error(`the config form must not read a quota: ${String(url)}`);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ run }) => {
      const text = await run("config");
      const projectFile = join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);

      assert.ok(text.includes("config: built-in < global"), text);
      assert.ok(text.includes(projectFile), text);
      assert.ok(text.includes("sessionSwitchAt = 75  [built-in]"), text);
      assert.ok(
        text.includes("agents.planner.primary.model = claude-bridge/claude-opus-5-5  [global]"),
        text,
      );
      assert.ok(
        text.includes("agents.planner.alternates[0].model = openai-codex/gpt-6-sol  [global]"),
        text,
      );

      // Not the report: the form answers a question about the config files, so
      // it prints no rail reading and no decision.
      assert.ok(!text.includes("claude: 5h"), text);
      assert.ok(!text.includes("planner -> "), text);
      assert.ok(!text.includes("[applied]"), text);
    },
    () => refused,
  );

  assert.equal(fetches, 0, "the config form is local and must fetch nothing");
  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "the config form must not write");
});

/**
 * A registry that carries pi's provider-token method beside the model lookup.
 *
 * Nothing here is called unless the dispatcher decides a refresh is due — which
 * is what these tests assert. The method's receiver is pinned by the unit test
 * for `providerTokenResolver` in `test/antigravity.test.ts`; the wiring proved
 * here only needs to notice a call.
 */
function tokenRegistry(calls: string[]) {
  return {
    find: (provider: string, modelId: string) => modelOf(`${provider}/${modelId}`),
    async getApiKeyForProvider(provider: string) {
      calls.push(provider);
      return JSON.stringify({ token: provider });
    },
  };
}

/**
 * The Antigravity credential is pi's to refresh, so the resolver is a dependency
 * of the dispatcher rather than something a read reaches for.
 *
 * Only a wired resolver produces the "not the default one" note, so that note is
 * the evidence that boot passed it on — for the dispatcher booted at load and for
 * the one a generation prepares. Neither boot, and neither report, may call it:
 * this fixture's auth file is not the one pi's provider owns, so no refresh is
 * due and a call would be a refresh this extension must never start.
 */
test("bootFrom wires pi's provider-token resolver into every dispatcher, and calls it for nothing", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  await layerNamesFixtureCredential(fx, GENERATED_LAYER);
  const calls: string[] = [];
  const WIRED = "the pi auth file is not the default one";
  const UNWIRED = "no provider token resolver is available";
  const authWith = (expires: number) =>
    writeFile(
      join(fx.agentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": { access: "test-token", accountId: "acct-test" },
        antigravity: { access: "stored-access", expires, projectId: "test-project" },
      }),
      "utf8",
    );

  await withExtension(
    fx,
    async ({ run }) => {
      const config = await run("config");
      assert.equal(calls.length, 0, "a config form that boots must not refresh a credential");
      assert.ok(config.includes("config: built-in < global"), config);

      // A usable token: all three pools read, and nothing consults the resolver.
      const healthy = await run("refresh");
      assert.ok(healthy.includes("antigravity-argon: gemini-argon-wtu-weekly 0%"), healthy);
      assert.equal(calls.length, 0, "a usable token never refreshes anything");

      // Expired, so a read has something to consult a resolver about; the note it
      // earns names the branch only a wired resolver reaches.
      await authWith(Date.now() - 1_000);
      // The provenance form boots and reads no quota, so an expired credential is
      // still not a reason to touch the provider.
      await run("config");
      assert.equal(calls.length, 0, "a config form reads no quota, so it refreshes nothing");
      const report = await run("refresh");
      assert.equal(calls.length, 0, "this profile's auth file is not pi's to refresh");
      assert.ok(report.includes(`antigravity-argon: unavailable — antigravity token expired; ${WIRED}`), report);
      assert.ok(!report.includes(UNWIRED), `boot must have passed the resolver on: ${report}`);

      // Generation is the second place a dispatcher is built: it carries the
      // pools' last good readings, so the failed refresh above does not refuse it,
      // and the dispatcher it prepares for the new layer must be wired as well.
      const generated = await run("generate");
      assert.ok(generated.startsWith("[generated]"), generated);
      const afterGenerate = await run("refresh");
      assert.ok(afterGenerate.includes(`antigravity-gemini: unavailable — antigravity token expired; ${WIRED}`), afterGenerate);
      assert.ok(!afterGenerate.includes(UNWIRED), `the prepared dispatcher must be wired too: ${afterGenerate}`);
      assert.equal(calls.length, 0, "a wired resolver is still not called when no refresh is due");
    },
    stubFetch,
    { modelRegistry: tokenRegistry(calls) },
  );
});

/**
 * An Antigravity pool is a rail like any other, so a route may name it — and the
 * write is the same write: the pool's model, the thinking level the route stated
 * for it, and the agent's body left alone.
 */
test("an Antigravity alternate is selected and applied with its own thinking level", async () => {
  const fx = await fixture(2_147_483_647, {
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternates: [{ model: "antigravity/gemini-3-pro", rail: "antigravity-gemini", thinking: "low" }],
    },
  });

  await withExtension(fx, async ({ run }) => {
    // claude's session is tight at 90% and the Gemini pool's session sits at 20%
    // with its week at 0, so the pool is the destination the policy picks.
    const text = await run("apply");
    assert.ok(text.includes("planner -> antigravity/gemini-3-pro (thinking: low)"), text);
    assert.ok(text.includes("[applied]"), text);
    assertNoProvenance(text);
  });

  const after = await readFile(fx.plannerFile, "utf8");
  assert.match(after, /^model: "antigravity\/gemini-3-pro"$/m);
  assert.match(after, /^thinking: low$/m);
  assert.match(after, /^Body\.$/m);
});

test("the apply command writes the decision, skips missing files, and reports only what it did", async () => {
  const fx = await fixture();

  await withExtension(fx, async ({ run }) => {
    const text = await run("apply");

    assert.ok(text.includes("[applied]"), text);
    assert.ok(text.includes("planner -> openai-codex/gpt-6-sol"), text);
    assert.ok(text.includes("[skipped (no file)]"), text);
    // `apply` ends at what it wrote. Provenance is a separate question, and
    // `/quota-dispatch config` is the form that answers it.
    assertNoProvenance(text);
  });

  const after = await readFile(fx.plannerFile, "utf8");
  assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
  assert.match(after, /^thinking: high$/m);
  assert.match(after, /^Body\.$/m);
});

// ---------------------------------------------------------------- invocation parsing

test("the argument is a whole form name, not a substring of one", () => {
  assert.deepEqual(parseInvocation(""), { form: "report", force: false });
  assert.deepEqual(parseInvocation("   "), { form: "report", force: false });
  assert.deepEqual(parseInvocation(" refresh "), { form: "report", force: true });
  assert.deepEqual(parseInvocation("config"), { form: "config" });
  assert.deepEqual(parseInvocation("apply"), { form: "apply" });
});

test("generate selects the global layer, or the project one with a single word", () => {
  assert.deepEqual(parseInvocation("generate"), { form: "generate", scope: "global" });
  assert.deepEqual(parseInvocation("  generate  "), { form: "generate", scope: "global" });
  assert.deepEqual(parseInvocation("generate project"), { form: "generate", scope: "project" });
  assert.deepEqual(parseInvocation("generate\tproject\n"), { form: "generate", scope: "project" });
  // A generated layer replaces one of the two known files, so the scope is a
  // whole word from a closed set; anything else is not guessed at.
  assert.deepEqual(parseInvocation("generate global"), { form: "unknown", arg: "generate global" });
  assert.deepEqual(parseInvocation("generate project extra"), {
    form: "unknown",
    arg: "generate project extra",
  });
  assert.deepEqual(parseInvocation("generatex"), { form: "unknown", arg: "generatex" });
});

test("an argument that names no form is unknown rather than a guess", () => {
  // Under the `includes` test this read as `apply`: a word that could have meant
  // "just look" selected the one form that writes.
  assert.deepEqual(parseInvocation("refresh apply"), { form: "unknown", arg: "refresh apply" });
  // And a typo used to fall through to the plain report without saying so.
  assert.deepEqual(parseInvocation("applyx"), { form: "unknown", arg: "applyx" });
  assert.deepEqual(parseInvocation("frobnicate"), { form: "unknown", arg: "frobnicate" });
});

/**
 * The description is the only place pi shows the forms: `config` is otherwise
 * discoverable only by reading the README, which left the provenance form
 * invisible to exactly the user this change added it for.
 */
test("the registered description names every form", async () => {
  const fx = await fixture();

  await withExtension(fx, async ({ description }) => {
    for (const form of ["refresh", "config", "apply", "generate"]) {
      assert.ok(description?.includes(form), `the description must name ${form}: ${description}`);
    }
  });
});

/**
 * The unknown form is answered before the boot, so it costs no config read, no
 * model check and no request — and the word that could have been `apply` cannot
 * reach a write.
 */
test("an unknown form is reported, reads no quota, and writes nothing", async () => {
  const fx = await fixture();
  const before = await readFile(fx.plannerFile, "utf8");
  let fetches = 0;
  const refused = (async (url: string | URL) => {
    fetches++;
    throw new Error(`an unknown form must not read a quota: ${String(url)}`);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ notifications, run }) => {
      const text = await run("refresh apply");
      assert.equal(text, unknownFormNotice("refresh apply").join("\n"));
      assert.equal(notifications[0].level, "warning");
      assert.ok(!text.includes("[applied]"), text);
    },
    () => refused,
  );

  assert.equal(fetches, 0, "an unknown form must not read a quota");
  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "an unknown form must not write");
});

// ---------------------------------------------------------------- generate

/** How long a poll cadence is lifted to so the background timer never fires. */
const MAX_POLL_MS = 2_147_483_647;

interface GenerateFixture {
  agentDir: string;
  projectDir: string;
  plannerFile: string;
  globalPath: string;
  projectPath: string;
  layerPath: string;
  marker: string;
}

/**
 * A fixture whose global config declares `command` as its generator. The layer
 * the command is expected to print is written beside it, and a marker path is
 * offered so a command can record that it actually ran.
 */
async function generateFixture(
  layer: unknown,
  command: (layerPath: string) => string = (layerPath) => `cat '${layerPath}'`,
  pollMs = MAX_POLL_MS,
): Promise<GenerateFixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-gen-cmd-"));
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
    JSON.stringify({
      "openai-codex": { access: "test-token", accountId: "acct-test" },
      // Generation needs a successful reading for every quota-capped rail, and
      // the three Antigravity pools are one credential and one request.
      antigravity: { access: "test-token", expires: Date.now() + 3_600_000, projectId: "test-project" },
    }),
    "utf8",
  );

  const globalPath = join(agentDir, CONFIG_FILE_NAME);
  const projectPath = join(projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  const layerPath = join(root, "layer.json");
  await writeFile(layerPath, JSON.stringify(layer, null, 2), "utf8");
  await writeFile(
    globalPath,
    JSON.stringify({
      claudeCredsPath,
      pollMs,
      generator: { command: command(layerPath) },
      agents: CONFIGURED_AGENTS,
    }),
    "utf8",
  );
  await writeFile(projectPath, JSON.stringify({ margin: 10 }), "utf8");

  const plannerFile = join(agentsDir, "planner.md");
  await writeFile(plannerFile, TEMPLATE("planner", "claude-bridge/claude-opus-5-5"), "utf8");

  return {
    agentDir,
    projectDir,
    plannerFile,
    globalPath,
    projectPath,
    layerPath,
    marker: join(root, "ran"),
  };
}

/**
 * Rewrite the fixture's layer so it names the fixture's Claude credential.
 *
 * A generated layer replaces the config file, `claudeCredsPath` included, so a
 * layer that does not name it sends the post-generation evaluation to the
 * developer's own `~/.claude` — present on a workstation, absent on CI, and a
 * test that passes only where it is.
 */
async function layerNamesFixtureCredential(fx: GenerateFixture, layer: object): Promise<void> {
  const claudeCredsPath = join(dirname(fx.agentDir), "claude-credentials.json");
  await writeFile(fx.layerPath, JSON.stringify({ ...layer, claudeCredsPath }), "utf8");
}

/** The ordinary config an existing ``/quota-dispatch generate`` invocation produces. */
const GENERATED_LAYER = {
  // A scalar the project layer beneath does not override, so the effective config
  // visibly moves with the generated global layer.
  weeklySwitchAt: 33,
  agents: {
    planner: {
      primary: { model: "openai-codex/gpt-6-sol", rail: "codex" },
      alternates: [{ model: "claude-bridge/claude-opus-5-5", rail: "claude" }],
    },
    reviewer: { primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" } },
  },
  skills: { "code-review": "reviewer" },
};

test("generate publishes the printed layer and activates it without a reload", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  const command = `cat '${fx.layerPath}'`;

  await withExtension(fx, async ({ run, statuses }) => {
    const text = await run("generate");
    assert.ok(text.startsWith(`[generated] ${fx.globalPath}`), text);

    // The footer follows the prepared runtime: a configured install with no
    // unknown models carries no warning line.
    assert.deepEqual(warningStatuses(statuses).at(-1), { key: "quota-dispatch", text: undefined });
    // ...and the generated config's own routes were drawn, so the gauge followed
    // the swap rather than describing the config the run replaced.
    assert.equal(typeof gaugeStatuses(statuses).at(-1)?.text, "string");

    // The file now holds the printed layer with its declaration preserved.
    const written = JSON.parse(await readFile(fx.globalPath, "utf8"));
    assert.deepEqual(written.generator, { command });
    assert.equal(written.weeklySwitchAt, 33);
    assert.equal(written.agents.planner.primary.model, "openai-codex/gpt-6-sol");

    // The active configuration moved with it: the provenance form answers from
    // the new layer, with no `/reload`.
    const config = await run("config");
    assert.ok(config.includes("weeklySwitchAt = 33  [global]"), config);
    assert.ok(config.includes("skills.code-review = reviewer  [global]"), config);
  });

  // The post-publication evaluation wrote the agent file for the new policy:
  // planner's primary is now the codex model, so that is what its file holds.
  assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
});

test("generate project replaces only the project file", async () => {
  const fx = await generateFixture({});
  const projectLayer = { margin: 44, agents: {} };
  const layerPath = join(dirname(fx.projectPath), "project-layer.json");
  await writeFile(layerPath, JSON.stringify(projectLayer), "utf8");

  // The project file declares its own generator, whose command prints the layer
  // in the project config directory (the run's working directory).
  await writeFile(
    fx.projectPath,
    JSON.stringify({ generator: { command: "cat project-layer.json" } }),
    "utf8",
  );
  const globalBefore = await readFile(fx.globalPath, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("generate project");
    // The run's working directory is the project config dir, and cwd is its
    // physical path, so the notice names that.
    assert.ok(text.startsWith("[generated] ") && text.includes(await realpath(fx.projectPath)), text);
    const written = JSON.parse(await readFile(fx.projectPath, "utf8"));
    assert.equal(written.margin, 44);
    assert.deepEqual(written.generator, { command: "cat project-layer.json" });
  });

  assert.equal(await readFile(fx.globalPath, "utf8"), globalBefore, "the global layer must be untouched");
});

test("nothing but the generate form runs the declared command", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let marker = "";
  const fx = await generateFixture(
    {},
    (layerPath) => {
      marker = join(dirname(layerPath), "ran");
      return `touch '${marker}' && cat '${layerPath}'`;
    },
    // A real cadence, so the poll tick below is not vacuous.
    40,
  );

  await withExtension(fx, async ({ run, sessionStart, input }) => {
    await sessionStart("startup");
    await run("");
    await run("refresh");
    await run("config");
    await run("apply");
    await sessionStart("reload");
    await input("hello");
    // A bound-skill input reads the cached config, which is the other path that
    // could plausibly reach the generator.
    await input("/skill:code-review");
    // And a real poll tick, not merely the absence of one.
    t.mock.timers.tick(40);
    await new Promise((done) => setImmediate(done));
    await assert.rejects(readFile(marker, "utf8"), "no other form may run the generator");

    await run("generate");
  });

  await readFile(marker, "utf8");
});

test("a failed generator leaves the file and the active configuration unchanged", async () => {
  const fx = await generateFixture({}, () => "echo 'the script died' >&2; exit 2");
  const plannerBefore = await readFile(fx.plannerFile, "utf8");
  const failedBefore = await readFile(fx.globalPath, "utf8");

  await withExtension(fx, async ({ run }) => {
    const text = await run("generate");
    assert.ok(text.includes("exited with code 2"), text);
    assert.ok(text.includes("the script died"), text);
    assert.ok(text.includes("This run did not change"), text);
    const config = await run("config");
    assert.ok(config.includes("agents.planner.primary.model = claude-bridge/claude-opus-5-5"), config);
  });

  assert.equal(await readFile(fx.globalPath, "utf8"), failedBefore);
  assert.equal(await readFile(fx.plannerFile, "utf8"), plannerBefore);
});

test("an overlapping generation is refused rather than queued", async () => {
  const fx = await generateFixture(GENERATED_LAYER, (layerPath) => `sleep 0.4; cat '${layerPath}'`);

  await withExtension(fx, async ({ invoke, notifications }) => {
    const first = invoke("generate");
    // Let the first reach its subprocess, which sleeps, before racing the second.
    await new Promise((done) => setTimeout(done, 80));
    const second = invoke("generate");
    await Promise.all([first, second]);
    assert.ok(
      notifications.some((n) => n.text.includes("already running")),
      notifications.map((n) => n.text).join("\n"),
    );
    assert.ok(notifications.some((n) => n.text.startsWith("[generated]")), notifications.map((n) => n.text).join("\n"));
  });
});

test("generate project fails when the project file declares no generator", async () => {
  const fx = await generateFixture({});
  await withExtension(fx, async ({ run }) => {
    const text = await run("generate project");
    assert.ok(text.includes('declares no "generator"'), text);
  });
});

test("a UI failure after publication does not undo or relabel the committed change", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  await withExtension(
    fx,
    async ({ invoke }) => {
      // The success notice throws; the file has already moved, so the change
      // must stand rather than be reported (or rolled) as unchanged.
      await assert.rejects(invoke("generate"));
    },
    stubFetch,
    { notifyThrows: true },
  );
  const written = JSON.parse(await readFile(fx.globalPath, "utf8"));
  assert.equal(written.weeklySwitchAt, 33);
  assert.equal(written.agents.planner.primary.model, "openai-codex/gpt-6-sol");
});

test("the evaluation fence drains a running evaluation and refuses a new one", async () => {
  const fence = evaluationFence();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });

  const running = fence.run(async () => {
    order.push("run:start");
    await gate;
    order.push("run:end");
  });
  const acquired = fence.acquire().then((rel) => {
    order.push("fenced");
    return rel;
  });

  // A new evaluation cannot start while the fence is up; it is refused, not queued.
  assert.equal(await fence.run(async () => order.push("late")), undefined);

  release();
  await running;
  const rel = await acquired;
  assert.deepEqual(order, ["run:start", "run:end", "fenced"]);

  rel();
  assert.equal(await fence.run(async () => "ok"), "ok");
});

/**
 * The boot the runtime holds is a mutable reference; a generation replaces it.
 * An evaluation must read it when the fence admits the evaluation, not when the
 * evaluation was requested, or a `session_start` awaiting an old boot could
 * evaluate the superseded policy after the generation's own evaluation.
 */
test("a fenced evaluation reads the current boot only after the fence admits it", async () => {
  const fence = evaluationFence();
  let boot: string | undefined = "old";
  const seen: string[] = [];
  const evaluate = async (value: unknown): Promise<void> => {
    seen.push(String(value));
  };

  const release = await fence.acquire();
  // A generation supersedes the boot while the fence is held.
  boot = "new";
  assert.equal(await fencedEvaluation(fence, async () => boot, evaluate), undefined);
  assert.deepEqual(seen, [], "a refused evaluation must not read the boot at all");

  release();
  await fencedEvaluation(fence, async () => boot, evaluate);
  assert.deepEqual(seen, ["new"], "the evaluation must use the boot current when it starts");

  // No boot at all is a no-op, not a crash.
  await fencedEvaluation(fence, () => undefined, evaluate);
  assert.deepEqual(seen, ["new"]);
});

/**
 * A `session_start` evaluation is awaited by the session, so when a generation
 * holds the fence it waits for the release instead of being dropped. The boot it
 * runs against is then the one the generation installed, not the one current
 * when the request arrived. This is the seam `session_start` uses; the poll tick
 * and `apply` keep the drop/refuse behaviour above.
 */
test("a waiting evaluation is admitted when the fence lowers and reads the boot it installed", async () => {
  const fence = evaluationFence();
  let boot = "old";
  const seen: string[] = [];
  const evaluate = async (value: unknown): Promise<void> => {
    seen.push(String(value));
  };

  const release = await fence.acquire();
  boot = "new";

  let settled = false;
  const evaluation = fencedEvaluation(fence, async () => boot, evaluate, { wait: true }).then((result) => {
    settled = true;
    return result;
  });

  // A macrotask of real time, so a refused evaluation that resolved in a
  // microtask cannot sneak past the assertion.
  await new Promise((done) => setImmediate(done));
  assert.equal(settled, false, "a waiting evaluation must not resolve while the fence is held");
  assert.deepEqual(seen, [], "it must not read the boot while the fence is held");

  release();
  await evaluation;
  assert.deepEqual(seen, ["new"], "it must read the boot current at the release, not at the request");
});

/** Rewrite the fixture's global config in place, before the extension loads it. */
async function editGlobal(fx: GenerateFixture, edit: (config: Record<string, any>) => void): Promise<void> {
  const config = JSON.parse(await readFile(fx.globalPath, "utf8"));
  edit(config);
  await writeFile(fx.globalPath, JSON.stringify(config), "utf8");
}

/**
 * Generation now always gathers the generator's input, so on an install that
 * has never read a rail it costs one request per capped rail. What this pins is
 * the rest: once the readings are held, neither the snapshot — whatever the
 * readings' age — nor the post-publication evaluation of an empty table asks a
 * vendor again. A tiny `ttlMs` makes "whatever their age" observable: a
 * snapshot that honoured the TTL, or that read through a fresh dispatcher, would
 * fetch both rails.
 */
test("a warmed install generates an empty table without reading a quota again", async () => {
  const fx = await generateFixture({}, () => "printf '{}'");
  await editGlobal(fx, (config) => {
    config.ttlMs = 1;
  });
  const quota = countingStubFetch();

  await withExtension(
    fx,
    async ({ run, sessionStart }) => {
      await sessionStart();
      assert.equal(quota.count(), 3, "precondition: startup read both vendor rails and the one Antigravity group");
      // Real time past the 1 ms TTL, so the readings are expired by any clock.
      await new Promise((done) => setTimeout(done, 20));
      const text = await run("generate");
      assert.ok(text.startsWith("[generated]"), text);
    },
    quota.factory,
  );

  assert.equal(quota.count(), 3, "a warmed install must cost no further usage request to generate an empty table");
});

/** A generator that saves what it was fed on stdin beside the layer, then prints the layer. */
function capturingGenerator(layerPath: string): string {
  return `cat > '${join(dirname(layerPath), "input.json")}'; cat '${layerPath}'`;
}

async function capturedInput(fx: GenerateFixture): Promise<any> {
  return JSON.parse(await readFile(join(dirname(fx.layerPath), "input.json"), "utf8"));
}

test("a generator reading stdin receives every rail's reading in the documented shape", async () => {
  const fx = await generateFixture({}, capturingGenerator);
  const before = Date.now();
  await withExtension(fx, async ({ run }) => {
    const text = await run("generate");
    assert.ok(text.startsWith("[generated]"), text);
  });
  const after = Date.now();
  const input = await capturedInput(fx);

  assert.equal(input.version, 1);
  assert.deepEqual(Object.keys(input.rails).sort(), [
    "antigravity-3p",
    "antigravity-argon",
    "antigravity-gemini",
    "claude",
    "codex",
    "deepseek",
  ]);
  assert.deepEqual(input.rails.deepseek, { metered: true, windows: [], raw: null });

  // The stub's numbers: claude session 90 with no reset reported, so the window
  // has no `resetsAt` key at all.
  const { claude, codex } = input.rails;
  assert.equal(claude.ok, true);
  assert.deepEqual(claude.windows, [
    { label: "5h", used: 90, budget: "session" },
    { label: "7d", used: 0, budget: "weekly" },
  ]);
  assert.deepEqual(claude.raw, { five_hour: { utilization: 90 }, seven_day: { utilization: 0 } });
  assert.ok(!("latestFailure" in claude));

  // Codex reports resets relative to the response; the document carries them as
  // ISO instants anchored on the reading's own `readAt`.
  assert.equal(codex.ok, true);
  assert.deepEqual(codex.windows.map((w: any) => [w.label, w.used, w.budget]), [
    ["5h", 10, "session"],
    ["7d", 0, "weekly"],
  ]);
  const readAt = Date.parse(codex.readAt);
  assert.equal(new Date(readAt).toISOString(), codex.readAt, "readAt must be ISO 8601 UTC");
  assert.ok(before <= readAt && readAt <= after, `readAt ${codex.readAt} is not the time of this run's read`);
  assert.equal(Date.parse(codex.windows[0].resetsAt) - readAt, 3_600_000);
  assert.equal(Date.parse(codex.windows[1].resetsAt) - readAt, 400_000_000);
  assert.equal(codex.raw.rate_limit.primary_window.used_percent, 10);
  assert.ok(!("latestFailure" in codex));

  // The three pools are one response partitioned by bucket id, so they share
  // `readAt` and `raw` and differ only in the windows each owns. Argon carries
  // a week and no session: the document must not invent a window for a cap that
  // pool does not have.
  const argon = input.rails["antigravity-argon"];
  const gemini = input.rails["antigravity-gemini"];
  const threeParty = input.rails["antigravity-3p"];
  assert.equal(argon.ok, true);
  assert.equal(gemini.ok, true);
  assert.equal(threeParty.ok, true);
  assert.deepEqual(argon.windows.map((w: any) => [w.label, w.used, w.budget]), [
    ["gemini-argon-wtu-weekly", 0, "weekly"],
  ]);
  assert.deepEqual(gemini.windows.map((w: any) => [w.label, w.used, w.budget]), [
    ["gemini-weekly", 0, "weekly"],
    ["gemini-5h", 20, "session"],
  ]);
  assert.deepEqual(threeParty.windows.map((w: any) => [w.label, w.used, w.budget]), [
    ["3p-weekly", 0, "weekly"],
    ["3p-5h", 30, "session"],
  ]);
  const poolReadAt = Date.parse(argon.readAt);
  const poolAfter = Date.now();
  assert.ok(before <= poolReadAt && poolReadAt <= poolAfter, `pool readAt ${argon.readAt} is not this run's`);
  // One vendor answer, one instant: three stamps would be three answers.
  assert.equal(gemini.readAt, argon.readAt);
  assert.equal(threeParty.readAt, argon.readAt);
  // Each pool carries the whole document — the same account-wide body three
  // times over — not a per-pool excerpt.
  assert.deepEqual(gemini.raw, argon.raw);
  assert.deepEqual(threeParty.raw, argon.raw);
  assert.deepEqual(Object.keys(argon.raw), ["groups"]);
  // Every window keeps the vendor's own reset instant.
  assert.equal(argon.windows[0].resetsAt, new Date(Date.parse(ANTIGRAVITY_WEEKLY_RESET)).toISOString());
  assert.equal(gemini.windows[1].resetsAt, new Date(Date.parse(ANTIGRAVITY_SESSION_RESET)).toISOString());
});

test("a never-read install reads each capped rail once to generate, and no more", async () => {
  const fx = await generateFixture({}, () => "printf '{}'");
  const quota = countingStubFetch();
  await withExtension(
    fx,
    async ({ run }) => {
      const text = await run("generate");
      assert.ok(text.startsWith("[generated]"), text);
    },
    quota.factory,
  );
  // One per capped rail for the input — and the Antigravity pools are one
  // request between them — while the empty generated table's own evaluation
  // asks nothing.
  assert.equal(quota.count(), 3);
});

test("a rail whose newest read failed is fed as its last good reading, marked", async () => {
  const fx = await generateFixture({}, capturingGenerator);
  let codexFails = false;
  const healthy = stubFetch();
  const flaky = (async (url: string | URL) => {
    if (codexFails && String(url).includes("chatgpt.com")) {
      // A definite answer: a 429 is not retried, so no backoff runs here.
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return healthy(url);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ run, sessionStart }) => {
      await sessionStart();
      codexFails = true;
      const refreshed = await run("refresh");
      assert.ok(refreshed.includes("codex: unavailable"), refreshed);
      const text = await run("generate");
      assert.ok(text.startsWith("[generated]"), text);
    },
    () => flaky,
  );

  const { claude, codex } = (await capturedInput(fx)).rails;
  assert.equal(codex.ok, true);
  assert.match(codex.latestFailure?.note ?? "", /HTTP 429/);
  // The startup reading's numbers, and its time: the failure is newer.
  assert.deepEqual(codex.windows.map((w: any) => w.used), [10, 0]);
  assert.ok(Date.parse(codex.readAt) <= Date.parse(codex.latestFailure.at), JSON.stringify(codex));
  assert.ok(!("latestFailure" in claude), "claude's refresh succeeded");
});

test("a capped rail that was never read successfully refuses the run and changes nothing", async () => {
  let marker = "";
  const fx = await generateFixture(GENERATED_LAYER, (layerPath) => {
    marker = join(dirname(layerPath), "ran");
    return `touch '${marker}'; cat '${layerPath}'`;
  });
  await rm(join(fx.agentDir, "auth.json"));
  const globalBefore = await readFile(fx.globalPath, "utf8");
  const plannerBefore = await readFile(fx.plannerFile, "utf8");

  await withExtension(fx, async ({ run, notifications }) => {
    const text = await run("generate");
    assert.equal(notifications[0].level, "warning", "a refusal is shown like any other generation failure");
    assert.ok(text.includes("codex") && text.includes("no pi auth file"), text);
    assert.ok(text.includes("This run did not change"), text);
    await assert.rejects(readFile(marker, "utf8"), "the generator must not have run");

    // The active configuration is the one from before the run.
    const config = await run("config");
    assert.ok(config.includes("agents.planner.primary.model = claude-bridge/claude-opus-5-5"), config);
  });

  assert.equal(await readFile(fx.globalPath, "utf8"), globalBefore);
  assert.equal(await readFile(fx.plannerFile, "utf8"), plannerBefore);
});

test("a claude rail that was never read successfully refuses the run too", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  // The other capped rail, so the refusal cannot be the codex path by accident.
  const config = JSON.parse(await readFile(fx.globalPath, "utf8"));
  await rm(config.claudeCredsPath);
  const globalBefore = await readFile(fx.globalPath, "utf8");

  await withExtension(fx, async ({ run, notifications }) => {
    const text = await run("generate");
    assert.equal(notifications[0].level, "warning", text);
    assert.ok(text.includes("the claude rail has no valid reading yet"), text);
    assert.ok(!text.includes("the codex rail has no valid reading"), `codex is readable: ${text}`);
    assert.ok(text.includes("This run did not change"), text);
  });

  assert.equal(await readFile(fx.globalPath, "utf8"), globalBefore);
});

/**
 * The readings describe the configuration in force *before* the run: a generated
 * layer that names different credential paths must not change where its own
 * input was read from. The generated layer points claude at a file that does
 * not exist, so a run that read through the *new* configuration would refuse
 * instead of producing the windows the old one yields.
 */
test("the readings come from the credential paths active before generation", async () => {
  const active = await generateFixture(
    { claudeCredsPath: join(tmpdir(), "pqd-gen-credential-does-not-exist.json"), agents: {} },
    capturingGenerator,
  );

  await withExtension(active, async ({ run }) => {
    const text = await run("generate");
    assert.ok(text.startsWith("[generated]"), text);
  });

  const { claude, codex } = (await capturedInput(active)).rails;
  assert.equal(claude.ok, true, JSON.stringify(claude));
  assert.deepEqual(claude.windows.map((w: any) => w.used), [90, 0]);
  assert.equal(codex.ok, true, JSON.stringify(codex));
});

test("generate project with no project declaration reads no quota", async () => {
  const fx = await generateFixture({});
  const quota = countingStubFetch();
  await withExtension(
    fx,
    async ({ run }) => {
      const text = await run("generate project");
      assert.ok(text.includes('declares no "generator"'), text);
    },
    quota.factory,
  );
  assert.equal(quota.count(), 0, "a file with nothing to run must not cost a usage request");
});

test("a slow quota read does not consume the generator's timeoutMs", async () => {
  const fx = await generateFixture({});
  // Less than the reads take: a timer started before the reads would expire
  // before the command was even spawned.
  await editGlobal(fx, (config) => {
    config.generator.timeoutMs = 150;
  });
  const healthy = stubFetch();
  const slow = (async (url: string | URL) => {
    await new Promise((done) => setTimeout(done, 400));
    return healthy(url);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ run }) => {
      const text = await run("generate");
      assert.ok(text.startsWith("[generated]"), text);
    },
    () => slow,
  );
});

test("a failed generation leaves the write fence usable", async () => {
  const fx = await generateFixture({}, () => "echo dead >&2; exit 3");
  await withExtension(fx, async ({ run }) => {
    const failed = await run("generate");
    assert.ok(failed.includes("exited with code 3"), failed);
    // The fence a generation takes around its final transition must be down, so
    // a later write-capable form is not refused as "generation finishing".
    const applied = await run("apply");
    assert.ok(applied.startsWith("[applied]"), applied);
  });
});

test("a held lock fails the run and still releases the fence", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  const lockPath = join(dirname(fx.globalPath), ".quota-dispatch.json.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }), "utf8");
  try {
    await withExtension(fx, async ({ run }) => {
      const failed = await run("generate");
      assert.ok(failed.includes("lock"), failed);
      await rm(lockPath, { force: true });
      const applied = await run("apply");
      assert.ok(applied.startsWith("[applied]"), applied);
    });
  } finally {
    await rm(lockPath, { force: true });
  }
});

/**
 * The overlap R1 and R2 are about, driven through the real handlers. A
 * generation is parked on a foreign file lock, so it holds the write fence but
 * has not published or swapped the boot yet. A `session_start` arriving then
 * must wait for the generation rather than being dropped, and must evaluate the
 * boot the generation installs — not the one it could have read before waiting.
 *
 * The two policies decide differently on purpose: the old table's claude
 * primary stays claude, and the generated table's codex primary stays codex,
 * because both rails read healthy. A stale evaluation of the old boot after the
 * release would write claude over the codex the generation chose.
 */
test("session_start waits out a generation's fence and evaluates the boot it installs", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  const lockPath = join(dirname(fx.globalPath), ".quota-dispatch.json.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }), "utf8");
  try {
    await withExtension(
      fx,
      async ({ invoke, runAll, sessionStart }) => {
        const generating = invoke("generate");

        // `apply` is refused for exactly as long as the fence is up, so the
        // refusal is the observable that the generation is parked inside it.
        let fenced = false;
        for (let i = 0; i < 3000 && !fenced; i++) {
          fenced = (await runAll("apply")).some((line) => line.includes("generation is finishing"));
          if (!fenced) await new Promise((done) => setImmediate(done));
        }
        assert.ok(fenced, "the generation must be parked on the fence before the session starts");

        let started = false;
        const starting = sessionStart().then(() => {
          started = true;
        });
        // The fence is held, so a session start that did not wait would have
        // resolved by the next macrotask.
        await new Promise((done) => setImmediate(done));
        assert.equal(started, false, "session_start must wait for the release, not be dropped by the fence");

        await rm(lockPath, { force: true });
        await starting;
        await generating;
      },
      () => stubFetch({ claudeSession: 10, codexSession: 10 }),
    );
  } finally {
    await rm(lockPath, { force: true });
  }

  // The generation's codex policy stands: the waiting session_start evaluated
  // the boot installed by the release, not the claude boot it saw at arrival.
  assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
});

test("a generation that changes pollMs reschedules the poll", async () => {
  const fx = await generateFixture({ ...GENERATED_LAYER, pollMs: 40 });
  const delays: number[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetInterval(fn, ms);
  }) as typeof setInterval;
  try {
    await withExtension(fx, async ({ run }) => {
      await run("generate");
    });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  // The first load schedules the fixture's lifted cadence; generation reschedules
  // from the generated one, and that is the cadence the extension is left on.
  assert.equal(delays.at(-1), 40, `scheduled delays: ${delays.join(", ")}`);
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
 * `railReadings` returns the cached reading unless `force` is set, so a cold report
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
    // The three pools are one request, so a complete read is three requests and
    // a refresh is three more.
    if (u.includes("cloudcode-pa.googleapis.com")) {
      return { ok: true, status: 200, json: async () => antigravityBody(DEFAULT_READINGS) };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ run }) => {
      const first = await run("");
      assert.equal(fetches, 3, "a cold plain report fetches both live rails and the Antigravity group once");
      assert.ok(first.includes("claude: 5h 90%"), first);

      // Change what the endpoint would report. Within `ttlMs` the plain form
      // must still show the reading it already has.
      claudeSession = 40;
      codexSession = 5;
      const second = await run("");
      assert.equal(fetches, 3, "the plain form reuses the cached reading within ttlMs");
      assert.ok(second.includes("claude: 5h 90%"), second);
      assert.ok(!second.includes("claude: 5h 40%"), second);

      const refreshed = await run("refresh");
      assert.equal(fetches, 6, "refresh forces a re-fetch of both live rails and the Antigravity group");
      assert.ok(refreshed.includes("claude: 5h 40%"), refreshed);
    },
    () => countingFetch,
  );
});

// ---------------------------------------------------------------- poll timer

const PRIMARY = TEMPLATE("planner", "claude-bridge/claude-opus-5-5");

/**
 * Pump the real event loop until `predicate` holds, or a bounded time elapses
 * and the test fails by name.
 *
 * Every test that starts background work waits on that work's *observed* result
 * before returning, so nothing is left in flight when the harness restores its
 * globals. The bound is why a broken extension body fails the assertion instead
 * of hanging.
 *
 * The bound is wall-clock, not a turn count: the work being waited on is real
 * file and socket I/O, which takes time rather than turns, and a turn-count
 * bound expires on a loaded CI runner while the I/O it is waiting for is still
 * perfectly on its way. Ten seconds is orders of magnitude above what the work
 * needs and still far below a hung suite.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Wrap a fetch implementation so one matched request can be held in flight.
 *
 * A race between two evaluations is only pinned if the first read is provably
 * still in flight when the second runs, and a settled promise is not. `arm()`
 * makes the next matching request resolve `entered` and wait for `release()`
 * before delegating, which gives the test both an arrival signal and control of
 * the moment the read finishes.
 */
function gatedFetch(inner: typeof fetch, match: (url: string) => boolean) {
  let armed = false;
  let arrive: (() => void) | undefined;
  let open: (() => void) | undefined;
  let entered = Promise.resolve();
  let gate = Promise.resolve();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (armed && match(String(url))) {
      armed = false;
      arrive?.();
      await gate;
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    arm() {
      armed = true;
      entered = new Promise<void>((done) => (arrive = done));
      gate = new Promise<void>((done) => (open = done));
    },
    get entered(): Promise<void> {
      return entered;
    },
    release() {
      open?.();
    },
  };
}

/**
 * Pump the real event loop until `planner.md` stops matching `original`, or a
 * bounded time elapses. `tick` only *starts* the interval's fire-and-forget
 * `evaluate()`, which then does async file I/O; this waits for that to land
 * without a wall-clock sleep. `setInterval` is mocked but `setImmediate` is
 * real, and the bound means a broken interval body fails the assertion instead
 * of hanging the test.
 *
 * The bound is wall-clock for the same reason `waitFor`'s is: the work being
 * awaited is real file I/O, so it takes time rather than turns, and a turn-count
 * bound expires on a loaded runner while the write is still on its way. Returns
 * whether the file moved, so a caller that must not fail on a timeout can ignore
 * it and one that must can assert on it.
 */
async function settle(read: () => Promise<string>, original: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if ((await read()) !== original) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
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
    assert.ok(await settle(() => readFile(fx.plannerFile, "utf8"), PRIMARY), "the tick's switch never landed");

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
      // followed by one `  <name>.md — model: …` line per file, and then the
      // report's tail, which is not indented. Slicing to the end of the text
      // would let a later line that happens to name `planner` pass a routed file
      // off as unmanaged.
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
 * reads: it answers the model, or undefined when this pi cannot spawn it. It
 * answers with the shared `MODEL_OBJECTS` instance, so the object `setModel` is
 * handed is the object `ctx.model` returns.
 */
function registry(known: Record<string, string[]>): ModelRegistryLike {
  return {
    find: (provider, modelId) => (known[provider]?.includes(modelId) ? modelOf(`${provider}/${modelId}`) : undefined),
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

      // The boot warning is still replayed, which is the duplication ADR 0008
      // argues for: the decision explains the agent, the warning stays a faithful
      // log of every one raised. Filtering the replay because a decision already
      // said it is the tempting tidy-up this pins against.
      const replay =
        "  warning: agents.planner.alternates[0].model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may";
      assert.ok(lines.includes(replay), text);

      // Both surfaces replay it: the report carries the warnings because a
      // config that is not doing what the user meant has to say so on the run
      // that read it, and `/quota-dispatch config` is the provenance block the
      // warnings have always been the tail of.
      const configText = (await runAll("config")).join("\n");
      assert.ok(configText.includes(replay), configText);
      assert.ok(configText.includes("sessionSwitchAt = 75  [built-in]"), configText);
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
          warningStatuses(statuses),
          [{ key: "quota-dispatch", text: "quota-dispatcher: a configured model is unknown to this pi." }],
          `the footer must hold the unknown model on ${reason}: ${JSON.stringify(statuses)}`,
        );
        assert.equal(
          lines[0],
          warningStatuses(statuses)[0].text,
          "the warning's headline and the footer are the same words",
        );
        // The gauge has its own key, so the warning does not stand in its place.
        assert.equal(typeof gaugeStatuses(statuses).at(-1)?.text, "string", JSON.stringify(statuses));
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
          warningStatuses(statuses),
          [{ key: "quota-dispatch", text: "quota-dispatcher: a configured model is unknown to this pi." }],
          `the footer must carry the unknown model on ${reason}: ${JSON.stringify(statuses)}`,
        );
        assert.equal(typeof gaugeStatuses(statuses).at(-1)?.text, "string", JSON.stringify(statuses));
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
      assert.deepEqual(
        warningStatuses(statuses),
        [{ key: "quota-dispatch", text: undefined }],
        JSON.stringify(statuses),
      );
      assert.equal(typeof gaugeStatuses(statuses).at(-1)?.text, "string", JSON.stringify(statuses));
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
    assert.deepEqual(
      warningStatuses(statuses),
      [{ key: "quota-dispatch", text: undefined }],
      JSON.stringify(statuses),
    );
    assert.equal(typeof gaugeStatuses(statuses).at(-1)?.text, "string", JSON.stringify(statuses));
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

// The warning moved to boot: both post-boot reader surfaces must retain it.
test("boot agent-file warnings remain in the report tail and the config command", async () => {
  const fx = await fixture();
  const missing = join(fx.agentDir, "agents", "reviewer.md");
  const warning = `  warning: ${missing}: configured agent "reviewer" has no file — run the /agents command to create a new agent`;
  await withExtension(fx, async ({ runAll }) => {
    const report = (await runAll("")).join("\n");
    assert.ok(report.split("\n").includes(warning), report);
    assert.ok(report.indexOf(warning) > report.indexOf("reviewer ->"), report);
    const configText = (await runAll("config")).join("\n");
    assert.ok(configText.split("\n").includes(warning), configText);
    assert.ok(configText.indexOf(warning) > configText.indexOf("agents.reviewer.primary.model"), configText);
  });
});

test("unmanaged listings use declared identities, not stems, including contested routed files", async () => {
  const fx = await fixture(2_147_483_647, {
    Architect: { primary: { model: "deepseek/deepseek-flash", rail: "deepseek" } },
    "plan-work": { primary: { model: "deepseek/deepseek-flash", rail: "deepseek" } },
    reviewer: { primary: { model: "deepseek/deepseek-flash", rail: "deepseek" } },
  });
  const dir = join(fx.agentDir, "agents");
  await writeFile(join(dir, "architect-work.md"), TEMPLATE("Architect", "deepseek/deepseek-flash"));
  await writeFile(join(dir, "plan-work.md"), TEMPLATE("Unrouted", "deepseek/deepseek-flash"));
  await writeFile(join(dir, "one.md"), TEMPLATE("reviewer", "deepseek/deepseek-flash"));
  await writeFile(join(dir, "two.md"), TEMPLATE("reviewer", "deepseek/deepseek-flash"));
  await withExtension(fx, async ({ run }) => {
    const report = await run("");
    const at = report.indexOf("unmanaged agent files");
    assert.notEqual(at, -1, report);
    const listed: string[] = [];
    for (const line of report.slice(at).split("\n").slice(1)) {
      if (!line.startsWith("  ") || !line.includes(".md")) break;
      listed.push(line);
    }
    assert.ok(listed.includes("  plan-work.md (name: Unrouted) — model: deepseek/deepseek-flash"), report);
    assert.ok(!listed.some((l) => l.includes("architect-work.md") || l.includes("one.md") || l.includes("two.md")), report);
    assert.ok(report.includes("[held]"), report);
    assert.equal(report.includes("ambiguous"), false);
    const warning = report.split("\n").find((line) => line.startsWith("  warning:") && line.includes('configured agent "reviewer"'));
    assert.ok(warning, report);
    assert.ok(warning.includes("is contested:"), report);
    assert.ok(warning.endsWith("give each file its own name"), report);
    const configText = await run("config");
    assert.equal(configText.includes("ambiguous"), false);
    assert.ok(configText.includes("is contested:"), configText);
  });
});

test("boot joins load, agent-file, and model warnings in that order", async () => {
  const fx = await fixture(2_147_483_647, {
    missing: { primary: { model: "deepseek/not-known", rail: "deepseek" } },
  });
  const path = join(fx.agentDir, CONFIG_FILE_NAME);
  const data = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...data, ttlMs: "bad" }));
  await withExtension(fx, async ({ runAll }) => {
    for (const form of ["", "config"]) {
      const lines = (await runAll(form)).join("\n").split("\n");
      const warnings = lines.filter((line) => line.startsWith("  warning:"));
      assert.equal(warnings.length, 3, lines.join("\n"));
      assert.ok(warnings[0].includes("ttlMs"), warnings.join("\n"));
      assert.ok(warnings[1].includes('configured agent "missing" has no file'), warnings.join("\n"));
      assert.ok(warnings[2].includes("agents.missing.primary.model: this pi does not know model"), warnings.join("\n"));
    }
  }, stubFetch, { modelRegistry: { find: () => undefined } });
});

test("a scoped occupant is listed unmanaged and its qualified warning reaches both reader surfaces", async () => {
  const fx = await fixture(2_147_483_647, {
    scoped: { primary: { model: "deepseek/deepseek-flash", rail: "deepseek" } },
  });
  const file = join(fx.agentDir, "agents", "scoped.md");
  const before = TEMPLATE("acme:scout", "deepseek/deepseek-flash");
  await writeFile(file, before);
  const listing = '  scoped.md — not an agent: its declared name "acme:scout" is scoped';
  await withExtension(fx, async ({ runAll }) => {
    for (const form of ["", "config"]) {
      const output = (await runAll(form)).join("\n");
      const warnings = output.split("\n").filter((line) => line.startsWith("  warning:") && line.includes(file));
      assert.equal(warnings.length, 1, output);
      assert.ok(warnings[0].includes('the file there is not an agent: its declared name "acme:scout" is scoped'), output);
      assert.equal(warnings[0].replace(file, "").includes("/agents"), false, warnings[0]);
      assert.ok(warnings[0].includes("give that file a name pi registers, or drop this route"), warnings[0]);
      if (form === "") {
        assert.ok(output.includes("unmanaged agent files"), output);
        assert.ok(output.split("\n").includes(listing), output);
        assert.ok(output.includes("[skipped (no file)]"), output);
      }
    }
    const applied = (await runAll("apply")).join("\n");
    assert.ok(applied.includes("[skipped (no file)]"), applied);
  });
  assert.equal(await readFile(file, "utf8"), before);
});

// Advice must be safe for the actual path: a parenthetical alone does not prevent
// a later create command from recommending an overwrite.
for (const occupant of ["none", "agent", "scoped", "unreadable"] as const) {
  test(`the ${occupant} occupant remedy reaches the report warning tail without destructive create advice`, async (t) => {
    if (occupant === "unreadable" && process.getuid?.() === 0) {
      t.skip("root can read a mode-000 file");
      return;
    }
    const primary = candidateOf({ model: "deepseek/deepseek-flash", rail: "deepseek" });
    const fx = await fixture(2_147_483_647, { New: { primary } });
    const dir = join(fx.agentDir, "agents");
    const file = join(dir, "New.md");
    if (occupant !== "none") {
      await writeFile(file, TEMPLATE(occupant === "scoped" ? "acme:scout" : "Architect", primary.model));
      if (occupant === "unreadable") {
        await chmod(file, 0);
        t.after(() => chmod(file, 0o600));
      }
    }
    const remedies = {
      none: "run the /agents command to create a new agent",
      agent: "name the route after that agent, or rename that file",
      scoped: "give that file a name pi registers, or drop this route",
      unreadable: "make that file readable, or remove it",
    };
    const notes = {
      none: "",
      agent: ' (the file there is agent "Architect")',
      scoped: ' (the file there is not an agent: its declared name "acme:scout" is scoped)',
      unreadable: " (the file there could not be read)",
    };
    const warnings = checkAgentFiles(
      { ...DEFAULT_CONFIG, agentDir: dir, agents: agentTable({ New: { primary, alternates: [] } }) },
      await readAgentDirectory(dir),
      () => {},
    );
    const expected = `${file}: configured agent "New" has no file${notes[occupant]} — ${remedies[occupant]}`;
    assert.deepEqual(warnings, [expected]);
    assert.equal(warnings[0].replace(file, "").includes("/agents"), occupant === "none", warnings[0]);
    assert.ok(warnings[0].includes(remedies[occupant]), warnings[0]);
    await withExtension(fx, async ({ runAll }) => {
      const report = (await runAll("")).join("\n");
      const replay = report.split("\n").filter((line) => line.startsWith("  warning:") && line.includes(file));
      assert.deepEqual(replay, [`  warning: ${expected}`], report);
      assert.equal(replay[0].replace(file, "").includes("/agents"), occupant === "none", replay[0]);
      assert.ok(replay[0].includes(remedies[occupant]), replay[0]);
      assert.ok(report.indexOf(replay[0]) > report.indexOf("New ->"), report);
    });
  });
}

// ---------------------------------------------------------------- #47 end-to-end override
async function sessionOverrideFixture(project: Record<string, unknown> = {}): Promise<Fixture> {
  const fx = await fixture(2_147_483_647, { planner: CONFIGURED_AGENTS.planner });
  await writeFile(join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), JSON.stringify({
    sessionSwitchAt: 70, margin: 30, sessionAlwaysSwitchAt: 90, ...project,
  }));
  return fx;
}

test("report and refresh are read-only even when override would switch", async () => {
  const fx = await sessionOverrideFixture();
  const before = await readFile(fx.plannerFile);
  await withExtension(fx, async ({ run }) => {
    for (const form of ["", "refresh"]) {
      const text = await run(form);
      // Assert read-only independently of selection, so a failing selection
      // cannot conceal a write from the report form.
      assert.deepEqual(await readFile(fx.plannerFile), before);
      assertNoProvenance(text);
      assert.ok(!text.includes("sessionAlwaysSwitchAt ="), text);
      assert.ok(text.includes("planner -> openai-codex/gpt-6-sol"), text);
      assert.ok(text.includes("sessionAlwaysSwitchAt"), text);
    }
    const text = await run("config");
    assert.ok(text.split("\n").includes("  sessionAlwaysSwitchAt = 90  [project]"), text);
    assert.deepEqual(await readFile(fx.plannerFile), before);
  }, () => stubFetch({ claudeSession: 90, codexSession: 85 }));
});

test("apply persists the override model while preserving thinking and body", async () => {
  const fx = await sessionOverrideFixture();
  const before = await readFile(fx.plannerFile, "utf8");
  assert.equal(before, TEMPLATE("planner", "claude-bridge/claude-opus-5-5"));
  await withExtension(fx, async ({ run }) => {
    const text = await run("apply");
    const after = await readFile(fx.plannerFile, "utf8");
    assert.notEqual(after, before, "apply must change the persisted agent definition");
    assert.equal(after, TEMPLATE("planner", "openai-codex/gpt-6-sol"));
    assert.match(after, /^model: "openai-codex\/gpt-6-sol"$/m);
    assert.match(after, /^thinking: high$/m);
    assert.match(after, /^Body\.$/m);
    assert.ok(text.includes("[applied]"), text);
    assert.ok(text.includes("sessionAlwaysSwitchAt"), text);
  }, () => stubFetch({ claudeSession: 90, codexSession: 85 }));
});

test("session_start existing evaluation writes override choice", async () => {
  const fx = await sessionOverrideFixture();
  await withExtension(fx, async ({ sessionStart }) => {
    await sessionStart("resume");
    assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
  }, () => stubFetch({ claudeSession: 95, codexSession: 89 }));
});

test("successive evaluations write margin switch return override switch and capped return", async () => {
  const fx = await sessionOverrideFixture();
  let readings = { claudeSession: 70, codexSession: 39 };
  const changingFetch = (async (...args: Parameters<typeof fetch>) => stubFetch(readings)(...args)) as typeof fetch;
  await withExtension(fx, async ({ run }) => {
    for (const [primary, alternate, model] of [
      [70, 39, "openai-codex/gpt-6-sol"],
      [70, 40, "claude-bridge/claude-opus-5-5"],
      [90, 85, "openai-codex/gpt-6-sol"],
      [100, 90, "claude-bridge/claude-opus-5-5"],
    ] as const) {
      readings = { claudeSession: primary, codexSession: alternate };
      const beforeRefresh = await readFile(fx.plannerFile);
      await run("refresh"); // force fresh stub readings, still never writes
      assert.deepEqual(await readFile(fx.plannerFile), beforeRefresh);
      const text = await run("apply");
      const after = await readFile(fx.plannerFile, "utf8");
      assert.ok(after.includes(`model: "${model}"`), `${primary}/${alternate}: ${after}`);
      assert.ok(text.includes("[applied]"), text);
    }
  }, () => changingFetch);
});

test("hold on unreadable primary leaves already-alternate bytes unchanged", async () => {
  const fx = await sessionOverrideFixture();
  const original = TEMPLATE("planner", "openai-codex/gpt-6-sol") + "\nPreserve these bytes.\n";
  await writeFile(fx.plannerFile, original);
  const before = await readFile(fx.plannerFile);
  const unreadable = (async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).includes("anthropic.com")) throw new Error("fixture unreadable primary");
    return stubFetch({ codexSession: 85 })(...args);
  }) as typeof fetch;
  await withExtension(fx, async ({ run, sessionStart }) => {
    const text = await run("apply");
    assert.ok(text.includes("[held]"), text);
    assert.ok(text.includes("planner -> (left as is)"), text);
    assert.deepEqual(await readFile(fx.plannerFile), before);
    await sessionStart("resume");
    assert.deepEqual(await readFile(fx.plannerFile), before);
  }, () => unreadable);
});

test("disabled ordering warning reaches report refresh and config without leaking provenance", async () => {
  const fx = await sessionOverrideFixture({ sessionSwitchAt: 95 });
  const globalPath = join(fx.agentDir, CONFIG_FILE_NAME);
  const data = JSON.parse(await readFile(globalPath, "utf8"));
  await writeFile(globalPath, JSON.stringify({ ...data, sessionSwitchAt: 70, sessionAlwaysSwitchAt: 90 }));
  // Project omits the override, inheriting the conflicting global 90.
  const projectPath = join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  await writeFile(projectPath, JSON.stringify({ sessionSwitchAt: 95, margin: 30 }));
  const before = await readFile(fx.plannerFile);
  await withExtension(fx, async ({ runAll }) => {
    for (const form of ["", "refresh", "config"]) {
      const text = (await runAll(form)).join("\n");
      assert.deepEqual(await readFile(fx.plannerFile), before);
      if (form !== "config") {
        assertNoProvenance(text);
        assert.ok(!text.includes("sessionAlwaysSwitchAt ="), text);
        assert.ok(text.includes("planner -> claude-bridge/claude-opus-5-5"), text);
      } else {
        assert.ok(text.split("\n").includes("  sessionAlwaysSwitchAt = disabled  [built-in]"), text);
        assert.ok(text.split("\n").includes("  sessionSwitchAt = 95  [project]"), text);
      }
      const warnings = text.split("\n").filter((line) => line.includes("warning:") && line.includes("sessionAlwaysSwitchAt"));
      assert.equal(warnings.length, 1, text);
      for (const word of ["sessionSwitchAt", "90", "95", globalPath, projectPath, "disabled"]) assert.ok(warnings[0].includes(word), warnings[0]);
    }
  }, () => stubFetch({ claudeSession: 95, codexSession: 85 }));
});

// ---------------------------------------------------------------- skill bindings (issue #52)

/** Every model the input tests' pi knows; anything else is unknown to it. */
const KNOWN_MODELS = registry({
  "claude-bridge": ["claude-opus-5-5"],
  "openai-codex": ["gpt-6-sol", "gpt-6-astra"],
  deepseek: ["deepseek-flash"],
});

const BINDINGS = { "implementation-plan": "planner", "code-review": "reviewer" };

const PLANNER_BOUND = 'Skill "implementation-plan" is bound to agent route "planner"';
const REVIEWER_BOUND = 'Skill "code-review" is bound to agent route "reviewer"';

/** The fixture with skill bindings in its global config. */
function skillFixture(skills: Record<string, unknown> = BINDINGS): Promise<Fixture> {
  return fixture(2_147_483_647, CONFIGURED_AGENTS, { skills });
}

/** An agent file with the frontmatter lines given, verbatim. */
function agentFile(...lines: string[]): string {
  return `---\n${lines.join("\n")}\n---\n\nBody.\n`;
}

/**
 * The quota network, refused: any request fails the call and is counted, so a
 * test can assert the input path made none. Its callers install the extension
 * and drive `input` without a `session_start`, so no startup evaluation or poll
 * ever reaches the network; `pollMs` is the timer max besides.
 */
function refusingFetch(): { factory: () => typeof fetch; count: () => number } {
  let count = 0;
  const refused = (async (url: string | URL) => {
    count++;
    throw new Error(`no quota request expected: ${String(url)}`);
  }) as unknown as typeof fetch;
  return { factory: () => refused, count: () => count };
}

/**
 * The quota network, counted but answered normally, so a test can let startup's
 * own evaluation succeed and then assert an invocation added no request.
 */
function countingStubFetch(overrides: Partial<RailReadings> = {}): { factory: () => typeof fetch; count: () => number } {
  let count = 0;
  const stub = stubFetch(overrides);
  const counting = (async (url: string | URL) => {
    count++;
    return stub(url);
  }) as unknown as typeof fetch;
  return { factory: () => counting, count: () => count };
}

/**
 * Install the extension over `session` with the known-model registry and a
 * refusing fetch, and assert afterwards that nothing reached the network.
 */
async function withSkills(
  fx: Fixture,
  session: FakeSession,
  body: (h: Harness) => Promise<void>,
  opts: { modelRegistry?: ModelRegistryLike; notifyThrows?: boolean; noRegistry?: boolean } = {},
): Promise<void> {
  const quota = refusingFetch();
  await withExtension(fx, body, quota.factory, {
    session,
    ...(opts.noRegistry ? {} : { modelRegistry: opts.modelRegistry ?? KNOWN_MODELS }),
    ...(opts.notifyThrows ? { notifyThrows: true } : {}),
  });
  assert.equal(quota.count(), 0, "a skill invocation must make no quota request");
}

/** The calls a successful switch makes: read, switch, ask for the level, read it back. */
function selectionCalls(model: string, level: ThinkingLevel): string[] {
  return ["getModel", "getThinkingLevel", `setModel:${model}`, `setThinkingLevel:${level}`, "getThinkingLevel"];
}

test("a bound skill selects the file's model, then its stated level, and leaves the input to pi", async () => {
  const fx = await skillFixture();
  const before = await readFile(fx.plannerFile, "utf8");
  const session = fakeSession();

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:implementation-plan write the plan for #52"), undefined);
    assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "high"));
    assert.deepEqual(notifications, [
      { text: "Skill implementation-plan → planner: claude-bridge/claude-opus-5-5, thinking high", level: "info" },
    ]);
  });

  assert.equal(session.model, "claude-bridge/claude-opus-5-5");
  assert.equal(session.thinking, "high");
  assert.equal(await readFile(fx.plannerFile, "utf8"), before, "invocation must not write the agent file");
});

// A skill name that shadows `Object.prototype` is admitted by the seam, so the
// invocation path has to look it up as an own key rather than reading the
// inherited value and finding a phantom binding.
test("a skill bound under __proto__ is invoked like any other binding", async () => {
  // An object literal `__proto__:` would set the prototype, so the own key is
  // built the way JSON does it.
  const skills = JSON.parse('{"__proto__":"planner"}') as Record<string, unknown>;
  const fx = await skillFixture(skills);
  const session = fakeSession();

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:__proto__"), undefined);
    assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "high"));
    assert.deepEqual(notifications, [
      { text: "Skill __proto__ → planner: claude-bridge/claude-opus-5-5, thinking high", level: "info" },
    ]);
  });
});

test("the bound agent is found by its declared name when the filename differs", async () => {
  const fx = await skillFixture();
  await rm(fx.plannerFile);
  await writeFile(
    join(dirname(fx.plannerFile), "plan-work.md"),
    agentFile("name: planner", 'model: "openai-codex/gpt-6-sol"', "thinking: low"),
  );
  const session = fakeSession();

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:implementation-plan"), undefined);
    assert.deepEqual(session.calls, selectionCalls("openai-codex/gpt-6-sol", "low"));
    assert.deepEqual(notifications, [
      { text: "Skill implementation-plan → planner: openai-codex/gpt-6-sol, thinking low", level: "info" },
    ]);
  });
});

test("each invocation reads the file as it stands", async () => {
  const fx = await skillFixture();
  const session = fakeSession();

  await withSkills(fx, session, async ({ input, notifications }) => {
    await input("/skill:implementation-plan first");
    await writeFile(fx.plannerFile, agentFile("name: planner", 'model: "openai-codex/gpt-6-sol"', "thinking: medium"));
    await input("/skill:implementation-plan second");

    assert.deepEqual(session.calls, [
      ...selectionCalls("claude-bridge/claude-opus-5-5", "high"),
      ...selectionCalls("openai-codex/gpt-6-sol", "medium"),
    ]);
    assert.deepEqual(
      notifications.map((n) => n.text),
      [
        "Skill implementation-plan → planner: claude-bridge/claude-opus-5-5, thinking high",
        "Skill implementation-plan → planner: openai-codex/gpt-6-sol, thinking medium",
      ],
    );
  });
  assert.equal(session.model, "openai-codex/gpt-6-sol");
  assert.equal(session.thinking, "medium");
});

test("a file left stale by a hold is used as it is, without a quota read", async () => {
  const fx = await skillFixture();
  // Not the planner's primary nor its alternate: only a hold or a hand edit
  // leaves the file here, and the file is still the authority.
  await writeFile(fx.plannerFile, agentFile("name: planner", 'model: "deepseek/deepseek-flash"', "thinking: high"));
  const session = fakeSession({ model: "openai-codex/gpt-6-sol" });

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:implementation-plan"), undefined);
    assert.deepEqual(session.calls, selectionCalls("deepseek/deepseek-flash", "high"));
    assert.deepEqual(notifications, [
      { text: "Skill implementation-plan → planner: deepseek/deepseek-flash, thinking high", level: "info" },
    ]);
  });
  assert.equal(session.model, "deepseek/deepseek-flash");
});

test("a file with no thinking line keeps the session's level across the switch", async () => {
  const fx = await skillFixture();
  await writeFile(fx.plannerFile, agentFile("name: planner", 'model: "claude-bridge/claude-opus-5-5"'));
  // pi's own switch would leave the session on `low`; the file asked for nothing.
  const session = fakeSession({ thinking: "medium", switchLevel: "low" });

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:implementation-plan"), undefined);
    assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "medium"));
    assert.deepEqual(notifications, [
      {
        text: "Skill implementation-plan → planner: claude-bridge/claude-opus-5-5, thinking retained (medium)",
        level: "info",
      },
    ]);
  });
  assert.equal(session.thinking, "medium");
});

test("an explicit thinking: off is applied, not taken for absent", async () => {
  const fx = await skillFixture();
  await writeFile(fx.plannerFile, agentFile("name: planner", 'model: "claude-bridge/claude-opus-5-5"', "thinking: off"));
  const session = fakeSession({ thinking: "high", switchLevel: "high" });

  await withSkills(fx, session, async ({ input, notifications }) => {
    await input("/skill:implementation-plan");
    assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "off"));
    assert.deepEqual(notifications, [
      { text: "Skill implementation-plan → planner: claude-bridge/claude-opus-5-5, thinking off", level: "info" },
    ]);
  });
  assert.equal(session.thinking, "off");
});

/**
 * The file's scalars are read by the conventions a spawn's file is read by: a
 * quoted value is unquoted, a trailing comment is not part of it, a commented
 * line states nothing, and an empty `thinking:` states nothing either — so it
 * keeps the session's level rather than being taken for a level.
 */
test("quoted, commented and empty frontmatter scalars are read the way the agent file is", async () => {
  const fx = await skillFixture();
  const reviewer = join(dirname(fx.plannerFile), "reviewer.md");
  const cases: Array<{ lines: string[]; asked: ThinkingLevel; notice: string }> = [
    {
      lines: ["name: reviewer", 'model: "openai-codex/gpt-6-astra" # pinned by hand', "thinking: 'low'"],
      asked: "low",
      notice: "thinking low",
    },
    {
      lines: ["name: reviewer", "model: openai-codex/gpt-6-astra", "# thinking: high"],
      asked: "medium",
      notice: "thinking retained (medium)",
    },
    {
      lines: ["name: reviewer", "model: 'openai-codex/gpt-6-astra'", 'thinking: ""'],
      asked: "medium",
      notice: "thinking retained (medium)",
    },
  ];
  for (const c of cases) {
    await writeFile(reviewer, agentFile(...c.lines));
    const session = fakeSession({ thinking: "medium", switchLevel: "minimal" });
    await withSkills(fx, session, async ({ input, notifications }) => {
      assert.equal(await input("/skill:code-review"), undefined);
      assert.deepEqual(session.calls, selectionCalls("openai-codex/gpt-6-astra", c.asked), c.lines.join(" | "));
      assert.deepEqual(notifications, [
        { text: `Skill code-review → reviewer: openai-codex/gpt-6-astra, ${c.notice}`, level: "info" },
      ]);
    });
  }
});

test("unbound skills and ordinary prompts change nothing and say nothing", async () => {
  const fx = await skillFixture();
  const session = fakeSession();
  const texts = [
    "/skill:pdf-tools extract a.pdf",
    "please run /skill:implementation-plan",
    "/skills:implementation-plan",
    "/skill:",
    "/skill: implementation-plan",
    '<skill name="implementation-plan">…</skill>',
    "",
  ];

  await withSkills(fx, session, async ({ input, notifications }) => {
    for (const text of texts) {
      assert.equal(await input(text), undefined, text);
      assert.deepEqual(session.calls, [], text);
      assert.deepEqual(notifications, [], text);
    }
  });
});

test("an install with no bindings is untouched by a skill invocation", async () => {
  const fx = await fixture();
  const session = fakeSession();

  await withSkills(fx, session, async ({ input, notifications }) => {
    for (const text of ["/skill:implementation-plan write it", "/skill:code-review", "/skill:planner"]) {
      assert.equal(await input(text), undefined, text);
    }
    assert.deepEqual(session.calls, []);
    assert.deepEqual(notifications, []);
  });
  assert.equal(session.model, "deepseek/deepseek-flash");
  assert.equal(session.thinking, "medium");
});

interface UnusableBinding {
  name: string;
  /** Bindings in force; defaults to `BINDINGS`. */
  skills?: Record<string, string>;
  /** Files written into the agents dir, by basename. */
  files?: Record<string, string>;
  unreadable?: string;
  noRegistry?: boolean;
  session?: Partial<FakeSession>;
  text?: string;
  warning: (dir: string) => string;
  calls: string[];
}

const READS = ["getModel", "getThinkingLevel"];
const ASTRA_REVIEWER = agentFile("name: reviewer", 'model: "openai-codex/gpt-6-astra"', "thinking: low");
const NOT_A_LEVEL = 'which is not one of "off", "minimal", "low", "medium", "high", "xhigh", "max"';

/** Every warning row of the plan's message contract, with the variants within a row. */
const UNUSABLE_BINDINGS: UnusableBinding[] = [
  {
    name: "a route the table does not configure",
    skills: { "code-review": "ghost" },
    warning: () => 'Skill "code-review" is bound to agent route "ghost", which is not configured',
    calls: [],
  },
  {
    name: "no file defines the route",
    warning: (dir) =>
      `${REVIEWER_BOUND}, but it has no file at ${dir}/reviewer.md — run the /agents command to create a new agent`,
    calls: [],
  },
  {
    name: "the route's file cannot be read",
    files: { "reviewer.md": ASTRA_REVIEWER },
    unreadable: "reviewer.md",
    warning: (dir) =>
      `${REVIEWER_BOUND}, but it has no file at ${dir}/reviewer.md (the file there could not be read) — make that file readable, or remove it`,
    calls: [],
  },
  {
    name: "the route's file is another agent",
    files: { "reviewer.md": agentFile("name: other", 'model: "openai-codex/gpt-6-astra"') },
    warning: (dir) =>
      `${REVIEWER_BOUND}, but it has no file at ${dir}/reviewer.md (the file there is agent "other") — name the route after that agent, or rename that file`,
    calls: [],
  },
  {
    name: "the route's file declares a scoped name",
    files: { "reviewer.md": agentFile("name: pkg:reviewer", 'model: "openai-codex/gpt-6-astra"') },
    warning: (dir) =>
      `${REVIEWER_BOUND}, but it has no file at ${dir}/reviewer.md (the file there is not an agent: its declared name "pkg:reviewer" is scoped) — give that file a name pi registers, or drop this route`,
    calls: [],
  },
  {
    name: "two files claim the route's name",
    files: { "a.md": ASTRA_REVIEWER, "b.md": ASTRA_REVIEWER },
    warning: () =>
      `${REVIEWER_BOUND}, but 2 agent files claim the name "reviewer" (a.md, b.md) and pi spawns whichever it loads last — give each file its own name`,
    calls: [],
  },
  ...[
    { variant: "no model line", file: agentFile("name: reviewer", "thinking: low") },
    { variant: "an empty quoted model", file: agentFile("name: reviewer", 'model: ""', "thinking: low") },
    { variant: "a bare model key", file: agentFile("name: reviewer", "model:", "thinking: low") },
    { variant: "a commented-out model", file: agentFile("name: reviewer", '# model: "openai-codex/gpt-6-astra"') },
    { variant: "no frontmatter", file: "Just a body, named by its stem.\n" },
  ].map(({ variant, file }) => ({
    name: `the file states no model: ${variant}`,
    files: { "reviewer.md": file },
    warning: () => `${REVIEWER_BOUND}, but its file states no model`,
    calls: [],
  })),
  ...[
    { variant: "two words", line: "thinking: very high", value: "very high" },
    { variant: "two words, quoted", line: 'thinking: "very high"', value: "very high" },
    { variant: "a level in the wrong case", line: "thinking: High", value: "High" },
  ].map(({ variant, line, value }) => ({
    name: `the file states a malformed level: ${variant}`,
    files: { "reviewer.md": agentFile("name: reviewer", 'model: "openai-codex/gpt-6-astra"', line) },
    warning: () => `${REVIEWER_BOUND}, but its file states thinking "${value}", ${NOT_A_LEVEL}`,
    calls: [],
  })),
  {
    name: "the registry does not know the model",
    files: { "reviewer.md": agentFile("name: reviewer", 'model: "openai-codex/gpt-9"', "thinking: low") },
    warning: () => `${REVIEWER_BOUND}, but this pi does not know model openai-codex/gpt-9 — a newer pi may`,
    calls: [],
  },
  {
    name: "the model has no provider",
    files: { "reviewer.md": agentFile("name: reviewer", "model: gpt-6-astra", "thinking: low") },
    warning: () => `${REVIEWER_BOUND}, but this pi does not know model gpt-6-astra — a newer pi may`,
    calls: [],
  },
  {
    name: "there is no registry at all",
    files: { "reviewer.md": ASTRA_REVIEWER },
    noRegistry: true,
    warning: () => `${REVIEWER_BOUND}, but this pi does not know model openai-codex/gpt-6-astra — a newer pi may`,
    calls: [],
  },
  {
    name: "setModel resolves false",
    files: { "reviewer.md": ASTRA_REVIEWER },
    session: { setModelResult: false },
    warning: () =>
      `${REVIEWER_BOUND}, but its model openai-codex/gpt-6-astra could not be selected (no authentication is configured for the provider)`,
    calls: [...READS, "setModel:openai-codex/gpt-6-astra"],
  },
  {
    name: "setModel rejects before moving, so there is nothing to restore",
    files: { "reviewer.md": ASTRA_REVIEWER },
    session: { setModelResult: new Error("No API key for openai-codex/gpt-6-astra") },
    warning: () =>
      `${REVIEWER_BOUND}, but its model openai-codex/gpt-6-astra could not be selected (No API key for openai-codex/gpt-6-astra)`,
    // The fault left the session where it was, so no put-back is attempted — only
    // the live probes of both halves that say so.
    calls: [...READS, "setModel:openai-codex/gpt-6-astra", "getModel", "getThinkingLevel"],
  },
];

for (const row of UNUSABLE_BINDINGS) {
  test(`each unusable binding warns once and leaves the session as it was: ${row.name}`, async (t) => {
    if (row.unreadable && process.getuid?.() === 0) {
      t.skip("root can read a mode-000 file");
      return;
    }
    const fx = await skillFixture(row.skills);
    const dir = join(fx.agentDir, "agents");
    // The planner's file is not the one under test; leave only what the row writes.
    for (const [name, text] of Object.entries(row.files ?? {})) await writeFile(join(dir, name), text);
    if (row.unreadable) {
      const file = join(dir, row.unreadable);
      await chmod(file, 0);
      t.after(() => chmod(file, 0o600));
    }
    const session = fakeSession(row.session);

    await withSkills(
      fx,
      session,
      async ({ input, notifications }) => {
        assert.equal(await input(row.text ?? "/skill:code-review review the diff"), undefined);
        assert.deepEqual(notifications, [{ text: row.warning(dir), level: "warning" }]);
        assert.deepEqual(session.calls, row.calls);
      },
      { noRegistry: row.noRegistry },
    );
    assert.equal(session.model, "deepseek/deepseek-flash", "the session's model must be as it was");
    assert.equal(session.thinking, "medium", "the session's level must be as it was");
  });
}

test("a throwing registry is reported and the skill still runs", async () => {
  const fx = await skillFixture();
  const session = fakeSession();
  const throwing: ModelRegistryLike = {
    find: () => {
      throw new Error("boom");
    },
  };

  await withSkills(
    fx,
    session,
    async ({ input, notifications }) => {
      assert.equal(await input("/skill:implementation-plan"), undefined);
      assert.deepEqual(notifications, [{ text: `${PLANNER_BOUND}, but applying it failed (boom)`, level: "warning" }]);
      assert.ok(!session.calls.some((c) => c.startsWith("set")), session.calls.join(", "));
    },
    { modelRegistry: throwing },
  );
  assert.equal(session.model, "deepseek/deepseek-flash");
  assert.equal(session.thinking, "medium");
});

test("a throwing notify does not stop the skill", async () => {
  const fx = await skillFixture();
  const session = fakeSession();

  await withSkills(
    fx,
    session,
    async ({ input, notifications }) => {
      // The success notice throws: the selection stands, and nothing is retried.
      assert.equal(await input("/skill:implementation-plan"), undefined);
      assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "high"));
      assert.equal(notifications.length, 1, notifications.map((n) => n.text).join("\n"));

      // A warning that throws is just as silent.
      session.calls.length = 0;
      notifications.length = 0;
      assert.equal(await input("/skill:code-review"), undefined);
      assert.deepEqual(session.calls, []);
      assert.equal(notifications.length, 1, notifications.map((n) => n.text).join("\n"));
    },
    { notifyThrows: true },
  );
  assert.equal(session.model, "claude-bridge/claude-opus-5-5");
  assert.equal(session.thinking, "high");
});

interface FileState {
  bytes: string;
  mtimeMs: number;
}

/** Every entry under `root`, recursively: directories by listing, files by bytes and mtime. */
async function snapshot(root: string): Promise<Record<string, FileState | string[]>> {
  const out: Record<string, FileState | string[]> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    out[dir] = entries.map((e) => e.name);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[path] = { bytes: await readFile(path, "utf8"), mtimeMs: (await stat(path)).mtimeMs };
    }
  };
  await walk(root);
  return out;
}

test("an invocation reads no quota and writes no agent file", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can write a read-only directory");
    return;
  }
  const fx = await skillFixture();
  const root = dirname(fx.agentDir);
  const agentsDir = join(fx.agentDir, "agents");
  const before = await snapshot(root);
  // A write, a lock or a temp file in the agents dir now fails outright.
  await chmod(agentsDir, 0o500);
  t.after(() => chmod(agentsDir, 0o700));
  const session = fakeSession();

  // `withSkills` refuses every fetch and asserts none was made.
  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:implementation-plan write the plan"), undefined);
    assert.equal(await input("/skill:code-review"), undefined);
    assert.deepEqual(
      notifications.map((n) => n.level),
      ["info", "warning"],
      notifications.map((n) => n.text).join("\n"),
    );
  });

  await chmod(agentsDir, 0o700);
  assert.deepEqual(await snapshot(root), before);
});

test("a bound invocation after startup evaluates no route, asks no quota and writes no file", async () => {
  const fx = await skillFixture();
  const session = fakeSession();
  // Claude healthy, so startup decides planner stays on its primary.
  const quota = countingStubFetch({ claudeSession: 10 });

  await withExtension(
    fx,
    async ({ sessionStart, input }) => {
      await sessionStart("startup");
      const afterStartup = quota.count();
      assert.ok(afterStartup > 0, "startup must evaluate the routes");

      // Diverge the file from that decision, so a re-evaluation during the
      // invocation would have to rewrite it to converge. A request count alone
      // cannot see a cached evaluation; a file it would revert can.
      await writeFile(
        fx.plannerFile,
        agentFile("name: planner", 'model: "openai-codex/gpt-6-sol"', "thinking: low"),
      );
      const divergent = await readFile(fx.plannerFile, "utf8");

      assert.equal(await input("/skill:implementation-plan plan it"), undefined);
      assert.equal(quota.count(), afterStartup, "a bound invocation must make no quota request");
      assert.equal(
        await readFile(fx.plannerFile, "utf8"),
        divergent,
        "a bound invocation must not evaluate the routes",
      );
      assert.deepEqual(session.calls, selectionCalls("openai-codex/gpt-6-sol", "low"));
    },
    quota.factory,
    { session, modelRegistry: KNOWN_MODELS },
  );
});

test("a second bound skill replaces the selection and nothing restores the first", async () => {
  const fx = await skillFixture();
  await writeFile(join(fx.agentDir, "agents", "reviewer.md"), ASTRA_REVIEWER);
  const session = fakeSession();

  await withSkills(fx, session, async ({ input, notifications }) => {
    await input("/skill:implementation-plan");
    await input("/skill:code-review look at it");
    assert.deepEqual(session.calls, [
      ...selectionCalls("claude-bridge/claude-opus-5-5", "high"),
      ...selectionCalls("openai-codex/gpt-6-astra", "low"),
    ]);
    assert.equal(session.model, "openai-codex/gpt-6-astra");
    assert.equal(session.thinking, "low");

    const settled = session.calls.length;
    await input("now carry on with the work");
    await input("/skill:pdf-tools extract a.pdf");
    assert.equal(session.calls.length, settled, `nothing may restore: ${session.calls.slice(settled).join(", ")}`);
    assert.equal(notifications.length, 2);
  });
  assert.equal(session.model, "openai-codex/gpt-6-astra");
  assert.equal(session.thinking, "low");
});

test("the registered handlers include input", async () => {
  const fx = await fixture();
  await withExtension(fx, async ({ events }) => {
    for (const event of ["session_start", "session_shutdown", "input"]) {
      assert.ok(events.includes(event), `missing ${event}: ${events.join(", ")}`);
    }
  });
});

/** Clamps anything above `medium` to `medium`, as pi does for a model that supports no more. */
const UP_TO_MEDIUM = (asked: ThinkingLevel): ThinkingLevel =>
  asked === "high" || asked === "xhigh" || asked === "max" ? "medium" : asked;

test("a level pi clamps is reported as the level actually running: a stated level", async () => {
  const fx = await skillFixture();
  await writeFile(fx.plannerFile, agentFile("name: planner", 'model: "claude-bridge/claude-opus-5-5"', "thinking: xhigh"));
  const session = fakeSession({ thinking: "low", switchLevel: "minimal", clamp: UP_TO_MEDIUM });

  await withSkills(fx, session, async ({ input, notifications }) => {
    await input("/skill:implementation-plan");
    // The file's level is what is asked for; pi, not the extension, clamps it.
    assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "xhigh"));
    assert.deepEqual(notifications, [
      {
        text: "Skill implementation-plan → planner: claude-bridge/claude-opus-5-5, thinking xhigh, clamped to medium by pi",
        level: "info",
      },
    ]);
  });
  assert.equal(session.thinking, "medium");
});

test("a level pi clamps is reported as the level actually running: a retained level", async () => {
  const fx = await skillFixture();
  await writeFile(fx.plannerFile, agentFile("name: planner", 'model: "claude-bridge/claude-opus-5-5"'));
  const session = fakeSession({ thinking: "high", switchLevel: "minimal", clamp: UP_TO_MEDIUM });

  await withSkills(fx, session, async ({ input, notifications }) => {
    await input("/skill:implementation-plan");
    assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "high"));
    assert.deepEqual(notifications, [
      {
        text: "Skill implementation-plan → planner: claude-bridge/claude-opus-5-5, thinking retained (medium, clamped from high)",
        level: "info",
      },
    ]);
  });
  assert.equal(session.thinking, "medium");
});

const NOT_RESTORED = " and the previous session selection could not be restored";

/**
 * Faults after the session has already moved. pi assigns the model (and a
 * level) before its later steps can throw, so "nothing changed" would be false:
 * the previous selection is put back, and the warning says whether that worked.
 */
const APPLY_FAULTS: Array<{
  name: string;
  session: Partial<FakeSession>;
  calls: string[];
  restored: boolean;
  after: { model: string; thinking: ThinkingLevel };
}> = [
  {
    name: "setModel moves and then fails, and the restore succeeds",
    session: { setModelResult: { moved: true, error: new Error("disk failure") } },
    calls: [
      ...READS,
      "setModel:openai-codex/gpt-6-astra",
      "getModel",
      "getThinkingLevel",
      "setModel:deepseek/deepseek-flash",
      "setThinkingLevel:medium",
    ],
    restored: true,
    after: { model: "deepseek/deepseek-flash", thinking: "medium" },
  },
  {
    name: "setModel moves and then fails, and the restore fails too",
    session: {
      setModelResult: { moved: true, error: new Error("disk failure") },
      laterSetModelResult: new Error("still failing"),
    },
    calls: [
      ...READS,
      "setModel:openai-codex/gpt-6-astra",
      "getModel",
      "getThinkingLevel",
      "setModel:deepseek/deepseek-flash",
    ],
    restored: false,
    after: { model: "openai-codex/gpt-6-astra", thinking: "minimal" },
  },
  {
    // The put-back's own `setModel` resolves `false` (pi's no-auth answer), which
    // `restore` must treat as a failed put-back rather than a silent success — and
    // it must not go on to write the level either, so the call list is exact.
    name: "setModel moves and then fails, and the put-back finds no auth",
    session: {
      setModelResult: { moved: true, error: new Error("disk failure") },
      laterSetModelResult: false,
    },
    calls: [
      ...READS,
      "setModel:openai-codex/gpt-6-astra",
      "getModel",
      "getThinkingLevel",
      "setModel:deepseek/deepseek-flash",
    ],
    restored: false,
    after: { model: "openai-codex/gpt-6-astra", thinking: "minimal" },
  },
  {
    name: "setThinkingLevel applies and then fails, and the restore succeeds",
    session: { thinkingThrows: new Error("disk failure") },
    calls: [
      ...READS,
      "setModel:openai-codex/gpt-6-astra",
      "setThinkingLevel:low",
      "getModel",
      "getThinkingLevel",
      "setModel:deepseek/deepseek-flash",
      "setThinkingLevel:medium",
    ],
    restored: true,
    after: { model: "deepseek/deepseek-flash", thinking: "medium" },
  },
  {
    name: "setThinkingLevel applies and then fails, and the restore fails too",
    session: { thinkingThrows: new Error("disk failure"), laterSetModelResult: new Error("still failing") },
    calls: [...READS, "setModel:openai-codex/gpt-6-astra", "setThinkingLevel:low", "getModel", "getThinkingLevel", "setModel:deepseek/deepseek-flash"],
    restored: false,
    after: { model: "openai-codex/gpt-6-astra", thinking: "low" },
  },
];

for (const fault of APPLY_FAULTS) {
  test(`a fault while applying warns truthfully and puts the previous selection back: ${fault.name}`, async () => {
    const fx = await skillFixture();
    await writeFile(join(fx.agentDir, "agents", "reviewer.md"), ASTRA_REVIEWER);
    const session = fakeSession(fault.session);

    await withSkills(fx, session, async ({ input, notifications }) => {
      assert.equal(await input("/skill:code-review"), undefined);
      const selected = `${REVIEWER_BOUND}, but its model openai-codex/gpt-6-astra could not be selected (disk failure)`;
      assert.deepEqual(notifications, [
        { text: fault.restored ? selected : `${selected}${NOT_RESTORED}`, level: "warning" },
      ]);
      assert.deepEqual(session.calls, fault.calls);
    });
    // A failed restore is reported, not hidden: the session is left where pi left it.
    assert.equal(session.model, fault.after.model);
    assert.equal(session.thinking, fault.after.thinking);
  });
}

test("a fault that moved only the level puts the level back without re-selecting the model", async () => {
  const fx = await skillFixture();
  await writeFile(join(fx.agentDir, "agents", "reviewer.md"), ASTRA_REVIEWER);
  // The session is already on the file's model object, so `setModel` re-selects
  // it: pi resets the level by its own rule and a later step throws. The model
  // did not move — by identity, and it is the same object the registry returns —
  // but the level did, so the put-back must write the level and only the level.
  const session = fakeSession({
    model: "openai-codex/gpt-6-astra",
    thinking: "high",
    switchLevel: "minimal",
    setModelResult: { moved: true, error: new Error("disk failure") },
  });

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:code-review"), undefined);
    assert.deepEqual(notifications, [
      {
        text: `${REVIEWER_BOUND}, but its model openai-codex/gpt-6-astra could not be selected (disk failure)`,
        level: "warning",
      },
    ]);
    assert.deepEqual(session.calls, [
      "getModel",
      "getThinkingLevel",
      "setModel:openai-codex/gpt-6-astra",
      "getModel",
      "getThinkingLevel",
      "setThinkingLevel:high",
    ]);
  });
  // A same-model re-selection is not "untouched": the level was reset and put
  // back, and the session's model is where it started.
  assert.equal(session.model, "openai-codex/gpt-6-astra");
  assert.equal(session.thinking, "high");
});

test("a fault applying an explicitly stated level puts the level back without re-selecting the model", async () => {
  const fx = await skillFixture();
  await writeFile(join(fx.agentDir, "agents", "reviewer.md"), ASTRA_REVIEWER);
  // The file states level `low`, so the level is applied explicitly rather than
  // only re-derived by `setModel`. The session already holds the file's model
  // object, so `setModel` succeeds without moving the model, then the explicit
  // level write applies and throws: the model half did not move and the level
  // half did, so the put-back must write the level and only the level.
  const session = fakeSession({
    model: "openai-codex/gpt-6-astra",
    thinking: "high",
    switchLevel: "minimal",
    thinkingThrows: new Error("disk failure"),
  });

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:code-review"), undefined);
    assert.deepEqual(notifications, [
      {
        text: `${REVIEWER_BOUND}, but its model openai-codex/gpt-6-astra could not be selected (disk failure)`,
        level: "warning",
      },
    ]);
    assert.deepEqual(session.calls, [
      "getModel",
      "getThinkingLevel",
      "setModel:openai-codex/gpt-6-astra",
      "setThinkingLevel:low",
      "getModel",
      "getThinkingLevel",
      "setThinkingLevel:high",
    ]);
  });
  // One `setModel` call above proves the unchanged model was not re-selected;
  // the level was put back and the session's model is where it started.
  assert.equal(session.model, "openai-codex/gpt-6-astra");
  assert.equal(session.thinking, "high");
});

test("a session with no previous model cannot be restored when the application selected one", async () => {
  const fx = await skillFixture();
  await writeFile(join(fx.agentDir, "agents", "reviewer.md"), ASTRA_REVIEWER);
  const session = fakeSession({
    model: undefined,
    thinking: "high",
    setModelResult: { moved: true, error: new Error("disk failure") },
  });

  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:code-review"), undefined);
    assert.deepEqual(notifications, [
      {
        text: `${REVIEWER_BOUND}, but its model openai-codex/gpt-6-astra could not be selected (disk failure)${NOT_RESTORED}`,
        level: "warning",
      },
    ]);
    // The movement check reads the level too; with no previous model there is
    // nothing to put back, so the put-back reports failure without writing.
    assert.deepEqual(session.calls, [
      "getModel",
      "getThinkingLevel",
      "setModel:openai-codex/gpt-6-astra",
      "getModel",
      "getThinkingLevel",
    ]);
  });
  // There is no way to unset a model, so the session is left on the one the fault
  // selected — the warning says so rather than claiming a restore that never was.
  assert.equal(session.model, "openai-codex/gpt-6-astra");
});

test("a binding edit is not seen until the extension is reloaded", async () => {
  const fx = await fixture();
  const globalConfig = join(fx.agentDir, CONFIG_FILE_NAME);
  const first = fakeSession();

  await withSkills(fx, first, async ({ input, notifications }) => {
    assert.equal(await input("/skill:implementation-plan"), undefined);
    const config: unknown = JSON.parse(await readFile(globalConfig, "utf8"));
    assert.ok(typeof config === "object" && config !== null);
    await writeFile(globalConfig, JSON.stringify({ ...config, skills: BINDINGS }));
    assert.equal(await input("/skill:implementation-plan"), undefined);
    assert.deepEqual(first.calls, []);
    assert.deepEqual(notifications, []);
  });

  const reloaded = fakeSession();
  await withSkills(fx, reloaded, async ({ input, notifications }) => {
    await input("/skill:implementation-plan");
    assert.deepEqual(reloaded.calls, selectionCalls("claude-bridge/claude-opus-5-5", "high"));
    assert.deepEqual(notifications.map((n) => n.level), ["info"]);
  });
});

test("the skill name is split exactly as pi splits it", async () => {
  assert.equal(explicitSkill("/skill:"), undefined);
  assert.equal(explicitSkill("/skill: x"), undefined);
  assert.equal(explicitSkill("/skills:x"), undefined);
  assert.equal(explicitSkill("\n/skill:x"), undefined);
  assert.equal(explicitSkill(" /skill:x"), undefined);
  assert.equal(explicitSkill("/skill:x"), "x");
  assert.equal(explicitSkill("/skill:x  two spaces"), "x");
  assert.equal(explicitSkill("/skill:a\tb x"), "a\tb");
  assert.equal(explicitSkill("/skill:a\tb "), "a\tb");
  assert.equal(explicitSkill("/skill:x\nnext line"), "x\nnext");

  // `pdf tools` is rejected by the config (it could never be invoked), so the
  // `/skill:pdf tools` below names `pdf`, which nothing binds.
  const fx = await skillFixture({ "a\tb": "planner", rôle: "planner", "pdf tools": "planner" });
  const notice = (skill: string) =>
    `Skill ${skill} → planner: claude-bridge/claude-opus-5-5, thinking high`;

  for (const [text, skill] of [
    ["/skill:a\tb x", "a\tb"],
    ["/skill:rôle x", "rôle"],
    ["/skill:a\tb ", "a\tb"],
  ] as const) {
    const session = fakeSession();
    await withSkills(fx, session, async ({ input, notifications }) => {
      assert.equal(await input(text), undefined);
      assert.deepEqual(session.calls, selectionCalls("claude-bridge/claude-opus-5-5", "high"), JSON.stringify(text));
      assert.deepEqual(notifications, [{ text: notice(skill), level: "info" }]);
    });
  }

  const session = fakeSession();
  await withSkills(fx, session, async ({ input, notifications }) => {
    assert.equal(await input("/skill:pdf tools"), undefined);
    assert.deepEqual(session.calls, []);
    assert.deepEqual(notifications, []);
  });
});

// ---------------------------------------------------------------- the rail gauge

/** Routes naming every capped rail plus the metered one, so the gauge's whole surface is covered. */
const ALL_RAILS_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "deepseek/deepseek-flash", rail: "deepseek" }],
  },
  gemini: { primary: { model: "antigravity-gemini/gemini-4-pro", rail: "antigravity-gemini" } },
  third: { primary: { model: "antigravity-3p/claude-and-gpt", rail: "antigravity-3p" } },
  argon: { primary: { model: "antigravity-claude/argon", rail: "antigravity-argon" } },
  coder: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } },
};

/**
 * The gauge line the default stub produces for `ALL_RAILS_AGENTS`.
 *
 * That table names `deepseek` as well, so the absence of the metered rail is part
 * of this expected text rather than a separate assertion about the constant.
 */
const ALL_RAILS_GAUGE = "claude <90>/0 │ ag-3p 30/0 │ ag-gemini 20/0 │ codex 10/0 │ ag-argon –/0";

test("the rail gauge is drawn at session start, most-used first", async () => {
  const fx = await fixture(MAX_POLL_MS, ALL_RAILS_AGENTS);

  await withExtension(fx, async ({ statuses, sessionStart }) => {
    await sessionStart("startup");

    assert.equal(gaugeStatuses(statuses).at(-1)?.text, ALL_RAILS_GAUGE, JSON.stringify(statuses));
  });
});

test("a tight codex session shows its reset duration", async () => {
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS);

  await withExtension(
    fx,
    async ({ statuses, sessionStart }) => {
      await sessionStart("startup");
      // The stub reports `reset_after_seconds: 3600` relative to the read, so the
      // duration is pinned without pinning the instant it was read at.
      assert.equal(gaugeStatuses(statuses).at(-1)?.text, "claude <90>/0 │ codex <80↻1h>/0");
    },
    () => stubFetch({ codexSession: 80 }),
  );
});

test("the warning footer and the gauge are both visible at once", async () => {
  const fx = await fixture(MAX_POLL_MS, TWO_UNKNOWN_AGENTS);

  await withExtension(
    fx,
    async ({ statuses, sessionStart }) => {
      await sessionStart("startup");
      const byKey = (key: string) => statuses.filter((status) => status.key === key).at(-1);
      assert.equal(
        byKey("quota-dispatch")?.text,
        "quota-dispatcher: a configured model is unknown to this pi.",
        JSON.stringify(statuses),
      );
      // The unknown primary is held, but its rail is still named by the route.
      assert.equal(typeof byKey(GAUGE_KEY)?.text, "string", JSON.stringify(statuses));
    },
    stubFetch,
    { modelRegistry: TWO_UNKNOWN_REGISTRY },
  );
});

test("railGauge: false clears the gauge and keeps it clear, and shows in provenance", async () => {
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS);
  await writeFile(
    join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    JSON.stringify({ margin: 10, railGauge: false }),
    "utf8",
  );

  await withExtension(fx, async ({ run, statuses, sessionStart }) => {
    await sessionStart("startup");
    await run("refresh");

    const drawn = gaugeStatuses(statuses);
    assert.ok(drawn.length > 0, "the gauge key is written, so the clear is observable");
    assert.deepEqual(drawn.filter((status) => status.text !== undefined), [], JSON.stringify(drawn));

    const config = await run("config");
    assert.ok(config.split("\n").includes("  railGauge = false  [project]"), config);
  });
});

test("every completed evaluation redraws the gauge", async () => {
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS);

  await withExtension(fx, async ({ run, statuses, sessionStart }) => {
    await sessionStart("startup");
    const drawnCount = () => gaugeStatuses(statuses).filter((status) => status.text !== undefined).length;

    for (const form of ["", "refresh", "apply"]) {
      const before = drawnCount();
      await run(form);
      assert.equal(drawnCount(), before + 1, `${form || "(plain)"} must redraw exactly once`);
    }
  });
});

test("generate redraws the gauge from the new configuration, and never blanks it in between", async () => {
  const fx = await generateFixture(GENERATED_LAYER);
  await layerNamesFixtureCredential(fx, GENERATED_LAYER);

  await withExtension(fx, async ({ run, sessionStart, statuses }) => {
    const drawn = () => gaugeStatuses(statuses).filter((status) => status.text !== undefined);
    // A line for the swap to replace: without one, a clear in between has nothing
    // to blank and the assertion below would pass for the wrong reason.
    await sessionStart("startup");
    assert.equal(drawn().length, 1, JSON.stringify(statuses));
    const mark = statuses.length;

    await run("generate");

    // One draw for each layer: the start's, and the new runtime's own pass.
    assert.equal(drawn().length, 2, JSON.stringify(statuses));
    // The generated layer routes on codex and claude, so both are named.
    assert.equal(drawn().at(-1)?.text, "claude <90>/0 │ codex 10/0");
    // This layer can draw, so the swap owes it no clear: a blank status here is the
    // footer going empty until the new runtime's first pass publishes.
    assert.deepEqual(
      gaugeStatuses(statuses.slice(mark)),
      [{ key: GAUGE_KEY, text: "claude <90>/0 │ codex 10/0" }],
      JSON.stringify(statuses.slice(mark)),
    );
  });
});

test("drawing the gauge costs no vendor request", async () => {
  const counted = () => {
    const inner = stubFetch();
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls++;
      return inner(url, init);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  };

  // Two separate installs, so the shared readings file a first run warms cannot
  // make the second one look cheaper.
  for (const railGauge of [true, false]) {
    const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS);
    await writeFile(
      join(fx.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
      JSON.stringify({ margin: 10, railGauge }),
      "utf8",
    );
    const counter = counted();
    await withExtension(
      fx,
      async ({ statuses, sessionStart }) => {
        await sessionStart("startup");
        assert.equal(gaugeStatuses(statuses).length, 1, JSON.stringify(statuses));
      },
      () => counter.fetchImpl,
    );
    // Both installs draw through the same pass: claude, codex and the one
    // Antigravity summary, whether or not the line is rendered.
    assert.equal(counter.calls(), 3, `railGauge: ${railGauge}`);
  }
});

test("an unconfigured install clears the gauge", async () => {
  const fx = await fixture(MAX_POLL_MS, {});

  await withExtension(fx, async ({ statuses, sessionStart }) => {
    await sessionStart("startup");
    assert.deepEqual(gaugeStatuses(statuses), [{ key: GAUGE_KEY, text: undefined }], JSON.stringify(statuses));
  });
});

test("a poll tick redraws the gauge, and shutdown clears it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fx = await fixture(50, CONFIGURED_AGENTS);

  await withExtension(fx, async ({ statuses, sessionStart, shutdown }) => {
    await sessionStart("startup");
    const drawnCount = () => gaugeStatuses(statuses).filter((status) => status.text !== undefined).length;
    const before = drawnCount();
    assert.equal(before, 1, JSON.stringify(statuses));

    t.mock.timers.tick(50);
    // The draw is the last step of the tick's evaluation, so observing it is the
    // deterministic signal that the tick's work has finished.
    await waitFor(() => drawnCount() > before, "the tick's gauge draw");

    await shutdown();
    assert.equal(gaugeStatuses(statuses).at(-1)?.text, undefined, JSON.stringify(statuses));
  });
});

// A `report` runs outside the evaluation fence, so it can finish after a
// generation has already published and evaluated a different configuration. The
// footer is the one piece of shared state such a pass could move, and the owner
// token is what stops it.
for (const [label, layer, expected] of [
  ["a layer routing only on codex", { agents: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } } } }, "codex 10/0"],
  ["a layer that turns the gauge off", { railGauge: false, agents: GENERATED_LAYER.agents }, undefined],
  ["a layer that empties the table", { agents: {} }, undefined],
] as const) {
  test(`a superseded refresh cannot repaint the gauge: ${label}`, async () => {
    const fx = await generateFixture(layer as unknown, undefined, MAX_POLL_MS);
    const gate = gatedFetch(stubFetch(), (url) => url.includes("anthropic.com"));

    await withExtension(
      fx,
      async ({ invoke, run, statuses, sessionStart }) => {
        await sessionStart("startup");
        assert.equal(gaugeStatuses(statuses).at(-1)?.text, "claude <90>/0 │ codex 10/0");

        // Hold the old runtime's forced Claude read in flight, so it is
        // guaranteed to finish after the generation below.
        gate.arm();
        const refreshing = invoke("refresh");
        await gate.entered;

        await run("generate");
        const mark = statuses.length;

        gate.release();
        await refreshing;

        assert.deepEqual(
          statuses.slice(mark).filter((status) => status.key === GAUGE_KEY),
          [],
          `a superseded pass must not touch the footer: ${JSON.stringify(statuses.slice(mark))}`,
        );
        assert.equal(gaugeStatuses(statuses).at(-1)?.text, expected, JSON.stringify(statuses));
      },
      () => gate.fetch,
    );
  });
}

test("a gauge that cannot be drawn does not veto the pass, and is reported", async (t) => {
  const errors = t.mock.method(console, "error");
  let failing = true;
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS);

  await withExtension(
    fx,
    async ({ run, statuses, sessionStart }) => {
      await sessionStart("startup");

      // The pass still ran: claude's session is tight in the stub, so the file
      // was written.
      assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
      assert.ok(
        errors.mock.calls.some((call) =>
          String(call.arguments[0]).includes("the rail gauge could not be drawn (status sink failed)"),
        ),
        JSON.stringify(errors.mock.calls),
      );

      const text = await run("");
      assert.ok(text.includes("claude: 5h 90%"), text);
      assert.ok(
        text.includes("  warning: quota-dispatcher: the rail gauge could not be drawn (status sink failed)"),
        text,
      );

      // A later draw that works clears the fault.
      failing = false;
      const healed = await run("");
      assert.ok(!healed.includes("the rail gauge could not be drawn"), healed);
      assert.equal(typeof gaugeStatuses(statuses).at(-1)?.text, "string", JSON.stringify(statuses));
    },
    stubFetch,
    { statusThrows: (key) => failing && key === GAUGE_KEY },
  );
});

test("a pass still in flight at shutdown draws nothing, and writes anyway", async (t) => {
  const errors = t.mock.method(console, "error");
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS, { ttlMs: 1 });
  const gate = gatedFetch(stubFetch(), (url) => url.includes("anthropic.com"));

  await withExtension(
    fx,
    async ({ statuses, sessionStart, shutdown }) => {
      await sessionStart("startup");

      // Back to the primary, so the pass below is the one that has to write: the
      // first start already switched it, and an assertion that only held because
      // of that earlier write would say nothing about this pass.
      await writeFile(fx.plannerFile, TEMPLATE("planner", "claude-bridge/claude-opus-5-5"), "utf8");

      gate.arm();
      const resumed = sessionStart("resume");
      await gate.entered;
      // In flight, and nothing written yet: the file is still the primary.
      assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "claude-bridge\/claude-opus-5-5"$/m);

      await shutdown();
      const mark = statuses.length;

      gate.release();
      // Session start awaits its evaluation, observer included, so awaiting the
      // handler is the deterministic signal that the pass is done.
      await resumed;

      assert.deepEqual(
        statuses.slice(mark),
        [],
        `a pass across a shutdown must not draw: ${JSON.stringify(statuses.slice(mark))}`,
      );
      // The policy still ran: the released pass wrote the switched model.
      assert.match(await readFile(fx.plannerFile, "utf8"), /^model: "openai-codex\/gpt-6-sol"$/m);
      // No stale getter was touched: the publisher read `footer` and found none.
      assert.ok(
        !errors.mock.calls.some((call) => String(call.arguments[0]).includes("could not be drawn")),
        JSON.stringify(errors.mock.calls),
      );
    },
    () => gate.fetch,
  );
});

// ---------------------------------------------------------------- gauge clears and pass order

/** The fault text the display's handler logs, as the report's warning tail words it. */
const DRAW_FAILED = "the rail gauge could not be drawn (status sink failed)";

test("a gauge sink that throws cannot veto an unconfigured session start, and is reported", async (t) => {
  const errors = t.mock.method(console, "error");
  const fx = await fixture(MAX_POLL_MS, {});

  await withExtension(
    fx,
    async ({ run, sessionStart, statuses }) => {
      // The clear at an unconfigured start goes through the display's handler, so
      // a footer that refuses the key is a fault rather than a rejection.
      await sessionStart("startup");

      assert.equal(
        warningStatuses(statuses).at(-1)?.text,
        "quota-dispatcher: no agents configured",
        JSON.stringify(statuses),
      );
      assert.ok(
        errors.mock.calls.some((call) => String(call.arguments[0]).includes(DRAW_FAILED)),
        JSON.stringify(errors.mock.calls),
      );

      const text = await run("");
      assert.ok(text.includes(`  warning: quota-dispatcher: ${DRAW_FAILED}`), text);
    },
    stubFetch,
    { statusThrows: (key) => key === GAUGE_KEY },
  );
});

test("a gauge sink that throws cannot abort a generation that empties the table", async (t) => {
  const errors = t.mock.method(console, "error");
  const fx = await generateFixture({ agents: {} });

  await withExtension(
    fx,
    async ({ run, statuses }) => {
      const text = await run("generate");

      assert.ok(text.startsWith(`[generated] ${fx.globalPath}`), text);
      assert.equal(
        warningStatuses(statuses).at(-1)?.text,
        "quota-dispatcher: no agents configured",
        JSON.stringify(statuses),
      );
      assert.ok(
        errors.mock.calls.some((call) => String(call.arguments[0]).includes(DRAW_FAILED)),
        JSON.stringify(errors.mock.calls),
      );
    },
    stubFetch,
    { statusThrows: (key) => key === GAUGE_KEY },
  );
});

test("a gauge sink that throws at shutdown still lets the context go, and draws nothing after", async (t) => {
  const errors = t.mock.method(console, "error");
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS, { ttlMs: 1 });
  const gate = gatedFetch(stubFetch(), (url) => url.includes("anthropic.com"));

  await withExtension(
    fx,
    async ({ statuses, sessionStart, shutdown }) => {
      await sessionStart("startup");

      gate.arm();
      const resumed = sessionStart("resume");
      await gate.entered;

      // The clear the handler runs at shutdown is the one that throws here.
      await shutdown();
      const mark = statuses.length;
      assert.ok(
        errors.mock.calls.some((call) => String(call.arguments[0]).includes(DRAW_FAILED)),
        JSON.stringify(errors.mock.calls),
      );

      gate.release();
      await resumed;
      assert.deepEqual(
        statuses.slice(mark),
        [],
        `a pass across a shutdown must not draw: ${JSON.stringify(statuses.slice(mark))}`,
      );
    },
    () => gate.fetch,
    { statusThrows: (key) => key === GAUGE_KEY },
  );
});

/**
 * A shutdown refuses the *warning* sink, not the gauge's: the gauge's own key
 * cannot throw any more (every clear goes through the display's handler), so this
 * is the only sink that can still interrupt the two clears the handler makes.
 *
 * It pins both halves of the handler's order. The gauge is cleared in a `finally`,
 * so the rejection a refusing warning sink causes must not cost the clear. And
 * `footer` is dropped before either call, so the pass released afterwards finds no
 * context at all — it neither writes a status nor reports a fault against the dead
 * one that is still in the command's hands.
 */
test("a warning sink that throws at shutdown still clears the gauge, and the released pass finds no footer", async (t) => {
  const errors = t.mock.method(console, "error");
  const fx = await fixture(MAX_POLL_MS, CONFIGURED_AGENTS, { ttlMs: 1 });
  const gate = gatedFetch(stubFetch(), (url) => url.includes("anthropic.com"));
  // Armed only for the shutdown: a start-time warning write would otherwise
  // refuse its key and fail the session start this test needs.
  let refusing = false;

  await withExtension(
    fx,
    async ({ statuses, sessionStart, shutdown }) => {
      await sessionStart("startup");
      assert.equal(gaugeStatuses(statuses).at(-1)?.text, "claude <90>/0 │ codex 10/0");

      gate.arm();
      const resumed = sessionStart("resume");
      await gate.entered;

      refusing = true;
      await assert.rejects(shutdown(), /status sink failed/);

      // The warning write threw, and the gauge was still cleared.
      assert.equal(
        gaugeStatuses(statuses).at(-1)?.text,
        undefined,
        `a refusing warning sink must not leave the gauge on screen: ${JSON.stringify(statuses)}`,
      );

      const mark = statuses.length;
      const faults = errors.mock.calls.length;
      gate.release();
      await resumed;

      assert.deepEqual(
        statuses.slice(mark),
        [],
        `a pass across a shutdown must not draw: ${JSON.stringify(statuses.slice(mark))}`,
      );
      assert.equal(
        errors.mock.calls.length,
        faults,
        `the released pass must find no footer at all, not a dead one: ${JSON.stringify(errors.mock.calls.slice(faults))}`,
      );
    },
    () => gate.fetch,
    { statusThrows: (key) => refusing && key === WARNING_KEY },
  );
});

/** Two agents on one route, so one pass has two writes to make. */
const TWO_SWITCHING_AGENTS = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  },
  reviewer: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-astra", rail: "codex" }],
  },
};

/**
 * The same-runtime race the pass number exists for. Owner tokens separate
 * configurations; they do not order two passes of one runtime, and a pass that
 * read earlier can finish later.
 *
 * The park is a foreign lock on one of the two files the pass has to write, so
 * the pass is provably *inside* its decisions — its other write is on disk —
 * while the forced refresh reads, fails and publishes. Releasing the lock lets
 * the older pass finish; its numbers must not replace the `?` that failure
 * earned.
 */
test("a pass that read earlier cannot publish over a later failed read", async () => {
  const fx = await fixture(MAX_POLL_MS, TWO_SWITCHING_AGENTS);
  const reviewerFile = join(dirname(fx.plannerFile), "reviewer.md");
  await writeFile(reviewerFile, TEMPLATE("reviewer", "claude-bridge/claude-opus-5-5"), "utf8");
  // The lock is keyed off the *resolved* file, and a temp dir is reached through
  // a link on macOS: a path built from the fixture's own name would name a lock
  // nothing waits on.
  const lockPath = join(await realpath(dirname(fx.plannerFile)), ".reviewer.md.lock");

  // A stub whose claude read can be made to fail after the older pass has read.
  let claudeFails = false;
  const fetchImpl = (async (url: string | URL) => {
    if (claudeFails && String(url).includes("anthropic.com")) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return stubFetch()(url);
  }) as unknown as typeof fetch;

  await withExtension(
    fx,
    async ({ invoke, statuses, sessionStart }) => {
      await sessionStart("startup");
      assert.equal(gaugeStatuses(statuses).at(-1)?.text, "claude <90>/0 │ codex 10/0");

      // Back to the primary for both, so this pass decides a switch for each.
      await writeFile(fx.plannerFile, TEMPLATE("planner", "claude-bridge/claude-opus-5-5"), "utf8");
      await writeFile(reviewerFile, TEMPLATE("reviewer", "claude-bridge/claude-opus-5-5"), "utf8");
      // Planted now, so the *startup* pass above does not park on it.
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: hostname(), at: Date.now() }), "utf8");

      const older = sessionStart("resume");
      try {
        // The planner write is observable, and the pass cannot finish while the
        // reviewer file's lock is held: so this is the pass's state *after* it
        // read and decided, and before it published. Bound generously, because
        // the wait covers a store read, the agent-dir read and a lock acquire —
        // still inside the lock's own patience, so a pass that never parks fails
        // by name rather than by timing out.
        await waitFor(
          async () => (await readFile(fx.plannerFile, "utf8")).includes("openai-codex/gpt-6-sol"),
          "the parked pass's planner write",
          2_000,
        );
        // Parked: the reviewer write cannot happen while its lock is held, and
        // the pass publishes only once every write has settled.
        assert.match(
          await readFile(reviewerFile, "utf8"),
          /^model: "claude-bridge\/claude-opus-5-5"$/m,
          "the pass must still be inside its decisions",
        );

        claudeFails = true;
        await invoke("refresh");
        assert.equal(
          gaugeStatuses(statuses).at(-1)?.text,
          "claude 90/0? │ codex 10/0",
          "the failed read is drawn stale",
        );
      } finally {
        await rm(lockPath, { force: true });
        await older;
      }

      // The older pass completed — it wrote the file it was parked on...
      assert.match(await readFile(reviewerFile, "utf8"), /^model: "openai-codex\/gpt-6-astra"$/m);
      // ...and its older snapshot did not erase the stale marker.
      assert.equal(
        gaugeStatuses(statuses).at(-1)?.text,
        "claude 90/0? │ codex 10/0",
        JSON.stringify(statuses),
      );
    },
    () => fetchImpl,
  );
});

/** A layer that turns the gauge off. The test forces its first pass to write, then blocks that write. */
const LAYER_TURNING_THE_GAUGE_OFF = {
  railGauge: false,
  agents: {
    planner: {
      primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
    },
  },
};

/** The same, with routes the superseded line does not describe at all. */
const LAYER_ON_OTHER_ROUTES = {
  agents: { planner: { primary: { model: "openai-codex/gpt-6-sol", rail: "codex" } } },
};

for (const [label, layer] of [
  ["a layer that turns the gauge off", LAYER_TURNING_THE_GAUGE_OFF],
  ["a layer on other routes", LAYER_ON_OTHER_ROUTES],
] as const) {
  test(`a generation whose first pass fails clears the superseded gauge: ${label}`, async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root can write a read-only directory");
      return;
    }
    const fx = await generateFixture(layer);
    await layerNamesFixtureCredential(fx, layer);
    const agentsDir = join(fx.agentDir, "agents");

    await withExtension(fx, async ({ run, sessionStart, statuses }) => {
      await sessionStart("startup");
      assert.equal(gaugeStatuses(statuses).at(-1)?.text, "claude <90>/0 │ codex 10/0");

      // Back to the primary, so the new layer's first pass has a write to make.
      await writeFile(fx.plannerFile, TEMPLATE("planner", "claude-bridge/claude-opus-5-5"), "utf8");
      // A directory that can be read and not added to: the pass reads the file,
      // decides a switch, and then cannot take the write's lock.
      await chmod(agentsDir, 0o500);
      t.after(() => chmod(agentsDir, 0o755));

      const text = await run("generate");
      assert.ok(
        text.includes("the configuration was activated, but evaluating it once failed"),
        text,
      );
      assert.equal(
        gaugeStatuses(statuses).at(-1)?.text,
        undefined,
        `the superseded gauge must not survive the swap: ${JSON.stringify(statuses)}`,
      );
    });
  });
}
