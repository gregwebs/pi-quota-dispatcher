/**
 * The rail gauge's text: how much of each budget a capped rail has used, ordered
 * most-used first. Pure — it is handed readings an evaluation already made and
 * has no way to make one. The projection from `RailReadings` lives in index.ts
 * beside the policy helpers it must agree with (`thresholdFor`, `budgetUsed`),
 * so tightness here cannot drift from tightness there.
 *
 * The footer is the only consumer, and it is what fixes the shape of this
 * interface: a caller projects its readings onto `GaugeEntry`, states how the two
 * tones are drawn, and gets back one line or `undefined`. Nothing else — no
 * context, no config, no clock — is reachable from here, which is what makes "a
 * drawing never causes a read" a property of the type rather than a promise.
 *
 * The type-only import of `VendorRail` back from index.ts follows the same
 * cycle-safe precedent as `readings-file.ts` and `refresh.ts`: types are erased,
 * so the runtime graph stays one-directional.
 */
import type { VendorRail } from "./index.ts";

/**
 * The tie order, and the order a rail with no number falls back to.
 *
 * Fixed rather than derived so two prints of the same readings always read the
 * same way: a gauge that reshuffled on a rounding difference would be a footer
 * the eye has to re-parse every tick.
 */
export const GAUGE_ORDER: readonly VendorRail[] = [
  "claude",
  "codex",
  "antigravity-3p",
  "antigravity-gemini",
  "antigravity-argon",
];

/** Exhaustive so a new capped rail cannot ship without a footer label. */
export const GAUGE_LABELS: Record<VendorRail, string> = {
  claude: "claude",
  codex: "codex",
  "antigravity-3p": "ag-3p",
  "antigravity-gemini": "ag-gemini",
  "antigravity-argon": "ag-argon",
};

/**
 * A budget slot as a fresh reading supports it.
 *
 * `uncarried` and `unreported` are different facts and are spelled differently:
 * Argon has no session budget, while a rail that carries one and did not report
 * it told us nothing. Collapsing them would print a missing reading as a free
 * budget — the error `budgetUsed` exists to prevent.
 *
 * `resetInMs` is required even when unknown, so a producer has to decide about
 * the countdown rather than forget it: `undefined` means the vendor reported no
 * reset for the window carrying the figure, and the slot prints its number alone.
 *
 * `disabled` is the vendor's own statement that a budget does not currently
 * apply — a spent week turns the 5-hour limit off — so it is neither a reading
 * nor an absence: the window may well be reported at 0%, and printing that would
 * claim a freedom the vendor has withdrawn.
 */
export type BudgetGauge =
  | { readonly kind: "uncarried" }
  | { readonly kind: "unreported" }
  | { readonly kind: "disabled" }
  | { readonly kind: "used"; readonly used: number; readonly resetInMs: number | undefined }
  | { readonly kind: "tight"; readonly used: number; readonly resetInMs: number | undefined };

/**
 * A stale reading is shown, never judged: it has no `tight` arm.
 *
 * The policy holds on a rail whose latest read failed, so there is no judgment to
 * display — and coloring a number that no longer decides anything as tight would
 * suggest one.
 *
 * It has no countdown arm either, spelled out rather than derived. A stale
 * reading's `resetsAt` came from a read that is already old, so subtracting the
 * clock from it yields a duration that looks fresh about a figure that is not;
 * leaving the countdown out of the type is what makes that unrepresentable here,
 * rather than a rule the renderer has to remember.
 */
export type StaleBudgetGauge =
  | { readonly kind: "uncarried" }
  | { readonly kind: "unreported" }
  | { readonly kind: "disabled" }
  | { readonly kind: "used"; readonly used: number };

/**
 * One rail as the gauge draws it. `unread` is a rail with no number at all.
 *
 * `spent` is the rail-level fact the sort needs and cannot derive from a peak:
 * a weekly pool has reached the vendor's cap, so there is nothing left on this
 * rail to spend for days. It is stated rather than recomputed here so that what
 * makes a rail spent — the vendor's 100%, not a switch threshold — stays in the
 * projection beside the `disabled` slot it also decides. An `unread` rail cannot
 * state it: no reading means no evidence either way, and a rail that might still
 * have headroom must not be sorted with the one that does not.
 */
export type GaugeEntry =
  | {
      readonly rail: VendorRail;
      readonly kind: "fresh";
      readonly spent: boolean;
      readonly session: BudgetGauge;
      readonly weekly: BudgetGauge;
    }
  | {
      readonly rail: VendorRail;
      readonly kind: "stale";
      readonly spent: boolean;
      readonly session: StaleBudgetGauge;
      readonly weekly: StaleBudgetGauge;
    }
  | { readonly rail: VendorRail; readonly kind: "unread" };

/** How the two tones are drawn; the extension passes pi's theme, a test a tagger. */
export interface GaugeStyle {
  dim(text: string): string;
  warning(text: string): string;
}

/** U+2502, the box-drawing bar: a thinner separator than `|` at footer size. */
const GAUGE_SEPARATOR = " │ ";
/** U+2013, a budget the rail does not have. */
const ABSENT = "–";
/**
 * A budget the vendor has switched off, which is why it is not a figure: the
 * reading may still carry one, and printing it would show 0% on a cap that is
 * not merely free but suspended.
 */
const DISABLED = "x";
/**
 * What stands between a budget's figure and the time left until it resets.
 *
 * A comma rather than an arrow because the figure is now always followed by its
 * countdown, and an arrow on every slot is a glyph repeated five times a line —
 * noise where the line should be numbers.
 */
