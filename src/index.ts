/**
 * pi-quota-dispatcher
 *
 * Keeps agent `model:` frontmatter in sync with subscription headroom, so you
 * stop hand-editing `~/.pi/agent/agents/*.md` every time a quota starts to run
 * out. It writes the `thinking:` line beside it when the configuration states a
 * level, because the model a budget can afford is often the model that should
 * think differently — see `upsertThinking` for the one guarantee it makes about
 * that line (there is only ever a forward one).
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
 * The policy is stateless: the target model, and any level that goes with it,
 * are pure functions of current rail headroom, so re-evaluating the same
 * readings is idempotent and the model cannot drift. The `thinking:` line is the
 * one thing a file does not converge on — a pass that resolves no level leaves
 * whatever is there — so which level an agent runs at can depend on the order of
 * past passes. See docs/adr/0004-thinking-levels.md.
 *
 * Quota is read from two undocumented-but-stable endpoints the vendors' own
 * clients use. No credentials are ever logged, and every read is bounded and
 * retried before a rail is called unreadable — see `QuotaReadPacing`.
 *
 * The Claude credential is read from the file Claude Code writes, falling back
 * to the macOS login keychain — which is the store Claude Code actually
 * refreshes, and so the one that is current on a machine driven through a
 * bridge rather than through `claude` directly. See
 * docs/adr/0003-claude-credential-stores.md.
 */
import { execFile } from "node:child_process";
import { existsSync, type Stats } from "node:fs";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  type AgentRoute,
  type Candidate,
  type ClaudeRefreshMode,
  type DispatcherConfig,
  type LoadedConfig,
  type ModelDefault,
  type Rail,
  type ThinkingLevel,
  agentNameRejection,
  configFilesFor,
  describeConfig,
  globalConfigPath,
  loadConfig,
  railFromModel,
  thinkingFor,
} from "./config.ts";

// Config is a separate module because it is read from disk at run time; it is
// re-exported here so `src/index.ts` remains the one import path for the
// extension's whole surface.
export {
  CLAUDE_REFRESH_MODES,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  configFilesFor,
  defaultConfig,
  describeConfig,
  globalConfigPath,
  isClaudeRefreshMode,
  isThinkingLevel,
  loadConfig,
  mergeConfig,
  modelIdRejection,
  projectConfigPath,
  railFromModel,
  thinkingFor,
} from "./config.ts";
export type {
  AgentRoute,
  Candidate,
  ClaudeRefreshMode,
  ConfigFile,
  ConfigSource,
  DispatcherConfig,
  LoadConfigDeps,
  LoadedConfig,
  MergeLayer,
  MergeResult,
  ModelDefault,
  Rail,
  SkipFlag,
  ThinkingLevel,
} from "./config.ts";

import { checkModels, modelLookup, type DroppedAlternate, type ModelMiss, unknownModelNote } from "./models.ts";

// The models module is where a config's model ids are resolved against the pi
// that is running; re-exported here for the same reason as the config module.
export { checkModels, modelLookup } from "./models.ts";
export type {
  DroppedAlternate,
  ModelCheckResult,
  ModelLookup,
  ModelMiss,
  ModelRegistryLike,
} from "./models.ts";

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
  /**
   * Free text: why a failed read failed, or a display-only qualifier such as
   * `limit_reached=true`. A failed read that was given up on says how many
   * attempts it cost (`HTTP 500 after 2 attempts`); a failure another request
   * would not have fixed is reported as that failure alone — see
   * `afterAttempts`.
   */
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
 *
 * `why` is human text, and it may span lines: the priority walk reports one note
 * per candidate it passed over, so a route with several alternates puts each on
 * its own line rather than joining them into one long sentence. Notes are never
 * dropped for brevity — the rendered layout is `describeDecisionLines`'s job.
 *
 * `thinking` rides along on an assign for the same reason `model` does: it is
 * part of the instruction to write, and it comes from the same pure resolution
 * over the chosen candidate. It is absent when nothing names a level, which is
 * not a level of "none" but the absence of an opinion — the file's `thinking:`
 * line is then left as it is, whether that is what the user wrote or what an
 * earlier pass wrote.
 */
export type Decision =
  | {
      agent: string;
      file: string;
      kind: "assign";
      model: string;
      thinking?: ThinkingLevel;
      why: string;
    }
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

/**
 * A headline with one line per note.
 *
 * The priority walk can pass over several alternates — some rejected on a
 * reading, some never consulted because an earlier one won — and naming them all
 * in one sentence produced a single unreadably long line. The notes are kept in
 * full and separated by a newline; `describeDecisionLines` is what renders the
 * layout.
 */
