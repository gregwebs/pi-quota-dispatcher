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
 * headroom, so re-evaluating is idempotent and cannot drift.
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

/**
 * The two budgets a rail imposes, which move on very different clocks.
 *
 * They have to be weighed separately. Collapsing them into one "worst window"
 * number let the weekly figure dominate every decision, because it is almost
 * always the larger of the two: a rail with a full session budget and a
 * comfortable week would be treated as tight purely on the week, and moving off
 * a weekly figure is close to one-way — it does not recover for days.
 */
export type Budget = "session" | "weekly";

export interface RailWindow {
  label: string;
  used: number;
  /**
   * Set when this window belongs to a budget the policy weighs. Windows left
   * unclassified are display-only: model-specific sub-caps and vendor windows
   * we do not recognise.
   */
  budget?: Budget;
  /** Seconds until this window resets, when the endpoint reports it. */
  resetsInSeconds?: number;
}

export interface RailState {
  rail: Rail;
  ok: boolean;
  /** Every window the endpoint reported, for display. Only some carry a budget. */
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
  /**
   * Consider the alternate once the primary's *session* budget reaches this.
   * This is the acute cap: the one that blocks you mid-task, and the only one
   * that recovers within hours, so a switch made on it is reversible.
   */
  sessionSwitchAt: number;
  /**
   * ...or once its *weekly* budget reaches this.
   *
   * Deliberately higher than `sessionSwitchAt`. The weekly window does not
   * recover for days, so a switch made on it is close to one-way and should be
   * a last resort rather than the routine signal.
   */
  weeklySwitchAt: number;
  /** ...and only when the alternate is at least this many points healthier. */
  margin: number;
  /** Agents absent from this table are never touched. */
  routes: Record<string, Route>;
}

export type Outcome =
  | "written"
  | "would-write"
  | "unchanged"
  | "held"
  | "skipped (no file)"
  | "skipped (no frontmatter)";

/**
 * Either an instruction to assign a model, or an explicit refusal to have an
 * opinion.
 *
 * This used to be a bare `model` string, with "hold" represented by naming the
 * primary. That made "I have no reading, leave things alone" indistinguishable
 * from "this agent belongs on the primary", so an unreadable quota rewrote any
 * agent a previous evaluation had moved onto the alternate — dragging work back
 * onto the very rail that was under pressure. A hold has no model; the type now
 * says so, and callers cannot read one out by accident.
 */
export type Decision =
  | { agent: string; file: string; kind: "assign"; model: string; why: string }
  | { agent: string; file: string; kind: "hold"; why: string };

export const DEFAULT_CONFIG: DispatcherConfig = {
  agentDir: join(homedir(), ".pi", "agent", "agents"),
  claudeCredsPath: join(homedir(), ".claude", ".credentials.json"),
  piAuthPath: join(homedir(), ".pi", "agent", "auth.json"),
  ttlMs: 3 * 60 * 1000,
  pollMs: 5 * 60 * 1000,
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

/**
 * Claude reports an account-wide session cap (`five_hour`) alongside weekly
 * caps: one account-wide plus per-model ones. Every weekly figure is classified
 * as the same budget, so the worst of them is what the weekly guard sees — a
 * Sonnet cap at 95% does block you, even when the account-wide week is
 * comfortable.
 */
export function parseClaudeUsage(data: any): RailWindow[] {
  const keys: Array<[string, string, Budget | undefined]> = [
    ["five_hour", "5h", "session"],
    ["seven_day", "7d", "weekly"],
    ["seven_day_sonnet", "7d Sonnet", "weekly"],
    ["seven_day_opus", "7d Opus", "weekly"],
    ["seven_day_omelette", "7d omelette", "weekly"],
  ];
  const windows: RailWindow[] = [];
  for (const [key, label, budget] of keys) {
    const used = num(data?.[key]?.utilization);
    if (used !== undefined) windows.push(budget ? { label, used, budget } : { label, used });
  }
  return windows;
}

/**
 * Label a window from its advertised length rather than assuming it, so the
 * display cannot quietly drift if the vendor changes a window.
 */
function durationLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === undefined) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * Codex reports a short "primary" window and a long "secondary" one. The
 * positions are the vendor's stable meaning; the labels come from the advertised
 * window length, and `reset_after_seconds` tells us when each recovers.
 */