const RESET_DELIMITER = ",";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The time left until a reset, in the coarsest unit that keeps the figure
 * honest: `45m`, `3h`, `4d`.
 *
 * Each unit is chosen *after* rounding, so a value that rounds up to the next
 * unit is promoted rather than printed as `60m` or `24h`. Minutes round up and
 * the rest round to nearest, because under a minute "0m" would claim no time is
 * left; a reset that has already passed says `now` instead of a negative.
 */
export function resetText(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

type Tone = "dim" | "warning";
interface Token {
  readonly text: string;
  readonly tone: Tone;
}

/** Whole percent as the report prints it. Display only: the order uses the raw figure. */
function whole(used: number): string {
  return used.toFixed(0);
}

/**
 * The rail's highest raw budget percentage, or `undefined` when it shows no
 * number at all.
 *
 * Raw rather than rounded, so two rails that both print `74` still order by what
 * they actually used. A stale entry counts: its last good reading is the last
 * thing known about it.
 */
function peak(entry: GaugeEntry): number | undefined {
  if (entry.kind === "unread") return undefined;
  const used = [entry.session, entry.weekly].flatMap((budget) =>
    budget.kind === "used" || budget.kind === "tight" ? [budget.used] : [],
  );
  return used.length ? Math.max(...used) : undefined;
}

/**
 * Most-used first, with the fixed order breaking ties and a rail with no number
 * at all last. Input order is deliberately irrelevant: the caller maps over the
 * rails it configures, and the sort is what makes that order not matter.
 *
 * A rail whose week is spent sorts after even those: the peak of a maxed rail is
 * 100 and would otherwise put it first, which is the wrong end of the line. Its
 * figure is the least actionable thing the gauge can print — nothing can be sent
 * there for days — so it goes last, while a rail with no number at all still
 * goes ahead of it, because an unread rail may well have headroom.
 */
function ordered(entries: readonly GaugeEntry[]): GaugeEntry[] {
  const rank = (entry: GaugeEntry) => GAUGE_ORDER.indexOf(entry.rail);
  const keyed = entries.map((entry) => ({
    entry,
    peak: peak(entry),
    spent: entry.kind !== "unread" && entry.spent,
    rank: rank(entry),
  }));
  return keyed
    .sort((a, b) => {
      if (a.spent !== b.spent) return a.spent ? 1 : -1;
      if (a.peak === undefined && b.peak !== undefined) return 1;
      if (b.peak === undefined && a.peak !== undefined) return -1;
      if (a.peak !== undefined && b.peak !== undefined && a.peak !== b.peak) return b.peak - a.peak;
      return a.rank - b.rank;
    })
    .map(({ entry }) => entry);
}

function budgetTokens(budget: StaleBudgetGauge): Token[] {
  switch (budget.kind) {
    case "uncarried":
      return [{ text: ABSENT, tone: "dim" }];
    case "unreported":
      return [{ text: "?", tone: "dim" }];
    case "disabled":
      return [{ text: DISABLED, tone: "dim" }];
    case "used":
      return [{ text: whole(budget.used), tone: "dim" }];
  }
}

/**
 * One budget slot's tokens: the figure, and the time left until it resets.
 *
 * The countdown is dropped rather than guessed when the vendor reported no reset
 * — a made-up duration would be a lie about the one thing the figure makes the
 * reader want to know — and a tight slot draws figure and countdown together in
 * the warning color, so "when does this clear" is answered without the eye
 * hunting for a second figure.
 */
function slotTokens(budget: BudgetGauge): Token[] {
  switch (budget.kind) {
    case "tight":
      return [{ text: figure(budget), tone: "warning" }];
    case "used":
      return [{ text: figure(budget), tone: "dim" }];
    default:
      return budgetTokens(budget);
  }
}

/** A reported figure and, when one is known, its countdown: `74`, or `74,2h`. */
function figure(budget: { readonly used: number; readonly resetInMs: number | undefined }): string {
  const countdown = budget.resetInMs === undefined ? "" : `${RESET_DELIMITER}${resetText(budget.resetInMs)}`;
  return `${whole(budget.used)}${countdown}`;
}

function entryTokens(entry: GaugeEntry): Token[] {
  const label = GAUGE_LABELS[entry.rail];
  if (entry.kind === "unread") return [{ text: `${label} ?`, tone: "dim" }];
  // A stale entry is drawn through `budgetTokens`, which has no countdown arm to
  // reach for: its budgets are of the type that cannot carry one.
  const [session, weekly] =
    entry.kind === "stale"
      ? [budgetTokens(entry.session), budgetTokens(entry.weekly)]
      : [slotTokens(entry.session), slotTokens(entry.weekly)];
  const tokens: Token[] = [
    { text: `${label} `, tone: "dim" },
    ...session,
    { text: "/", tone: "dim" },
    ...weekly,
  ];
  if (entry.kind === "stale") tokens.push({ text: "?", tone: "dim" });
  return tokens;
}

/**
 * The one line, or `undefined` when there is nothing to draw.
 *
 * Adjacent same-tone tokens are merged before styling, so a line carries one
 * escape run per tone change rather than one per token.
 */
export function renderRailGauge(
  entries: readonly GaugeEntry[],
  style: GaugeStyle,
): string | undefined {
  if (entries.length === 0) return undefined;
  const tokens: Token[] = [];
  ordered(entries).forEach((entry, index) => {
    if (index > 0) tokens.push({ text: GAUGE_SEPARATOR, tone: "dim" });
    tokens.push(...entryTokens(entry));
  });
  let out = "";
  let run: Token[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = run.map((token) => token.text).join("");
    out += run[0].tone === "warning" ? style.warning(text) : style.dim(text);
    run = [];
  };
  for (const token of tokens) {
    if (run.length && run[0].tone !== token.tone) flush();
    run.push(token);
  }
  flush();
  return out;
}
