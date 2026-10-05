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
import { existsSync, type Stats } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  type AgentRoute,
  type Candidate,
  type ConfigFile,
  type DispatcherConfig,
  type LoadedConfig,
  type ModelDefault,
  type Rail,
  type ThinkingLevel,
  agentKey,
  agentNameRejection,
  configFilesFor,
  describeConfig,
  describeConfigLayers,
  describeConfigWarnings,
  errorText,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  railFromModel,
  thinkingFor,
  unusableConfigFileLines,
} from "./config.ts";

// The generator module is where a declared command's output replaces one config
// layer. Its orchestration is a call the command handler makes, not a public
// surface: the tests import the module directly, so nothing is re-exported here.
// The stdin document's types come back the other way, so the projection onto
// them can be built where the readings live without generator.ts learning about
// dispatchers.
import {
  type GeneratorInputOutcome,
  type GeneratorReadingInput,
  type GeneratorWindowInput,
  GENERATOR_INPUT_VERSION,
  generateConfig,
} from "./generator.ts";

// Config is a separate module because it is read from disk at run time; it is
// re-exported here so `src/index.ts` remains the one import path for the
// extension's whole surface.
export {
  CLAUDE_REFRESH_MODES,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  DEFAULT_GENERATOR_TIMEOUT_MS,
  THINKING_LEVELS,
  agentKey,
  configFilesFor,
  defaultConfig,
  describeConfig,
  describeConfigLayers,
  describeConfigWarnings,
  globalConfigPath,
  isClaudeRefreshMode,
  isThinkingLevel,
  loadConfig,
  mergeConfig,
  modelIdRejection,
  parseGeneratorDeclaration,
  projectConfigPath,
  railFromModel,
  skillKey,
  thinkingFor,
} from "./config.ts";
export type {
  AgentRoute,
  Candidate,
  ClaudeRefreshMode,
  ConfigFile,
  ConfigFileFault,
  ConfigFileState,
  ConfigPosition,
  ConfigSource,
  DispatcherConfig,
  GeneratorDeclaration,
  LoadConfigDeps,
  LoadedConfig,
  MergeLayer,
  MergeResult,
  ModelDefault,
  Rail,
  SkipFlag,
  SkillBinding,
  ThinkingLevel,
} from "./config.ts";

import { checkModels, modelLookup, type DroppedAlternate, type ModelMiss, unknownModelNote } from "./models.ts";
import {
  type Coordination,
  type FileWritePacing,
  errnoIs,
  replaceFileAtomically,
  withFileLock,
} from "./agent-file.ts";

// The coordination module is where a write to a shared agent file is made safe;
// re-exported here for the same reason as the config and models modules.
export {
  ABANDONED_LOCK_MS,
  DEFAULT_FILE_WRITE,
  agentFileTarget,
  lockPathFor,
  replaceFileAtomically,
  withFileLock,
} from "./agent-file.ts";
export type { Coordination, FileWritePacing, LockAttempt, LockHolder } from "./agent-file.ts";

import {
  DEFAULT_SHARED_READINGS,
  createSharedReadings,
  type SharedReadingsPacing,
  type StickyHalt,
  type VendorReading,
} from "./readings-file.ts";

// The readings module is where the rail cache lives and is shared across
// processes; re-exported here for the same reason as the config and models
// modules, so `src/index.ts` is the one import path for the extension's whole
// surface.
export {
  DEFAULT_SHARED_READINGS,
  READINGS_FILE_VERSION,
  asReadings,
  createSharedReadings,
} from "./readings-file.ts";
export type {
  CachedReadings,
  CredentialGates,
  GatePatch,
  RefreshGates,
  SharedReadings,
  SharedReadingsDeps,
  SharedReadingsPacing,
  StickyHalt,
  VendorReading,
} from "./readings-file.ts";

// The models module is where a config's model ids are resolved against the pi
// that is running; re-exported here for the same reason as the config module.
export {
  checkModels,
  modelLookup,
  splitModelId,
  unknownModelClause,
} from "./models.ts";
export type {
  DroppedAlternate,
  ModelCheckResult,
  ModelLookup,
  ModelMiss,
  ModelRegistryLike,
} from "./models.ts";

import { type AgentFileSelection, applySkillBinding, explicitSkill } from "./skill-binding.ts";

// The skill-binding module is where an explicit `/skill:` invocation selects the
// session's model; re-exported here for the same reason as the config module.
export { applySkillBinding, explicitSkill } from "./skill-binding.ts";
export type { AgentFileSelection, SessionSelection, SkillBindingDeps } from "./skill-binding.ts";

import {
  CLAUDE_PING_COOLDOWN_MS,
  CLAUDE_PING_TIMEOUT_MS,
  type ClaudePing,
  type ClaudeRefresh,
  execFileRunner,
  isDefaultClaudeCredsPath,
  refreshPlan,
} from "./refresh.ts";

// The refresh module owns the subprocess and loopback listener, not the gates
// or the report; re-exported here so index.ts remains the extension's one import
// path for this surface.
export {
  CLAUDE_PING_COOLDOWN_MS,
  CLAUDE_PING_TIMEOUT_MS,
  claudePingArgs,
  claudePingEnv,
  claudeRefresher,
  execFileRunner,
  isDefaultClaudeCredsPath,
  loopbackListener,
  refreshPlan,
} from "./refresh.ts";
export type {
  ClaudePing,
  ClaudeRefresh,
  PingListener,
  PingListenerFactory,
  RefreshPlan,
} from "./refresh.ts";

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
  readonly label: string;
  /**
   * How much of the window is used, in percent. This is the figure the policy
   * weighs and the report prints, which on one path is not a transcription of
   * the vendor's document: Codex's `limit_reached` path reports every window
   * full (`100`) even where the response's own percentages say less (see
   * `GoodReading.raw`). The windows and the raw body therefore come from the
   * same response, but `used` is the policy-effective number rather than an
   * arithmetic shadow of `raw`.
   */
  readonly used: number;
  /**
   * Set when this window belongs to a budget the policy weighs. Windows left
   * unclassified are display-only: model-specific sub-caps and vendor windows
   * we do not recognise.
   */
  readonly budget?: Budget;
  /**
   * When this window resets, in epoch milliseconds on the clock
   * `DispatcherDeps.now` reads, when the vendor reports it.
   *
   * Absolute rather than "seconds from now" because a reading is consulted after
   * it was taken — by a later report, by whoever reads the cache — and a relative
   * figure is wrong by however long it sat. Codex states its reset relative to
   * the response, so it is converted against the reading's `readAt`; Claude's is
   * already absolute.
   *
   * Milliseconds rather than ISO text: every other time here is on that clock,
   * so freshness is a subtraction, and Claude's own text beside a converted
   * Codex instant would be two dialects of one field. Text is a choice for
   * whoever writes a reading out.
   */
  readonly resetsAt?: number;
}

/**
 * A read the vendor answered with windows we could classify.
 *
 * `raw` is the document those windows were parsed from — the same response, not
 * a second request. It is kept whole and uninterpreted: it is for readers that
 * want what normalization leaves out, never for the policy, and never printed in
 * a report or a note, since a vendor's account document is not ours to echo.
 */
export interface GoodReading {
  readonly rail: Rail;
  readonly ok: true;
  /** Declared only so `reading.metered` narrows a `RailReading`: a rail that was read is not metered. */
  readonly metered?: undefined;
  /** Every window the endpoint reported, for display. Only some carry a budget. */
  readonly windows: readonly RailWindow[];
  /**
   * When the read ended, on the `DispatcherDeps.now` clock. Codex's relative
   * resets are converted against it; it is not the cache's TTL origin, which is
   * stamped when the finished reading is stored.
   */
  readonly readAt: number;
  /**
   * The vendor's response body as it arrived — the document `windows` was parsed
   * from, never a second request. It is what normalization leaves out. It does
   * not promise that `windows[].used` can be recomputed from it: the Codex
   * limiter reports `used: 100` over the vendor's own percentages (see
   * `RailWindow.used`).
   */
  readonly raw: unknown;
  /**
   * A display-only qualifier — Codex's `limit_reached=true`, or the sticky
   * refresh anomaly — that the report must still show on a healthy rail.
   */
  readonly note?: string;
}

/**
 * A read that left the rail without a usable reading: the endpoint refused or
 * never answered, answered with nothing we could classify, or there was no
 * credential to ask with. It reports no windows and no `raw` — not the last ones
 * seen — because a failure states only why it failed; what was last known is
 * the last good reading's job.
 */
export interface FailedReading {
  readonly rail: Rail;
  readonly ok: false;
  /** Declared only so `reading.metered` narrows a `RailReading`. */
  readonly metered?: undefined;
  readonly windows: readonly [];
  /** When the read gave up, on the `DispatcherDeps.now` clock. */
  readonly readAt: number;
  /**
   * Why the read failed. A failed read that was given up on says how many
   * attempts it cost (`HTTP 500 after 2 attempts`); a failure another request
   * would not have fixed is reported as that failure alone — see
   * `afterAttempts`.
   */
  readonly note: string;
}

/**
 * A rail billed per token rather than quota-capped, so there is no budget to
 * read: `budgetUsed` reports 0 on both and the rail can never block a switch.
 * Distinct from reporting no windows, which for a capped rail is a partial
 * reading the policy must not guess at.
 *
 * It is never read, so it has no `readAt` and no `raw`: there is no instant it
 * was taken at and no response it came from.
 */
export interface MeteredReading {
  /** The one metered rail: `deepseekReading` is this reading's only producer. */
  readonly rail: "deepseek";
  readonly ok: true;
  readonly metered: true;
  readonly windows: readonly [];
  readonly note?: string;
}

/**
 * What one quota read reports for one rail — the policy's only evidence. It
 * states facts; whether a budget is tight is the judgment `decide` makes about
 * it, not part of it.
 */
export type RailReading = GoodReading | FailedReading | MeteredReading;

/**
 * A rail's latest reading beside its last good one.
 *
 * They answer different questions, so neither stands in for the other. `latest`
 * is what the policy decides on: a failed latest read holds whatever an earlier
 * read said, because routing on numbers the latest read could not confirm is the
 * guess the hold exists to refuse (ADR 0006). `lastGood` is the vendor's last
 * word together with when it was said, for readers outside the policy, and it is
 * never routed on.
 *
 * The union proves the outcome correlation. A vendor success is paired with its
 * own last good reading — required, never `undefined`, and the *same object* — so
 * a consumer knows a success is also the last word; a failure may carry the good
 * reading left behind; a metered rail carries neither. It does not prove that
 * `latest` and `lastGood` are about the same rail: the variants do not name their
 * rails, though rail literals or a mapped type could correlate them if they did.
 * Nor does it prove a `lastGood` was really recorded before `latest` — object
 * identity and history are the writer's job. Two writers build this shape:
 * `asReadings` projects the shared store's cached vendor rails, and the
 * `deepseek` arm of `railReadings` builds the metered reading directly.
 *
 * The metered arm's `lastGood?: never` is deliberate. Without it, structural
 * typing lets the other arms' `lastGood` property through to a metered entry,
 * because a union's excess-property check accepts a key any arm declares.
 */
export type RailReadings =
  | { readonly latest: MeteredReading; readonly lastGood?: never }
  | { readonly latest: FailedReading; readonly lastGood?: GoodReading }
  | { readonly latest: GoodReading; readonly lastGood: GoodReading };

/**
 * A vendor rail's readings: the arms of `RailReadings` the cache can produce,
 * with the metered arm — which only the metered rail can have — excluded.
 */
export type VendorRailReadings = Exclude<RailReadings, { readonly latest: MeteredReading }>;