export function parseCodexUsage(data: any): {
  windows: RailWindow[];
  limited: boolean;
} {
  const rl = data?.rate_limit;
  const windows: RailWindow[] = [];
  const push = (key: string, budget: Budget, fallback: string) => {
    const w = rl?.[key];
    const used = num(w?.used_percent);
    if (used === undefined) return;
    const resetsInSeconds = num(w?.reset_after_seconds);
    windows.push({
      label: durationLabel(num(w?.limit_window_seconds), fallback),
      used,
      budget,
      ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
    });
  };
  push("primary_window", "session", "5h");
  push("secondary_window", "weekly", "7d");
  return { windows, limited: rl?.limit_reached === true };
}

// ---------------------------------------------------------------- policy

/**
 * Used-percent for one budget on a rail.
 *
 * Several windows can share a budget — Claude reports an account-wide week plus
 * per-model weeks — so this takes the worst of them. A rail that reports no
 * windows at all is metered rather than capped (the DeepSeek case), which is why
 * the fallback is 0 and not "unknown": `deepseekState()` is the only rail that
 * can be `ok` with no windows, and being uncapped is a reading, not a gap.
 */
export function budgetUsed(state: RailState, budget: Budget): number {
  const used = state.windows.filter((w) => w.budget === budget).map((w) => w.used);
  return used.length ? Math.max(...used) : 0;
}

/** A budget at or over its threshold, with the threshold that caught it. */
interface TightBudget {
  budget: Budget;
  used: number;
  threshold: number;
}

/**
 * The budget that makes a rail tight, if any.
 *
 * Session is tested first: it is the acute cap and the one that recovers within
 * hours, so when both are tight it is the more actionable thing to report.
 */
function tightBudget(state: RailState, cfg: DispatcherConfig): TightBudget | null {
  for (const budget of ["session", "weekly"] as const) {
    const threshold = budget === "session" ? cfg.sessionSwitchAt : cfg.weeklySwitchAt;
    const used = budgetUsed(state, budget);
    if (used >= threshold) return { budget, used, threshold };
  }
  return null;
}

/** Both budgets, for the decision's `why`. */
function budgetSummary(state: RailState): string {
  if (!state.windows.length) return state.note ?? "no windows";
  return (["session", "weekly"] as const)
    .map((b) => `${b} ${budgetUsed(state, b).toFixed(0)}%`)
    .join(", ");
}

/**
 * Pick the model for one agent from current rail headroom.
 *
 * The session and weekly budgets are weighed *separately*, session first. They
 * mean opposite things. Session is the acute cap: it blocks you mid-task but
 * clears within hours, so acting on it is reversible. Weekly rarely blocks you,
 * but when it does it does so for days, so it earns a vote only at a much higher
 * threshold. Folding the two into one "worst window" number let the weekly
 * figure set the policy on its own, because it is almost always the larger of
 * the two.
 *
 * Deliberate rule: unreadable quota is *not* evidence of pressure. When a rail
 * cannot be read we make no assignment at all, leaving the file exactly as the
 * user left it. Substituting the primary here would move agents back onto a
 * constrained rail on the strength of a failed HTTP call.
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
    return {
      agent,
      file,
      kind: "assign",
      model: route.primary.model,
      why: "no alternate configured",
    };
  }
  if (!primary?.ok) {
    return {
      agent,
      file,
      kind: "hold",
      why: `${route.primary.rail} unreadable (${primary?.note ?? "unknown"}) — holding`,
    };
  }
  if (!alt.ok) {
    return {
      agent,
      file,
      kind: "hold",
      why: `${route.alternate.rail} unreadable (${alt.note}) — holding`,
    };
  }

  const tight = tightBudget(primary, cfg);
  if (!tight) {
    return {
      agent,
      file,
      kind: "assign",
      model: route.primary.model,
      why: `${primary.rail} ok (${budgetSummary(primary)})`,
    };
  }

  const altUsed = budgetUsed(alt, tight.budget);
  if (altUsed < tight.used - cfg.margin) {
    return {
      agent,
      file,
      kind: "assign",
      model: route.alternate.model,
      why: `${primary.rail} ${tight.budget} ${tight.used.toFixed(0)}% >= ${tight.threshold}%, ${alt.rail} ${tight.budget} ${altUsed.toFixed(0)}%`,
    };
  }
  return {
    agent,
    file,
    kind: "assign",
    model: route.primary.model,
    why: `${primary.rail} ${tight.budget} ${tight.used.toFixed(0)}% >= ${tight.threshold}% but ${alt.rail} ${tight.budget} ${altUsed.toFixed(0)}% is within margin`,
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

/** One-line rendering of a decision, for reports and command output. */
export function describeDecision(decision: Decision): string {
  return decision.kind === "hold"
    ? `${decision.agent} -> (left as is)`
    : `${decision.agent} -> ${decision.model}`;
}

