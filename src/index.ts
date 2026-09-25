/**
 * pi-quota-dispatcher
 *
 * Keeps agent `model:` frontmatter in sync with subscription headroom, so you
 * stop hand-editing `~/.pi/agent/agents/*.md` every time a quota starts to run
 * out.
 *
 * Design notes
 * ------------
 * It writes frontmatter rather than injecting a `model` parameter into Agent
 * tool calls. Two reasons:
 *
 *   1. Coverage. Injecting only reaches the `Agent` tool. `SubagentWorkflow`'s
 *      `agent()` and `@agent` mentions spawn through the manager and bypass the
 *      tool, so they would silently keep a stale model. pi-subagents re-reads
 *      agent files on every spawn, so a written file is what every path sees.
 *   2. Failure mode. If this extension stops loading, the last-written model
 *      persists. An injector would leave frontmatter without a `model:` and
 *      agents would inherit the parent model — a reviewer quietly downgraded to
 *      the session model is worse than a stale-but-sane one.
 *
 * The policy is stateless: the target model is a pure function of current rail
 * pressure, so re-evaluating is idempotent and cannot drift.
 *
 * Quota is read from two undocumented-but-stable endpoints the vendors' own
 * clients use. No credentials are ever logged.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- types

export type Rail = "claude" | "codex" | "deepseek";

export interface Candidate {
  model: string;
  rail: Rail;
}

export interface Route {
  primary: Candidate;
  alternate?: Candidate;
}

export interface RailWindow {
  label: string;
  used: number;
}

export interface RailState {
  rail: Rail;
  ok: boolean;
  /** Worst-window used-percent, 0-100. `Infinity` when unavailable. */
  pressure: number;
  windows: RailWindow[];
  note?: string;
}

export interface DispatcherConfig {
  agentDir: string;
  claudeCredsPath: string;
  piAuthPath: string;
  /** Quota readings are cached this long. 5h/7d windows move slowly. */
  ttlMs: number;
  /** Re-evaluate on this cadence while a session is open. */
  pollMs: number;
  /** Consider the alternate once the primary rail reaches this used-percent. */
  switchAt: number;
  /** ...and only when the alternate is at least this many points healthier. */
  margin: number;
  /** Agents absent from this table are never touched. */
  routes: Record<string, Route>;
}

export type Outcome =
  | "written"
  | "would-write"
  | "unchanged"
  | "skipped (no file)"
  | "skipped (no frontmatter)";

export interface Decision {
  agent: string;
  file: string;
  model: string;
  why: string;
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  agentDir: join(homedir(), ".pi", "agent", "agents"),
  claudeCredsPath: join(homedir(), ".claude", ".credentials.json"),
  piAuthPath: join(homedir(), ".pi", "agent", "auth.json"),
  ttlMs: 3 * 60 * 1000,
  pollMs: 5 * 60 * 1000,
  switchAt: 75,
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
      // DeepSeek is metered but cheap and effectively unbounded, so it is the
      // resting place; the codex model is the pressure valve, not the default.
      primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
      alternate: { model: "openai-codex/gpt-6-luna", rail: "codex" },
    },
  },
};

// ---------------------------------------------------------------- parsing

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseClaudeUsage(data: any): RailWindow[] {
  const keys: Array<[string, string]> = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
    ["seven_day_sonnet", "7d Sonnet"],
    ["seven_day_opus", "7d Opus"],
    ["seven_day_omelette", "7d Opus"],
  ];
  const windows: RailWindow[] = [];
  for (const [key, label] of keys) {
    const used = num(data?.[key]?.utilization);
    if (used !== undefined) windows.push({ label, used });
  }
  return windows;
}

export function parseCodexUsage(data: any): {
  windows: RailWindow[];
  limited: boolean;
} {
  const windows: RailWindow[] = [];
  const rl = data?.rate_limit;
  for (const [key, label] of [
    ["primary_window", "5h"],
    ["secondary_window", "7d"],
  ] as Array<[string, string]>) {
    const used = num(rl?.[key]?.used_percent);
    if (used !== undefined) windows.push({ label, used });
  }
  return { windows, limited: rl?.limit_reached === true };
}

// ---------------------------------------------------------------- policy

/**
 * Pick the model for one agent from current rail pressure.
 *
 * Deliberate rule: unreadable quota is *not* evidence of pressure. When a rail
 * cannot be read we hold the primary rather than flapping onto the other plan
 * on the strength of a failed HTTP call.
 */
