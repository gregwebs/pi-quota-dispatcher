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
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  type DispatcherConfig,
  type LoadedConfig,
  type Rail,
  type Route,
  describeConfig,
  loadConfig,
} from "./config.ts";

// Config is a separate module because it is read from disk at run time; it is
// re-exported here so `src/index.ts` remains the one import path for the
// extension's whole surface.
export {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  defaultConfig,
  describeConfig,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  projectConfigPath,
} from "./config.ts";
export type {
  Candidate,
  ConfigFile,
  ConfigSource,
  DispatcherConfig,
  LoadConfigDeps,
  LoadedConfig,
  MergeLayer,
  MergeResult,
  Rail,
  Route,
} from "./config.ts";

// ---------------------------------------------------------------- types

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
  /**
   * Billed per token rather than quota-capped, so there is no budget to read:
   * `budgetUsed` reports 0 on both and the rail can never block a switch.
   * Distinct from reporting no windows, which for a capped rail is a partial
   * reading the policy must not guess at.
   */
  metered?: boolean;
  note?: string;
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

/** Budgets in the order the policy weighs them: the acute cap first. */
const BUDGET_ORDER: readonly Budget[] = ["session", "weekly"];

/** The budget a destination would still have to survive. */
const OTHER_BUDGET: Record<Budget, Budget> = { session: "weekly", weekly: "session" };

function thresholdFor(budget: Budget, cfg: DispatcherConfig): number {
  return budget === "session" ? cfg.sessionSwitchAt : cfg.weeklySwitchAt;
}

/** Percentages arrive fractional and are only ever read to the point. */
function pct(n: number): string {
  return `${n.toFixed(0)}%`;
}

/**
 * Used-percent for one budget, or `undefined` when the rail did not report it.
 *
 * `undefined` rather than 0 is the point. A missing 5-hour window is not
 * evidence that the 5-hour budget is free, and reading it as free is exactly how
 * a rail that was blocked outright came to look like the roomiest place to send
 * work. Several windows can share a budget — Claude reports an account-wide week
 * plus per-model weeks — so this takes the worst of them.
 *
 * A metered rail is billed per token rather than capped, so it has no budget to
 * report and honestly reads 0 on both.
 */
export function budgetUsed(state: RailState, budget: Budget): number | undefined {
  if (state.metered) return 0;
  const used = state.windows.filter((w) => w.budget === budget).map((w) => w.used);
  return used.length ? Math.max(...used) : undefined;
}

/**
 * Budgets a capped rail failed to report.
 *
 * A metered rail reads 0 through `budgetUsed`, and unreadable rails are rejected
 * before this is consulted, so anything returned here is a partial reading. The
 * policy holds rather than guessing: an unreported budget is not an idle one.
 */
function absentBudgets(state: RailState): Budget[] {
  return BUDGET_ORDER.filter((b) => budgetUsed(state, b) === undefined);
}

/** Both budgets, for the decision's `why`. */
function budgetSummary(state: RailState): string {
  if (state.metered) return state.note ?? "metered";
  if (!state.windows.length) return state.note ?? "no windows";
  return BUDGET_ORDER.map((b) => {
    const used = budgetUsed(state, b);
    return `${b} ${used === undefined ? "unreported" : pct(used)}`;
  }).join(", ");
}

/**
 * Whether `file` (already formed by `join`) lies inside `dir`.
 *
 * A plain `file.startsWith(dir)` is not enough: an `agentDir` sibling such as
 * `<agentDir>-evil` shares the prefix without being inside. Comparing resolved
 * paths and requiring the separator is what makes `agentDir + "/x"` fail to
 * match it. `dir` is resolved too, so a relative or trailing-slash `agentDir`
 * compares the same way.
 */