// ---------------------------------------------------------------- rails

function unavailable(rail: Rail, note: string): RailState {
  return { rail, ok: false, windows: [], note };
}

/**
 * DeepSeek is metered per token rather than quota-capped, so it never blocks a
 * switch. Reported with no windows — "uncapped" rather than "unknown" — so the
 * policy can rest there without evidence to the contrary. `budgetUsed` reads
 * that as 0.
 */
function deepseekState(): RailState {
  return { rail: "deepseek", ok: true, windows: [], note: "metered" };
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
  report(opts?: { force?: boolean }): Promise<string[]>;
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
    return { rail: "claude", ok: true, windows };
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
    if (!limited) return { rail: "codex", ok: true, windows };
    // `limit_reached` means blocked outright, not merely close, so every budget
    // reads full rather than leaving a comfortable-looking percentage behind.
    return {
      rail: "codex",
      ok: true,
      windows: windows.map((w) => ({ ...w, used: 100 })),
      note: "limit_reached=true",
    };
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

  async function decideAll(
    rails: Map<Rail, RailState>,
    dry: boolean,
  ): Promise<Array<{ decision: Decision; outcome: Outcome }>> {
    const decisions = Object.entries(cfg.routes).map(([agent, route]) =>
      decide(agent, route, rails, cfg),
    );
    return Promise.all(
      decisions.map(async (decision) => ({
        decision,
        // A hold carries no model, so there is nothing to write and the file
        // is left exactly as the user left it.
        outcome:
          decision.kind === "hold"
            ? ("held" as const)
            : await applyDecision(decision.file, decision.model, dry),
      })),
    );
  }

  async function evaluate(
    opts: { force?: boolean; dry?: boolean } = {},
  ): Promise<Array<{ decision: Decision; outcome: Outcome }>> {
    return decideAll(await allRails(opts.force), opts.dry ?? false);
  }

  /**
   * Read-only by construction: there is deliberately no way to ask `report` to
   * write.
   *
   * It previously forwarded a `dry` flag straight into `evaluate`, which meant
   * the plain `/quota-dispatch` "show me the state" command silently rewrote
   * agent files whenever a switch happened to be due. A function called
   * `report` should not be able to mutate, so the option is gone rather than
   * defaulted correctly — a default is something a caller can override by
   * accident.
   *
   * Rails are also fetched once and shared with the decisions, so the numbers
   * on screen are the numbers the decisions were made from, and `refresh` costs
   * two HTTP requests rather than four.
   */
  async function report(opts: { force?: boolean } = {}): Promise<string[]> {
    const rails = await allRails(opts.force);
    const lines: string[] = [];
    for (const rail of ["claude", "codex", "deepseek"] as Rail[]) {
      const s = rails.get(rail)!;
      if (!s.ok) lines.push(`${rail}: unavailable — ${s.note}`);
      else if (!s.windows.length) lines.push(`${rail}: ok — ${s.note ?? "no windows"}`);
      else lines.push(`${rail}: ${s.windows.map((w) => `${w.label} ${w.used.toFixed(0)}%`).join(", ")}`);
    }
    lines.push("");
    for (const { decision, outcome } of await decideAll(rails, true)) {
      lines.push(`${describeDecision(decision)}  [${outcome}]  (${decision.why})`);
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

      // Only this form writes. The plain and `refresh` forms are read-only.
      if (a.includes("apply")) {
        const rows = await dispatcher.evaluate({ force: true });
        const lines = [
          "[applied]",
          ...rows.map(
            (r) => `${describeDecision(r.decision)}  [${r.outcome}]  (${r.decision.why})`,
          ),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const force = a.includes("refresh");
      ctx.ui.notify((await dispatcher.report({ force })).join("\n"), "info");
    },
  });

  // Awaited on purpose, so the first spawn of the session already sees current
  // frontmatter. Note that neither quota request sets a timeout yet, so a
  // stalled endpoint can delay session start — see the README limitations.
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