function withNotes(headline: string, notes: string[]): string {
  return notes.length ? `${headline}\n${notes.join("\n")}` : headline;
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
 * Deliberate rule: an unreadable quota is *not* evidence of pressure, and it is
 * not evidence of room either — it is a missing reading. The policy holds when a
 * reading it does not have could have changed the answer, and otherwise proceeds
 * on the readings it does have:
 *
 *   - the primary's rail unreadable, or reporting nothing for a budget it should
 *     have reported, holds: that missing number is exactly the one that decides
 *     whether to move;
 *   - a primary that is readable and below every threshold is assigned even when
 *     an alternate is unreadable, because no alternate could have been chosen;
 *   - when the primary is tight, the alternates are walked in priority order and
 *     the first usable one wins — but an unreadable alternate that comes before
 *     the winner holds instead, and an unreadable alternate holds when nothing
 *     readable qualifies either, since the missing reading might have won.
 *
 * Substituting the primary whenever a read fails would move agents back onto a
 * constrained rail on the strength of a failed HTTP call; holding whenever any
 * read fails would drag work off a healthy primary for no reason. Both are
 * guesses about numbers nobody read, so the rule is stated as what the missing
 * number could have done.
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
 *
 * `droppedAlternates` is the one fact `route` cannot carry: boot may have
 * removed alternates this pi cannot spawn, and the route it handed over is
 * indistinguishable from one the user wrote with no alternates. Absent means
 * nothing was dropped, so an empty `alternates` is the user's own `[]`.
 */
export function decide(
  agent: string,
  route: AgentRoute,
  rails: Map<Rail, RailState>,
  cfg: DispatcherConfig,
  droppedAlternates: readonly DroppedAlternate[] = [],
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

  /**
   * An assign for `candidate`, carrying the level the three places that can
   * state one resolve to. Both fields come from the same pure resolution, so the
   * pair written to the file is always the pair the decision reported.
   */
  const assign = (candidate: Candidate, why: string): Decision => {
    const thinking = thinkingFor(cfg, route, candidate);
    return {
      agent,
      file,
      kind: "assign",
      model: candidate.model,
      ...(thinking !== undefined ? { thinking } : {}),
      why,
    };
  };

  // An empty list pins the agent to its primary. There is nothing else the
  // answer could be, so no reading is consulted and no hold is possible.
  if (!route.alternates.length) {
    return assign(route.primary, pinnedWhy(droppedAlternates));
  }

  // A state missing from the map is as unreadable as one with `ok: false`: we
  // have no reading either way. A missing reading is exactly what the hold rule
  // is about, so it is handled before any threshold is consulted.
  const primary = rails.get(route.primary.rail);
  if (!primary || !primary.ok) {
    return {
      agent,
      file,
      kind: "hold",
      why: `${route.primary.rail} unreadable (${primary?.note ?? "unknown"}) — holding`,
    };
  }

  // A rail that is readable but silent about a budget it should report is the
  // same danger: the missing number is the one that decides whether to move, so
  // it is unknown rather than idle. Guessing here is what let a rail that was
  // blocked outright read as the roomiest place to send work.
  const primaryAbsent = absentBudgets(primary);
  if (primaryAbsent.length) {
    return {
      agent,
      file,
      kind: "hold",
      why: `${primary.rail} did not report its ${primaryAbsent.join(" and ")} budget (${budgetSummary(primary)}) — holding`,
    };
  }

  // The positive half of the sensitivity rule: a primary below every threshold
  // is assigned whatever the alternates say, because no alternate could have
  // been chosen, so an unreadable one is no reason to hold.
  const tightBudgets = BUDGET_ORDER.filter(
    (budget) => budgetUsed(primary, budget)! >= thresholdFor(budget, cfg),
  );
  if (!tightBudgets.length) {
    return assign(route.primary, `${primary.rail} ok (${budgetSummary(primary)})`);
  }

  const reasons: string[] = [];
  for (const budget of BUDGET_ORDER) {
    const used = budgetUsed(primary, budget)!;
    const threshold = thresholdFor(budget, cfg);
    // Only a budget the primary is tight on can trigger a switch; the other one
    // is weighed on its own pass, so a spent week is not masked by a merely
    // tight session.
    if (used < threshold) continue;

    const spare = OTHER_BUDGET[budget];
    const spareThreshold = thresholdFor(spare, cfg);

    // The alternates are consulted in the priority order the user wrote, never
    // re-sorted by headroom: order is the only intent the numbers cannot
    // express, and a "healthiest" rule would add a second source of
    // oscillation to a policy that already swaps models near a threshold.
    const rejected: string[] = [];
    const missing: string[] = [];
    let winner: Candidate | undefined;
    let winnerUsed = 0;
    let winnerIndex = -1;
    for (let index = 0; index < route.alternates.length; index++) {
      const candidate = route.alternates[index];
      const state = rails.get(candidate.rail);
      // Named by model, not by rail alone: two alternates can share a rail, and
      // "codex unreadable" twice would not say which readings were missing.
      if (!state || !state.ok) {
        missing.push(
          `${candidate.model} on ${candidate.rail} unreadable (${state?.note ?? "unknown"})`,
        );
        continue;
      }
      const absent = absentBudgets(state);
      if (absent.length) {
        missing.push(
          `${candidate.model} on ${candidate.rail} did not report its ${absent.join(" and ")} budget (${budgetSummary(state)})`,
        );
        continue;
      }
      const altUsed = budgetUsed(state, budget)!;
      const altSpare = budgetUsed(state, spare)!;

      // A destination that is tight on its *other* budget would block this work
      // just as surely, so switching there trades one cap for another rather
      // than relieving anything. This is what stops an agent being moved onto
      // the very rail another agent was moved off in the same pass.
      if (altSpare >= spareThreshold) {
        // Named by model, not just rail: two alternates can share a rail, and a
        // rail alone cannot say which one was passed over.
        rejected.push(
          `rejected ${candidate.model} on ${candidate.rail} (${spare} ${pct(altSpare)} is itself tight)`,
        );
        continue;
      }
      if (altUsed < used - cfg.margin) {
        winner = candidate;
        winnerUsed = altUsed;
        winnerIndex = index;
        break;
      }
      rejected.push(
        `rejected ${candidate.model} on ${candidate.rail} (${budget} ${pct(altUsed)} is within margin)`,
      );
    }

    if (winner) {
      // Everything after the winner lost its place rather than losing on health,
      // and everything an earlier budget pass rejected is still part of the
      // story: the reader asked "why this model?", so the notes carry every
      // candidate the walk did not take, in the order it met them.
      const notConsulted = route.alternates
        .slice(winnerIndex + 1)
        .map((c) => `${c.model} on ${c.rail} not consulted (lower priority than the winner)`);
      const notes = [...reasons, ...rejected, ...notConsulted];

      // We stop at the first usable candidate, so one we could not read that
      // came earlier in order may have been that candidate. The missing reading
      // could have changed the answer, so we hold rather than guess past it.
      if (missing.length) {
        return {
          agent,
          file,
          kind: "hold",
          why: withNotes(
            `an unreadable candidate could have won before ${winner.model} on ${winner.rail} — holding`,
            [...missing, ...notes],
          ),
        };
      }
      return assign(
        winner,
        withNotes(
          `${primary.rail} ${budget} ${pct(used)} >= ${pct(threshold)}, choosing ${winner.model} on ${winner.rail} (${budget} ${pct(winnerUsed)})`,
          notes,
        ),
      );
    }

    // Nothing readable qualified. If an alternate we could not read might have,
    // the missing reading could have been the answer, so we hold instead of
    // resting the agent back on a rail we know is tight.
    if (missing.length) {
      return {
        agent,
        file,
        kind: "hold",
        why: withNotes(
          `an unreadable candidate could have won on ${budget} (${primary.rail} ${pct(used)} >= ${pct(threshold)}) — holding`,
          [...missing, ...reasons, ...rejected],
        ),
      };
    }
    reasons.push(...rejected);
  }

  return assign(
    route.primary,
    reasons.length
      ? withNotes(
          `${primary.rail} tight on ${tightBudgets.join(" and ")} (${budgetSummary(primary)}) and no alternate won`,
          reasons,
        )
      : `${primary.rail} ok (${budgetSummary(primary)})`,
  );
}

/**
 * Why a route with no alternates to walk is pinned to its primary.
 *
 * Two different facts leave a route with an empty list, and reporting the first
 * for the second tells a user who did configure alternates that they configured
 * none — on the one line they read when asking why nothing is switching. So the
 * dropped models are named instead, in the warning's own words, one note each:
 * a route with three of them is not one unreadably long line, and the note names
 * the config key to go and fix.
 *
 * The pinning itself is unchanged either way. An unresolvable model is *known
 * bad*, so it was dropped rather than held, and with nothing left to move to the
 * primary is the only answer — no reading is consulted.
 *
 * See docs/adr/0008-dropped-alternates-explained.md.
 */
function pinnedWhy(droppedAlternates: readonly DroppedAlternate[]): string {
  if (!droppedAlternates.length) return "no alternate configured";
  return withNotes(
    "every alternate was dropped — pinned to the primary",
    droppedAlternates.map((dropped) => unknownModelNote(dropped.key, dropped.model)),
  );
}

/**
 * The decision for an agent whose primary this pi cannot spawn.
 *
 * A hold, and a different kind of hold from the ones `decide` returns. Those are
 * about a *reading* that is missing and could have changed the answer; this one
 * is about a model that is known bad, where no reading could change anything.
 * The distinction matters to a reader: an unreadable rail is a reading that
 * failed and may well succeed later, and an unknown model id needs the config
 * edited.
 *
 * Pure, and a decision like any other, so the report and the `apply` output
 * render it without a special case: `agent -> (left as is)  [held]  (...)`.
 */
export function heldDecision(agent: string, cfg: DispatcherConfig, model: string): Decision {
  return {
    agent,
    file: join(cfg.agentDir, `${agent}.md`),
    kind: "hold",
    // The primary's own key, so the reader gets the line to edit rather than
    // having to work out which of the agent's candidates this is. The wording is
    // the model check's, shared with the note a dropped alternate earns.
    why: `${unknownModelNote(`agents.${agent}.primary.model`, model)}; holding`,
  };
}

// ---------------------------------------------------------------- frontmatter

/**
 * The frontmatter block of `src` — everything before the closing `---` line —
 * or `undefined` when the file has no usable frontmatter.
 */
function frontmatter(src: string): string | undefined {
  if (!src.startsWith("---")) return undefined;
  const end = src.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return src.slice(0, end);
}

/** The uncommented `model:` line, capturing everything after the colon. */
const MODEL_LINE = /^model:[ \t]*(.*?)[ \t]*$/m;

/**
 * Strip one layer of quoting and any trailing comment, so the value read here is
 * the model the file actually declares rather than the bytes around it.
 *
 * The value is read in order to be *compared* with the model the policy chose,
 * and `model: X`, `model: "X"` and `model: X  # note` all name the same model.
 * Discovery reads it through the same function, so the startup snippet proposes
 * a model id rather than a model id with someone's comment glued to it.
 *
 * Anything ambiguous — an unterminated quote, an escape JSON does not accept —
 * falls back to the raw text, which then fails the comparison and the line gets
 * rewritten. Guessing the other way would be worse: it could report `unchanged`
 * for a model that is not the one on disk.
 */
function decodeScalar(text: string): string {
  const value = stripComment(text).trim();
  const quote = value[0];
  if (value.length >= 2 && value.endsWith(quote) && quote === '"') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not a JSON string after all; the raw text cannot match a real model, so
      // the line is rewritten.
    }
    return value;
  }
  if (value.length >= 2 && value.endsWith(quote) && quote === "'") {
    // YAML escapes a single quote by doubling it, and has no other escapes.
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/**
 * Drop a trailing YAML comment from a scalar. A `#` starts one only at the start
 * of a line or after whitespace, and not inside quotes, so `a#b` stays whole.
 */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/**
 * The model the uncommented `model:` line declares, decoded, if any.
 */
function activeModel(head: string): string | undefined {
  const match = MODEL_LINE.exec(head);
  return match ? decodeScalar(match[1]) : undefined;
}

/**
 * Set the uncommented `model:` line inside the frontmatter block.
 *
 * Commented alternatives (`# model:`) and unrelated keys (`fallbackModels:`)
 * are left untouched. If no uncommented line exists, one is inserted after
 * `name:`. Returns null when the file has no usable frontmatter.
 *
 * A file that already names the model returns `src` byte-for-byte, so a pass
 * that changes nothing about where the agent points writes nothing and reports
 * `unchanged`. Canonicalising the punctuation instead would rewrite — and report
 * as `written` — a file whose effective model was already correct, which makes
 * every pass look like it did something. The comparison is on the decoded
 * value, so `model: X`, `model: "X"` and `model: X  # note` are all the same
 * model; an undecodable line is rewritten rather than assumed equal.
 */
export function upsertModel(src: string, model: string): string | null {
  const head = frontmatter(src);
  if (head === undefined) return null;
  const tail = src.slice(head.length);
  const line = `model: ${JSON.stringify(model)}`;

  if (MODEL_LINE.test(head)) {
    if (activeModel(head) === model) return src;
    return head.replace(MODEL_LINE, line) + tail;
  }
  if (/^name:[^\n]*$/m.test(head)) {
    return head.replace(/^name:[^\n]*$/m, (l) => `${l}\n${line}`) + tail;
  }
  return null;
}

/** The uncommented `thinking:` line, capturing everything after the colon. */
const THINKING_LINE = /^thinking:[ \t]*(.*?)[ \t]*$/m;

/**
 * The thinking level the uncommented `thinking:` line declares, decoded, if any.
 */
function activeThinking(head: string): string | undefined {
  const match = THINKING_LINE.exec(head);
  return match ? decodeScalar(match[1]) : undefined;
}

/**
 * Set the uncommented `thinking:` line inside the frontmatter block, beside the
 * model it applies to.
 *
 * `undefined` writes nothing at all, and that is a deliberate absence rather
 * than a default: a level no layer named is not a level of "none", so the
 * file's line is left as it is — whether the user put it there or an earlier
 * pass did — and `src` comes back byte-for-byte, which is what keeps the pass
 * reporting `unchanged`.
 *
 * There is **no removal and no restore**. The dispatcher does not remember what
 * a file said before it wrote a level, and does not put anything back when an
 * agent moves to a candidate that names none — so on a route where only the
 * alternates state a level, the level written on the way out is still there on
 * the way home. That is the honest consequence of treating this line as the
 * dispatcher's to write: the guarantee is only ever forward (`what this pass
 * resolved`), never a promise about what the file used to hold, and it is also
 * why `model:` converges on the decision while this line need not. A candidate
 * that wants its own level back states one.
 *
 * Unlike `model`, the value is written unquoted — `thinking: high` — which is
 * how pi's own agent files and the subagents plugin's editor spell it. A line
 * that is already correct is left byte-for-byte, so `thinking: "high"` is not
 * rewritten to `thinking: high`; only a value that differs is replaced.
 *
 * Returns `src` unchanged when the file has no usable frontmatter, and also when
 * its frontmatter carries neither a `model:` nor a `name:` line to hang the
 * level beside. That is unreachable from `applyDecision`, which has already
 * refused a file `upsertModel` could not rewrite, and it is the honest answer
 * for a direct call: there is nothing to write.
 */
export function upsertThinking(src: string, thinking: ThinkingLevel | undefined): string {
  if (thinking === undefined) return src;
  const head = frontmatter(src);
  if (head === undefined) return src;
  const tail = src.slice(head.length);
  const line = `thinking: ${thinking}`;

  if (THINKING_LINE.test(head)) {
    if (activeThinking(head) === thinking) return src;
    return head.replace(THINKING_LINE, line) + tail;
  }
  // Beside the model it qualifies where there is one, and after `name:`, where
  // `upsertModel` puts a model line it has to insert.
  if (MODEL_LINE.test(head)) {
    return head.replace(MODEL_LINE, (l) => `${l}\n${line}`) + tail;
  }
  if (/^name:[^\n]*$/m.test(head)) {
    return head.replace(/^name:[^\n]*$/m, (l) => `${l}\n${line}`) + tail;
  }
  return src;
}

/**
 * One `<agentDir>/<name>.md` file found on disk, with the model its frontmatter
 * currently declares.
 *
 * `model` is the value of the uncommented `model:` line, decoded — the same
 * value `upsertModel` compares against — and is absent when the file has no
 * usable frontmatter or declares no model. A file is listed without one all the
 * same: the ask names every file it found, including the ones it could not build
 * a candidate from.
 */
export interface AgentFile {
  name: string;
  file: string;
  model?: string;
  /**
   * The file is there but its frontmatter could not be read. Distinct from a
   * file that declares no model: one is a fact about the file, the other is a
   * fact about us, and the listing says which.
   */
  unreadable?: boolean;
}

/**
 * Only the frontmatter is ever read, and it sits at the top of the file, so a
 * bounded prefix is enough. Reading whole files would make every session start
 * and every `/quota-dispatch` wait on the largest markdown file someone happens
 * to keep in their agent directory.
 */
const FRONTMATTER_LIMIT = 64 * 1024;

/** The first `FRONTMATTER_LIMIT` bytes of `file`, as text. */
async function readPrefix(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(FRONTMATTER_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Every agent definition in `agentDir`, sorted by name.
 *
 * A directory that is not there reads as no files: on a fresh install it usually
 * is not there yet, and that is the state the ask is for. Reading never throws,
 * and every name found is listed — a file we cannot read is still a file the
 * user has, and "which of my files does this ignore?" is a question about what
 * is on disk.
 *
 * Discovery is deliberately not a directory listing. `stat` is used rather than
 * `readdir`'s file type because it follows symlinks (an agent file may well be
 * one) and, unlike opening the file, cannot block on a FIFO; a file that is not
 * a regular file is not an agent definition and is skipped.
 */
export async function readAgentFiles(agentDir: string): Promise<AgentFile[]> {
  let names: string[];
  try {
    names = await readdir(agentDir);
  } catch {
    return [];
  }

  const files: AgentFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = join(agentDir, name);

    let info: Stats;
    try {
      info = await stat(file);
    } catch {
      // A dangling symlink resolves to nothing, so there is no file to report.
      continue;
    }
    if (!info.isFile()) continue;

    const entry: AgentFile = { name: name.slice(0, -".md".length), file };
    try {
      const head = frontmatter(await readPrefix(file));
      const model = head === undefined ? undefined : activeModel(head);
      if (model !== undefined) entry.model = model;
    } catch {
      entry.unreadable = true;
    }
    files.push(entry);
  }

  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The candidates a startup snippet can derive from `files`, keyed by agent name.
 *
 * Shared by the snippet and the check for whether there is anything to paste, so
 * the two cannot disagree about what counts as derivable. A file is left out —
 * not guessed at — when it declares no model, when its prefix names a rail we do
 * not know, or when the config seam would reject its name; every one of those
 * would produce a table that warns the moment it is pasted.
 */
function derivableCandidates(files: AgentFile[]): Array<[string, Candidate]> {
  const candidates: Array<[string, Candidate]> = [];
  for (const file of files) {
    if (file.model === undefined) continue;
    if (agentNameRejection(file.name) !== undefined) continue;
    const rail = railFromModel(file.model);
    if (rail === undefined) continue;
    candidates.push([file.name, { model: file.model, rail }]);
  }
  return candidates;
}

/**
 * A paste-ready config fragment built from the agent files found: each file's
 * current `model:` becomes one primary, and the rail derived from that model's
 * prefix is registered once in the `models` table, so the candidates themselves
 * name only a model.
 *
 * A file whose model has no recognised prefix contributes nothing — inventing a
 * rail would be a guess the user then pastes and the loader then warns about —
 * and neither does a file that declares no model at all. Returns the lines of a
 * JSON object, so the caller can indent it into a message.
 */
export function agentTableSnippet(files: AgentFile[]): string[] {
  const models: Record<string, ModelDefault> = {};
  const agents: Record<string, { primary: { model: string } }> = {};
  for (const [name, candidate] of derivableCandidates(files)) {
    models[candidate.model] = { rail: candidate.rail };
    agents[name] = { primary: { model: candidate.model } };
  }
  return JSON.stringify({ models, agents }, null, 2).split("\n");
}

/**
 * One line per agent file found, with the model it declares, so a reader can
 * see which names exist and which of them are already pinned somewhere.
 */
export function describeAgentFiles(files: AgentFile[]): string[] {
  return files.map((file) =>
    file.unreadable
      ? `  ${file.name}.md — unreadable`
      : `  ${file.name}.md — model: ${file.model ?? "(none)"}`,
  );
}

/**
 * What a fresh, unconfigured install has to say for itself: which file to
 * configure, a paste-ready snippet built from the agent files it found, and the
 * list of those files.
 *
 * Pure, and separate from the UI call, so the wording is testable without a
 * terminal. Unlike `describeAgentFiles` this is not a report — it exists to be
 * read once, by someone who has just installed the extension.
 */
export function unconfiguredNotice(
  configPath: string,
  agentDir: string,
  files: AgentFile[],
): string[] {
  const lines = [
    "quota-dispatcher: no agents are configured, so nothing is managed yet.",
    `Name them in ${configPath} to start routing.`,
  ];

  if (derivableCandidates(files).length) {
    lines.push("For example:", "", ...agentTableSnippet(files));
  } else if (files.length) {
    // A snippet of `{"agents": {}}` would configure nothing, so say why there
    // is nothing to paste rather than print it.
    lines.push(
      "None of the agent files below declares a model whose rail can be derived, so there is no snippet to paste yet.",
    );
  }

  if (files.length) {
    lines.push("", `Agent files found in ${agentDir}:`, ...describeAgentFiles(files));
  } else {
    lines.push("", `No agent files were found in ${agentDir}.`);
  }

  lines.push("", "Then /reload. Run /quota-dispatch at any time to see what it would do.");
  return lines;
}

/**
 * The one line for a config that names a model this pi cannot spawn: the
 * notify's headline and the footer status that holds the state between asks, so
 * the interruption and the standing fact are the same words.
 *
 * "Unknown to this pi" rather than "invalid" is #14's wording, and the reason
 * this warning exists at all: the id may be perfectly good on a newer pi, and a
 * user who reads "invalid" goes hunting for a typo that is not there.
 */
const UNKNOWN_MODEL_SUMMARY = "quota-dispatcher: a configured model is unknown to this pi.";

/**
 * What an install whose config names models this pi cannot spawn has to say for
 * itself: every occurrence, at the dotted key it came from, and the files to
 * edit.
 *
 * The miss lines are `unknownModelNote`'s, verbatim, so the reader meets the
 * same sentence here as in the log and in `/quota-dispatch`'s provenance block —
 * the startup warning is a shortcut to that record, not a third telling of the
 * same fact. Pure, and separate from the UI call, for the same reason
 * `unconfiguredNotice` is.
 */
export function unknownModelsNotice(misses: ModelMiss[], configPaths: string[]): string[] {
  return [
    UNKNOWN_MODEL_SUMMARY,
    ...misses.map((miss) => unknownModelNote(miss.key, miss.model)),
    // The action last, so the occurrences above it read as the evidence for it
    // rather than as a list trailing off an instruction.
    `Edit ${configPaths.join(" or ")}, then /reload, or upgrade pi.`,
  ];
}

export async function applyDecision(
  file: string,
  model: string,
  thinking: ThinkingLevel | undefined,
  dry: boolean,
): Promise<Outcome> {
  if (!existsSync(file)) return "skipped (no file)";
  const src = await readFile(file, "utf8");
  const withModel = upsertModel(src, model);
  if (withModel === null) return "skipped (no frontmatter)";
  // The model first, so a `thinking:` line that has to be inserted lands beside
  // the model line rather than beside `name:`. `next` is compared against the
  // original source, not against `withModel`, so a pass that changed nothing at
  // all still reports `unchanged` and writes nothing.
  const next = upsertThinking(withModel, thinking);
  if (next === src) return "unchanged";
  if (dry) return "would-write";
  await writeFile(file, next, "utf8");
  return "written";
}

/**
 * One-line rendering of a decision, for reports and command output.
 *
 * A resolved thinking level is named on the line because it is part of what the
 * write does: the model is already reported in full, and "what will this agent be
 * running at" is the other half of the same answer.
 */
export function describeDecision(decision: Decision): string {
  if (decision.kind === "hold") return `${decision.agent} -> (left as is)`;
  const thinking = decision.thinking === undefined ? "" : ` (thinking: ${decision.thinking})`;
  return `${decision.agent} -> ${decision.model}${thinking}`;
}

/**
 * One decision as the lines a report prints: the decision and its outcome, then
 * the reasoning — one indented line per note.
 *
 * `why` already carries a newline between notes, because a route with several
 * alternates names one rejected or never-consulted candidate each and joining
 * them into a sentence produces a single unreadably long line. Splitting here
 * keeps the note text itself untouched and puts the layout in one place, shared
 * by the report and the `apply` output.
 */
export function describeDecisionLines(decision: Decision, outcome: Outcome): string[] {
  const [headline, ...notes] = decision.why.split("\n");
  return [
    `${describeDecision(decision)}  [${outcome}]  (${headline})`,
    ...notes.map((note) => `  ${note}`),
  ];
}

// ---------------------------------------------------------------- rails

function unavailable(rail: Rail, note: string): RailState {
  return { rail, ok: false, windows: [], note };
}

/**
 * How long one quota read may stall, and how many times it is asked again
 * before the rail reads as unreadable.
 *
 * Both numbers are small on purpose. The read is awaited by `session_start`, so
 * the point of the bound is that a vendor which has gone quiet costs a session
 * a few seconds rather than the rest of the session. The retry is the other
 * half: without it a single dropped connection reads as an outage and holds
 * every agent on the route, which is a decision made on evidence a second
 * request would have supplied.
 *
 * They are a seam rather than config-file keys: how long to wait for a socket
 * is a fact about this network, not a routing preference, and the two timings
 * only mean anything together.
 *
 * See docs/adr/0006-bounded-quota-reads.md for why the retry does not soften the
 * hold rule.
 */
export interface QuotaReadPacing {
  /** One attempt is abandoned after this long, signal and all. */
  timeoutMs: number;
  /** Attempts per rail, the first one included. */
  attempts: number;
  /** Wait between attempts. */
  backoffMs: number;
}

/** The shipped timings — see `QuotaReadPacing`. */
export const DEFAULT_QUOTA_READ: QuotaReadPacing = {
  timeoutMs: 5_000,
  attempts: 2,
  backoffMs: 250,
};

/** Waits `ms`, for the pause between two attempts at the same endpoint. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What one failed attempt is reported as, in the single line a note has room
 * for.
 *
 * A timeout is reported by its budget rather than by the exception's own text
 * ("The operation was aborted due to timeout"), because the number is the
 * actionable part — it is the one the pacing chose and the one someone would
 * change. A body that is not JSON is named as such: a reply truncated without
 * framing and a captive portal both arrive looking like this, and the parser's
 * message is the only thing that can hint at which one it was.
 *
 * A failed request is reported by the code its cause carries — `ECONNREFUSED`,
 * `ENOTFOUND`, a TLS failure — and never by its message. undici flattens a
 * network failure to a bare "fetch failed" anyway, while an error thrown while
 * *building* the request quotes the header value it rejected — and one of those
 * headers is the credential. Not repeating what a request error says about
 * itself is how this file keeps its promise that no credential is ever logged.
 */
function attemptFailure(err: unknown, timeoutMs: number): string {
  if ((err as { name?: unknown } | null)?.name === "TimeoutError") {
    return `no answer within ${timeoutMs}ms`;
  }
  if (err instanceof SyntaxError) return `unreadable body (${err.message})`;
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return code ? `request failed (${code})` : "request failed";
}

/**
 * Whether asking again could get a different answer. A 4xx is the endpoint's
 * reply — an expired token stays expired and a moved endpoint stays moved — so
 * only a server-side failure is worth a second request. A 429 is deliberately
 * not on this list: it says "too many requests", and asking again 250ms later
 * without honouring `Retry-After` is the thing it is asking us not to do.
 */
function retryableStatus(status: number): boolean {
  return status >= 500;
}

/**
 * The note a rail reads as when a failure worth retrying outlived its attempts.
 *
 * The count is said out loud only when there was more than one, so the report
 * separates the two failures `unreadable` used to cover: a reading another
 * request would not have fixed — a 401, a 429, a credential store with nothing
 * to give — from one that was asked again and given up on. Both hold, but only
 * the second is about the request rather than about what the endpoint said.
 */
function afterAttempts(note: string, attempts: number): string {
  return attempts > 1 ? `${note} after ${attempts} attempts` : note;
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

// ---------------------------------------------------------------- credentials

/**
 * One credential store's answer: the text it held, or why it could not be read.
 *
 * A store is read for its *text* rather than for a parsed token because the
 * credential file and the login keychain hold the same JSON shape, so both are
 * judged by the same parser instead of by two that could disagree.
 */
export type CredentialRead = { text: string } | { error: string };

/**
 * The raw JSON text of the macOS login keychain item Claude Code keeps its
 * subscription credential in.
 */
export type KeychainRead = () => Promise<CredentialRead>;

/**
 * Runs one command and resolves its stdout as text, or the reason it failed.
 * The seam `keychainReader` needs so that the argv it passes to `security` can
 * be tested without a keychain on the machine running the tests.
 */
export type CommandRunner = (file: string, args: string[]) => Promise<CredentialRead>;

/** The keychain item Claude Code writes its subscription credential to. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Whether the login keychain belongs to the credential file at this path.
 *
 * The keychain holds the credential of the *default* Claude Code profile only:
 * a `CLAUDE_CONFIG_DIR` profile keeps its credential in its own file and never
 * writes the keychain. A `claudeCredsPath` naming anything but the default file
 * therefore belongs to a different account, and the keychain must not answer
 * for it — reporting one account's headroom while work draws on another is
 * worse than reporting nothing.
 */
export function isDefaultClaudeCredsPath(path: string): boolean {
  return path === DEFAULT_CONFIG.claudeCredsPath;
}

/**
 * The macOS login keychain reader, or `undefined` on a platform that has no
 * such store — so that no caller can consult one that does not exist, and a
 * Linux install pays neither a subprocess nor an error line for it.
 *
 * On darwin it runs `security find-generic-password -a $USER -w -s "Claude
 * Code-credentials"`: the same call Claude Code and the Agent SDK make, against
 * the same item they write. `run` exists so that this argv is testable; the
 * real runner passes `security` a timeout, because a wedged keychain must not
 * stall the session start this is awaited from.
 */
export function keychainReader(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = execFileRead,
): KeychainRead | undefined {
  if (platform !== "darwin") return undefined;
  return () => run("security", keychainArgs());
}

/**
 * `security find-generic-password -a <user> -w -s "Claude Code-credentials"`,
 * the call that reads back what Claude Code wrote. `-a` is omitted only when
 * the user cannot be determined at all, in which case searching by service
 * alone is still the right guess; the keychain is per-user either way.
 */
function keychainArgs(): string[] {
  const account = currentUser();
  return [
    "find-generic-password",
    ...(account ? ["-a", account] : []),
    "-w",
    "-s",
    CLAUDE_KEYCHAIN_SERVICE,
  ];
}

/** `$USER` first, as the SDK does, then the passwd entry — which can be absent. */
function currentUser(): string | undefined {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * A stalled keychain must not stall the session start this read is awaited
 * from, so the read is bounded the way the vendors' own clients bound it.
 */
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * How long one refresh ping may run.
 *
 * Longer than a keychain read because it does far more work — a binary's start
 * plus a token refresh — and because its failure lasts longer: an expired token
 * stays expired for the rest of the day, where a missed keychain read costs one
 * reading. The measurements behind the number, and the residual risk of killing
 * a run whose token request is in flight, are in
 * docs/adr/0007-refresh-pings.md.
 *
 * The bound need not be tight to be safe, which is what makes it holdable: the
 * refresh is written *before* the request is dispatched, so whatever landed is
 * found by the re-read either way.
 */
const CLAUDE_PING_TIMEOUT_MS = 10_000;

/**
 * How long after a failed ping before another may be made.
 *
 * A dead refresh token must not mean a subprocess per poll: `pollMs` ships at
 * five minutes, so without this every poll for the rest of the day would start
 * one. This is a time gate, armed by a `failed` attempt only — a transient
 * failure worth exactly one retry, a missing binary or a stall before any
 * request. An attempt that could have spent money, or ran without effect, arms
 * the permanent `halted` instead (see `recordVerdict`).
 */
export const CLAUDE_PING_COOLDOWN_MS = 900_000;

/**
 * The real runner, for one subprocess: its stdout is the value read back, and a
 * failure is reported as the one line a reader can act on — what the command
 * said, its exit code when it said nothing, or the reason the process never ran.
 *
 * `env` narrows the child's environment; left off, the child inherits this
 * process's, which is what every runner here but the refresh ping wants.
 */
export function execFileRunner(timeoutMs: number, env?: NodeJS.ProcessEnv): CommandRunner {
  return (file, args) =>
    new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          ...(env === undefined ? {} : { env }),
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ text: stdout.trim() });
          resolve({ error: failureDetail(err, stderr, timeoutMs) });
        },
      );
      // A child that reads stdin would otherwise wait for input that is never
      // coming until the timeout kills it; ending the pipe hands it EOF instead.
      //
      // Spawn's `stdio: ["ignore", ...]` cannot do this, because `execFile`
      // discards that option and rebuilds its own spawn options — a `cat` run
      // through the documented form still hung for the full timeout.
      child.stdin?.end();
    });
}

