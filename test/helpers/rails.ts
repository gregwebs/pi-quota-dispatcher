/**
 * Readings for tests that are not about the request.
 *
 * The dispatcher's dependencies expose the three reads by credential shape, so a
 * test above a vendor hands over a reading rather than answering a URL. That is
 * the seam, and this helper builds the one thing that crosses it: readings, and
 * the small vocabulary needed to write one. No document shapes, no HTTP, no
 * headers: the request shape and the vendor documents belong to
 * `test/rail-read.test.ts`, and the endpoints' names to `src/endpoints.ts`.
 * ADR-0021's amendment draws the line between those and the wire-level tests
 * that stub `fetch` below the seam.
 */
import type { AntigravityToken, CodexCredential } from "../../src/credentials.ts";
import type {
  AntigravityReadings,
  FailedReading,
  GoodReading,
  RailWindow,
  VendorRail,
  VendorReading,
} from "../../src/rail-reading.ts";
import { failedReading, poolFailure, type RailRead } from "../../src/rail-read.ts";
import { RAIL_BUDGETS, type AntigravityRail, type Budget } from "../../src/rail.ts";

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

/**
 * A successful reading for one rail.
 *
 * Generic in the rail so a caller building one arm of a correlated payload — the
 * three Antigravity pools are a mapped type whose entries must name their own
 * rail — gets a value the type can check. Widening the rail to `VendorRail`
 * would make every grouped fixture assert the correlation away.
 */
export function readingOf<R extends VendorRail>(
  rail: R,
  used: Used,
  readAt: number = READ_AT,
): GoodReading & { readonly rail: R } {
  return { rail, ok: true, windows: windowsOf(used), readAt, raw: { rail } };
}

/** A rail that could not be read, for the note its read gave up with. */
export function failureOf<R extends VendorRail>(
  rail: R,
  note: string,
  readAt: number = READ_AT,
): FailedReading & { readonly rail: R } {
  return failedReading(rail, note, readAt);
}

export { poolFailure };

/**
 * The one reading a rail has when it was read and spent nothing: every budget it
 * *carries* reported at zero.
 *
 * Zeros rather than an empty window list, because the two are different facts to
 * the policy: a carried budget the read did not report is unknown and holds, and
 * a fixture default that omitted them would quietly turn "this test says nothing
 * about quota" into a hold on every pool. A test that wants a budget missing
 * states it — `poolGroup({ "antigravity-gemini": {} })`.
 */
function unused(rail: VendorRail): Used {
  const used: { session?: number; weekly?: number } = {};
  for (const budget of RAIL_BUDGETS[rail]) used[budget] = 0;
  return used;
}

/** The three pools' one answer. A pool a test does not name reads as unused. */
export function poolGroup(
  used: Partial<Record<AntigravityRail, Used>> = {},
  readAt: number = READ_AT,
): AntigravityReadings {
  return {
    "antigravity-argon": readingOf("antigravity-argon", used["antigravity-argon"] ?? unused("antigravity-argon"), readAt),
    "antigravity-gemini": readingOf("antigravity-gemini", used["antigravity-gemini"] ?? unused("antigravity-gemini"), readAt),
    "antigravity-3p": readingOf("antigravity-3p", used["antigravity-3p"] ?? unused("antigravity-3p"), readAt),
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
 *
 * The Antigravity default is the exception, because that read is handed the
 * *acquisition* rather than a token: an unusable credential is one group-wide
 * failure that the read itself produces, with no request behind it. Answering a
 * healthy group for one would turn a credential failure into a successful
 * reading at the seam this helper exists to model honestly, and every test that
 * did not state its own answer would stop being able to see it.
 */
export function fakeReads(given: {
  claude?: Answer<VendorReading, string>;
  codex?: Answer<VendorReading, CodexCredential>;
  antigravity?: Answer<AntigravityReadings, AntigravityToken>;
} = {}): FakeReads {
  const reads = { claude: 0, codex: 0, antigravity: 0 };
  const answer = async <T, C>(value: Answer<T, C>, credential: C, call: number): Promise<T> =>
    typeof value === "function" ? (value as (credential: C, call: number) => T | Promise<T>)(credential, call) : value;
  const antigravity = (credential: AntigravityToken): AntigravityReadings =>
    "token" in credential ? poolGroup() : poolFailure(credential.error, READ_AT);
  return {
    reads,
    claude: (token) =>
      answer(given.claude ?? readingOf("claude", HEALTHY.claude), token, ++reads.claude),
    codex: (credential) =>
      answer(given.codex ?? readingOf("codex", HEALTHY.codex), credential, ++reads.codex),
    antigravity: (credential) =>
      answer(given.antigravity ?? antigravity, credential, ++reads.antigravity),
  };
}
