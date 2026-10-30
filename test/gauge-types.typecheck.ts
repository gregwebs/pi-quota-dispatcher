/**
 * Compile-time regression fixture for the rail gauge's slot types.
 *
 * Included by `tsconfig.json` (the whole `test` directory) but never run: it ends
 * in `.typecheck.ts`, which `npm test`'s `test/*.test.ts` glob does not match. Its
 * only purpose is that `npm run typecheck` fails if the guarantees below stop
 * holding — every `@ts-expect-error` is checked to actually suppress an error, so
 * widening a type turns the build red rather than quietly accepting a value the
 * gauge must never draw.
 *
 * The guarantees: a stale budget cannot carry a countdown, and a fresh budget
 * cannot omit the decision about one.
 */
import type { BudgetGauge, GaugeEntry, StaleBudgetGauge } from "../src/index.ts";

// A stale reading's reset instant came from a read that is already old, so a
// countdown computed from it would look fresh about a figure that is not. The
// type is what refuses it, not a rule the renderer remembers.
const noCountdown: StaleBudgetGauge = { kind: "used", used: 74 };
// @ts-expect-error a stale budget has no countdown arm
const staleCountdown: StaleBudgetGauge = { kind: "used", used: 74, resetInMs: 7_200_000 };
// @ts-expect-error and it is not judged tight either
const staleTight: StaleBudgetGauge = { kind: "tight", used: 74, resetInMs: 7_200_000 };

// A fresh budget states its countdown either way, so a producer cannot forget to
// ask the question — `undefined` is how it answers "the vendor reported none".
const freshUnknown: BudgetGauge = { kind: "used", used: 74, resetInMs: undefined };
const freshKnown: BudgetGauge = { kind: "used", used: 74, resetInMs: 7_200_000 };
// @ts-expect-error a fresh budget has to say whether a countdown is known
const freshSilent: BudgetGauge = { kind: "used", used: 74 };

// One entry, one kind: a stale entry's budgets are the countdown-free type.
const staleEntry: GaugeEntry = {
  rail: "codex",
  kind: "stale",
  session: noCountdown,
  weekly: { kind: "uncarried" },
};

export const guarantees = [
  noCountdown,
  staleCountdown,
  staleTight,
  freshUnknown,
  freshKnown,
  freshSilent,
  staleEntry,
];
