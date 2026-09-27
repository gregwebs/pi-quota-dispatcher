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
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  type AgentRoute,
  type Candidate,
  type DispatcherConfig,
  type LoadedConfig,
  type Rail,
  agentNameRejection,
  describeConfig,
  globalConfigPath,
  loadConfig,
  railFromModel,
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
  railFromModel,
} from "./config.ts";
export type {
  AgentRoute,
  Candidate,
  ConfigFile,
  ConfigSource,
  DispatcherConfig,
  LoadConfigDeps,
  LoadedConfig,
  MergeLayer,
  MergeResult,
  Rail,
  SkipFlag,
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
 *
 * `why` is human text, and it may span lines: the priority walk reports one note
 * per candidate it passed over, so a route with several alternates puts each on
 * its own line rather than joining them into one long sentence. Notes are never
 * dropped for brevity — the rendered layout is `describeDecisionLines`'s job.
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
 */
export function decide(
  agent: string,
  route: AgentRoute,
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

  // An empty list pins the agent to its primary. There is nothing else the
  // answer could be, so no reading is consulted and no hold is possible.
  if (!route.alternates.length) {
    return {
      agent,
      file,
      kind: "assign",
      model: route.primary.model,
      why: "no alternate configured",
    };
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
    return {
      agent,
      file,
      kind: "assign",
      model: route.primary.model,
      why: `${primary.rail} ok (${budgetSummary(primary)})`,
    };
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
      return {
        agent,
        file,
        kind: "assign",
        model: winner.model,
        why: withNotes(
          `${primary.rail} ${budget} ${pct(used)} >= ${pct(threshold)}, choosing ${winner.model} on ${winner.rail} (${budget} ${pct(winnerUsed)})`,
          notes,
        ),
      };
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

  return {
    agent,
    file,
    kind: "assign",
    model: route.primary.model,
    why: reasons.length
      ? withNotes(
          `${primary.rail} tight on ${tightBudgets.join(" and ")} (${budgetSummary(primary)}) and no alternate won`,
          reasons,
        )
      : `${primary.rail} ok (${budgetSummary(primary)})`,
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
 * A paste-ready `agents` table built from the agent files found: each file's
 * current `model:` becomes one primary, and `rail` is derived from the model's
 * prefix.
 *
 * A file whose model has no recognised prefix contributes nothing — inventing a
 * rail would be a guess the user then pastes and the loader then warns about —
 * and neither does a file that declares no model at all. Returns the lines of a
 * JSON object, so the caller can indent it into a message.
 */
export function agentTableSnippet(files: AgentFile[]): string[] {
  const agents: Record<string, { primary: Candidate }> = {};
  for (const [name, candidate] of derivableCandidates(files)) {
    agents[name] = { primary: candidate };
  }
  return JSON.stringify({ agents }, null, 2).split("\n");
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
 * The real runner. Its stdout is the keychain item's password — the credential
 * JSON — and its failures are reported as the one line a reader can act on:
 * what `security` said, its exit code when it said nothing, or the reason the
 * process never ran.
 */
const execFileRead: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ text: stdout.trim() });
        resolve({ error: failureDetail(err, stderr) });
      },
    );
  });

/**
 * One line, because this ends up in a one-line report: `security`'s own
 * message when it printed one, otherwise the spawn failure's.
 */
function failureDetail(err: Error, stderr: string): string {
  if ((err as { killed?: boolean }).killed) return `timed out after ${CLAUDE_KEYCHAIN_TIMEOUT_MS}ms`;
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
 * Pulls `claudeAiOauth.accessToken` out of one store's JSON text.
 *
 * `now` is a parameter rather than a call to `Date.now()` so that the expiry
 * comparison stays a pure function of its inputs. A token carrying no
 * `expiresAt` is used: the shaping Claude Code writes always carries one, and a
 * missing field is not evidence of expiry.
 */
export function parseClaudeToken(text: string, now: number): { token: string } | { error: string } {
  let oauth: any;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch (err) {
    return { error: `unreadable claude credentials: ${(err as Error).message}` };
  }
  if (!oauth?.accessToken) return { error: "no claudeAiOauth.accessToken" };
  // Claude Code refreshes this on use; we only read it.
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < now) {
    return { error: "claude token expired (run Claude Code to refresh)" };
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
 */
export async function readClaudeToken(
  path: string,
  deps: ClaudeTokenDeps = {},
): Promise<{ token: string } | { error: string }> {
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
  const fromFile = "text" in file ? parseClaudeToken(file.text, now) : file;
  if ("token" in fromFile) return fromFile;
  if (!deps.keychain) return fromFile;

  const read = await deps.keychain();
  const fromKeychain = "text" in read ? parseClaudeToken(read.text, now) : read;
  if ("token" in fromKeychain) return fromKeychain;
  return { error: `${fromFile.error}; keychain: ${fromKeychain.error}` };
}

export interface DispatcherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Fallback credential store for the Claude rail. Left unset, production takes
   * whichever one this platform has; tests inject a fake so that they never
   * read, or prompt for, the keychain of the machine they run on. An injected
   * reader is used whatever `claudeCredsPath` names — the default-path
   * restriction is about which profile the *platform's* keychain belongs to,
   * and an injected reader is a statement about that already.
   */
  readKeychain?: KeychainRead;
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
  // A `claudeCredsPath` naming anything but the default file belongs to another
  // profile, whose credential the login keychain never holds — so the fallback
  // is not offered to it.
  const keychain =
    deps.readKeychain ??
    (isDefaultClaudeCredsPath(cfg.claudeCredsPath) ? keychainReader() : undefined);

  async function fetchClaude(): Promise<RailState> {
    const cred = await readClaudeToken(cfg.claudeCredsPath, { keychain, now: now() });
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
    const decisions = Object.entries(cfg.agents).map(([agent, route]) =>
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
  // frontmatter. Note that neither quota request sets a timeout yet, so a
  // stalled endpoint can delay session start — see the README limitations.
  //
  // An unconfigured install evaluates nothing: with no agents there is nothing
  // to write, and asking two vendors for quota to then decide about no files is
  // a request the user never asked for. It says so instead.
  pi.on("session_start", async (event, ctx) => {
    const { loaded, dispatcher } = await bootOnce();

    if (managesNothing(loaded.config)) {
      await announceUnconfigured(loaded, ctx, event.reason);
      return;
    }

    // Clears the footer line the state carried while the table was empty. The
    // table is read once per extension load, so this is the same session that
    // set it whenever it was set at all.
    setFooterStatus(ctx, undefined);
    await dispatcher.evaluate().catch(() => {});
  });

  // Periodic re-evaluation so workflow and mention spawns, which bypass the
  // Agent tool, still see current frontmatter. Starts only once the config has
  // been read, because the cadence is one of the things it configures, and only
  // when there is something to evaluate.
  void bootOnce().then(({ loaded, dispatcher }) => {
    if (stopped || managesNothing(loaded.config)) return;
    timer = setInterval(() => {
      void dispatcher.evaluate().catch(() => {});
    }, loaded.config.pollMs);
    timer.unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    if (timer) clearInterval(timer);
    setFooterStatus(ctx, undefined);
  });
}
