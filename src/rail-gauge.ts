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
 */
export type BudgetGauge =
  | { readonly kind: "uncarried" }
  | { readonly kind: "unreported" }
  | { readonly kind: "used"; readonly used: number }
  | { readonly kind: "tight"; readonly used: number; readonly resetInMs: number | undefined };

/**
 * A stale reading is shown, never judged: it has no `tight` arm.
 *
 * The policy holds on a rail whose latest read failed, so there is no judgment to
 * display — and coloring a number that no longer decides anything as tight would
 * suggest one.
 */
export type StaleBudgetGauge = Exclude<BudgetGauge, { kind: "tight" }>;

/** One rail as the gauge draws it. `unread` is a rail with no number at all. */
export type GaugeEntry =
  | {
      readonly rail: VendorRail;
      readonly kind: "fresh";
      readonly session: BudgetGauge;
      readonly weekly: BudgetGauge;
    }
  | {
      readonly rail: VendorRail;
      readonly kind: "stale";
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
/** U+21BB, "resets": the time left until the tight budget clears. */
const RESET = "↻";

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
 * Most-used first, with the fixed order breaking ties and ordering rail with no
 * number at all last. Input order is deliberately irrelevant: the caller maps
 * over the rails it configures, and the sort is what makes that order not matter.
 */
function ordered(entries: readonly GaugeEntry[]): GaugeEntry[] {
  const rank = (entry: GaugeEntry) => GAUGE_ORDER.indexOf(entry.rail);
  const keyed = entries.map((entry) => ({ entry, peak: peak(entry), rank: rank(entry) }));
  return keyed
    .sort((a, b) => {
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
    case "used":
      return [{ text: whole(budget.used), tone: "dim" }];
  }
}

/**
 * One budget slot's tokens: the number, and for a tight one the reset it clears
 * at. `↻` is dropped rather than guessed when the vendor reported no reset — a
 * made-up duration would be a lie about the one thing a tight budget makes the
 * reader want to know.
 */
function slotTokens(budget: BudgetGauge): Token[] {
  switch (budget.kind) {
    case "tight":
      return [
        {
          text: budget.resetInMs === undefined ? whole(budget.used) : `${whole(budget.used)}${RESET}${resetText(budget.resetInMs)}`,
          tone: "warning",
        },
      ];
    default:
      return budgetTokens(budget);
  }
}

function entryTokens(entry: GaugeEntry): Token[] {
  const label = GAUGE_LABELS[entry.rail];
  if (entry.kind === "unread") return [{ text: `${label} ?`, tone: "dim" }];
  const tokens: Token[] = [
    { text: `${label} `, tone: "dim" },
    ...slotTokens(entry.session),
    { text: "/", tone: "dim" },
    ...slotTokens(entry.weekly),
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
