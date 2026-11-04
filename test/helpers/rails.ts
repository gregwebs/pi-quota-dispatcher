/**
 * Readings for tests that are not about the request.
 *
 * The dispatcher's dependencies expose the three reads by credential shape, so a
 * test above a vendor hands over a reading rather than answering a URL. That is
 * the seam, and this helper builds the one thing that crosses it: readings, and
 * the small vocabulary needed to write one. No document shapes, no HTTP, no
 * headers — those belong to `test/rail-read.test.ts`, which is the only file
 * that names a vendor endpoint.
 */
import type { AntigravityToken, CodexCredential } from "../../src/credentials.ts";
import type { AntigravityReadings, RailWindow, VendorRail, VendorReading } from "../../src/rail-reading.ts";
import { failedReading, poolFailure, type RailRead } from "../../src/rail-read.ts";
import type { AntigravityRail, Budget } from "../../src/rail.ts";

/** The instant a fake reading was taken, so readings in one test share one clock. */
export const READ_AT = 1_700_000_000_000;

/** The budgets a test states, as percentages used. */
export interface Used {
  readonly session?: number;
  readonly weekly?: number;
}

/** A window at `used` percent of `budget`, labelled as the vendor labels it. */
export function windowOf(budget: Budget, used: number): RailWindow {
  return { label: budget === "session" ? "5h" : "7d", used, budget };
}

/** One window per stated budget, session first as the vendors report it. */
export function windowsOf(used: Used): RailWindow[] {
  return [
    ...(used.session === undefined ? [] : [windowOf("session", used.session)]),
    ...(used.weekly === undefined ? [] : [windowOf("weekly", used.weekly)]),
  ];
}

/** A successful reading for one rail. */
export function readingOf(rail: VendorRail, used: Used, readAt: number = READ_AT): VendorReading {
  return { rail, ok: true, windows: windowsOf(used), readAt, raw: { rail } };
}

/** A rail that could not be read, for the note its read gave up with. */
export function failureOf(rail: VendorRail, note: string, readAt: number = READ_AT): VendorReading {
  return failedReading(rail, note, readAt);
}

export { poolFailure };

/** The three pools' one answer. A pool a test does not name reads as unused. */
export function poolGroup(used: Partial<Record<AntigravityRail, Used>> = {}): AntigravityReadings {
  return {
    "antigravity-argon": readingOf("antigravity-argon", used["antigravity-argon"] ?? { weekly: 0 }) as never,
    "antigravity-gemini": readingOf("antigravity-gemini", used["antigravity-gemini"] ?? {}) as never,
    "antigravity-3p": readingOf("antigravity-3p", used["antigravity-3p"] ?? {}) as never,
  };
}

/**
 * An answer that is either fixed or decided per call, given the credential the
 * dispatcher acquired and the call count from 1.
 */
export type Answer<T, C> = T | Promise<T> | ((credential: C, call: number) => T | Promise<T>);

/**
 * What a rail reads as when a test says nothing about it: comfortable, with caps
 * for both budgets, so a test that is not about quota never has to state one.
 */
const HEALTHY = { claude: { session: 10, weekly: 20 }, codex: { session: 5, weekly: 10 } } as const;

/** A rail read over one credential's worth of rails, by credential shape. */
export interface FakeReads extends RailRead {
  /** How many times each read was called — how a cache or TTL test counts requests. */
  readonly reads: { readonly claude: number; readonly codex: number; readonly antigravity: number };
}

/**
 * A rail read answering from the given readings, with a healthy default for every
 * rail a test does not name.
 *
 * A credential is not modelled here beyond being passed through: a test that
 * cares which token was acquired records it in its own answer function, which
 * asserts the credential the dispatcher produced rather than a header some
 * request built out of it.
 */
export function fakeReads(given: {
  claude?: Answer<VendorReading, string>;
  codex?: Answer<VendorReading, CodexCredential>;
  antigravity?: Answer<AntigravityReadings, AntigravityToken>;
} = {}): FakeReads {
  const reads = { claude: 0, codex: 0, antigravity: 0 };
  const answer = async <T, C>(value: Answer<T, C>, credential: C, call: number): Promise<T> =>
    typeof value === "function" ? (value as (credential: C, call: number) => T | Promise<T>)(credential, call) : value;
  return {
    reads,
    claude: (token) =>
      answer(given.claude ?? readingOf("claude", HEALTHY.claude), token, ++reads.claude),
    codex: (credential) =>
      answer(given.codex ?? readingOf("codex", HEALTHY.codex), credential, ++reads.codex),
    antigravity: (credential) =>
      answer(given.antigravity ?? poolGroup(), credential, ++reads.antigravity),
  };
}