function isInside(dir: string, file: string): boolean {
  const root = resolve(dir);
  const target = resolve(file);
  return target === root || target.startsWith(root + sep);
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
 *
 * A destination is held to the same standard as a source. It must be strictly
 * healthier on the budget that triggered the move *and* not tight on its other
 * budget, because a rail that is tight there would block the work just as
 * surely. Without that, one agent can be moved onto the very rail another was
 * moved off in the same pass.
 *
 * Containment is checked here even though the config seam validates names:
 * `decide` is handed a `DispatcherConfig` that need not have come through
 * `mergeConfig`, so the name is not trusted. This path check is the guarantee
 * that a write lands inside `agentDir`; the regex upstream only makes a name
 * conventional. A name that resolves outside holds rather than assigning,
 * because a hold writes nothing and the file stays as the user left it.
 */
export function decide(
  agent: string,
  route: Route,
  rails: Map<Rail, RailState>,
  cfg: DispatcherConfig,
): Decision {
  const file = join(cfg.agentDir, `${agent}.md`);
  if (!isInside(cfg.agentDir, file)) {
    return {
      agent,
      file,
      kind: "hold",
      why: `"${agent}" resolves outside the agents directory (${file}) — holding`,
    };
  }
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

  // An unreported budget is unknown, not idle. Guessing here is what let a rail
  // that was blocked outright read as the roomiest place to send work.
  for (const state of [primary, alt]) {
    const absent = absentBudgets(state);
    if (absent.length) {
      return {
        agent,
        file,
        kind: "hold",
        why: `${state.rail} did not report its ${absent.join(" and ")} budget (${budgetSummary(state)}) — holding`,
      };
    }
  }

  const reasons: string[] = [];
  for (const budget of BUDGET_ORDER) {
    const used = budgetUsed(primary, budget)!;
    const threshold = thresholdFor(budget, cfg);
    if (used < threshold) continue;

    const spare = OTHER_BUDGET[budget];
    const altUsed = budgetUsed(alt, budget)!;
    const altSpare = budgetUsed(alt, spare)!;

    // A destination that is tight on its *other* budget would block this work
    // just as surely, so switching there trades one cap for another rather than
    // relieving anything. This is what stops an agent being moved onto the very
    // rail another agent was moved off in the same pass.
    if (altSpare >= thresholdFor(spare, cfg)) {
      reasons.push(
        `${primary.rail} ${budget} ${pct(used)} >= ${pct(threshold)} but ${alt.rail} ${spare} ${pct(altSpare)} is itself tight`,
      );
      continue;
    }
    if (altUsed < used - cfg.margin) {
      return {
        agent,
        file,
        kind: "assign",
        model: route.alternate.model,
        why: `${primary.rail} ${budget} ${pct(used)} >= ${pct(threshold)}, ${alt.rail} ${budget} ${pct(altUsed)}`,
      };
    }
    reasons.push(
      `${primary.rail} ${budget} ${pct(used)} >= ${pct(threshold)} but ${alt.rail} ${budget} ${pct(altUsed)} is within margin`,
    );
  }

  return {
    agent,
    file,
    kind: "assign",
    model: route.primary.model,
    why: reasons.length ? reasons.join("; ") : `${primary.rail} ok (${budgetSummary(primary)})`,
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
  return { rail: "deepseek", ok: true, windows: [], metered: true, note: "metered" };
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
  /**
   * Config is resolved once per extension load, and the command reports which
   * layer every value came from. `/reload` is what picks up an edit, which is
   * the same deal as any other pi config file and keeps the polling cadence
   * from changing underfoot mid-session.
   */
  let boot: Promise<{ loaded: LoadedConfig; dispatcher: Dispatcher }> | undefined;
  const bootOnce = () =>
    (boot ??= loadConfig().then((loaded) => ({
      loaded,
      dispatcher: createDispatcher(loaded.config),
    })));

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  pi.registerCommand("quota-dispatch", {
    description: "Show subscription headroom and which model each agent is dispatched to",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      const { loaded, dispatcher } = await bootOnce();

      // Only this form writes. The plain and `refresh` forms are read-only.
      let lines: string[];
      if (a.includes("apply")) {
        const rows = await dispatcher.evaluate({ force: true });
        lines = [
          "[applied]",
          ...rows.map(
            (r) => `${describeDecision(r.decision)}  [${r.outcome}]  (${r.decision.why})`,
          ),
        ];
      } else {
        const force = a.includes("refresh");
        lines = await dispatcher.report({ force });
      }

      // Every form ends with the provenance block, so "where did this value
      // come from?" is answerable from whichever one you ran. Both branches
      // build the body first and share this tail rather than duplicating it.
      lines.push("", ...describeConfig(loaded));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Awaited on purpose, so the first spawn of the session already sees current
  // frontmatter. Note that neither quota request sets a timeout yet, so a
  // stalled endpoint can delay session start — see the README limitations.
  pi.on("session_start", async () => {
    const { dispatcher } = await bootOnce();
    await dispatcher.evaluate().catch(() => {});
  });

  // Periodic re-evaluation so workflow and mention spawns, which bypass the
  // Agent tool, still see current frontmatter. Starts only once the config has
  // been read, because the cadence is one of the things it configures.
  void bootOnce().then(({ loaded, dispatcher }) => {
    if (stopped) return;
    timer = setInterval(() => {
      void dispatcher.evaluate().catch(() => {});
    }, loaded.config.pollMs);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    stopped = true;
    if (timer) clearInterval(timer);
  });
}
