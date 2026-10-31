/**
 * The rail: one independently capped quota pool, and the facts about it that a
 * reading is interpreted against.
 *
 * This module is where "what a rail is" has its single home. Three modules name
 * rails and must agree on the list — the configuration names one per candidate,
 * the rail gauge draws them, and a rail reading is about one — so the identity,
 * its guards, the model prefixes that imply it and the budgets it carries live
 * here and nowhere else.
 *
 * Two things deliberately do not live here. It owns no reading and nothing about
 * what a rail reported: that is `rail-reading.ts`. And it owns no threshold:
 * whether a budget is *tight* is a judgment about a reading, made with a number
 * the caller supplies, so a configured switch point never reaches this module.
 *
 * See CONTEXT.md's "Rail", "Session budget" and "Weekly budget", and
 * docs/adr/0005-model-rails.md: the rail is a property of the model, registered
 * once, not of the route that names the model.
 */

/**
 * The three quota pools Antigravity gives one account, each independently capped.
 *
 * They are separate rails rather than one account rail because the vendor caps
 * them separately: spending the Claude-and-GPT pool says nothing about the
 * Gemini one. They share a credential and a single vendor read, which is why the
 * dispatcher fetches them as a group — see
 * `docs/adr/0019-antigravity-pool-rails.md`.
 */
export const ANTIGRAVITY_RAILS = ["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const;

export type AntigravityRail = (typeof ANTIGRAVITY_RAILS)[number];

/**
 * Every rail, in the order the report prints them: the two long-standing vendor
 * rails, then the three Antigravity pools as one account's group, then the
 * metered rail.
 *
 * One ordered list rather than a literal repeated at each reader, so the report
 * and the generator cannot disagree about which rails exist or how they read —
 * and the list is what the `Rail` type is derived from, so a rail cannot be
 * named in the type without being in the order.
 */
export const RAILS = ["claude", "codex", ...ANTIGRAVITY_RAILS, "deepseek"] as const;

/**
 * One independently capped quota pool that model calls draw on.
 *
 * A rail is per-pool, not per-provider or per-account: several model prefixes
 * can draw on one rail, and one account can back more than one. `deepseek` is
 * the metered one, billed per token rather than capped.
 */
export type Rail = (typeof RAILS)[number];

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

/**
 * The budgets each rail actually carries, which is the difference between "no
 * cap here" and "this read did not say".
 *
 * A pool need not impose both caps: Antigravity's Argon pool has one weekly
 * bucket and no 5-hour window at all, and the metered rail has no cap of either
 * kind. Only a carried budget can be *missing* — an uncarried one is a budget the
 * rail cannot exceed, so its effective usage is zero and no threshold, not even
 * one configured as `0`, can make it tight. Reading the two cases alike is what
 * would hold every Argon primary for a session window the vendor never promised.
 *
 * Declared as one exhaustive record so a new rail cannot be added without
 * answering this question.
 */
export const RAIL_BUDGETS: Record<Rail, readonly Budget[]> = {
  claude: ["session", "weekly"],
  codex: ["session", "weekly"],
  "antigravity-argon": ["weekly"],
  "antigravity-gemini": ["session", "weekly"],
  "antigravity-3p": ["session", "weekly"],
  deepseek: [],
};

/** The budget a destination would still have to survive. */
export const OTHER_BUDGET: Record<Budget, Budget> = { session: "weekly", weekly: "session" };

export function carries(rail: Rail, budget: Budget): boolean {
  return RAIL_BUDGETS[rail].includes(budget);
}

export function isRail(value: unknown): value is Rail {
  return typeof value === "string" && (RAILS as readonly string[]).includes(value);
}

/**
 * Whether `value` is one of the three Antigravity pool rails.
 *
 * Exported because the readings store groups those three behind one fetch, and
 * the grouping is stated once here rather than re-derived from a prefix.
 */
export function isAntigravityRail(value: unknown): value is AntigravityRail {
  return typeof value === "string" && (ANTIGRAVITY_RAILS as readonly string[]).includes(value);
}

/**
 * The rail a model's prefix implies, or `undefined` for a prefix we do not
 * recognise. An unknown prefix is not evidence of a mistake, so it never warns.
 *
 * Exported because the startup snippet derives each candidate's `rail` from the
 * model an agent file already declares, and a second copy of these prefixes
 * would be free to drift from the one the loader validates against.
 */
export function railFromModel(model: string): Rail | undefined {
  if (model.startsWith("claude-bridge/") || model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("openai-codex/")) return "codex";
  if (model.startsWith("deepseek/")) return "deepseek";
  // Argon is checked before the general Gemini prefix: both pools serve Gemini
  // models, and only the Argon one has its own weekly bucket. A suffix such as
  // `gemini-4-argon-extra` is still Argon, because the vendor's own bucket ids
  // for the pool all share that stem.
  if (model.startsWith("antigravity/gemini-4-argon")) return "antigravity-argon";
  if (model.startsWith("antigravity/gemini-")) return "antigravity-gemini";
  if (model.startsWith("antigravity/claude-") || model.startsWith("antigravity/gpt-")) {
    return "antigravity-3p";
  }
  return undefined;
}
