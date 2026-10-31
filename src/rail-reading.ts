/**
 * The rail reading: what one quota read reported about one rail, the parsers that
 * turn a vendor's own document into one, and the few judgments that can be made
 * about a reading without a configuration.
 *
 * A reading is the policy's only evidence, and it is read by four modules that
 * must agree on its shape: the policy decides on it, the rail gauge draws it, the
 * readings file stores and replays it, and the generator serializes it. All four
 * get the shape, its parsers and its one decoder from here, so the type has one
 * home and one validation site.
 *
 * What deliberately stays out: the thresholds a reading is weighed against
 * (`thresholdFor` and the switch policy), because a reading states facts and a
 * configured switch point is not one of them; the reading's *text* in a decision
 * or a report; and the entry envelope, versioning and gates of the readings file,
 * which are that file's own business.
 */
import { jsonObject } from "./json.ts";
import { RAIL_BUDGETS, carries, type AntigravityRail, type Budget, type Rail } from "./rail.ts";

// ---------------------------------------------------------------- shape

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

/** A reading that came from asking: every rail but the metered one, and the only kind the file holds. */
export type VendorReading = GoodReading | FailedReading;

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

/**
 * Which pool owns a bucket, by the bucket id's own prefix.
 *
 * The vendor groups its buckets under display names, but the names and the group
 * order are presentation: what a bucket *is* comes from its id. Argon is matched
 * before the general `gemini-` prefix because the Argon pool's buckets are Gemini
 * buckets too (`gemini-argon-wtu-weekly`), and only the id distinguishes them.
 */
function antigravityPoolFor(bucketId: string): AntigravityRail | undefined {
  if (bucketId.startsWith("gemini-argon-")) return "antigravity-argon";
  if (bucketId.startsWith("gemini-")) return "antigravity-gemini";
  if (bucketId.startsWith("3p-")) return "antigravity-3p";
  return undefined;
}

/**
 * The budget a bucket's window counts toward.
 *
 * Exact matches only: an unfamiliar window (a future `monthly`, a vendor rename)
 * is display-only rather than guessed into a budget, because a guess would make a
 * required budget look reported when it was not.
 */
function antigravityBudget(window: unknown): Budget | undefined {
  if (window === "5h") return "session";
  if (window === "weekly") return "weekly";
  return undefined;
}

/**
 * One `retrieveUserQuotaSummary` document partitioned across the three pools.
 *
 * A pool with no bucket of its own is an empty list, not an absent key: the
 * caller states the same three rails whatever the vendor said, and an empty list
 * is how "this response said nothing about that pool" is spelled. Everything the
 * parser cannot use — a bucket with no id, a fraction that is missing or not a
 * number, a bucket belonging to no pool — is dropped rather than repaired.
 *
 * `remainingFraction` is what the vendor reports, so `used` is its complement in
 * whole percent, clamped: a fraction outside `[0, 1]` would otherwise produce a
 * negative or impossible usage figure that the policy would weigh as real.
 */