/** The metered arm, which only the metered rail can have. */
export type MeteredRailReadings = Extract<RailReadings, { readonly latest: MeteredReading }>;

/**
 * A rail the dispatcher asks a vendor about: every rail but the metered one,
 * which has no endpoint to ask and no cache entry to hold.
 */
export type VendorRail = Exclude<Rail, "deepseek">;

/**
 * Every rail's readings as the dispatcher already holds them, keyed by the rail
 * itself so a reader needs no case for a missing rail and none for "is this one
 * metered". The policy's `Map<Rail, RailReading>` cannot promise which arm a rail
 * carries; this can, because its keys are the rails.
 */
export interface KnownReadings {
  readonly claude: VendorRailReadings;
  readonly codex: VendorRailReadings;
  readonly deepseek: MeteredRailReadings;
}

/**
 * One vendor rail projected onto the wire, or the reason there is nothing to
 * send. Tagged rather than `undefined` for the absent case, so the refusal
 * carries the failure note with the type proving a note exists: only a failed
 * newest read with no last good reading behind it produces `no-reading`.
 */
type VendorRailProjection =
  | { readonly kind: "reading"; readonly reading: GeneratorReadingInput }
  | { readonly kind: "no-reading"; readonly note: string };

/**
 * An epoch instant as the wire document states it.
 *
 * Safe by construction: a `resetsAt` that reaches here passed
 * `representableInstant`, and a `readAt` comes from the dispatcher's clock.
 * A throw is still left to propagate rather than clamped into a plausible-
 * looking instant — the `input` seam turns it into a failed run, which is the
 * honest report for a reading this process cannot write out.
 */
function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * One report window in the wire's text form. `budget` and `resetsAt` are spread
 * in only when the reading carries them, because an absent key and a key whose
 * value is `null` are different documents: a generator testing for the key
 * would read a judgment out of the second that the reading never made.
 */
function windowInput(w: RailWindow): GeneratorWindowInput {
  return {
    label: w.label,
    used: w.used,
    ...(w.budget === undefined ? {} : { budget: w.budget }),
    ...(w.resetsAt === undefined ? {} : { resetsAt: isoInstant(w.resetsAt) }),
  };
}

/** One reading in the wire's shape, apart from the failure that may qualify it. */
function readingInput(sent: GoodReading): GeneratorReadingInput {
  return {
    ok: true,
    readAt: isoInstant(sent.readAt),
    windows: sent.windows.map(windowInput),
    raw: sent.raw,
    ...(sent.note === undefined ? {} : { note: sent.note }),
  };
}

/**
 * The document for one capped rail, or why there is none to send.
 *
 * A newest read that failed sends the last good reading marked `latestFailure`,
 * rather than its own empty windows: the generator routes on the vendor's last
 * word, and the marker is what keeps it from reading that word as current. The
 * `note` is the sent reading's — a qualifier explaining `used: 100` (Codex's
 * `limit_reached=true`) travels with the reading it qualifies, never with the
 * failure that made an older one stand in.
 */
function projectVendorRail(readings: VendorRailReadings): VendorRailProjection {
  const { latest } = readings;
  if (latest.ok) return { kind: "reading", reading: readingInput(latest) };
  const { lastGood } = readings;
  if (lastGood === undefined) return { kind: "no-reading", note: latest.note };
  return {
    kind: "reading",
    reading: {
      ...readingInput(lastGood),
      latestFailure: { at: isoInstant(latest.readAt), note: latest.note },
    },
  };
}

/**
 * The generator's stdin document, or the refusal when a capped rail has never
 * been read successfully.
 *
 * Pure: the readings are its only input, so the shape a generator sees is
 * testable without a dispatcher, a clock or a subprocess. Facts only, and every
 * rail key present — see `GeneratorInput` for the document and
 * docs/adr/0015-configuration-generation.md for the contract and its reasons.
 *
 * The refusal is stated as facts too: one sentence per rail naming it and the
 * note its latest read left, so the reason is the vendor's own account rather
 * than this process's opinion about it. A rail that has never been read cannot
 * be filled with a placeholder instead — a generator would route on a guess,
 * which is the guess ADR 0006's hold exists to refuse.
 */
export function generatorInput(known: KnownReadings): GeneratorInputOutcome {
  const claude = projectVendorRail(known.claude);
  const codex = projectVendorRail(known.codex);
  if (claude.kind === "no-reading" || codex.kind === "no-reading") {
    return {
      kind: "refused",
      reason: [
        "the generator was not run: a quota-capped rail has no successful reading yet.",
        ...refusalLine("claude", claude),
        ...refusalLine("codex", codex),
        // Advice, not a fact about the readings, but the refusal is the only
        // place the user learns the run was skipped before the vendor was
        // asked — and an unforced read is exactly what would clear it. A
        // credential that is missing rather than stale is not something a
        // refresh can fix, which is why the sentence is conditional.
        "Run /quota-dispatch refresh once the rail can be read, then generate again.",
      ],
    };
  }
  return {
    kind: "ready",
    input: {
      version: GENERATOR_INPUT_VERSION,
      rails: {
        claude: claude.reading,
        codex: codex.reading,
        deepseek: { metered: true, windows: [], raw: null },
      },
    },
  };
}