/** The keychain read: `security`'s stdout is the credential JSON itself. */
const execFileRead: CommandRunner = execFileRunner(CLAUDE_KEYCHAIN_TIMEOUT_MS);

/**
 * One line, because this ends up in a one-line report: the command's own
 * message when it printed one, otherwise the spawn failure's.
 */
function failureDetail(err: Error, stderr: string, timeoutMs: number): string {
  if ((err as { killed?: boolean }).killed) return `timed out after ${timeoutMs}ms`;
  const said = firstLine(stderr) ?? firstLine(err.message);
  const code = (err as { code?: unknown }).code;
  return said ?? (typeof code === "number" ? `exit ${code}` : "failed");
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * Why no store supplied a token, as the one distinction the caller acts on.
 *
 *   `expired`   a store answered and the token it holds has run out. Claude
 *               Code refreshing that store is exactly the fix, so this is the
 *               one failure a refresh ping is started for.
 *   `unusable`  no store answered, or none held a token at all. A ping would
 *               leave every one of those reasons standing.
 *
 * The message names the store and the cause; the tag exists so that nothing has
 * to read the message to know whether a ping is worth trying.
 */
export type TokenFailure = "expired" | "unusable";

/** One store's refusal, or both stores' refusals joined into one message. */
export interface ClaudeTokenError {
  error: string;
  reason: TokenFailure;
}

/** The Claude rail's token, or why no store supplied one. */
export type ClaudeToken = { token: string } | ClaudeTokenError;

/**
 * A store that answered with a failure of its own — a keychain read that could
 * not run, a file that could not be opened. Nothing a refresh ping fixes, which
 * is what makes it `unusable` rather than `expired`: the store never got as far
 * as a token whose age could be the problem.
 */
function storeFailure(error: string): ClaudeTokenError {
  return { error, reason: "unusable" };
}

/**
 * Pulls `claudeAiOauth.accessToken` out of one store's JSON text.
 *
 * `now` is a parameter rather than a call to `Date.now()` so that the expiry
 * comparison stays a pure function of its inputs. A token carrying no
 * `expiresAt` is used: the shaping Claude Code writes always carries one, and a
 * missing field is not evidence of expiry.
 *
 * The expiry message is the *fact* only — "claude token expired" — because it
 * is the first half of the note `fetchClaude` composes, and the second half is
 * whatever decision was made about it. Naming an action here would tell a
 * bridge user to run a command that only refreshes a credential the bridge
 * already owns.
 */
export function parseClaudeToken(text: string, now: number): ClaudeToken {
  let oauth: any;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch (err) {
    return storeFailure(`unreadable claude credentials: ${(err as Error).message}`);
  }
  if (!oauth?.accessToken) return storeFailure("no claudeAiOauth.accessToken");
  // Claude Code refreshes this on use; we only read it.
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < now) {
    return { error: "claude token expired", reason: "expired" };
  }
  return { token: oauth.accessToken };
}