export function decide(
  agent: string,
  route: Route,
  rails: Map<Rail, RailState>,
  cfg: DispatcherConfig,
): Decision {
  const file = join(cfg.agentDir, `${agent}.md`);
  const primary = rails.get(route.primary.rail);
  const alt = route.alternate ? rails.get(route.alternate.rail) : undefined;

  if (!route.alternate || !alt) {
    return { agent, file, model: route.primary.model, why: "no alternate configured" };
  }
  if (!primary?.ok) {
    return {
      agent,
      file,
      model: route.primary.model,
      why: `${route.primary.rail} unreadable (${primary?.note ?? "unknown"}) — holding`,
    };
  }
  if (!alt.ok) {
    return {
      agent,
      file,
      model: route.primary.model,
      why: `${route.alternate.rail} unreadable (${alt.note}) — holding`,
    };
  }
  if (primary.pressure >= cfg.switchAt && alt.pressure < primary.pressure - cfg.margin) {
    return {
      agent,
      file,
      model: route.alternate.model,
      why: `${primary.rail} ${primary.pressure.toFixed(0)}% >= ${cfg.switchAt}%, ${alt.rail} ${alt.pressure.toFixed(0)}%`,
    };
  }
  return {
    agent,
    file,
    model: route.primary.model,
    why: `${primary.rail} ${primary.pressure.toFixed(0)}% ok`,
  };
}

// ---------------------------------------------------------------- frontmatter

/**
 * Set the uncommented `model:` line inside the frontmatter block.
 *
 * Commented alternatives (`# model:`) and unrelated keys (`fallbackModels:`)
 * are left untouched. If no uncommented line exists, one is inserted after
 * `name:`. Returns null when the file has no usable frontmatter.
 */
export function upsertModel(src: string, model: string): string | null {
  if (!src.startsWith("---")) return null;
  const fmEnd = src.indexOf("\n---", 3);
  if (fmEnd === -1) return null;

  const line = `model: ${JSON.stringify(model)}`;
  const head = src.slice(0, fmEnd);
  const tail = src.slice(fmEnd);

  if (/^model:[^\n]*$/m.test(head)) {
    return head.replace(/^model:[^\n]*$/m, line) + tail;
  }
  if (/^name:[^\n]*$/m.test(head)) {
    return head.replace(/^name:[^\n]*$/m, (l) => `${l}\n${line}`) + tail;
  }
  return null;
}

export async function applyDecision(
  file: string,
  model: string,
  dry: boolean,
): Promise<Outcome> {
  if (!existsSync(file)) return "skipped (no file)";
  const src = await readFile(file, "utf8");
  const next = upsertModel(src, model);
  if (next === null) return "skipped (no frontmatter)";
  if (next === src) return "unchanged";
  if (dry) return "would-write";
  await writeFile(file, next, "utf8");
  return "written";
}

// ---------------------------------------------------------------- rails

function unavailable(rail: Rail, note: string): RailState {
  return { rail, ok: false, pressure: Infinity, windows: [], note };
}

/**
 * DeepSeek is metered per token rather than quota-capped, so it never blocks a
 * switch. Modelled as zero pressure rather than "unknown" so the policy can
 * rest there without evidence to the contrary.
 */
function deepseekState(): RailState {
  return { rail: "deepseek", ok: true, pressure: 0, windows: [], note: "metered" };
}

async function readClaudeToken(path: string): Promise<{ token: string } | { error: string }> {
  if (!existsSync(path)) return { error: "no claude credentials file" };
  try {
    const oauth = JSON.parse(await readFile(path, "utf8"))?.claudeAiOauth;
    if (!oauth?.accessToken) return { error: "no claudeAiOauth.accessToken" };
    // Claude Code refreshes this on use; we only read it.
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
      return { error: "claude token expired (run Claude Code to refresh)" };
    }
    return { token: oauth.accessToken };
  } catch (err) {
    return { error: `unreadable claude credentials: ${(err as Error).message}` };
  }
}

export interface DispatcherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Dispatcher {
  railState(rail: Rail, force?: boolean): Promise<RailState>;
  allRails(force?: boolean): Promise<Map<Rail, RailState>>;
  evaluate(opts?: { force?: boolean; dry?: boolean }): Promise<Array<{ decision: Decision; outcome: Outcome }>>;
  report(opts?: { force?: boolean; dry?: boolean }): Promise<string[]>;
}