export function parseAntigravityUsage(data: unknown): Record<AntigravityRail, RailWindow[]> {
  const windows: Record<AntigravityRail, RailWindow[]> = {
    "antigravity-argon": [],
    "antigravity-gemini": [],
    "antigravity-3p": [],
  };
  const groups = jsonObject(data)?.groups;
  if (!Array.isArray(groups)) return windows;
  for (const group of groups) {
    const buckets = jsonObject(group)?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      const fields = jsonObject(bucket);
      if (fields === undefined) continue;
      const bucketId = fields.bucketId;
      if (typeof bucketId !== "string") continue;
      const rail = antigravityPoolFor(bucketId);
      if (rail === undefined) continue;
      const remaining = num(fields.remainingFraction);
      if (remaining === undefined) continue;
      const budget = antigravityBudget(fields.window);
      const resetsAt = instant(fields.resetTime);
      windows[rail].push({
        label: bucketId,
        used: Math.round((1 - Math.min(1, Math.max(0, remaining))) * 100),
        ...(budget === undefined ? {} : { budget }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    }
  }
  return windows;
}

// ---------------------------------------------------------------- usage

/**
 * Used-percent for one budget, or `undefined` when the rail carries the budget
 * and did not report it.
 *
 * `undefined` rather than 0 is the point, and applies to a budget the rail
 * carries. A missing 5-hour window on a rail that has one is not evidence that
 * the 5-hour budget is free, and reading it as free is exactly how a rail that
 * was blocked outright came to look like the roomiest place to send work.
 * Several windows can share a budget — Claude reports an account-wide week plus
 * per-model weeks, Antigravity reports one bucket per pool — so this takes the
 * worst of them.
 *
 * `0` is the answer for a budget the rail does not carry: a metered rail is
 * billed per token rather than capped, and Argon's pool has no session window, so
 * neither can ever be tight there. That is a different fact from "the read did
 * not say", and the two must not be spelled alike — see `RAIL_BUDGETS`.
 */
export function budgetUsed(reading: RailReading, budget: Budget): number | undefined {
  if (reading.metered || !carries(reading.rail, budget)) return 0;
  const used = reading.windows.filter((w) => w.budget === budget).map((w) => w.used);
  return used.length ? Math.max(...used) : undefined;
}

/**
 * The budgets a rail carries and failed to report.
 *
 * A budget the rail does not carry is never missing — it reads 0 through
 * `budgetUsed` — and unreadable rails are rejected before this is consulted, so
 * anything returned here is a partial reading of a cap the rail really has. The
 * policy holds rather than guessing: an unreported budget is not an idle one.
 */
export function absentBudgets(reading: RailReading): Budget[] {
  return RAIL_BUDGETS[reading.rail].filter((b) => budgetUsed(reading, b) === undefined);
}

/**
 * Whether a reading puts `budget` at or above `threshold` — the one
 * implementation of the judgment CONTEXT.md calls **tight**, shared by the
 * policy and the rail gauge so a budget the policy calls tight cannot print as
 * comfortable.
 *
 * The threshold is the caller's, never read from a configuration: a reading
 * states facts, and this is a judgment made *about* one, so the module that
 * states facts does not go looking for a switch point.
 *
 * Two cases are never tight, and neither is a guess at room. A budget the rail
 * does not carry cannot be exceeded there, so no threshold — not even one
 * configured as `0` — may make it tight; that is what keeps Argon, with no
 * session window at all, from being refused on one. A carried budget the read
 * did not report is not evidence of pressure either: the policy holds on it
 * instead, because a missing number is not a small one.
 */
export function isTight(reading: RailReading, budget: Budget, threshold: number): boolean {
  if (!carries(reading.rail, budget)) return false;
  const used = budgetUsed(reading, budget);
  return used !== undefined && used >= threshold;
}

/**
 * Used-percent at which a budget has reached the vendor's own cap. Not a
 * threshold: the switch thresholds are configurable and this is the vendor's
 * hard limit, the one that changes how the vendor behaves rather than how the
 * dispatcher does.
 */
const EXHAUSTED = 100;

/**
 * Whether a spent week has switched this rail's session budget off, and left it
 * with nothing to spend.
 *
 * Antigravity says so in as many words — "You have hit your weekly limit, the
 * 5-hour limit does not currently apply" — and still reports a 5-hour window at
 * 0%, so the figure must be read against the week rather than taken at face
 * value. The week is the rail's worst pool, which is what `budgetUsed` returns:
 * one pool at its cap is enough, and the vendor turns the limit off for the
 * whole account. A rail with no session budget still answers here, because a
 * spent week leaves it with nothing to spend either — only the `disabled` slot
 * is out of its reach (`freshBudget` and `staleBudget` answer `uncarried` first,
 * so Argon keeps its `–`).
 */
export function weekSpent(reading: RailReading): boolean {
  const week = budgetUsed(reading, "weekly");
  return week !== undefined && week >= EXHAUSTED;
}

// ---------------------------------------------------------------- from the readings file

/**
 * Whether `value` is a window the policy can weigh.
 *
 * Each field is the one a consumer reads: `label` and `used` are interpolated
 * straight into the report, so a missing one would print `undefined`, and
 * `budget` and `resetsAt` are optional exactly as `RailWindow` declares them.
 * A window that fails here fails its whole reading, because a reading is the
 * unit the policy decides on and half of one is not a reading.
 */
function validWindow(value: unknown): value is RailWindow {
  if (value === null || typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  if (typeof w.label !== "string") return false;
  if (typeof w.used !== "number" || !Number.isFinite(w.used)) return false;
  if (w.budget !== undefined && w.budget !== "session" && w.budget !== "weekly") return false;
  if (w.resetsAt !== undefined && (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt))) {
    return false;
  }
  return true;
}

/**
 * Whether `value` is a successful reading of `rail`, as the file's schema
 * states one.
 *
 * The `raw` key must be *present* rather than merely truthy: a generator reads
 * it, and an entry whose writer dropped it would be a reading a consumer cannot
 * use. `metered` is refused exactly where the union refuses it, so a hand-edited
 * file cannot smuggle the metered arm into a capped rail.
 */
function goodReading(value: unknown, rail: VendorRail): GoodReading | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r.rail !== rail) return undefined;
  if (r.ok !== true) return undefined;
  if (r.metered !== undefined) return undefined;
  if (typeof r.readAt !== "number" || !Number.isFinite(r.readAt)) return undefined;
  if (!Array.isArray(r.windows) || !r.windows.every(validWindow)) return undefined;
  if (!Object.hasOwn(r, "raw")) return undefined;
  if (r.note !== undefined && typeof r.note !== "string") return undefined;
  return r as unknown as GoodReading;
}

/**
 * Whether `value` is a failed reading of `rail`, as the file's schema states
 * one. The empty `windows` is required rather than tolerated: a failure reports
 * no windows, and a decoded failure that carried some would give the policy
 * numbers the failure's own note says it does not have.
 */
function failedReading(value: unknown, rail: VendorRail): FailedReading | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r.rail !== rail) return undefined;
  if (r.ok !== false) return undefined;
  if (r.metered !== undefined) return undefined;
  if (typeof r.readAt !== "number" || !Number.isFinite(r.readAt)) return undefined;
  if (!Array.isArray(r.windows) || r.windows.length !== 0) return undefined;
  if (typeof r.note !== "string") return undefined;
  return r as unknown as FailedReading;
}

/**
 * A reading of `rail` as the readings file states one, or `undefined` when the
 * value is not one.
 *
 * The rail is a parameter rather than read off the value: an entry may only hold
 * a reading of the rail it is filed under, so a hand edit that rewrites one
 * `rail` key cannot move another pool's numbers onto it. The file keeps what is
 * genuinely its own — the entry envelope, the document version, the gates — and
 * this answers only the reading's own shape and which arm it is.
 */
export function decodeReading(value: unknown, rail: VendorRail): VendorReading | undefined {
  return goodReading(value, rail) ?? failedReading(value, rail);
}