export interface ClaudeTokenDeps {
  /**
   * Fallback store, consulted only when the file yields no usable token.
   *
   * On macOS the file is the store Claude Code *used* to write: the live token
   * lives in the login keychain, and only Claude Code refreshes it there. A file
   * that has gone stale is therefore the normal state for a machine driven
   * through a bridge rather than through `claude` directly.
   */
  keychain?: KeychainRead;
  /** Epoch milliseconds for the expiry comparison. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * The Claude rail's token, or why no store could supply one.
 *
 * The credential file is read first, so a healthy file behaves exactly as it
 * did before the keychain was consulted at all and an install with no keychain
 * pays nothing for it. Only when the file cannot answer — absent, unreadable,
 * shapeless, or holding an expired token — is the fallback read, and either
 * store's token wins on equal terms: the first one that yields an unexpired
 * token is the answer.
 *
 * When neither yields a token the error names both reasons, the file's first
 * and the keychain's as `; keychain: <reason>`, because "why can't the Claude
 * rail be read" is only answerable if the user learns that both stores were
 * tried and how each failed. With no fallback the note is the file's reason
 * alone.
 *
 * The reason the read failed travels beside that message. A ping is worth
 * starting when *any* store answered with an expiry — Claude Code refreshes the
 * store it writes, which on Linux is this file and on macOS is the login
 * keychain, and either one expiring is the case the ping fixes. A store that
 * could not be read at all is a different problem, a locked keychain or a
 * permission, and does not on its own call for one.
 */
export async function readClaudeToken(
  path: string,
  deps: ClaudeTokenDeps = {},
): Promise<ClaudeToken> {
  const now = deps.now ?? Date.now();

  let file: CredentialRead;
  if (!existsSync(path)) {
    file = { error: "no claude credentials file" };
  } else {
    try {
      file = { text: await readFile(path, "utf8") };
    } catch (err) {
      file = { error: `unreadable claude credentials: ${(err as Error).message}` };
    }
  }
  const fromFile: ClaudeToken = "text" in file ? parseClaudeToken(file.text, now) : storeFailure(file.error);
  if ("token" in fromFile) return fromFile;
  if (!deps.keychain) return fromFile;

  const read = await deps.keychain();
  const fromKeychain: ClaudeToken =
    "text" in read ? parseClaudeToken(read.text, now) : storeFailure(read.error);
  if ("token" in fromKeychain) return fromKeychain;
  return {
    error: `${fromFile.error}; keychain: ${fromKeychain.error}`,
    reason: fromFile.reason === "expired" || fromKeychain.reason === "expired" ? "expired" : "unusable",
  };
}

/**
 * The loopback socket a refresh ping's model request is diverted to.
 *
 * A listener rather than an unroutable port, for two reasons measured in
 * docs/adr/0007-refresh-pings.md: it ends the run promptly, and a request
 * *arriving* is the only evidence that the diversion took effect — the command
 * exits non-zero either way, so a run that died on this socket and one that
 * failed to authenticate are indistinguishable by exit status. Without that
 * evidence an override which silently did not apply would spend a real request
 * while being reported as a failed refresh.
 */
export interface PingListener {
  /** The base URL the ping's `--settings` carries. */
  url: string;
  /**
   * Whether the diverted request turned up.
   *
   * Headers are never read: the request carries the freshly refreshed access
   * token in an `Authorization` header, and a listener that recorded one would
   * be the only place in this extension that holds a credential.
   */
  arrived(): boolean;
  /**
   * The socket's own failure after it began listening, if any.
   *
   * A live listener has no caller left to reject, so an `'error'` event cannot
   * be passed up the way a failed bind is; dropping it would take the whole pi
   * process down, and swallowing it would let a broken socket masquerade as a
   * clean exit that never reached the listener. Recorded here so the refresher
   * reports it as the failure it is.
   */
  error(): string | undefined;
  close(): Promise<void>;
}

/** Opens a listener. A seam, so the refresher's failure paths are testable. */
export type PingListenerFactory = () => Promise<PingListener>;

/**
 * What became of one refresh ping.
 *
 * Cases rather than a success flag, because the caller does three different
 * things with the answer: the rail's note is built from how the attempt went,
 * `failed` arms a cooldown, and the outcomes that could have spent money or ran
 * without effect arm a halt for the rest of the expiry. The credential is
 * re-read after any of them, including `failed`: the refresh is written *before*
 * the request is dispatched, so a command that failed afterwards can still have
 * left a fresh token behind.
 */
export type ClaudePing =
  /**
   * The command ran far enough to dispatch its model request — in the diverted
   * form, the request arrived on our own listener. Whether a fresh token came
   * back is the store's answer, not ours: re-read it.
   */
  | { outcome: "pinged" }
  /**
   * Another Claude Code process holds the refresh lock and is refreshing the
   * token itself. Benign, and a deferral rather than a failure: the next read is
   * what finds its work.
   */
  | { outcome: "deferred"; note: string }
  /**
   * The command exited cleanly with no request on the listener.
   *
   * A clean exit means the model call was *answered* — so it was answered
   * somewhere else, and the diversion this whole design rests on may have
   * silently failed at the cost of a real request. Deliberately not `failed`:
   * `failed` is "nothing appears to have happened", this is "something happened
   * and it was not what we asked for".
   */
  | { outcome: "undiverted"; note: string }
  /** The ping could not be run, or ran and failed before dispatching. */
  | { outcome: "failed"; note: string };

/** One refresh ping: makes Claude Code refresh its own credential. */
export type ClaudeRefresh = () => Promise<ClaudePing>;

/**
 * The argv of one refresh ping.
 *
 * `divertTo` is the loopback listener's base URL, carried in `--settings`
 * because that is the one way to hand it over without widening `CommandRunner`
 * past `(file, args)`. Without it the ping is a real request — the `ping` mode,
 * which spends a real answer's worth of tokens.
 *
 * There is no `--model`. An id the running install does not recognise is
 * rejected client-side, before authentication is reached, which is the one
 * outcome that would defeat the whole exercise; and the diverted form encodes
 * nothing, so no model need be named to ask for it.
 */
export function claudePingArgs(divertTo?: string): string[] {
  if (divertTo === undefined) return ["-p", "hi"];
  return ["-p", "hi", "--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: divertTo } })];
}

/**
 * Vendor text: Claude Code saying another of its processes is already holding
 * the refresh lock. Matched loosely because the wording is not ours and may
 * change; a miss is harmless — the attempt is reported as failed and arms one
 * 15-minute cooldown, which costs a retry delay and never a wrong answer.
 */
const REFRESH_LOCK_RE = /refresh lock/i;

/**
 * What a diverted ping that exited cleanly without dispatching is reported as,
 * in one line.
 *
 * Fixed rather than quoting whatever the command printed: a clean-exit run that
 * never dispatched reached its failure in Claude Code's own output, which names
 * the account, so the note must carry none of it.
 */
const PING_UNDIVERTED_NOTE = "claude exited before the request reached the loopback listener";

/**
 * The refresh ping for one mode, or `undefined` when the mode is `off` — so that
 * no caller can run one that is not enabled, the shape `keychainReader` uses for
 * a platform with no keychain.
 *
 * `run` and `listen` are seams: the first so every argument and failure path can
 * be tested without a `claude` on the machine running the tests, the second so
 * that "no request arrived" can be tested without a socket.
 *
 * The diverted mode is judged by arrival, not by exit status. The 400 the
 * listener answers with makes the command exit non-zero on its own, so a run
 * that landed the refresh and a run that failed to authenticate look identical
 * from outside; only a request on our own socket proves the diversion took
 * effect — and an override that silently did not would spend a real request.
 * `ping` mode has no listener to prove anything with, so there a clean exit is
 * the proof that a real answer came back.
 */
export function claudeRefresher(
  mode: ClaudeRefreshMode,
  run: CommandRunner = execFileRunner(CLAUDE_PING_TIMEOUT_MS, claudePingEnv(process.env)),
  listen: PingListenerFactory = loopbackListener,
): ClaudeRefresh | undefined {
  if (mode === "off") return undefined;

  if (mode === "ping") {
    return async () => {
      const result = await run("claude", claudePingArgs());
      if ("text" in result) return { outcome: "pinged" };
      if (REFRESH_LOCK_RE.test(result.error)) return { outcome: "deferred", note: oneLine(result.error) };
      return { outcome: "failed", note: oneLine(result.error) };
    };
  }

  return async () => {
    let listener: PingListener;
    try {
      listener = await listen();
    } catch (err) {
      return { outcome: "failed", note: `could not open the loopback listener: ${oneLine(detail(err))}` };
    }
    let result: CredentialRead;
    try {
      result = await run("claude", claudePingArgs(listener.url));
    } catch (err) {
      result = { error: detail(err) };
    } finally {
      // In a `finally` so a throwing runner still frees the port; the session
      // start awaits this path, and a socket left open is a session left waiting.
      await listener.close();
    }
    if (listener.arrived()) return { outcome: "pinged" };
    // A socket of our own that broke is a failure, and naming it keeps it from
    // reading as the clean exit that never diverted — which would halt the
    // feature for the session on the strength of our own bug.
    const listenerError = listener.error();
    if (listenerError !== undefined) {
      return { outcome: "failed", note: `loopback listener failed: ${oneLine(listenerError)}` };
    }
    if ("error" in result && REFRESH_LOCK_RE.test(result.error)) {
      return { outcome: "deferred", note: oneLine(result.error) };
    }
    // A clean exit with no arrival: the request was answered somewhere else.
    if ("text" in result) return { outcome: "undiverted", note: PING_UNDIVERTED_NOTE };
    return { outcome: "failed", note: oneLine(result.error) };
  };
}

/**
 * The variables a refresh ping must not inherit.
 *
 * The ping exists to refresh *the* credential this dispatcher read, but it
 * inherits pi's environment, and the env can point Claude Code somewhere else in
 * four ways: which credential it uses, which provider serves the request, where
 * the request goes, and which model answers. A provider switch or a base URL
 * that this extension does not know about moves the model request off our
 * listener entirely, so the diverted ping becomes a billed request against
 * another provider — the one thing the diversion exists to prevent. `HOME` and
 * `PATH` are deliberately kept: the child still has to be an ordinary Claude
 * Code run.
 *
 * A denylist rather than an allowlist because the child must still run normally:
 * an allowlist would also have to be right about everything the child *needs* —
 * `PATH`, `HOME`, the login keychain, proxies — and being wrong there turns a
 * working refresh into a silent failure. An allowlist is worth doing once
 * someone has checked one against a live credential. The residual is bounded: a
 * selection variable this list does not know about shows up as an `undiverted`
 * run, which halts for the session — one request at worst, never a loop.
 */
const CLAUDE_PING_ENV_EXCLUDE = [
  // Which credential it uses.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  // Which provider serves the request.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_CCR_V",
  // Where the request goes.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "CLAUDE_CODE_API_BASE_URL",
  // Which credential store or OAuth endpoint.
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  // Which model answers: an unrecognised id is rejected before authentication,
  // which would defeat the exercise.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
] as const;

/**
 * The environment one refresh ping runs under.
 *
 * Everything else — `PATH`, `HOME`, proxies, locale — is inherited, because the
 * child still has to be an ordinary Claude Code run. Pure, so the exact set of
 * variables is pinned by a test rather than by prose.
 */
export function claudePingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of CLAUDE_PING_ENV_EXCLUDE) delete clean[key];
  return clean;
}