export function createDispatcher(
  cfg: DispatcherConfig = DEFAULT_CONFIG,
  deps: DispatcherDeps = {},
): Dispatcher {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<Rail, { at: number; state: RailState }>();

  async function fetchClaude(): Promise<RailState> {
    const cred = await readClaudeToken(cfg.claudeCredsPath);
    if ("error" in cred) return unavailable("claude", cred.error);

    const res = await doFetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
    if (!res.ok) return unavailable("claude", `HTTP ${res.status}`);

    const windows = parseClaudeUsage(await res.json());
    if (!windows.length) return unavailable("claude", "no usage windows returned");
    return {
      rail: "claude",
      ok: true,
      pressure: Math.max(...windows.map((w) => w.used)),
      windows,
    };
  }

  async function fetchCodex(): Promise<RailState> {
    if (!existsSync(cfg.piAuthPath)) return unavailable("codex", "no pi auth file");
    let cred: any;
    try {
      cred = JSON.parse(await readFile(cfg.piAuthPath, "utf8"))["openai-codex"];
    } catch (err) {
      return unavailable("codex", `unreadable pi auth: ${(err as Error).message}`);
    }
    if (!cred?.access) return unavailable("codex", "no openai-codex.access");
    if (!cred?.accountId) return unavailable("codex", "no openai-codex.accountId");

    const res = await doFetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${cred.access}`,
        "ChatGPT-Account-Id": cred.accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) return unavailable("codex", `HTTP ${res.status}`);

    const { windows, limited } = parseCodexUsage(await res.json());
    if (!windows.length) return unavailable("codex", "no rate_limit windows returned");
    const state: RailState = {
      rail: "codex",
      ok: true,
      pressure: Math.max(...windows.map((w) => w.used)),
      windows,
    };
    return limited ? { ...state, pressure: 100, note: "limit_reached=true" } : state;
  }

  async function railState(rail: Rail, force = false): Promise<RailState> {
    if (rail === "deepseek") return deepseekState();
    const hit = cache.get(rail);
    if (!force && hit && now() - hit.at < cfg.ttlMs) return hit.state;

    let state: RailState;
    try {
      state = rail === "claude" ? await fetchClaude() : await fetchCodex();
    } catch (err) {
      state = unavailable(rail, (err as Error).message);
    }
    cache.set(rail, { at: now(), state });
    return state;
  }

  async function allRails(force = false): Promise<Map<Rail, RailState>> {
    const rails: Rail[] = ["claude", "codex", "deepseek"];
    const states = await Promise.all(rails.map((r) => railState(r, force)));
    return new Map(states.map((s) => [s.rail, s]));
  }

  async function evaluate(
    opts: { force?: boolean; dry?: boolean } = {},
  ): Promise<Array<{ decision: Decision; outcome: Outcome }>> {
    const rails = await allRails(opts.force);
    const decisions = Object.entries(cfg.routes).map(([agent, route]) =>
      decide(agent, route, rails, cfg),
    );
    return Promise.all(
      decisions.map(async (decision) => ({
        decision,
        outcome: await applyDecision(decision.file, decision.model, opts.dry ?? false),
      })),
    );
  }

  async function report(opts: { force?: boolean; dry?: boolean } = {}): Promise<string[]> {
    const rails = await allRails(opts.force);
    const lines: string[] = [];
    for (const rail of ["claude", "codex", "deepseek"] as Rail[]) {
      const s = rails.get(rail)!;
      if (!s.ok) lines.push(`${rail}: unavailable — ${s.note}`);
      else if (!s.windows.length) lines.push(`${rail}: ok — ${s.note ?? "no windows"}`);
      else lines.push(`${rail}: ${s.windows.map((w) => `${w.label} ${w.used.toFixed(0)}%`).join(", ")}`);
    }
    lines.push("");
    for (const { decision, outcome } of await evaluate(opts)) {
      lines.push(`${decision.agent} -> ${decision.model}  [${outcome}]  (${decision.why})`);
    }
    return lines;
  }

  return { railState, allRails, evaluate, report };
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const dispatcher = createDispatcher();

  pi.registerCommand("quota-dispatch", {
    description: "Show subscription headroom and which model each agent is dispatched to",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      const dry = a.includes("dry");
      const force = a.includes("refresh") || dry;
      const lines = await dispatcher.report({ force, dry });
      ctx.ui.notify(`${dry ? "[dry run]\n" : ""}${lines.join("\n")}`, "info");
    },
  });

  // Fire-and-forget: a slow quota endpoint must not delay session start.
  pi.on("session_start", async () => {
    await dispatcher.evaluate().catch(() => {});
  });

  // Periodic re-evaluation so workflow and mention spawns, which bypass the
  // Agent tool, still see current frontmatter.
  const timer = setInterval(() => {
    void dispatcher.evaluate().catch(() => {});
  }, DEFAULT_CONFIG.pollMs);
  timer.unref?.();

  pi.on("session_shutdown", async () => {
    clearInterval(timer);
  });
}