/** A rail's one line in a refusal, or nothing when it has a reading to send. */
function refusalLine(rail: VendorRail, projection: VendorRailProjection): string[] {
  return projection.kind === "no-reading" ? [`the ${rail} rail has no valid reading yet (${projection.note}).`] : [];
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
 *
 * A hold carries neither a model nor a file. An agent definition names the file
 * to write, and a hold writes nothing, so a file on it could only be wrong — the
 * same argument as for the model.
 */
export type Decision =
  | (AgentDefinition & {
      kind: "assign";
      model: string;
      thinking?: ThinkingLevel;
      why: string;
    })
  | { agent: string; kind: "hold"; why: string };

// ---------------------------------------------------------------- parsing

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The largest instant a JavaScript `Date` can represent, in epoch milliseconds
 * (±100,000,000 days, `8.64e15`). Past it `new Date(ms)` is invalid and
 * `.toISOString()` throws, so a reading carrying one is not usable by the
 * serializer `generatorInput` builds — the same reason `instant` drops an
 * unparseable Claude reset.
 */
const MAX_EPOCH_MS = 8.64e15;

/**
 * Whether `ms` is an instant a `Date` can hold: finite and inside
 * `MAX_EPOCH_MS`. A derived reset that fails this is dropped like a malformed
 * absolute one, rather than reaching a reader as `Infinity` or an out-of-range
 * number.
 */
function representableInstant(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS;
}

/**
 * An absolute time a vendor wrote as text, in epoch milliseconds — `undefined`
 * when it is absent or not a time at all, so a malformed value is dropped like a
 * missing one rather than reaching a reader as `NaN`.
 */
function instant(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Claude reports an account-wide session cap (`five_hour`) alongside weekly
 * caps: one account-wide plus per-model ones. Every weekly figure is classified
 * as the same budget, so the worst of them is what the weekly guard sees — a
 * Sonnet cap at 95% does block you, even when the account-wide week is
 * comfortable.
 *
 * Claude states each window's reset as absolute text (`resets_at`), taken as an
 * instant so a reading consulted later still says when the window clears.
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
    if (used !== undefined) {
      const resetsAt = instant(data?.[key]?.resets_at);
      windows.push({
        label,
        used,
        ...(budget ? { budget } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    }
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
 *
 * `reset_after_seconds` is relative to the response, so it is converted against
 * `readAt`, the instant the read ended.
 */
export function parseCodexUsage(
  data: any,
  { readAt }: { readAt: number },
): {
  windows: RailWindow[];
  limited: boolean;
} {
  const rl = data?.rate_limit;
  const windows: RailWindow[] = [];
  const push = (key: string, budget: Budget, fallback: string) => {
    const w = rl?.[key];
    const used = num(w?.used_percent);
    if (used === undefined) return;
    const after = num(w?.reset_after_seconds);
    const resetsAt = after === undefined ? undefined : readAt + after * 1000;
    windows.push({
      label: durationLabel(num(w?.limit_window_seconds), fallback),
      used,
      budget,
      ...(resetsAt !== undefined && representableInstant(resetsAt) ? { resetsAt } : {}),
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
 * What a destination's reading must beat for the source reading that triggered
 * this pass. The two rules are mutually exclusive per pass: the override does
 * not widen the margin, so a destination at or above the override threshold is
 * rejected even where the margin would have passed it. README's "The policy"
 * has the worked rules.
 */
type Eligibility = { kind: "margin"; margin: number } | { kind: "override"; below: number };

function eligibilityFor(budget: Budget, used: number, cfg: DispatcherConfig): Eligibility {
  // Local invariant: the override is session-only. The weekly pass always weighs
  // the margin, so a spent week never inherits a session threshold that would
  // relax it.
  const alwaysAt = cfg.sessionAlwaysSwitchAt;
  return budget === "session" && alwaysAt !== undefined && used >= alwaysAt
    ? { kind: "override", below: alwaysAt }
    : { kind: "margin", margin: cfg.margin };
}

function qualifies(rule: Eligibility, readings: { used: number; altUsed: number }): boolean {
  switch (rule.kind) {
    case "margin":
      return readings.altUsed < readings.used - rule.margin;
    case "override":
      return readings.altUsed < rule.below;
  }
}

/** Why a destination failed `rule`, in the parenthetical a rejection note carries. */
function unqualifiedText(rule: Eligibility, budget: Budget, altUsed: number): string {
  switch (rule.kind) {
    case "margin":
      return `${budget} ${pct(altUsed)} is within margin`;
    case "override":
      // The candidate lost to the override, not to the margin, so this must not
      // say "within margin". Both numbers are printed exactly, because the
      // override boundary is strict: rounding the reading while printing the
      // threshold raw can read as a false statement (90% "is not below" 90.4%).
      return `${budget} ${pctExact(altUsed)} is not below sessionAlwaysSwitchAt ${pctExact(rule.below)}`;
  }
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
 * Percentages in override-mode prose, where the fractional boundary is the whole
 * point: the override compares strictly against the configured threshold, so a
 * rounded reading can read as a false statement or hide which side of the
 * boundary a value sat on.
 *
 * Six decimals kill the noise a computed reading carries (`92.33333333333333`)
 * while staying truthful for any percentage this config can hold, and
 * `Number(...)` trims the trailing zeros `toFixed` would pad.
 */
function pctExact(n: number): string {
  return `${Number(n.toFixed(6))}%`;
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
export function budgetUsed(reading: RailReading, budget: Budget): number | undefined {
  if (reading.metered) return 0;
  const used = reading.windows.filter((w) => w.budget === budget).map((w) => w.used);
  return used.length ? Math.max(...used) : undefined;
}

/**
 * Budgets a capped rail failed to report.
 *
 * A metered rail reads 0 through `budgetUsed`, and unreadable rails are rejected
 * before this is consulted, so anything returned here is a partial reading. The
 * policy holds rather than guessing: an unreported budget is not an idle one.
 */
function absentBudgets(reading: RailReading): Budget[] {
  return BUDGET_ORDER.filter((b) => budgetUsed(reading, b) === undefined);
}

/** Both budgets, for the decision's `why`. */
function budgetSummary(reading: RailReading): string {
  if (reading.metered) return reading.note ?? "metered";
  if (!reading.windows.length) return reading.note ?? "no windows";
  return BUDGET_ORDER.map((b) => {
    const used = budgetUsed(reading, b);
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
 * The session pass has one opt-in exception, `sessionAlwaysSwitchAt`, which
 * replaces the margin rule rather than widening it and applies to the session
 * pass alone: the weekly pass always weighs the margin, so the override can
 * never relax the session eligibility of a weekly-triggered switch, and when
 * nothing qualifies the ordinary fallback restores the primary. README's "The
 * policy" has the worked rules and boundaries.
 *
 * Containment is checked here even though the config seam validates names:
 * `decide` is handed a hand-built `AgentDefinition` and a `DispatcherConfig`
 * that need not have come through `mergeConfig`, so `definition.file` is not
 * trusted. The seam only guarantees that a name is a single path segment; this
 * path check is the guarantee that a write lands inside `agentDir`. A
 * definition that resolves outside holds rather than assigning, because a hold
 * writes nothing and the file stays as the user left it.
 *
 * `droppedAlternates` is the one fact `route` cannot carry: boot may have
 * removed alternates this pi cannot spawn, and the route it handed over is
 * indistinguishable from one the user wrote with no alternates. Absent means
 * nothing was dropped, so an empty `alternates` is the user's own `[]`.
 */
export function decide(
  definition: AgentDefinition,
  route: AgentRoute,
  rails: Map<Rail, RailReading>,
  cfg: DispatcherConfig,
  droppedAlternates: readonly DroppedAlternate[] = [],
): Decision {
  const { agent, file } = definition;
  if (!isInside(cfg.agentDir, file)) {
    return {
      agent,
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
    const rule = eligibilityFor(budget, used, cfg);

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
      if (qualifies(rule, { used, altUsed })) {
        winner = candidate;
        winnerUsed = altUsed;
        winnerIndex = index;
        break;
      }
      rejected.push(
        `rejected ${candidate.model} on ${candidate.rail} (${unqualifiedText(rule, budget, altUsed)})`,
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
          kind: "hold",
          why: withNotes(
            `an unreadable candidate could have won before ${winner.model} on ${winner.rail} — holding`,
            [...missing, ...notes],
          ),
        };
      }
      // The trigger and the winner's own figure are worded differently in
      // override mode so the line says why the margin did not apply and never
      // reads as a winner sitting at the threshold; margin mode is the legacy
      // `>= <threshold>` phrasing, unchanged.
      const override = rule.kind === "override";
      const trigger = override
        ? `${pctExact(used)} >= sessionAlwaysSwitchAt ${pctExact(rule.below)}`
        : `${pct(used)} >= ${pct(threshold)}`;
      const winnerPct = override ? pctExact(winnerUsed) : pct(winnerUsed);
      return assign(
        winner,
        withNotes(
          `${primary.rail} ${budget} ${trigger}, choosing ${winner.model} on ${winner.rail} (${budget} ${winnerPct})`,
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
 *
 * The pair travels as a record because two bare strings in a row — an agent and
 * a model — are the same type in the same position, so a swapped call site
 * compiles and reports a model by an agent's name.
 */
export function heldDecision(held: { agent: string; model: string }): Decision {
  return {
    agent: held.agent,
    kind: "hold",
    // The primary's own key, so the reader gets the line to edit rather than
    // having to work out which of the agent's candidates this is. The wording is
    // the model check's, shared with the note a dropped alternate earns.
    why: `${unknownModelNote(`${agentKey(held.agent)}.primary.model`, held.model)}; holding`,
  };
}

/**
 * The hold for a contested name: two or more files claim it, so pi spawns
 * whichever it loads last and writing either would be a guess about which one
 * that is. A `held` outcome writes nothing, which is exactly right when there is
 * no one file to write. The note is the boot warning's, so the reader meets one
 * sentence for one fact however they arrive at it.
 */
export function contestedDecision(contest: ContestedAgent): Decision {
  return { agent: contest.agent, kind: "hold", why: `${contestedNote(contest)} — holding` };
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

/** One `.md` file in the agent dir. */
export type AgentFile = NamedAgentFile | ScopedNameFile;

/** A file pi registers an agent for, named as pi names it (see `AgentFile.name`). */
export interface NamedAgentFile {
  kind: "agent";
  /** The pi-visible name: declared `name:` trimmed when non-empty, else the filename stem. */
  name: string;
  /** Absolute path, `<agentDir>/<filename>`. */
  file: string;
  model?: string;
  /**
   * The uncommented `thinking:` value, decoded but deliberately not validated: a
   * skill binding has to tell a malformed level from an absent one and warn,
   * which it cannot do if a bad value is dropped here.
   */
  thinking?: string;
  /** The file is there but its frontmatter could not be read; it names no agent either. */
  unreadable?: boolean;
}

/**
 * A file pi registers no agent for, because its declared `name:` contains `:`,
 * which the subagents plugin reserves for its own scoped ids — it skips such a
 * file whole. Still listed, and it can still occupy the path a route's file
 * would be created at, but it names no agent, contests none, and no route can
 * target it.
 */
export interface ScopedNameFile {
  kind: "scoped";
  /** The declared name, as pi read it. */
  declared: string;
  file: string;
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

/** The uncommented `name:` line, capturing everything after the colon. */
const NAME_LINE = /^name:[ \t]*(.*?)[ \t]*$/m;

/**
 * The pi-visible name an agent file declares, or `undefined` when it declares
 * none.
 *
 * `decodeScalar` strips a trailing comment and one layer of quotes, and the
 * trim that follows it is pi-subagents' own: `name: "  Plan  "` is the agent
 * `Plan`, and a route keyed `Plan` has to reach it. A value that is empty or
 * only whitespace declares nothing, so the caller falls back to the stem, the
 * way `declared || filenameType` does in the plugin.
 */
function declaredName(head: string): string | undefined {
  const match = NAME_LINE.exec(head);
  return match ? decodeScalar(match[1]).trim() : undefined;
}

/**
 * Every agent file in `agentDir`, sorted by filename. Each named file carries
 * the `model:` and `thinking:` values it states, decoded.
 *
 * The name is the pi-visible one (see `AgentFile`), so a route keyed by a
 * declared name reaches the file that declares it. A declared name containing
 * `:` is pi's one refusal — it reserves that for plugin-scoped ids — so such a
 * file names no agent, is not proposed, and no route can target it; it is still
 * listed, because it is a file in the dir and can occupy the path a route's
 * file would be created at. The sort is by filename and not by name because two
 * files can claim one name, and a stable, order-independent list is what keeps
 * every report of that state the same whichever way `readdir` ordered them.
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
  let entries: string[];
  try {
    entries = await readdir(agentDir);
  } catch {
    return [];
  }

  const files: AgentFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = join(agentDir, entry);

    let info: Stats;
    try {
      info = await stat(file);
    } catch {
      // A dangling symlink resolves to nothing, so there is no file to report.
      continue;
    }
    if (!info.isFile()) continue;

    let name = entry.slice(0, -".md".length);
    let model: string | undefined;
    let thinking: string | undefined;
    let unreadable = false;
    try {
      const head = frontmatter(await readPrefix(file));
      if (head !== undefined) {
        const declared = declaredName(head);
        // pi refuses a declared `:` and skips the file whole, so it names no
        // agent — but the file is still there, and it can still occupy the path
        // another route's file would be created at, so it is listed as the file
        // it is.
        if (declared?.includes(":")) {
          files.push({ kind: "scoped", declared, file });
          continue;
        }
        if (declared) name = declared;
        model = activeModel(head);
        thinking = activeThinking(head);
      }
    } catch {
      unreadable = true;
    }
    files.push({
      kind: "agent",
      name,
      file,
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(unreadable ? { unreadable } : {}),
    });
  }

  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** An agent as pi spawns it: its name, and the file a write for it lands in. */
export interface AgentDefinition {
  /** The pi-visible name, which is also the route key. */
  agent: string;
  /**
   * The `.md` file a write for this agent lands in — for a `missing`
   * resolution, the path `/agents` would create, which is never written.
   */
  file: string;
}

/** The agent dir as read once, for one pass or one boot. */
export interface AgentDirectory {
  /** The agent dir itself (`cfg.agentDir`). */
  dir: string;
  /** `readAgentFiles(dir)`. */
  files: readonly AgentFile[];
}

/** The one read of the agent dir a pass or a boot needs. */
export async function readAgentDirectory(dir: string): Promise<AgentDirectory> {
  return { dir, files: await readAgentFiles(dir) };
}

/** More than one readable file claims the same name. */
export interface ContestedAgent {
  kind: "contested";
  agent: string;
  /** Every readable file whose `name` is `agent`, in filename order; always ≥ 2. */
  files: readonly AgentFile[];
}

export type AgentResolution =
  /** Exactly one readable file claims the name: a route for it writes that file. */
  | { kind: "defined"; definition: AgentDefinition }
  /**
   * No readable file claims the name. `definition.file` is
   * `join(dir, `${agent}.md`)`, the path `/agents` would create. It is never
   * written. `occupant` is the `AgentFile` already at that exact path, if any:
   * a file that is some other agent, a scoped file, or an unreadable one.
   */
  | { kind: "missing"; definition: AgentDefinition; occupant?: AgentFile }
  | ContestedAgent;

/**
 * Resolve a route key against the dir. Pure and sync.
 *
 * Only a readable file that names an agent can define or contest a name: a
 * scoped file names no agent, and an unreadable file could name anything — pi
 * cannot read it either — so neither can be the agent a route reaches. Both can
 * still be the `occupant` of the path `/agents` would create, which is why the
 * occupant lookup asks for a file at that exact path whatever kind it is.
 * Matching is exact and case-sensitive: the name is the one pi spawns, and pi
 * does not fold case for us.
 */
export function resolveAgent(directory: AgentDirectory, agent: string): AgentResolution {
  const claimants = directory.files.filter(
    (file): file is NamedAgentFile =>
      file.kind === "agent" && !file.unreadable && file.name === agent,
  );
  if (claimants.length === 1) {
    return { kind: "defined", definition: { agent, file: claimants[0].file } };
  }
  // `directory.files` is in filename order, so the claimants are too, and the
  // outcome does not depend on which way `readdir` listed them.
  if (claimants.length > 1) return { kind: "contested", agent, files: claimants };
  const file = join(directory.dir, `${agent}.md`);
  const occupant = directory.files.find((candidate) => candidate.file === file);
  return { kind: "missing", definition: { agent, file }, ...(occupant ? { occupant } : {}) };
}

/**
 * The `model:` a pass read out of `file`, from the one directory read it made.
 *
 * This is the write's `base`: the line a decision is allowed to replace. Reading
 * it from the pass's own listing rather than from the file at write time is what
 * makes a concurrent assignment detectable at all — a fresh read would already
 * have the other process's model in it and would look like the state the
 * decision had always been made against.
 */
function passModel(directory: AgentDirectory, file: string): string | undefined {
  for (const candidate of directory.files) {
    if (candidate.kind === "agent" && candidate.file === file) return candidate.model;
  }
  return undefined;
}

/** One sentence for a contested name, shared by the boot warning and the `held` line. */
function contestedNote(contest: ContestedAgent): string {
  const claimants = contest.files.map((file) => basename(file.file)).join(", ");
  return `${contest.files.length} agent files claim the name "${contest.agent}" (${claimants}) and pi spawns whichever it loads last`;
}

/** What to do about a contested name, wherever one is reported. */
const CONTESTED_REMEDY = "give each file its own name";

/**
 * What to say about the file already sitting at the path `/agents` would
 * create, and what to do about it.
 *
 * The remedy has to change with the occupant. `/agents` creates
 * `<agentDir>/<name>.md` and offers to overwrite what is there, so telling
 * someone to run it at an occupied path is telling them to destroy the file
 * this same line just named.
 */
function occupantNote(occupant: AgentFile | undefined): { why: string; remedy: string } {
  if (occupant === undefined) {
    return { why: "", remedy: "run the /agents command to create a new agent" };
  }
  switch (occupant.kind) {
    case "scoped":
      return {
        why: ` (the file there is not an agent: its declared name "${occupant.declared}" is scoped)`,
        remedy: "give that file a name pi registers, or drop this route",
      };
    case "agent":
      if (occupant.unreadable) {
        return {
          why: " (the file there could not be read)",
          remedy: "make that file readable, or remove it",
        };
      }
      return {
        why: ` (the file there is agent "${occupant.name}")`,
        remedy: "name the route after that agent, or rename that file",
      };
  }
}

/**
 * The boot check: one warning per configured agent that resolves `missing` or
 * `contested`, in sorted name order, and nothing for `defined`.
 *
 * Beside `checkModels`, and for the same reason: the question needs something
 * `config.ts` cannot know — the agent files, whose frontmatter parser lives in
 * this module — so it is asked once at boot and its lines join
 * `loaded.warnings`, which is what feeds the log, the report's warning tail and
 * `describeConfig`. A throwing sink is swallowed, as in `checkModels`.
 */
export function checkAgentFiles(
  config: DispatcherConfig,
  directory: AgentDirectory,
  warn: (message: string) => void = console.error,
): string[] {
  const warnings: string[] = [];
  for (const agent of Object.keys(config.agents).sort()) {
    const resolution = resolveAgent(directory, agent);
    let line: string;
    if (resolution.kind === "contested") {
      line = `${directory.dir}: configured agent "${agent}" is contested: ${contestedNote(resolution)} — ${CONTESTED_REMEDY}`;
    } else if (resolution.kind === "missing") {
      const { why, remedy } = occupantNote(resolution.occupant);
      line = `${resolution.definition.file}: configured agent "${agent}" has no file${why} — ${remedy}`;
    } else {
      continue;
    }
    warnings.push(line);
    try {
      warn(line);
    } catch {
      // Warning sinks are callers' code; a throwing one must not sink a boot.
    }
  }
  return warnings;
}

/**
 * A reader for the file that names `agent` right now, or why there is nothing to
 * read — for a skill binding, which selects whatever that file says.
 *
 * A factory rather than a two-string function: the agent dir is fixed for the
 * reader's life and the bound route varies per call, so each call names one thing
 * and no signature carries two adjacent strings.
 *
 * The read is fresh on every call and resolved by pi-visible name exactly as a
 * spawn is (`resolveAgent`), so a dispatcher write or a hand edit since the last
 * invocation is what the session gets. Nothing is cached and nothing is written.
 *
 * `why` is a finished clause built from the boot check's own accounts of the same
 * states (`contestedNote`, `occupantNote`), so one state reads the same wherever
 * the reader meets it. An empty `model:` or `thinking:` states nothing, the way
 * an empty `name:` declares nothing, so it comes back absent.
 */
export function agentSelectionReader(agentDir: string): (agent: string) => Promise<AgentFileSelection> {
  return async (agent) => {
    const directory = await readAgentDirectory(agentDir);
    const resolution = resolveAgent(directory, agent);
    switch (resolution.kind) {
      case "contested":
        return { kind: "unavailable", why: `${contestedNote(resolution)} — ${CONTESTED_REMEDY}` };
      case "missing": {
        const { why, remedy } = occupantNote(resolution.occupant);
        return { kind: "unavailable", why: `it has no file at ${resolution.definition.file}${why} — ${remedy}` };
      }
      case "defined": {
        const file = directory.files.find(
          (candidate): candidate is NamedAgentFile =>
            candidate.kind === "agent" && candidate.file === resolution.definition.file,
        );
        const model = file?.model;
        const thinking = file?.thinking;
        return { kind: "file", ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
      }
    }
  };
}

/**
 * The candidates a startup snippet can derive from `files`, keyed by agent name.
 *
 * Shared by the snippet and the check for whether there is anything to paste, so
 * the two cannot disagree about what counts as derivable. A file is left out —
 * not guessed at — when it names no agent (a scoped file, which no route can
 * target), when a second readable file claims its name, when it declares no
 * model, when its prefix names a rail we do not know, or when the config seam
 * would reject its name. Every one of those would produce a table that warns the
 * moment it was pasted: a contested name would be held, not dispatched.
 */
function derivableCandidates(files: AgentFile[]): Array<[string, Candidate]> {
  const claims = new Map<string, number>();
  for (const file of files) {
    if (file.kind !== "agent" || file.unreadable) continue;
    claims.set(file.name, (claims.get(file.name) ?? 0) + 1);
  }

  const candidates: Array<[string, Candidate]> = [];
  for (const file of files) {
    if (file.kind !== "agent") continue;
    if (file.model === undefined) continue;
    if ((claims.get(file.name) ?? 0) > 1) continue;
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
 *
 * The filename leads, because that is the thing to open; when the agent's pi
 * name differs from the filename stem — a file that declares `name:` — the name
 * is named as well, otherwise the line would suggest the file's agent is called
 * something it is not. A file pi registers no agent for says so, because a
 * reader asking "which of my files does this ignore?" is owed that answer.
 */
export function describeAgentFiles(files: AgentFile[]): string[] {
  return files.map((file) => {
    const filename = basename(file.file);
    if (file.kind === "scoped") {
      return `  ${filename} — not an agent: its declared name "${file.declared}" is scoped`;
    }
    const label =
      file.name === filename.slice(0, -".md".length)
        ? filename
        : `${filename} (name: ${file.name})`;
    return file.unreadable
      ? `  ${label} — unreadable`
      : `  ${label} — model: ${file.model ?? "(none)"}`;
  });
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
      "None of the files below is an agent that declares a model whose rail can be derived, so there is no snippet to paste yet.",
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
 * The one line for a config file the dispatcher could not use: the notify's
 * headline, so the interruption names the state this install is in.
 *
 * "A config file" rather than "your config" because the notice may be about
 * either layer, and the fault lines under it name which.
 */
const UNUSABLE_CONFIG_SUMMARY = "quota-dispatcher: a config file could not be used.";

/**
 * What an install with a config file that is there and unusable has to say for
 * itself: every fault, then the fix.
 *
 * `unconfiguredNotice` is the wrong answer for this install: its file names
 * agents, so "no agents are configured — name them in <path>" tells the reader
 * to do what they already did, and buries the one fact that explains the empty
 * table. Taking the files rather than a rendered sentence is what keeps the
 * headline honest — nothing but a `ConfigFile` can be handed to a notice that
 * says a config file could not be used. The fault lines are
 * `unusableConfigFileLines`', verbatim, so the reader meets the sentence they
 * will find in the log and the report rather than a third telling of it.
 */
export function unusableConfigNotice(files: ConfigFile[]): string[] {
  return [
    UNUSABLE_CONFIG_SUMMARY,
    ...unusableConfigFileLines(files),
    "Fix the file, then /reload. Run /quota-dispatch at any time to see what it would do.",
  ];
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
 * same sentence here as in the log and in the report's warning tail — the
 * startup warning is a shortcut to that record, not a third telling of the same
 * fact. Pure, and separate from the UI call, for the same reason
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

/**
 * One agent file's write, as a pass decided it.
 *
 * `base` is the `model:` the pass read out of the file when it listed the agent
 * dir, and it is what makes a conflicting assignment detectable: a write may
 * only replace the line the decision was made against, so a model that appeared
 * between the pass's read and the write is somebody else's answer rather than
 * this pass's to overwrite. It is required rather than optional for that reason
 * — a caller that has not read the file has not made a decision that can be
 * checked, and an omitted base would silently turn every write into "overwrite
 * whatever is there", which is the behaviour this exists to remove.
 */
export interface AgentWrite {
  file: string;
  model: string;
  /** The level the pass resolved; absent when nothing stated one. */
  thinking?: ThinkingLevel;
  /** The model the pass read out of `file`; `undefined` when it read none. */
  base: string | undefined;
  /** Report what a write would do, and write nothing. */
  dry: boolean;
}

/** Every outcome a write reaches on its own; the rest is a hold, which needs a reason. */
export type WriteOutcome = Exclude<Outcome, "held">;

/**
 * What one coordinated write did, or why it declined to write at all.
 *
 * A refusal is a hold and not a failure: the file is left exactly as it was,
 * which is the vocabulary this extension already uses for "I have no opinion I
 * can act on". The caller renders `why` into the hold it reports, so a refusal
 * reads on the report line the same way every other hold does.
 */
export type WriteResult = { kind: WriteOutcome } | { kind: "held"; why: string };

export async function applyDecision(write: AgentWrite, coordination: Coordination = {}): Promise<WriteResult> {
  // Decided first as a dry pass, which writes nothing by construction: this is a
  // probe, and a probe that can write is how the write below would come to
  // happen outside the lock it is meant to be inside.
  //
  // A pass with nothing to write needs no coordination at all — the file already
  // says what was decided, which is most passes. The lock exists to serialize
  // writes, and reading the file is what this extension did before any of this,
  // so two things follow, both wanted: a poll does not create and delete a lock
  // file per agent for no write, and an agent dir that cannot hold a new file is
  // still reportable rather than failing every pass.
  const read = await applyWrite({ ...write, dry: true });
  if (write.dry || read.kind !== "would-write") return read;

  // A write is needed, so it is decided again from inside the lock: between the
  // read above and this one another process may have assigned something, and the
  // text that gets written has to be composed from the bytes on disk now —
  // otherwise that process's edit is lost to a write that never saw it.
  const attempt = await withFileLock(write.file, coordination, (target) =>
    applyWrite({ ...write, file: target }),
  );
  if (attempt.ok) return attempt.value;
  // The target vanished before the lock could be keyed off it: nothing to write
  // to, which is the same skip the missing-file pre-check reports rather than a
  // hold on a file that is not there.
  if (attempt.reason === "gone") return { kind: "skipped (no file)" };
  const pid = attempt.holder?.pid;
  return {
    kind: "held",
    why:
      pid === undefined
        ? "another pi process holds this file's lock — holding"
        : `another pi process holds this file's lock (pid ${pid}) — holding`,
  };
}

/**
 * The one place a decision becomes text.
 *
 * Shared by the locked real write and the unlocked dry probe on purpose, so the
 * two cannot disagree about `unchanged` or about the conflict rule and report a
 * write the real pass then refuses. It works from the bytes on disk at this
 * moment, which is what lets an edit that landed earlier survive.
 */
async function applyWrite(write: AgentWrite): Promise<WriteResult> {
  let src: string;
  try {
    src = await readFile(write.file, "utf8");
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return { kind: "skipped (no file)" };
    throw err;
  }

  // Everything below works from the same immutable `src`, though `upsertModel`
  // and `upsertThinking` each parse the frontmatter again themselves. What
  // matters is that the conflict check reads the *same* text the write was
  // composed from, or it would be checking a model that is not the one on disk.
  const head = frontmatter(src);
  const withModel = upsertModel(src, write.model);
  if (head === undefined || withModel === null) return { kind: "skipped (no frontmatter)" };
  const next = upsertThinking(withModel, write.thinking);
  // `unchanged` is decided against what is on disk now rather than against the
  // pass's read: two passes that agree converge, and a `model:` line the user
  // re-quoted to the same value is left alone.
  if (next === src) return { kind: "unchanged" };

  // Both transformations read the fresh text, so an edit that landed before this
  // read — a body change, a new key, a `model:` the user re-quoted — survives
  // byte-for-byte and only the lines the dispatcher owns move. An edit landing
  // in the instant between this read and the rename is the one thing a
  // read-modify-write cannot keep; the lock is what keeps another *pass* out of
  // that instant, which is the part that can be arranged.
  //
  // The decision was made against `base`, and the file may have moved since. If
  // its decoded model is neither what the pass decided against nor what it wants
  // to write, another process answered first, and overwriting would discard that
  // answer — so this pass holds and names both models instead.
  const freshModel = activeModel(head);
  if (freshModel !== write.base && freshModel !== write.model) {
    // A file left with no model line at all is the same refusal: the line this
    // pass was going to replace is gone, and whatever removed it did so under
    // this pass. It gets its own sentence because `undefined` is not a model,
    // and a note that names one would send the reader hunting for it.
    const change =
      freshModel === undefined
        ? "another pi process removed the model line from this file mid-pass"
        : `another pi process wrote "${freshModel}" into this file mid-pass`;
    return {
      kind: "held",
      why: `${change}, so "${write.model}" was not written — holding`,
    };
  }

  if (write.dry) return { kind: "would-write" };
  try {
    await replaceFileAtomically(write.file, next);
  } catch (err) {
    // The file, or its directory, was removed while this pass held the lock:
    // there is nothing left to land on, which is the same skip a missing file
    // gets rather than a failure the caller cannot act on.
    if (errnoIs(err, "ENOENT")) return { kind: "skipped (no file)" };
    throw err;
  }
  return { kind: "written" };
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
function deepseekReading(): MeteredReading {
  return { rail: "deepseek", ok: true, windows: [], metered: true, note: "metered" };
}

/**
 * The policy's view of the readings: each rail's latest and nothing else. A
 * last good reading never reaches `decide` — see `RailReadings`.
 */
function latestReadings(readings: ReadonlyMap<Rail, RailReadings>): Map<Rail, RailReading> {
  return new Map([...readings].map(([rail, r]) => [rail, r.latest]));
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

/** The keychain read: `security`'s stdout is the credential JSON itself. */
const execFileRead: CommandRunner = execFileRunner(CLAUDE_KEYCHAIN_TIMEOUT_MS);

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
 * per-episode halt — that one ends with the expiry, this one outlives it — so
 * the rail has to name what does end it.
 *
 * The two things that end it are both outside this process, and neither is
 * obvious from the rail line alone; without them the still-off feature reads as
 * a bug. A process that dies does *not* end it: the halt is a fact about the
 * machine's claude install, which is why it outlives a token and why another pi
 * process on this host inherits it.
 */
const STICKY_HALT_SUFFIX =
  "no further attempt will be made until the resolved claude changes or /quota-dispatch refresh";

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

export interface ClaudeIdentity {
  path: string;
  mtimeMs: number;
}

/**
 * The `claude` executable name, and the extensions a Windows PATH lookup tries
 * beside it when `PATHEXT` says nothing.
 */
const CLAUDE_EXE = "claude";
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve the `claude` this machine's ping would run, by PATH scan (never
 * spawning it), and its mtime. Skips directories and non-executable files.
 * Returns undefined when nothing resolves.
 *
 * A scan rather than a spawn because this runs on the path that decides whether
 * a ping may run at all: asking by running would be the very request the gates
 * exist to bound. `stat` follows a symlink on purpose — the mtime that moves
 * when an install is upgraded is the target's — while `realpath` is deliberately
 * not applied, so the identity is the name this PATH would select.
 *
 * Executability is part of the identity because it is part of the lookup: the
 * shell and `execvp` skip a `claude` they cannot run and take the next name on
 * PATH, so accepting a non-executable file here would key a halt to a file no
 * ping would ever reach.
 *
 * The scan mirrors the lookup the ping's own runner performs, `execvp`'s: an
 * empty segment is the working directory and a relative one is relative to it,
 * so both are resolved against the cwd and the answer is always absolute.
 */
export async function claudeInstall(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeIdentity | undefined> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((ext) => ext !== "")]
      : [""];
  for (const segment of (env.PATH ?? "").split(delimiter)) {
    // An empty segment means the working directory to `execvp` (and so to the
    // ping's `execFile`), resolved here against this process's cwd; skipping it
    // would key the halt to a different binary than the ping runs.
    const base = segment === "" ? "." : segment;
    for (const extension of extensions) {
      const candidate = resolve(base, `${CLAUDE_EXE}${extension}`);
      let found: Stats;
      try {
        found = await stat(candidate);
      } catch {
        continue;
      }
      if (!found.isFile()) continue;
      if (process.platform !== "win32" && (found.mode & 0o111) === 0) continue;
      return { path: candidate, mtimeMs: found.mtimeMs };
    }
  }
  return undefined;
}

export interface DispatcherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Seam: the claude install the sticky halt is keyed to. Defaults to
   * claudeInstall().
   */
  claudeIdentity?: () => Promise<ClaudeIdentity | undefined>;
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
  /**
   * Timings for the per-file lock a write to a shared agent file takes,
   * overriding `DEFAULT_FILE_WRITE` field by field. A seam for the same reason
   * `quotaRead` is one: how long a lock may sit before it is a crash, and how
   * long a writer waits for one, are facts about the machine and the tests, not
   * routing preferences, and the numbers only mean anything together.
   */
  fileWrite?: Partial<FileWritePacing>;
  /**
   * Timings for the two locks the shared readings file takes, overriding
   * `DEFAULT_SHARED_READINGS` and the computed fetch bound field by field. A
   * seam for the same reason `fileWrite` is one: a test that wants to watch a
   * waiter reach its bound must not wait out the shipped seconds, which depend
   * on how long a real vendor read may take.
   */
  readings?: Partial<SharedReadingsPacing>;
  /**
   * How the readings store waits between lock attempts. Injected alongside
   * `now` so a test that holds a fetch lock can advance the clock instead of
   * spending real time; the production default is `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface Dispatcher {
  /**
   * One rail's readings, read again only when its latest is older than `ttlMs`
   * or `force` is set.
   *
   * This and `allReadings` are the one way out of the reading cache, so a reader
   * outside the policy depends on this shape and not on what backs it.
   */
  railReadings(rail: Rail, force?: boolean): Promise<RailReadings>;
  /**
   * Every rail's readings, one entry per rail. Worth a second method over
   * `railReadings` because the policy and the report need the whole picture at
   * once. Each rail receives the same `force` flag, but each applies its own
   * TTL, so a pass deliberately mixes a still-warm cached rail with a lapsed one
   * that was just read.
   *
   * A caller can rely on exactly one entry per rail, and on each entry being the
   * same shape `railReadings` gives: `deepseek` is the metered variant, the
   * others carry their latest reading and, when a failure left one behind, the
   * last good reading. The returned `Map` is a snapshot — adding to or clearing
   * it does not touch the cache — not a synchronized sample of the rails.
   */
  allReadings(force?: boolean): Promise<Map<Rail, RailReadings>>;
  /**
   * Every rail's readings, whatever their age: an entry the store already holds
   * is returned without consulting its TTL, and only a rail with no entry at all
   * is read, once, unforced. A rail whose newest read failed is returned as it
   * stands — its `latest` failure beside the last good reading, when one was
   * left behind — rather than retried. The reading may come from the shared
   * file, so it is not necessarily one this process took.
   *
   * The one seam a reader outside the policy uses for "what is already known",
   * and the seam the generator path reads through.
   */
  knownReadings(): Promise<KnownReadings>;
  evaluate(opts?: { force?: boolean; dry?: boolean }): Promise<Array<{ decision: Decision; outcome: Outcome }>>;
  report(opts?: { force?: boolean }): Promise<string[]>;
  /** Clear the machine-wide sticky halt; `/quota-dispatch refresh` calls this. */
  clearStickyHalt(): Promise<void>;
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
  // One coordination per dispatcher, so every write a dispatcher makes takes its
  // lock on the same clock, and the injected `now` stays the only clock a test
  // has to know about. The timings are handed over as they were stated — the
  // module owns their defaults, and merging them here as well would be a second
  // copy of that rule to keep in step.
  const fileWrite: Coordination = { pacing: deps.fileWrite, now };
  // The longest a single vendor read can honestly take: every attempt timing
  // out, every backoff between them, and the refresh ping a Claude read may run
  // inside one of them. A waiter for another process's fetch lock is given this
  // much before it gives up and fetches for itself, so the bound can never cut
  // short a read that is still working — and can never hang past one that is
  // not. A test may state it directly.
  const fetchWaitMs =
    deps.readings?.fetchWaitMs ??
    pacing.attempts * pacing.timeoutMs + (pacing.attempts - 1) * pacing.backoffMs + CLAUDE_PING_TIMEOUT_MS;
  const readings = createSharedReadings({
    path: cfg.readingsPath,
    now,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    pacing: { ...DEFAULT_SHARED_READINGS, ...deps.readings, fetchWaitMs },
  });
  /**
   * A failed read, stamped with the dispatcher's own clock at the moment it
   * gave up. That is `readAt` — when the read gave up — not the TTL origin: the
   * TTL counts from the cache entry's `at`, stamped at insertion after this
   * returns.
   */
  function unavailable(rail: Rail, note: string): FailedReading {
    return { rail, ok: false, windows: [], readAt: now(), note };
  }
  // A `claudeCredsPath` naming anything but the default file belongs to another
  // profile, whose credential the login keychain never holds — so the fallback
  // is not offered to it.
  const keychain =
    deps.readKeychain ??
    (isDefaultClaudeCredsPath(cfg.claudeCredsPath) ? keychainReader() : undefined);
  // The mode and the default-path rule are resolved once, here, so the read that
  // skips a ping and the plan that would run one cannot disagree about why.
  const plan = refreshPlan(cfg, deps.refreshClaude);

  // One ping in flight at a time, however many callers race `railReadings`.
  let inFlight: Promise<ClaudePing> | undefined;
  // The gates over the next attempt live in the shared readings store, not in
  // this closure: they are facts about the credential and the machine's claude
  // install, so every pi process under this OS user must obey the same ones.
  // A gate hit never re-arms: `pollMs` ships at five minutes and the cooldown at
  // fifteen, so a hit that re-armed would push the retry out forever and the
  // ping would never be tried again after a transient failure.
  //
  // The install the sticky halt is keyed to. Resolved at most once per read, and
  // only when there is a halt to validate or a ping is about to run — the latter
  // so an `undiverted` verdict can be recorded against the install that actually
  // ran. Not tied to expiry: a usable-token read validates an existing halt too.
  const claudeIdentity = deps.claudeIdentity ?? (() => claudeInstall());

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
  async function claudeUsage(token: string): Promise<VendorReading> {
    const read = await readUsage("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
    if ("note" in read) return unavailable("claude", read.note);

    const readAt = now();
    const windows = parseClaudeUsage(read.json);
    if (!windows.length) return unavailable("claude", "no usage windows returned");
    return { rail: "claude", ok: true, windows, readAt, raw: read.json };
  }

  /**
   * The line one verdict earns, and the gate it arms. `undefined` for a verdict
   * whose meaning is only known after the re-read — `pinged`.
   *
   * A `failed` attempt in the mode that spends budget, or an `undiverted` one,
   * can only be repeated by paying again or by running again without effect, so
   * both halt — but the two halts differ in lifespan. `undiverted` is sticky: a
   * usable token does not clear it, because the next expiry would fail to divert
   * the same way and pay again, so it is keyed to the install it was armed from
   * and shared machine-wide. The spending mode's halt is per-episode, like the
   * `pinged`-without-a-token halt set below. A `deferred` attempt is reported but
   * arms nothing: another process is doing the work, so the next read may try
   * again.
   *
   * `identity` is the install resolved before the ping ran, so the sticky halt
   * an `undiverted` verdict arms names the executable that actually ran rather
   * than one resolved after it finished and perhaps changed underneath it. A
   * machine where nothing resolves records `null`/`null` rather than a guess —
   * the halt still stands, and only an explicit clear removes it.
   */
  async function recordVerdict(
    credential: string,
    verdict: ClaudePing,
    spends: boolean,
    identity: ClaudeIdentity | undefined,
  ): Promise<string | undefined> {
    if (verdict.outcome === "pinged") return undefined;
    const note = describePing(verdict);
    if (verdict.outcome === "deferred") return note;
    if (verdict.outcome === "undiverted") {
      const sticky = stickyHaltNote(note);
      await readings.setStickyHalt(
        identity === undefined
          ? { note: sticky, claudePath: null, claudeMtimeMs: null }
          : { note: sticky, claudePath: identity.path, claudeMtimeMs: identity.mtimeMs },
      );
      return sticky;
    }
    if (spends) {
      const halted = haltNote(note);
      await readings.setGates(credential, { halt: halted });
      return halted;
    }
    await readings.setGates(credential, { cooldown: { at: now(), note } });
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
    // The resolved credential path, which is also the shared store's key for
    // this rail: two configs that name one file through different spellings read
    // and arm one set of gates.
    const credential = credentialFor("claude");
    // Read before the credential, because the answer decides whether an attempt
    // may be made at all.
    const gates = await readings.gates(credential);

    // Resolved at most once per read, and only by the two callers that need it.
    let resolved: ClaudeIdentity | undefined;
    let resolvedOnce = false;
    const install = async (): Promise<ClaudeIdentity | undefined> => {
      if (!resolvedOnce) {
        resolvedOnce = true;
        resolved = await claudeIdentity();
      }
      return resolved;
    };

    // The sticky halt that still names this machine's install, or `undefined`.
    // The identity is what gives the halt its lifespan: an install that changed
    // is an install the halt says nothing about, so the halt goes — cleared
    // conditionally, so a peer's halt armed from some other install meanwhile is
    // not erased. A halt armed with no resolved install (`null`/`null`) is kept:
    // an unresolvable install is not evidence that the executable changed.
    //
    // The conditional clear is only conditionally effective: if a peer publishes
    // a different halt while the clear waits for the lock, the store keeps that
    // replacement, and this dispatcher must judge the survivor rather than ping
    // past it. So after each clear the survivor is re-read and re-judged, up to
    // a small bound — each turn only continues while peers keep arming halts
    // this install does not match. Past the bound the survivor is returned and
    // honoured, never discarded, because pinging past a live halt is the costlier
    // error.
    const liveSticky = async (sticky: StickyHalt | undefined): Promise<StickyHalt | undefined> => {
      let current = sticky;
      for (let turn = 0; turn < 3; turn++) {
        if (current === undefined || current.claudePath === null) return current;
        const found = await install();
        if (found === undefined) return current;
        if (found.path === current.claudePath && found.mtimeMs === current.claudeMtimeMs) return current;
        await readings.setStickyHalt(undefined, current);
        const survivor = (await readings.gates(credential)).sticky;
        if (survivor === undefined) return undefined;
        current = survivor;
      }
      return current;
    };

    const first = await readClaudeToken(cfg.claudeCredsPath, { keychain, now: now() });
    if ("token" in first) {
      // A usable token is the end of the expiry episode, so the per-episode halt
      // it armed is cleared here and nowhere else. The sticky one is not: it is
      // a property of the environment, not of this expiry.
      if (gates.halt !== undefined) await readings.setGates(credential, { clearHalt: true });
      const sticky = await liveSticky(gates.sticky);
      return sticky === undefined ? { token: first.token } : { token: first.token, note: sticky.note };
    }
    if (first.reason !== "expired") return { note: first.error };
    if ("skip" in plan) return { note: expiredNote(first.error, skippedNote(plan.skip)) };

    // A gate hit returns the note its attempt earned, without re-arming. The
    // sticky halt outranks the per-episode one: once the environment has failed
    // to divert, no attempt is worth making whatever else is armed.
    const sticky = await liveSticky(gates.sticky);
    if (sticky !== undefined) return { note: expiredNote(first.error, sticky.note) };
    if (gates.halt !== undefined) return { note: expiredNote(first.error, gates.halt) };
    if (gates.cooldown !== undefined && now() - gates.cooldown.at < CLAUDE_PING_COOLDOWN_MS) {
      return { note: expiredNote(first.error, gates.cooldown.note) };
    }

    // Resolved before the ping runs, not after, so an `undiverted` verdict is
    // keyed to the install that actually ran; an install that changes while the
    // ping runs must not be the one a halt is armed against.
    const identity = await install();
    const verdict = await (inFlight ??= plan.ping().finally(() => { inFlight = undefined; }));
    const decision = await recordVerdict(credential, verdict, plan.spends, identity);

    const reread = await readClaudeToken(cfg.claudeCredsPath, { keychain, now: now() });
    if ("token" in reread) {
      // The halt goes with the episode, including one this very attempt armed: a
      // spending-mode `failed` halts only until the store yields a token again.
      const after = await readings.gates(credential);
      if (after.halt !== undefined) await readings.setGates(credential, { clearHalt: true });
      const live = await liveSticky(after.sticky);
      return live === undefined ? { token: reread.token } : { token: reread.token, note: live.note };
    }
    // `pinged` but still nothing usable: the run dispatched a request and the
    // store gained nothing, so another one would not either.
    if (decision === undefined) {
      const halted = haltNote(describePing(verdict));
      await readings.setGates(credential, { halt: halted });
      return { note: expiredNote(reread.error, halted) };
    }
    return { note: expiredNote(reread.error, decision) };
  }

  async function fetchClaude(): Promise<VendorReading> {
    const outcome = await claudeToken();
    if (!("token" in outcome)) return unavailable("claude", outcome.note);
    const reading = await claudeUsage(outcome.token);
    if (outcome.note === undefined) return reading;
    return { ...reading, note: reading.note === undefined ? outcome.note : `${reading.note}; ${outcome.note}` };
  }

  async function fetchCodex(): Promise<VendorReading> {
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

    const readAt = now();
    const { windows, limited } = parseCodexUsage(read.json, { readAt });
    if (!windows.length) return unavailable("codex", "no rate_limit windows returned");
    if (!limited) return { rail: "codex", ok: true, windows, readAt, raw: read.json };
    // `limit_reached` means blocked outright, not merely close, so every budget
    // reads full rather than leaving a comfortable-looking percentage behind.
    return {
      rail: "codex",
      ok: true,
      windows: windows.map((w) => ({ ...w, used: 100 })),
      readAt,
      raw: read.json,
      note: "limit_reached=true",
    };
  }

  /**
   * The credential a rail's shared entry is keyed by.
   *
   * Resolved, not the raw config string: two configs can name one file through
   * different spellings, and they must share the entry they both mean. Two
   * genuinely different credentials — another Claude profile, another pi auth
   * file — get different keys and therefore never see each other's readings,
   * which is the one thing a shared cache must not do.
   */
  function credentialFor(rail: VendorRail): string {
    return resolve(rail === "claude" ? cfg.claudeCredsPath : cfg.piAuthPath);
  }

  /**
   * One rail's vendor read, as the store asks for it. The store is deliberately
   * not told which rail it is fetching — it keys on the credential the caller
   * named — so the throw-to-failure translation stays here, where the note it
   * builds is the one the report has always printed.
   */
  function fetchFor(rail: VendorRail): () => Promise<VendorReading> {
    return async () => {
      try {
        return rail === "claude" ? await fetchClaude() : await fetchCodex();
      } catch (err) {
        return unavailable(rail, (err as Error).message);
      }
    };
  }

  async function vendorRailReadings(rail: VendorRail, force: boolean): Promise<VendorRailReadings> {
    return readings.read(rail, credentialFor(rail), {
      ttlMs: cfg.ttlMs,
      force,
      fetch: fetchFor(rail),
    });
  }

  async function railReadings(rail: Rail, force = false): Promise<RailReadings> {
    // The metered rail has no endpoint to ask and no cache entry to hold: its
    // reading is a fact about the account, so there is nothing that could go
    // stale or fail.
    if (rail === "deepseek") return { latest: deepseekReading() };
    return vendorRailReadings(rail, force);
  }

  async function allReadings(force = false): Promise<Map<Rail, RailReadings>> {
    const rails: Rail[] = ["claude", "codex", "deepseek"];
    const entries = await Promise.all(rails.map((r) => railReadings(r, force)));
    return new Map(entries.map((r) => [r.latest.rail, r]));
  }

  /**
   * One capped rail for the generator input: an entry the store already holds is
   * returned whatever its age, and only the absence of one costs a read.
   * Deliberately not `railReadings(rail)`, whose TTL is the policy's freshness
   * rule for routing — a reader asking what is already known is not asking what
   * is fresh. The store answers from the file as well as this process, so a
   * reading another pi took is "already known" here too.
   */
  async function knownVendorRailReadings(rail: VendorRail): Promise<VendorRailReadings> {
    return (await readings.known(rail, credentialFor(rail))) ?? vendorRailReadings(rail, false);
  }

  async function knownReadings(): Promise<KnownReadings> {
    // Both rails in flight together: the two reads are independent, and a
    // sequential pair would make generation wait out two vendor latencies.
    const [claude, codex] = await Promise.all([
      knownVendorRailReadings("claude"),
      knownVendorRailReadings("codex"),
    ]);
    return { claude, codex, deepseek: { latest: deepseekReading() } };
  }

  async function decideAll(
    rails: Map<Rail, RailReading>,
    dry: boolean,
    directory: AgentDirectory,
  ): Promise<Array<{ decision: Decision; outcome: Outcome }>> {
    // One directory per pass, shared by the decisions and — in `report` — the
    // unmanaged list, so the two cannot disagree about which file defines which
    // agent. Reading per pass rather than once at boot is deliberate: a file
    // created with `/agents` after the boot warning is picked up on the next
    // pass, and so is a `name:` edited mid-session.
    return Promise.all(
      Object.entries(cfg.agents).map(async ([agent, route]) => {
        const resolution = resolveAgent(directory, agent);
        // A contested name has no single file to write, and no reading could
        // change which file that is, so it is answered before the model check.
        if (resolution.kind === "contested") {
          return { decision: contestedDecision(resolution), outcome: "held" as const };
        }
        if (deps.held && Object.hasOwn(deps.held, agent)) {
          return {
            decision: heldDecision({ agent, model: deps.held[agent] }),
            outcome: "held" as const,
          };
        }
        const decision = decide(
          resolution.definition,
          route,
          rails,
          cfg,
          deps.droppedAlternates?.[agent] ?? [],
        );
        // A hold writes nothing, whether it came from a reading or from a
        // definition `decide` refused.
        if (decision.kind === "hold") return { decision, outcome: "held" as const };
        // The path `/agents` would create is not the agent's file, so it is
        // never written: the write is refused here rather than by
        // `applyDecision` finding no file.
        if (resolution.kind === "missing") {
          return { decision, outcome: "skipped (no file)" as const };
        }
        const written = await applyDecision(
          {
            file: decision.file,
            model: decision.model,
            thinking: decision.thinking,
            // The pass's own read of the file, not a fresh one: this is the
            // line the decision is allowed to replace, and the whole of what
            // makes another process's assignment mid-pass detectable.
            base: passModel(directory, decision.file),
            dry,
          },
          fileWrite,
        );
        if (written.kind === "held") {
          // A refused write is a hold, and it is reported as one: the model the
          // pass wanted rides in the reason, because "left as is" on its own
          // would not say that this pass had an answer it declined to write.
          return { decision: { agent, kind: "hold", why: written.why }, outcome: "held" as const };
        }
        return { decision, outcome: written.kind };
      }),
    );
  }

  async function evaluate(
    opts: { force?: boolean; dry?: boolean } = {},
  ): Promise<Array<{ decision: Decision; outcome: Outcome }>> {
    const directory = await readAgentDirectory(cfg.agentDir);
    return decideAll(latestReadings(await allReadings(opts.force)), opts.dry ?? false, directory);
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
    const rails = latestReadings(await allReadings(opts.force));
    // Read before the decisions, and shared with them and with the unmanaged
    // list below, so the pass makes one read of the agent dir rather than two
    // that could disagree.
    const directory = await readAgentDirectory(cfg.agentDir);
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
    const decisions = await decideAll(rails, true, directory);
    // No separator without decisions: an unconfigured install has nothing
    // between the rail lines and whatever the caller appends.
    if (decisions.length) lines.push("");
    for (const { decision, outcome } of decisions) {
      lines.push(...describeDecisionLines(decision, outcome));
    }

    // Unlike the startup ask, this form reports unmanaged files whenever there
    // are any. It is the diagnostic, and "which of my files is this ignoring?"
    // is a question a configured install asks too; the ask stays quiet about
    // them because a configured install deliberately does not manage them. A
    // scoped file names no agent, so no route can name it and it is always
    // listed.
    const unmanaged = directory.files.filter(
      (file) => file.kind !== "agent" || !Object.hasOwn(cfg.agents, file.name),
    );
    if (unmanaged.length) {
      lines.push(
        "",
        `unmanaged agent files in ${cfg.agentDir} (no route names them):`,
        ...describeAgentFiles(unmanaged),
      );
    }
    // A warning the store recorded while the rails were read: a corrupt shared
    // file is not a reason to fail a report, but it is why the numbers above may
    // come from a vendor rather than from a peer process — and it is the only
    // place a user learns a file in their agent dir needs attention.
    const warnings = readings.warnings();
    if (warnings.length) lines.push("", ...warnings);
    return lines;
  }

  /**
   * Clear the machine-wide sticky halt.
   *
   * Unconditional, unlike the clear the expired-credential path makes: this is
   * the user's own lever (`/quota-dispatch refresh`), a deliberate statement
   * about the machine rather than a reader's stale observation, so there is
   * nothing to compare against.
   */
  async function clearStickyHalt(): Promise<void> {
    await readings.setStickyHalt(undefined);
  }

  return { railReadings, allReadings, knownReadings, evaluate, report, clearStickyHalt };
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
 * Report a config file that is there and was not used, on the reasons that ask
 * for setup, and say whether there was one to report.
 *
 * The answer is what the unconfigured branch needs: an install whose file names
 * routes that were thrown away is not asking to be configured from scratch.
 */
function announceUnusableConfig(
  loaded: LoadedConfig,
  ctx: ExtensionContext,
  reason: SessionStartEvent["reason"],
): boolean {
  if (!ctx.hasUI || !ASK_REASONS.has(reason)) return false;
  if (!loaded.files.some((file) => file.state.kind === "unusable")) return false;

  ctx.ui.notify(unusableConfigNotice(loaded.files).join("\n"), "warning");
  return true;
}

/**
 * The ask. It cannot coexist with the unusable-file notice above: an install is
 * unconfigured *or* it has a file that names routes, and one of those two things
 * is the answer to "why is nothing managed?".
 */
async function announceUnconfigured(
  loaded: LoadedConfig,
  ctx: ExtensionContext,
  reason: SessionStartEvent["reason"],
): Promise<void> {
  // An empty table is an empty table whether or not a file fed it, and
  // "unconfigured" is the standing fact between asks either way.
  setFooterStatus(ctx, STATUS_TEXT);
  if (announceUnusableConfig(loaded, ctx, reason)) return;
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

/**
 * Which form `/quota-dispatch` was invoked in.
 *
 * `report` carries its own `force` rather than being two variants because the
 * plain and `refresh` forms differ in that one boolean and in nothing else.
 */
export type Invocation =
  | { form: "report"; force: boolean }
  | { form: "config" }
  | { form: "apply" }
  | { form: "generate"; scope: "global" | "project" }
  | { form: "unknown"; arg: string };

/**
 * What the command's argument asks for.
 *
 * The argument is a form name and nothing else: the whole trimmed argument is
 * matched, not a substring of it. The `includes` test this replaces had two
 * failures worth naming. `refresh apply` read as `apply` — a word that could
 * have meant "just look" selected the one form that writes. And any typo fell
 * through to the plain report without saying so, which is the quiet-wrong-answer
 * shape the rest of this extension works to avoid. An argument naming no form is
 * now `unknown`, and the caller answers it with the list of forms rather than a
 * guess.
 */
export function parseInvocation(args: string): Invocation {
  const arg = args.trim();
  if (arg === "") return { form: "report", force: false };
  if (arg === "refresh") return { form: "report", force: true };
  if (arg === "config") return { form: "config" };
  if (arg === "apply") return { form: "apply" };
  // `generate` takes exactly one optional word, `project`; ordinary whitespace
  // between and around the words is allowed. Anything else — `generate global`,
  // a second word — is unknown, and answered with the catalogue rather than
  // guessed at. The scope is not a path and not a layer name to search: it
  // selects which of the two known files the declared command replaces.
  const words = arg.split(/\s+/);
  if (words[0] === "generate") {
    if (words.length === 1) return { form: "generate", scope: "global" };
    if (words.length === 2 && words[1] === "project") return { form: "generate", scope: "project" };
  }
  return { form: "unknown", arg };
}

/**
 * What an argument that names no form is told: the offending text, then the
 * forms. Listing them is the point — the failure being fixed is a form the user
 * could not discover, so the answer to a typo is the catalogue.
 */
export function unknownFormNotice(arg: string): string[] {
  return [
    `quota-dispatcher: "${arg}" is not a form.`,
    "Forms: /quota-dispatch, /quota-dispatch refresh, /quota-dispatch config, /quota-dispatch apply, /quota-dispatch generate [project].",
  ];
}

/**
 * The mutual exclusion between same-extension evaluations and a generation's
 * final transition.
 *
 * An evaluation reads the current configuration and writes agent files. A
 * generation changes the configuration and then evaluates once. Without this,
 * an evaluation that started on the *old* configuration could finish its writes
 * after the new one, leaving an agent on a model the new policy would not pick.
 * `acquire` refuses new evaluations and waits for running ones to drain; its
 * release lets them through again. It is deliberately tiny — no queue, no
 * cancellation, no arbitration between processes — because it only has to close
 * the instant between publication and cache swap.
 */
export interface EvaluationFence {
  /**
   * Run one evaluation, or `undefined` while the fence is up.
   *
   * `wait` is for the one caller whose result is a promise to the session: it
   * waits for the generation to release the fence and then runs, instead of
   * being refused. A refusal stays the default for a poll tick (the next one
   * catches up) and for `apply` (the user can try again).
   */
  run<T>(body: () => Promise<T>, options?: { wait?: boolean }): Promise<T | undefined>;
  /** Raise the fence, wait for running evaluations, and return its release. */
  acquire(): Promise<() => void>;
}

export function evaluationFence(): EvaluationFence {
  let fenced = false;
  let running = 0;
  const idle: Array<() => void> = [];
  const cleared: Array<() => void> = [];
  return {
    async run<T>(body: () => Promise<T>, options: { wait?: boolean } = {}): Promise<T | undefined> {
      // The loop is not for a queue: `acquire` is the only raiser, and it waits
      // for `running` before it hands back a release, so one release wakes every
      // waiter at once and the re-check is only for a second generation that
      // took the fence in the same instant.
      while (fenced) {
        if (!options.wait) return undefined;
        await new Promise<void>((done) => cleared.push(done));
      }
      running += 1;
      try {
        return await body();
      } finally {
        running -= 1;
        if (running === 0) for (const done of idle.splice(0)) done();
      }
    },
    async acquire(): Promise<() => void> {
      fenced = true;
      if (running > 0) await new Promise<void>((done) => idle.push(done));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fenced = false;
        for (const done of cleared.splice(0)) done();
      };
    },
  };
}

/**
 * Run one policy evaluation under the fence, reading the boot it evaluates only
 * once the fenced body has been entered.
 *
 * The indirection is the point. A `session_start` can await a boot that a
 * generation then supersedes: had it captured that boot's dispatcher before the
 * wait, it would evaluate the old policy *after* the generation had evaluated
 * the new one. Reading the boot inside the body puts the read in the same step
 * as the fence check, so a body that starts at all starts against the policy the
 * generation left, and one that would have started stale is refused instead —
 * or, with `wait`, released once the generation is done and then started
 * against the policy it left.
 */
export function fencedEvaluation<T, R>(
  fence: EvaluationFence,
  current: () => Promise<T> | undefined,
  evaluate: (value: T) => Promise<R>,
  options?: { wait?: boolean },
): Promise<R | undefined> {
  return fence.run(async () => {
    const pending = current();
    if (pending === undefined) return undefined;
    return evaluate(await pending);
  }, options);
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
   * none. It only needs the cadence, so it reads the config directly. Every
   * caller that needs the checks and the dispatcher goes through `bootOnce`; the
   * input handler is the deliberate exception, because a skill binding needs
   * neither.
   */
  let loadedPromise: Promise<LoadedConfig> | undefined;
  const loadedOnce = () => (loadedPromise ??= loadConfig());

  /**
   * Boot the extension against a context, once per extension load.
   *
   * Booting is where the two checks that need more than the config file run.
   * `checkModels` consults the running pi's model registry and drops candidates
   * this pi cannot spawn before any decision is made; `checkAgentFiles` reads
   * the agent dir and reports every configured agent no single file defines.
   * Their warnings both ride along with the load warnings, so `/quota-dispatch`
   * prints them whichever form was run, and the model check's `held` record is
   * what makes an unresolvable primary hold rather than be written.
   *
   * This is why a boot needs the context, and why the timer reads the cached
   * `boot` rather than starting one of its own: a boot without a registry skips
   * the model check silently, which would pin agents to models this pi cannot
   * spawn. `session_start` precedes the first tick, and generation boots the same
   * way, so the cache is warm by then; a tick with no cached boot at all is a
   * no-op rather than a ctx-less boot.
   */
  let boot:
    | Promise<{ loaded: LoadedConfig; dispatcher: Dispatcher; misses: ModelMiss[] }>
    | undefined;

  /**
   * Build the runtime a validated configuration implies: read the agent dir,
   * run the two checks that need pi, and create the dispatcher.
   *
   * Split out of `bootOnce` because generation needs it before it publishes: a
   * configuration that cannot be booted must fail before it reaches the disk,
   * so the prepared runtime is built from the generated layer and handed back
   * for the caches to swap in once the file has moved. It writes neither the
   * config file nor an agent file.
   */
  const bootFrom = async (
    base: LoadedConfig,
    ctx: ExtensionContext,
  ): Promise<{ loaded: LoadedConfig; dispatcher: Dispatcher; misses: ModelMiss[] }> => {
    const directory = await readAgentDirectory(base.config.agentDir);
    // Both checks join the load warnings, so the log, the report's warning
    // tail and `describeConfig` carry them: the agent-file check first, in the
    // place its warning used to sit when `loadConfig` still made it.
    const agentFileWarnings = checkAgentFiles(base.config, directory);
    const checked = checkModels(base.config, modelLookup(ctx));
    return {
      // The checked config is the effective one; `sources` still describe the
      // config that resulted, because the check only drops candidates it
      // cannot spawn.
      loaded: {
        ...base,
        config: checked.config,
        warnings: [...base.warnings, ...agentFileWarnings, ...checked.warnings],
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
  };

  const bootOnce = (ctx: ExtensionContext) => (boot ??= loadedOnce().then((base) => bootFrom(base, ctx)));

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  // Whether generation has already chosen the polling cadence. The first load's
  // scheduling runs from a callback registered before any command could run, so
  // this only matters if a generation somehow settles first — and then the
  // generated cadence must not be overwritten by the older one.
  let cadenceFromGeneration = false;
  // One generation at a time. Overlap is refused rather than queued: two runs
  // would both read the file, run a script and race to publish, and the second
  // would either lose its work to the compare-and-swap or clobber a change the
  // first had just made.
  let generating = false;

  // ------------------------------------------------------------- evaluation fence
  //
  // An evaluation reads the current config and writes agent files. A generation
  // changes the config and then evaluates once. Without a fence an evaluation
  // that started on the *old* config could finish its writes after the new
  // evaluation, leaving an agent on a model the new policy would not pick. The
  // fence is deliberately tiny: new evaluations are refused only for the final
  // transition, and already-running ones are drained before the file is
  // published. It is not a scheduler and does not arbitrate across processes.
  const fence = evaluationFence();
  const acquireFence = () => fence.acquire();

  /**
   * (Re)schedule the periodic evaluation for `cfg`.
   *
   * The one place a cadence is chosen, so the first load and a generation cannot
   * each set a timer: a generation whose output changed `pollMs`, emptied the
   * table or named different agents reschedules here rather than leaving the old
   * interval running. A stopped extension or an empty table gets no timer.
   */
  function scheduleTimer(cfg: DispatcherConfig): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (stopped || managesNothing(cfg)) return;
    timer = setInterval(() => {
      void fencedEvaluation(fence, () => boot, ({ dispatcher }) => dispatcher.evaluate()).catch(() => {});
    }, cfg.pollMs);
    timer.unref?.();
  }

  /**
   * Run the explicit generation form for one scope.
   *
   * The subprocess, the strict check and the atomic publication all live in
   * `generateConfig`; what happens here is the part that only the extension can
   * do — gather the readings the command is fed, prepare a runtime, swap the two
   * cached handles together, choose the cadence and evaluate the new policy once.
   * A failure is reported and changes nothing: no cache, no cadence, no footer.
   *
   * The readings come from the runtime of the configuration active *before* the
   * run — its credential paths — so this boots that runtime, where every other
   * pass on this path would not have had to. It is the same cached boot a session
   * start or a report uses, it writes nothing, and it is read lazily inside the
   * `input` callback: a file that declares no generator, or declares one badly,
   * still costs neither a boot nor a quota request.
   */
  async function runGenerate(scope: "global" | "project", ctx: ExtensionContext): Promise<void> {
    if (generating) {
      ctx.ui.notify("quota-dispatcher: a configuration generation is already running.", "warning");
      return;
    }
    generating = true;
    try {
      // The initial load is awaited before committing anything: its cadence
      // callback was registered at setup, and letting generation finish first
      // must not leave that older cadence able to overwrite the generated one.
      await loadedOnce();
      const path = scope === "global" ? globalConfigPath() : projectConfigPath();
      const result = await generateConfig({
        source: scope,
        path,
        // The active configuration's own readings, not the generated one's: a
        // generator is told what this install knows as it is being asked, and it
        // is about to change what that is.
        input: async () => {
          const booted = await bootOnce(ctx);
          return generatorInput(await booted.dispatcher.knownReadings());
        },
        prepare: (loaded) => bootFrom(loaded, ctx),
        acquireFence,
      });
      if (result.kind === "failed") {
        ctx.ui.notify(result.lines.join("\n"), "warning");
        return;
      }

      // Published. The two in-memory handles swap together, so the active
      // configuration cannot disagree with itself. The file was already
      // published a moment earlier, so a read in that instant can still see the
      // new file beside the old cached config — harmless, because this fence's
      // job is to order evaluations, not readers. The fence stays held through
      // the new evaluation so no poll tick can race it, and is released once
      // that work is done — or once it fails.
      loadedPromise = Promise.resolve(result.loaded);
      boot = Promise.resolve(result.prepared);
      try {
        cadenceFromGeneration = true;
        scheduleTimer(result.prepared.loaded.config);
        // The footer is a statement about the install, and generation can change
        // it: the table may now be configured, or a model this pi does not know
        // may have appeared. "resume" sets the line without a fresh notify — the
        // success notice below already carries every warning.
        if (managesNothing(result.prepared.loaded.config)) {
          setFooterStatus(ctx, STATUS_TEXT);
        } else {
          announceUnknownModels(result.prepared.misses, result.prepared.loaded, ctx, "resume");
        }

        const lines: string[] = [`[generated] ${result.path}`];
        let note: string | undefined = result.cleanupNote;
        try {
          // The same evaluation `session_start` runs: skipped when the new table
          // manages nothing (an empty table has no files to decide, and asking
          // two vendors for quota to decide about none is a request the user
          // never asked for), and unforced so it reads through the shared store
          // rather than forcing a fetch — another process, or this one's
          // predecessor before the swap, may already have answered the rail, and
          // activation is not a request for fresh numbers.
          const rows = managesNothing(result.prepared.loaded.config)
            ? []
            : await result.prepared.dispatcher.evaluate();
          lines.push(...rows.flatMap((r) => describeDecisionLines(r.decision, r.outcome)));
        } catch (err) {
          // The file moved and the caches swapped; a failure here cannot undo
          // that, so it is reported as a note rather than as an unchanged state.
          note = `the configuration was activated, but evaluating it once failed (${errorText(err)})`;
        }
        lines.push(
          "",
          describeConfigLayers(result.prepared.loaded),
          ...describeConfigWarnings(result.prepared.loaded),
        );
        if (note !== undefined) lines.push(`  note: ${note}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } finally {
        result.release();
      }
    } finally {
      generating = false;
    }
  }

  pi.registerCommand("quota-dispatch", {
    // The forms are named here because this is the only place pi shows them:
    // a user who never opens the README would not otherwise learn that the
    // provenance form exists.
    description: "Show subscription headroom and each agent's model; forms: refresh, config, apply, generate",
    handler: async (args, ctx) => {
      const invocation = parseInvocation(args ?? "");

      // Answered before the boot, so a typo costs no config read, no model check
      // and no quota request — and cannot reach a write.
      if (invocation.form === "unknown") {
        ctx.ui.notify(unknownFormNotice(invocation.arg).join("\n"), "warning");
        return;
      }

      // Generation runs the declared command and replaces one file, so it is
      // answered before the ordinary boot: it prepares its *own* runtime from the
      // generated layer, and the current runtime is booted separately inside the
      // run, only for the readings its command is fed.
      if (invocation.form === "generate") {
        await runGenerate(invocation.scope, ctx);
        return;
      }

      const { loaded, dispatcher } = await bootOnce(ctx);

      // Only `apply` and `generate` write, and only `config` skips the quota
      // read: it is about the files on this machine, so it answers without
      // costing a request.
      let lines: string[];
      if (invocation.form === "apply") {
        const rows = await fencedEvaluation(
          fence,
          () => bootOnce(ctx),
          ({ dispatcher }) => dispatcher.evaluate({ force: true }),
        );
        if (rows === undefined) {
          ctx.ui.notify("quota-dispatcher: a configuration generation is finishing; try again.", "warning");
          return;
        }
        lines = [
          "[applied]",
          ...rows.flatMap((r) => describeDecisionLines(r.decision, r.outcome)),
        ];
      } else if (invocation.form === "config") {
        lines = describeConfig(loaded);
      } else {
        // `refresh` is the user's one lever on the machine-wide sticky halt: the
        // halt outlives a token and a process, so without this a machine whose
        // diversion had failed once would have no way back short of editing the
        // shared file. Cleared before the report, so the forced read the report
        // makes is one that may actually ping.
        if (invocation.force) await dispatcher.clearStickyHalt();
        // The report carries the install's shape and its warnings, not where
        // each value came from: provenance is a question asked deliberately,
        // and `config` is the form that answers it. The warnings stay because a
        // config that is not doing what the user meant has to say so on the run
        // that read it, whichever form that was.
        lines = [
          ...(await dispatcher.report({ force: invocation.force })),
          "",
          describeConfigLayers(loaded),
          ...describeConfigWarnings(loaded),
        ];
      }

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
  //
  // The whole body — the gate, the announcements and the evaluation — runs on
  // one boot read *inside* the fence. Reading it here, before the fence, would
  // let a generation commit while this boot was pending and leave the gate and
  // the footer describing a superseded table; the generation has its own
  // announcement, so the cost is a stale footer plus a quota request the new
  // empty table did not ask for. Waiting (rather than being refused) is also
  // what keeps this handler's promise: unlike a poll tick, the session's first
  // spawn is held on this evaluation.
  pi.on("session_start", async (event, ctx) => {
    await fencedEvaluation(
      fence,
      () => bootOnce(ctx),
      async ({ loaded, misses, dispatcher }) => {
        if (managesNothing(loaded.config)) {
          await announceUnconfigured(loaded, ctx, event.reason);
          return;
        }

        // Before the evaluation, so the warning is on screen while the quota
        // reads that follow it are still in flight. It also replaces the footer
        // line an unconfigured install left: the table is read once per
        // extension load, so the state has to change here or nowhere.
        //
        // A config file that could not be used is reported here too, not only
        // when it leaves the table empty: the layer it lost is not the whole
        // config, so the other symptom is a route that is quietly not the one
        // the reader wrote — the same invisible-from-the-outside state ADR 0009
        // raised for a model this pi cannot spawn.
        announceUnusableConfig(loaded, ctx, event.reason);
        announceUnknownModels(misses, loaded, ctx, event.reason);
        await dispatcher.evaluate().catch(() => {});
      },
      { wait: true },
    );
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
  //
  // A cadence a generation has already chosen is not overwritten by this first
  // callback, which was registered before any command could run.
  void loadedOnce().then((loaded) => {
    if (cadenceFromGeneration) return;
    scheduleTimer(loaded.config);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    if (timer) clearInterval(timer);
    setFooterStatus(ctx, undefined);
  });

  // An explicit `/skill:<name>` applies its binding before pi expands the skill:
  // input handlers run first and are awaited. The path touches only the cached
  // config and the agent dir — no boot, no quota request, no credential, no write
  // — and returns nothing, so the text reaches pi exactly as typed and the skill
  // runs whatever happened here. See
  // docs/adr/0014-skill-bindings-read-the-agent-file.md.
  //
  // `loadedOnce` rather than `bootOnce`: a boot runs the model and agent-file
  // checks and builds the dispatcher, none of which a binding needs, and a
  // binding must not be what triggers them.
  pi.on("input", async (event, ctx) => {
    // Answered before the config is read, so ordinary input costs nothing.
    if (explicitSkill(event.text) === undefined) return;
    const { config } = await loadedOnce();
    await applySkillBinding(
      {
        config,
        readSelection: agentSelectionReader(config.agentDir),
        selection: {
          // `ctx.model` is a live getter over the session's current model, so
          // reading it before the switch gives the pre-switch model, and reading
          // it after a fault says whether the session moved.
          getModel: () => ctx.model,
          // Feature-detected like `modelLookup`: a context whose registry lacks
          // `find` is no registry, so the binding warns "does not know model"
          // rather than throwing into the catch-all.
          findModel: (provider, modelId) =>
            typeof ctx.modelRegistry?.find === "function"
              ? ctx.modelRegistry.find(provider, modelId)
              : undefined,
          setModel: (model) => pi.setModel(model),
          getThinkingLevel: () => pi.getThinkingLevel(),
          setThinkingLevel: (level) => pi.setThinkingLevel(level),
        },
        // A binding's notice is a UI affordance like every other one here; a
        // headless context has nowhere to show it and no one watching.
        notify: (message, type) => {
          if (ctx.hasUI) ctx.ui.notify(message, type);
        },
      },
      event.text,
    );
  });
}