/** The single line a failed command is reported by, whatever length it printed. */
function oneLine(detail: string): string {
  return firstLine(detail) ?? "claude failed";
}

/** An error's takeaway for a note: its message when it has one, else its text. */
function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A loopback listener on an ephemeral port, bound to 127.0.0.1 only.
 *
 * The port is the OS's to choose, so there is no collision to handle and no
 * fixed port to be occupied. Every request is answered at once with a 400: enough
 * for the client to give up rather than retry, and a body it never has to write.
 * The body is drained, never inspected — the request carries the freshly
 * refreshed access token in an `Authorization` header, and a listener that read
 * one would be the only place in this extension holding a credential.
 */
export const loopbackListener: PingListenerFactory = async () => {
  let arrived = false;
  let listenerError: string | undefined;
  const server = createServer((req, res) => {
    arrived = true;
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "offline ping" } }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // A listening socket has no caller left to reject, but an `'error'` event with
  // no listener takes the whole pi process down with it. Record it instead: the
  // refresher reports the socket's own failure rather than letting it masquerade
  // as a clean exit that never reached the listener.
  server.on("error", (err) => {
    listenerError ??= detail(err);
  });

  const address = server.address();
  // A TCP listener always yields an `AddressInfo`, so anything else here is a
  // failure to report rather than a port to invent a URL around.
  if (typeof address !== "object" || address === null) {
    await closeServer(server);
    throw new Error("loopback listener bound no TCP port");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    arrived: () => arrived,
    error: () => listenerError,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
};

/**
 * Ends every open connection before closing, so the close resolves promptly.
 *
 * `server.close` otherwise waits for the ping client's keep-alive socket to
 * end, and the session start awaits this refresh, so a close that waited out a
 * keep-alive would stall the very path the ping exists to unblock.
 *
 * The callback's error is deliberately dropped: it only ever means the server
 * was not listening, and the port is free either way, so there is nothing to
 * report and nothing to do about it.
 */
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * What an expired token will be met with: a ping, or the reason none can run.
 *
 * The mode and the default-path rule are both decided here so that the read
 * which skips a ping and the setup which would run one cannot disagree about
 * why.
 */
export type RefreshPlan = { ping: ClaudeRefresh; spends: boolean } | { skip: string };

/**
 * The single place the mode and the default-path rule are resolved.
 *
 * `injected` wins over both, as it does for the keychain reader: a test's
 * injected ping is a statement about which process may be spawned, and the
 * default-path rule is about whose *platform* keychain the default credential
 * file belongs to.
 *
 * `spends` marks the one mode whose every attempt is a real request, so a
 * failure there can only be answered by paying again — which is what makes it a
 * halt rather than a cooldown.
 */
export function refreshPlan(cfg: DispatcherConfig, injected?: ClaudeRefresh): RefreshPlan {
  if (injected) return { ping: injected, spends: cfg.claudeRefresh === "ping" };
  if (!isDefaultClaudeCredsPath(cfg.claudeCredsPath)) {
    return { skip: "claudeCredsPath names another profile" };
  }
  const ping = claudeRefresher(cfg.claudeRefresh);
  if (!ping) return { skip: 'claudeRefresh is "off"' };
  return { ping, spends: cfg.claudeRefresh === "ping" };
}

/** Why no ping was run, in the shape an expired rail's note carries it. */
function skippedNote(reason: string): string {
  return `no refresh ping was run (${reason})`;
}

/**
 * The rail's note for an expired credential: the credential layer's own message
 * — the fact, naming both stores when both were tried — then what was decided
 * about it. The decision is appended rather than substituted so that a keychain
 * which could not be read is not lost behind a ping's verdict.
 */
function expiredNote(fact: string, decision: string): string {
  return `${fact}; ${decision}`;
}

/** The suffix a halted note carries, so the rail says no further attempt is coming. */
const HALT_SUFFIX = "no further attempt will be made";

/**
 * The suffix the sticky halt carries. It is the one difference from the
 * per-episode halt: the per-episode one ends with the expiry, the sticky one
 * with the pi process, and the rail has to say so or the user will read the
 * still-off feature as a bug.
 */
const STICKY_HALT_SUFFIX = "no further attempt will be made this session";

function haltNote(note: string): string {
  return `${note}; ${HALT_SUFFIX}`;
}

function stickyHaltNote(note: string): string {
  return `${note}; ${STICKY_HALT_SUFFIX}`;
}

/**
 * The line one attempt adds to the rail's note. `pinged`'s line is only known
 * after the re-read, so it is stated here as what a still-unusable store makes
 * of it rather than as the verdict itself; the re-read's own failure — expired
 * or a locked keychain — is the fact the note is built around.
 */
function describePing(result: ClaudePing): string {
  if (result.outcome === "pinged") return "refresh ping ran but the credential is still not usable";
  return `refresh ping ${result.outcome}: ${result.note}`;
}

export interface DispatcherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Agents whose primary this pi cannot spawn, by agent name, each carrying the
   * model id it did not recognise — the `held` record `checkModels` returns.
   *
   * They are held rather than evaluated: a model that cannot be spawned is known
   * bad, so no quota reading could change the answer, and the agent's file is
   * left exactly as the user left it. Absent or empty, every configured agent is
   * decided the ordinary way.
   */
  held?: Readonly<Record<string, string>>;
  /**
   * The alternates `checkModels` dropped, by agent name — the
   * `droppedAlternates` record of the same result.
   *
   * Needed because the config that comes back from the check cannot say whether
   * a route with no alternates started that way or lost them. Absent or empty,
   * an empty `alternates` list reads as the user's own `[]`.
   */
  droppedAlternates?: Readonly<Record<string, readonly DroppedAlternate[]>>;
  /**
   * Fallback credential store for the Claude rail. Left unset, production takes
   * whichever one this platform has; tests inject a fake so that they never
   * read, or prompt for, the keychain of the machine they run on. An injected
   * reader is used whatever `claudeCredsPath` names — the default-path
   * restriction is about which profile the *platform's* keychain belongs to,
   * and an injected reader is a statement about that already.
   */
  readKeychain?: KeychainRead;
  /**
   * The refresh ping for an expired Claude credential, or `undefined` when
   * nothing may be run — which is what `claudeRefresh: "off"` compiles to.
   * Left unset, production takes it from `claudeRefresh`, and only for the
   * default credential path: the ping refreshes this machine's default Claude
   * Code profile and can say nothing about another one. Tests inject a ping so
   * that no `claude` is ever spawned, and an injected ping is used whatever
   * `claudeRefresh` and `claudeCredsPath` say, for the same reason an injected
   * keychain reader is.
   */
  refreshClaude?: ClaudeRefresh;
  /**
   * Timings for the two bounded quota reads, overriding `DEFAULT_QUOTA_READ`
   * field by field. Tests inject small ones so the timeout and retry paths can
   * be exercised without waiting out the shipped timings, which is also why
   * they are a seam here rather than config-file keys — see `QuotaReadPacing`.
   */
  quotaRead?: Partial<QuotaReadPacing>;
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
  // Merged field by field rather than spread, so an injected `undefined` reads
  // as "not stated" instead of replacing a shipped timing with one that has no
  // value at all.
  const pacing: QuotaReadPacing = {
    timeoutMs: deps.quotaRead?.timeoutMs ?? DEFAULT_QUOTA_READ.timeoutMs,
    attempts: deps.quotaRead?.attempts ?? DEFAULT_QUOTA_READ.attempts,
    backoffMs: deps.quotaRead?.backoffMs ?? DEFAULT_QUOTA_READ.backoffMs,
  };
  const cache = new Map<Rail, { at: number; state: RailState }>();
  // A `claudeCredsPath` naming anything but the default file belongs to another
  // profile, whose credential the login keychain never holds — so the fallback
  // is not offered to it.
  const keychain =
    deps.readKeychain ??
    (isDefaultClaudeCredsPath(cfg.claudeCredsPath) ? keychainReader() : undefined);
  // The mode and the default-path rule are resolved once, here, so the read that
  // skips a ping and the plan that would run one cannot disagree about why.
  const plan = refreshPlan(cfg, deps.refreshClaude);

  // One ping in flight at a time, however many callers race `railState`.
  let inFlight: Promise<ClaudePing> | undefined;
  // The gates over the next attempt. `cooldown` is a time gate armed by a
  // `failed` attempt only. `halted` is armed by anything that could have spent
  // money or ran without effect, and is cleared only by a read that yields a
  // usable token — the end of the expiry episode. `stickyHalt` is the one
  // exception: an `undiverted` run is a statement about the environment, not
  // about that expiry, so the next expiry would pay again; it survives a usable
  // token and only a new pi process clears it.
  //
  // A gate hit never re-arms any of them: `pollMs` ships at five minutes and the
  // cooldown at fifteen, so a hit that re-armed would push the retry out forever
  // and the ping would never be tried again after a transient failure.
  let cooldown: { at: number; note: string } | undefined;
  let halted: string | undefined;
  let stickyHalt: string | undefined;

  /**
   * A vendor's usage document, read under a timeout and retried while the
   * failure is one another attempt could fix.
   *
   * Every attempt carries its own `AbortSignal.timeout`, because a stalled
   * endpoint is the worst case rather than a mild one: a request that never
   * answers is not a request that failed, so without the bound it would hold
   * the evaluation that `session_start` awaits for as long as the vendor felt
   * like staying quiet.
   *
   * The body read is inside the attempt on purpose. The signal stays attached
   * to the response, so a body that stalls mid-stream is abandoned by the same
   * deadline instead of hanging past it.
   *
   * What comes back is either the parsed document or the note the rail is
   * unreadable for. The note carries an attempt count only when the read was
   * given up on: an answer another request would only repeat — a 4xx, a 429 —
   * is reported as that answer alone. The shape problem ("no usage windows
   * returned") is left to the caller, because a well-formed answer we cannot use
   * is still an answer.
   */
  async function readUsage(
    url: string,
    init: RequestInit,
  ): Promise<{ json: unknown } | { note: string }> {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await sleep(pacing.backoffMs);
      let note: string;
      let retry: boolean;
      try {
        const res = await doFetch(url, {
          ...init,
          signal: AbortSignal.timeout(pacing.timeoutMs),
        });
        if (res.ok) return { json: await res.json() };
        note = `HTTP ${res.status}`;
        retry = retryableStatus(res.status);
      } catch (err) {
        // Everything thrown here is a failure of the request or of its payload:
        // a dropped connection, a timeout — the signal stays attached to the
        // response, so even a body that stalls mid-stream is abandoned by the
        // same deadline — or a body that is not JSON at all, which is what a
        // truncated reply and a captive portal both look like.
        note = attemptFailure(err, pacing.timeoutMs);
        retry = true;
      }
      if (!retry) return { note };
      if (attempt >= pacing.attempts) return { note: afterAttempts(note, attempt) };
    }
  }

  /** The Claude rail's ordinary read, once a token has been supplied. */
  async function claudeUsage(token: string): Promise<RailState> {
    const read = await readUsage("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
    if ("note" in read) return unavailable("claude", read.note);

    const windows = parseClaudeUsage(read.json);
    if (!windows.length) return unavailable("claude", "no usage windows returned");
    return { rail: "claude", ok: true, windows };
  }

  /**
   * The line one verdict earns, and the gate it arms. `undefined` for a verdict
   * whose meaning is only known after the re-read — `pinged`.
   *
   * A `failed` attempt in the mode that spends budget, or an `undiverted` one,
   * can only be repeated by paying again or by running again without effect, so
   * both halt — but the two halts differ in lifespan. `undiverted` is sticky: a
   * usable token does not clear it, because the next expiry would fail to divert
   * the same way and pay again. The spending mode's halt is per-episode, like
   * the `pinged`-without-a-token halt set below. A `deferred` attempt is
   * reported but arms nothing: another process is doing the work, so the next
   * read may try again.
   */
  function recordVerdict(verdict: ClaudePing, spends: boolean): string | undefined {
    if (verdict.outcome === "pinged") return undefined;
    const note = describePing(verdict);
    if (verdict.outcome === "deferred") return note;
    if (verdict.outcome === "undiverted") {
      stickyHalt = stickyHaltNote(note);
      return stickyHalt;
    }
    if (spends) {
      halted = haltNote(note);
      return halted;
    }
    cooldown = { at: now(), note };
    return note;
  }

  /**
   * The Claude rail's token, or the note the rail is unreadable for.
   *
   * One operation because its parts are not separable: the gate must be
   * consulted before an attempt, the attempt's verdict arms the next gate, and
   * the re-read is what decides whether the attempt worked — the refresh is
   * written *before* the request is dispatched, so even a run that failed
   * afterwards can have left a fresh token behind.
   *
   * A caller that arrives while an attempt is in flight awaits that same
   * attempt, so concurrent evaluations spawn one `claude`. Only an expiry earns
   * one: a 401 is an answer about a token just read, and a 429 is the usage
   * endpoint asking us to slow down (ADR 0006).
   *
   * A usable token carries the sticky anomaly back out with it rather than
   * swallowing it: `undiverted` is the case that most likely paid for a real
   * request, and reporting it — in the successful rail's own line — is the whole
   * reason the halt exists.
   */
  async function claudeToken(): Promise<{ token: string; note?: string } | { note: string }> {
    const first = await readClaudeToken(cfg.claudeCredsPath, { keychain, now: now() });
    if ("token" in first) {
      // A usable token is the end of the expiry episode, so the per-episode halt
      // it armed is cleared here and nowhere else. The sticky one is not: it is
      // a property of the environment, not of this expiry.
      halted = undefined;
      return stickyHalt === undefined ? { token: first.token } : { token: first.token, note: stickyHalt };
    }
    if (first.reason !== "expired") return { note: first.error };
    if ("skip" in plan) return { note: expiredNote(first.error, skippedNote(plan.skip)) };

    // A gate hit returns the note its attempt earned, without re-arming. The
    // sticky halt outranks the per-episode one: once the environment has failed
    // to divert, no attempt is worth making whatever else is armed.
    const gate = stickyHalt ?? halted;
    if (gate !== undefined) return { note: expiredNote(first.error, gate) };
    if (cooldown && now() - cooldown.at < CLAUDE_PING_COOLDOWN_MS) {
      return { note: expiredNote(first.error, cooldown.note) };
    }

    const verdict = await (inFlight ??= plan.ping().finally(() => { inFlight = undefined; }));
    const decision = recordVerdict(verdict, plan.spends);

    const reread = await readClaudeToken(cfg.claudeCredsPath, { keychain, now: now() });
    if ("token" in reread) {
      halted = undefined;
      return stickyHalt === undefined ? { token: reread.token } : { token: reread.token, note: stickyHalt };
    }
    // `pinged` but still nothing usable: the run dispatched a request and the
    // store gained nothing, so another one would not either.
    if (decision === undefined) {
      halted = haltNote(describePing(verdict));
      return { note: expiredNote(reread.error, halted) };
    }
    return { note: expiredNote(reread.error, decision) };
  }

  async function fetchClaude(): Promise<RailState> {
    const outcome = await claudeToken();
    if (!("token" in outcome)) return unavailable("claude", outcome.note);
    const state = await claudeUsage(outcome.token);
    if (outcome.note === undefined) return state;
    return { ...state, note: state.note === undefined ? outcome.note : `${state.note}; ${outcome.note}` };
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

    const read = await readUsage("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${cred.access}`,
        "ChatGPT-Account-Id": cred.accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if ("note" in read) return unavailable("codex", read.note);

    const { windows, limited } = parseCodexUsage(read.json);
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
    const decisions = Object.entries(cfg.agents).map(([agent, route]) =>
      deps.held && Object.hasOwn(deps.held, agent)
        ? heldDecision(agent, cfg, deps.held[agent])
        : decide(agent, route, rails, cfg, deps.droppedAlternates?.[agent] ?? []),
    );
    return Promise.all(
      decisions.map(async (decision) => ({
        decision,
        // A hold carries no model, so there is nothing to write and the file
        // is left exactly as the user left it.
        outcome:
          decision.kind === "hold"
            ? ("held" as const)
            : await applyDecision(decision.file, decision.model, decision.thinking, dry),
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
      else {
        const windows = s.windows.map((w) => `${w.label} ${w.used.toFixed(0)}%`).join(", ");
        // A note on an otherwise healthy rail — the sticky refresh anomaly, or
        // Codex's `limit_reached=true` — is a note the reader needs; dropping it
        // here is what would make "an anomaly to report" report nothing.
        lines.push(`${rail}: ${windows}${s.note === undefined ? "" : ` — ${s.note}`}`);
      }
    }
    lines.push("");
    for (const { decision, outcome } of await decideAll(rails, true)) {
      lines.push(...describeDecisionLines(decision, outcome));
    }

    // Unlike the startup ask, this form reports unmanaged files whenever there
    // are any. It is the diagnostic, and "which of my files is this ignoring?"
    // is a question a configured install asks too; the ask stays quiet about
    // them because a configured install deliberately does not manage them.
    const unmanaged = (await readAgentFiles(cfg.agentDir)).filter(
      (file) => !Object.hasOwn(cfg.agents, file.name),
    );
    if (unmanaged.length) {
      lines.push(
        "",
        `unmanaged agent files in ${cfg.agentDir} (no route names them):`,
        ...describeAgentFiles(unmanaged),
      );
    }
    return lines;
  }

  return { railState, allRails, evaluate, report };
}

// ---------------------------------------------------------------- extension

/** Footer status key, so the line can be replaced and later cleared. */
const STATUS_KEY = "quota-dispatch";

/** The footer line an unconfigured install carries until its table is filled. */
const STATUS_TEXT = "quota-dispatcher: no agents configured";

/**
 * The session reasons a fresh, unconfigured install asks for configuration on.
 *
 * `resume` and `fork` are deliberately not among them: they continue work the
 * user is already in the middle of, and a setup warning is noise at that moment.
 * The footer status still reports the state on those reasons, because that is a
 * standing fact rather than an interruption.
 */
const ASK_REASONS: ReadonlySet<SessionStartEvent["reason"]> = new Set(["startup", "new", "reload"]);

/**
 * Nothing is managed until the table names something. An empty table means no
 * quota request, no poll interval and no evaluation — the extension has no
 * opinion about files the user never named, and must not spend an HTTP call
 * discovering that.
 */
function managesNothing(cfg: DispatcherConfig): boolean {
  return Object.keys(cfg.agents).length === 0;
}

/**
 * Footer status is a rendering, so it obeys `hasUI` exactly as the notify does:
 * in print and JSON modes there is no footer to hold a line.
 */
function setFooterStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

/**
 * The ask, and the status that holds the state between asks. Split out so the
 * handler reads as the decision it is making — configured or not — rather than
 * as UI plumbing.
 */
async function announceUnconfigured(
  loaded: LoadedConfig,
  ctx: ExtensionContext,
  reason: SessionStartEvent["reason"],
): Promise<void> {
  setFooterStatus(ctx, STATUS_TEXT);
  if (!ctx.hasUI || !ASK_REASONS.has(reason)) return;

  const { agentDir } = loaded.config;
  const configPath =
    loaded.files.find((file) => file.source === "global")?.path ?? globalConfigPath();
  const files = await readAgentFiles(agentDir);
  ctx.ui.notify(unconfiguredNotice(configPath, agentDir, files).join("\n"), "warning");
}

/**
 * The config file to edit for each unknown model id.
 *
 * The fallback names the file a user would create: a miss names a candidate of
 * the effective table, and every candidate there was written by some layer, so
 * the fallback is unreachable — a better failure than naming none.
 */
function unknownModelConfigPaths(misses: ModelMiss[], loaded: LoadedConfig): string[] {
  const paths = configFilesFor(loaded, misses.map((miss) => miss.key));
  return paths.length ? paths : [globalConfigPath()];
}

/**
 * The warning for a config this pi cannot fully use, and the footer line that
 * holds the state between warnings.
 *
 * The footer is set on every reason and the notify fires only on the three that
 * ask for setup. That split is #13's, and it earns its keep most on `resume`,
 * where no notify ever fires: without the footer the only trace of a model the
 * dispatcher is quietly stepping over would be the console line, which scrolls
 * past at session start.
 */
function announceUnknownModels(
  misses: ModelMiss[],
  loaded: LoadedConfig,
  ctx: ExtensionContext,
  reason: SessionStartEvent["reason"],
): void {
  if (misses.length === 0) {
    setFooterStatus(ctx, undefined);
    return;
  }

  setFooterStatus(ctx, UNKNOWN_MODEL_SUMMARY);
  if (!ctx.hasUI || !ASK_REASONS.has(reason)) return;
  ctx.ui.notify(unknownModelsNotice(misses, unknownModelConfigPaths(misses, loaded)).join("\n"), "warning");
}

export default function (pi: ExtensionAPI) {
  /**
   * Config is resolved once per extension load, and the command reports which
   * layer every value came from. `/reload` is what picks up an edit, which is
   * the same deal as any other pi config file and keeps the polling cadence
   * from changing underfoot mid-session.
   *
   * Loading is separate from booting because the model check needs the
   * `ExtensionContext`, and the module-load timer below is the one caller with
   * none. It only needs the cadence, so it reads the config directly; every
   * caller that can supply a context goes through `bootOnce`.
   */
  let loadedPromise: Promise<LoadedConfig> | undefined;
  const loadedOnce = () => (loadedPromise ??= loadConfig());

  /**
   * Boot the extension against a context, once per extension load.
   *
   * Booting is where the running pi's model registry is consulted:
   * `checkModels` drops candidates this pi cannot spawn before any decision is
   * made. Its warnings ride along with the load warnings, so `/quota-dispatch`
   * prints them in the same provenance block, and its `held` record is what
   * makes an unresolvable primary hold rather than be written.
   *
   * This is why a boot needs the context, and why the timer reads the cached
   * `boot` rather than starting one of its own: a boot without a registry skips
   * the check silently, which would pin agents to models this pi cannot spawn.
   * `session_start` always precedes the first tick, so the cache is warm by
   * then; a tick before any session is a no-op rather than a ctx-less boot.
   */
  let boot:
    | Promise<{ loaded: LoadedConfig; dispatcher: Dispatcher; misses: ModelMiss[] }>
    | undefined;
  const bootOnce = (ctx: ExtensionContext) =>
    (boot ??= loadedOnce().then((base) => {
      const checked = checkModels(base.config, modelLookup(ctx));
      return {
        // The checked config is the effective one, and the model warnings join
        // the load warnings; `sources` still describe the config that resulted,
        // because the check only drops candidates it cannot spawn.
        loaded: {
          ...base,
          config: checked.config,
          warnings: [...base.warnings, ...checked.warnings],
        },
        dispatcher: createDispatcher(checked.config, {
          held: checked.held,
          droppedAlternates: checked.droppedAlternates,
        }),
        // The occurrences the same check warned about, for `session_start` to
        // surface. Rendered lines would have to be read back apart to be listed
        // as a warning, which is the work `checkModels` already did.
        misses: checked.misses,
      };
    }));

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  pi.registerCommand("quota-dispatch", {
    description: "Show subscription headroom and which model each agent is dispatched to",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      const { loaded, dispatcher } = await bootOnce(ctx);

      // Only this form writes. The plain and `refresh` forms are read-only.
      let lines: string[];
      if (a.includes("apply")) {
        const rows = await dispatcher.evaluate({ force: true });
        lines = [
          "[applied]",
          ...rows.flatMap((r) => describeDecisionLines(r.decision, r.outcome)),
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
  // frontmatter. Each quota request is bounded and retried, so the worst a
  // stalled endpoint can cost is `DEFAULT_QUOTA_READ`'s two attempts; an expired
  // Claude credential that triggers a refresh ping adds that run's own bound and
  // the credential re-read which follows it, once per expiry episode — see the
  // README caveats.
  //
  // An unconfigured install evaluates nothing: with no agents there is nothing
  // to write, and asking two vendors for quota to then decide about no files is
  // a request the user never asked for. It says so instead.
  pi.on("session_start", async (event, ctx) => {
    const { loaded, dispatcher, misses } = await bootOnce(ctx);

    if (managesNothing(loaded.config)) {
      await announceUnconfigured(loaded, ctx, event.reason);
      return;
    }

    // Before the evaluation, so the warning is on screen while the quota reads
    // that follow it are still in flight. It also replaces the footer line an
    // unconfigured install left: the table is read once per extension load, so
    // the state has to change here or nowhere.
    announceUnknownModels(misses, loaded, ctx, event.reason);
    await dispatcher.evaluate().catch(() => {});
  });

  // Periodic re-evaluation so workflow and mention spawns, which bypass the
  // Agent tool, still see current frontmatter. Starts only once the config has
  // been read, because the cadence is one of the things it configures, and only
  // when there is something to evaluate.
  //
  // This reads the config directly and does not boot: a boot needs a context to
  // run the model check, and this is the one caller without one. Each tick
  // therefore reuses the cached boot a session has already built, and does
  // nothing at all if no session has started yet. Starting a boot here would
  // skip the check silently, which is the failure this whole change is about.
  void loadedOnce().then((loaded) => {
    if (stopped || managesNothing(loaded.config)) return;
    timer = setInterval(() => {
      boot?.then(({ dispatcher }) => dispatcher.evaluate()).catch(() => {});
    }, loaded.config.pollMs);
    timer.unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    if (timer) clearInterval(timer);
    setFooterStatus(ctx, undefined);
  });
}
