/**
 * The document a **configuration generator** is fed, built from readings the
 * dispatcher already holds.
 *
 * Pure, and deliberately a module of its own: the shape a generator sees is
 * testable without a dispatcher, a clock or a subprocess, and neither the
 * generator module nor the readings vocabulary has to learn about the other.
 * Facts only — a reading states what the vendor said, and the projection adds
 * nothing but the wire's own text forms. See
 * docs/adr/0015-configuration-generation.md.
 */
import {
  GENERATOR_INPUT_VERSION,
  type GeneratorInputOutcome,
  type GeneratorReadingInput,
  type GeneratorWindowInput,
} from "./generator.ts";
import {
  type GoodReading,
  type MeteredRailReadings,
  type RailWindow,
  type VendorRail,
  type VendorRailReadings,
} from "./rail-reading.ts";

// ---------------------------------------------------------------- types

/**
 * Every rail's readings as the dispatcher already holds them, keyed by the rail
 * itself so a reader needs no case for a missing rail and none for "is this one
 * metered". The policy's `Map<Rail, RailReading>` cannot promise which arm a rail
 * carries; this can, because its keys are the rails.
 */
export interface KnownReadings {
  readonly claude: VendorRailReadings;
  readonly codex: VendorRailReadings;
  readonly "antigravity-argon": VendorRailReadings;
  readonly "antigravity-gemini": VendorRailReadings;
  readonly "antigravity-3p": VendorRailReadings;
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
  const argon = projectVendorRail(known["antigravity-argon"]);
  const gemini = projectVendorRail(known["antigravity-gemini"]);
  const threeParty = projectVendorRail(known["antigravity-3p"]);
  // Canonical order, and the order the refusal names a failing rail in: a
  // generator reads one document, so the five capped rails are one list rather
  // than five independent chances to be the one that is missing.
  const capped: ReadonlyArray<readonly [VendorRail, VendorRailProjection]> = [
    ["claude", claude],
    ["codex", codex],
    ["antigravity-argon", argon],
    ["antigravity-gemini", gemini],
    ["antigravity-3p", threeParty],
  ];
  if (
    claude.kind === "no-reading" ||
    codex.kind === "no-reading" ||
    argon.kind === "no-reading" ||
    gemini.kind === "no-reading" ||
    threeParty.kind === "no-reading"
  ) {
    return {
      kind: "refused",
      reason: [
        "the generator was not run: a quota-capped rail has no successful reading yet.",
        ...capped.flatMap(([rail, projection]) => refusalLine(rail, projection)),
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
        "antigravity-argon": argon.reading,
        "antigravity-gemini": gemini.reading,
        "antigravity-3p": threeParty.reading,
        deepseek: { metered: true, windows: [], raw: null },
      },
    },
  };
}

/** A rail's one line in a refusal, or nothing when it has a reading to send. */
function refusalLine(rail: VendorRail, projection: VendorRailProjection): string[] {
  return projection.kind === "no-reading" ? [`the ${rail} rail has no valid reading yet (${projection.note}).`] : [];
}
