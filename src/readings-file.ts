/**
 * The rail readings one machine shares between its pi processes.
 *
 * Every pi process under this OS user caches the same few vendor responses: what
 * `/usage` said for the Claude account, what `/wham/usage` said for the Codex
 * one. Without a shared store each process polls the vendor on its own `ttlMs`,
 * so a developer with three sessions open makes three requests per TTL for one
 * account — and a rate-limited vendor answers all three with the same 429. This
 * module is the one file those processes read and write instead.
 *
 * It is a **deep module**: the file format, the decoding rules, the two locks
 * and the process-local overlay all live behind `createSharedReadings`, and a
 * caller only ever asks for a rail's readings by rail and credential. The format
 * is internal and versioned; nothing outside names a key of it.
 *
 * Three properties are deliberate and load-bearing:
 *
 *   - **One fetch at a time, bounded.** Two processes that need the same lapsed
 *     rail must make one request, not two, so the first takes a per-key fetch
 *     lock and the rest wait for its result. The wait is bounded by
 *     `SharedReadingsPacing.fetchWaitMs` — the longest a single vendor read can
 *     honestly take — and a waiter that reaches the bound fetches itself rather
 *     than hanging behind a holder it cannot see the end of. A held lock never
 *     costs a caller the read it came for.
 *   - **Failures are shared too.** A 429 or a 500 on a rail is a fact about the
 *     account and this instant, so another process on the same credential would
 *     get the same failure from a request of its own. The failure is an entry
 *     like any other and is honoured for the TTL, which is what keeps a lapsed
 *     credential from being hammered once per process per TTL.
 *   - **Writing is best effort.** The file is a cache. A read that cannot write
 *     it still returns its reading from the process-local overlay, and nothing
 *     here ever throws on a write failure: a full disk or a lock held elsewhere
 *     must not turn a quota evaluation into an error.
 *
 * `lastGood` never routes: the policy decides on `latest` and holds on a
 * failure, exactly as it did when the cache was a `Map` (ADR 0006).
 *
 * The file is `0600` because a `GoodReading.raw` body can carry account details
 * (an email, a metadata block) that the report deliberately never prints. A
 * cache is not worth publishing the vendor's own document in.
 *
 * The reading itself — its shape, its decoder, the judgments that can be made
 * about it — is `rail-reading.ts`, imported rather than restated: what this file
 * stores and what it replays are one definition, validated by one decoder. The
 * entry envelope, the document version and the gates are this file's own.
 */
import { createHash } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errnoIs, lockPathFor, withLockPath, type FileWritePacing, type LockAttempt } from "./agent-file.ts";
import { READINGS_FILE_NAME } from "./config.ts";
import { ANTIGRAVITY_RAILS, isAntigravityRail, isRail, type AntigravityRail } from "./rail.ts";
import {
  decodeReading,
  type GoodReading,
  type VendorRail,
  type VendorRailReadings,
  type VendorReading,
} from "./rail-reading.ts";

/**
 * The version this module writes.
 *
 * 2 added the refresh gates and the sticky halt beside the entries. 3 widened
 * the accepted rail vocabulary to the three Antigravity pools, which is a change
 * to what an entry's `rail` may be — the one field whose acceptance the version
 * answers for.
 *
 * A version-2 document is still *read*, and that is deliberate: it can only hold
 * Claude and Codex entries, whose shape did not change, so accepting it costs
 * nothing and keeping its readings — and, far more importantly, its refresh
 * gates and sticky halt — through the upgrade is what stops an upgrade from
 * forgetting that a ping already spent money. Writes are always version 3. Any
 * other version is an unknown shape this writer cannot promise to preserve, so
 * it faults the whole file and the next write repairs it.
 */
export const READINGS_FILE_VERSION = 3;

/**
 * The versions this reader accepts.
 *
 * Version 2 rather than "every version at or below 3" on purpose: the list is of
 * shapes that were checked, not of numbers that happen to be smaller. It is also
 * what `ReadableVersion` is derived from, so a version this reader does not
 * accept cannot be written into the code that reads one.
 */
const READABLE_VERSIONS = [2, 3] as const;

type ReadableVersion = (typeof READABLE_VERSIONS)[number];

/** Whether a decoded document's `version` is one whose shape this reader checked. */
function isReadableVersion(value: number): value is ReadableVersion {
  return READABLE_VERSIONS.some((version) => version === value);
}

/**
 * Pacing for the two locks a shared reading takes, all of it in milliseconds.
 *
 * The two waits mean different things and are therefore separate. `writeWaitMs`
 * bounds the read-modify-write of the whole file, a millisecond critical section
 * — the same patience `DEFAULT_FILE_WRITE` grants an agent file. `fetchWaitMs`
 * bounds waiting for *another process's vendor request*, which is longer by
 * orders of magnitude and is computed from the quota read's own limits rather
 * than chosen here.
 */
export interface SharedReadingsPacing {
  /** Bound on waiting for another process's in-flight fetch (the longest read). */
  fetchWaitMs: number;
  /** Short bound on the read-modify-write of the whole file. */
  writeWaitMs: number;
  pollMs: number;
  /** Staleness bound for a lock holder this host cannot confirm. */
  staleMs: number;
}

/**
 * The shipped timings, apart from `fetchWaitMs`.
 *
 * `writeWaitMs`, `pollMs` and `staleMs` mirror `DEFAULT_FILE_WRITE`: the file
 * write is the same shape of critical section as an agent-file write. The fetch
 * wait is deliberately not here — it is a function of the quota read's timings,
 * which this module does not know, so the dispatcher computes it and passes it
 * in.
 */
export const DEFAULT_SHARED_READINGS: Omit<SharedReadingsPacing, "fetchWaitMs"> = {
  writeWaitMs: 3_000,
  pollMs: 25,
  staleMs: 10_000,
};

/**
 * What one Antigravity fetch answers: all three pool rails, each correlated with
 * its own rail.
 *
 * One type for three results because one vendor request produces them — the
 * buckets of a single `retrieveUserQuotaSummary` body are partitioned across the
 * pools. It is the *fetch*'s answer, not history: which of a pool's earlier
 * readings survives is the store's business.
 */
export type AntigravityReadings = {
  readonly [R in AntigravityRail]: VendorReading & { readonly rail: R };
};

/**
 * One cached rail: the reading that was stored, and when storing it made it the
 * newest.
 *
 * There are two times because they mean different things. `latest.readAt` is a
 * fact about the response — when the vendor answered, which relative resets are
 * converted against; the TTL must not start before the finished reading is
 * stored, so it counts from `at`, stamped after the read is normalized. Counting
 * from `readAt` would let parse and continuation time consume the TTL.
 */
export interface CachedReadings {
  at: number;
  latest: VendorReading;
  lastGood?: GoodReading;
}

/**
 * One cache entry as the seam's shape. The store's only projection into
 * `RailReadings` (`railReadings`' `deepseek` arm builds the metered entry
 * itself), so the union's invariants hold by construction rather than by each
 * caller's care: a success is paired with itself as its own last good reading,
 * and a failure omits `lastGood` rather than setting it to `undefined`, so a
 * strict deep comparison sees only the keys that exist.
 */
export function asReadings(entry: CachedReadings): VendorRailReadings {
  const { latest } = entry;
  if (latest.ok) return { latest, lastGood: latest };
  return entry.lastGood === undefined ? { latest } : { latest, lastGood: entry.lastGood };
}

export interface CredentialGates {
  /** Armed by a `failed` offline ping; honoured for CLAUDE_PING_COOLDOWN_MS from `at`. */
  cooldown?: { at: number; note: string };
  /** The per-episode halt: ends when a read yields a usable token. */
  halt?: string;
}

/**
 * The machine-wide sticky halt. An `undiverted` run is a fact about the claude
 * install, not about one credential. The identity is the install the halt was
 * armed against; a `null`/`null` pair means the install could not be resolved
 * when it was armed, so only an explicit clear removes it.
 */
export type StickyHalt = { note: string } & (
  | { claudePath: string; claudeMtimeMs: number }
  | { claudePath: null; claudeMtimeMs: null }
);

export interface RefreshGates extends CredentialGates {
  sticky?: StickyHalt;
}

/** A locked, field-level read-modify-write of one credential's gates. */
export interface GatePatch {
  cooldown?: { at: number; note: string };
  halt?: string;
  /** Removes `halt`; takes precedence over `halt` if both are passed. */
  clearHalt?: boolean;
}

/**
 * A rail whose readings come from a request of its own.
 *
 * The Antigravity pools are deliberately not in this set: one
 * `retrieveUserQuotaSummary` answers for all three, so a per-pool fetch can be
 * neither locked nor published on its own — see `readAntigravity`.
 */
export type SingleFetchRail = Exclude<VendorRail, AntigravityRail>;

/**
 * What a shared store answers, in the forms the dispatcher needs.
 *
 * `read` is the policy's path — a reading fresh within its TTL, a fetch when it
 * has lapsed — and `known` is the generator path, which is deliberately
 * age-blind (see ADR 0015). `readAntigravity` is `read` for the three pools one
 * vendor call answers, so the group is fetched, locked and published once.
 * `warnings` is a rendering, not state: the report is where a corrupt file
 * becomes visible, and nowhere else is allowed to refuse work over one.
 */
export interface SharedReadings {
  /** Fresh-within-ttl entry, else lock/recheck/fetch/write. Never routes on lastGood. */
  read(
    rail: SingleFetchRail,
    credential: string,
    opts: { ttlMs: number; force?: boolean; fetch: () => Promise<VendorReading> },
  ): Promise<VendorRailReadings>;
  /**
   * One Antigravity pool's readings, from a fetch that answers for all three.
   *
   * The selected rail is what the caller asked about; the store fetches, locks
   * and publishes the whole group, and every other caller wanting a pool of the
   * same credential joins that same work. A group whose earlier three entries are
   * all present and fresh is a cache hit for all three, so a caller wanting a
   * pool the group already holds costs no request at all.
   */
  readAntigravity(
    rail: AntigravityRail,
    credential: string,
    opts: { ttlMs: number; force?: boolean; fetch: () => Promise<AntigravityReadings> },
  ): Promise<VendorRailReadings>;
  /** Whatever entry the file/process already holds, at any age; no fetch. */
  known(rail: VendorRail, credential: string): Promise<VendorRailReadings | undefined>;
  /** The gates one credential's next refresh ping is subject to, sticky halt included. */
  gates(credential: string): Promise<RefreshGates>;
  /** A locked, field-level read-modify-write of one credential's gates. */
  setGates(credential: string, patch: GatePatch): Promise<void>;
  /**
   * Set the machine-wide sticky halt, or clear it with `undefined`.
   * A clear with `expected` is conditional: it only clears when the current
   * sticky halt deep-equals `expected` (so a stale reader cannot erase a halt a
   * peer just armed). A clear with no `expected` is unconditional (`refresh`).
   */
  setStickyHalt(sticky: StickyHalt | undefined, expected?: StickyHalt): Promise<void>;
  /** Warning lines for a corrupt/unknown-version/invalid file, for `report()`. */
  warnings(): readonly string[];
}

export interface SharedReadingsDeps {
  /** The file to read and write; its absent-ness is an empty store, not a fault. */
  path: string;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  pacing: SharedReadingsPacing;
}

/**
 * One fetch's answer for every pool it reports on, correlated with the rail each
 * reading is filed under.
 *
 * The single-rail source has one member; Antigravity has three. Every member is
 * present or the source failed as a whole — a fetch that answered for only some
 * of the pools it was asked for is not a source, and no member is ever
 * fabricated from a neighbour's numbers.
 */
type SourceReadings =
  | { readonly kind: "single"; readonly rail: SingleFetchRail; readonly entry: CachedReadings }
  | { readonly kind: "antigravity"; readonly entries: AntigravityCachedReadings };

/**
 * One Antigravity pool's cached entry, correlated with the rail it is filed
 * under.
 *
 * The correlation is what keeps a group's three results from being handed out
 * as one indistinguishable bag: a caller asking about `antigravity-gemini` gets
 * a reading the store knows is Gemini's.
 */
type AntigravityCachedReadings = {
  readonly [R in AntigravityRail]: CachedReadings & {
    readonly latest: VendorReading & { readonly rail: R };
  };
};

/** What one operation asks the vendor: one reading, or all three pools at once. */
type ReadSource =
  | { readonly kind: "single"; readonly rail: SingleFetchRail; readonly fetch: () => Promise<VendorReading> }
  | { readonly kind: "antigravity"; readonly fetch: () => Promise<AntigravityReadings> };

/**
 * One operation this process has in flight, and whether it counts as a fetch.
 *
 * `fetched` is mutable because only `performSource` knows when the question is
 * settled: a read registered before its first `await` cannot say yet whether it
 * will answer from the local cache, ask the vendor, or return a vendor answer a
 * peer published while it waited. Those last two are what a forced read may
 * join, so they set the flag; a forced read that joined a record whose flag
 * stayed false knows the result is a cache hit and runs a fetch of its own.
 *
 * The promise carries *every* member's result, not the rail the first caller
 * happened to ask for: a caller joins the work and then projects its own rail.
 */
interface InFlight {
  promise: Promise<SourceReadings>;
  fetched: boolean;
}

/**
 * A sticky-halt write this process has not yet published.
 *
 * A clear carries the halt it means to remove when it has one, so that applying
 * it to a later document hides only that halt rather than whatever a peer armed
 * in between. The operation is a plain object held by identity, which is what
 * lets `setStickyHalt` retire exactly the write it made and no newer one.
 */
type PendingSticky =
  | { kind: "set"; sticky: StickyHalt }
  | { kind: "clear"; expected?: StickyHalt };

/** One entry of the on-disk document, validated into the shape the writer needs. */
interface FileEntry {
  rail: VendorRail;
  credential: string;
  at: number;
  latest: VendorReading;
  lastGood?: GoodReading;
}

/** One credential's stored gates, keyed the way a readings entry is. */
interface GateEntry extends CredentialGates {
  credential: string;
}

/**
 * The whole on-disk document.
 *
 * One object rather than three readers, because the file is one writer's
 * replacement of all of it: a write that carried only the part it meant to
 * change would drop the readings, a peer's gates, or the sticky halt. `gates`
 * is a list rather than a map keyed by credential so that a hand edit cannot
 * silently collide two credentials' gates, and `stickyHalt` is absent rather
 * than `null` so a strict comparison sees only the keys that exist.
 */
interface FileDocument {
  entries: FileEntry[];
  gates: GateEntry[];
  stickyHalt?: StickyHalt;
}

/** A decoded document, or the single reason the whole file reads as empty. */
type Decoded = FileDocument | { fault: string };

/** Distinguishes two writes made by one process, which a pid alone does not. */
let tempSerial = 0;

/** The staging path for one write: a name no other writer can be holding. */
function tempPathFor(path: string): string {
  tempSerial += 1;
  return `${path}.tmp.${process.pid}.${tempSerial}`;
}

/**
 * The fault one entry fails on, named the way the report can point at it: by the
 * rail it claims when it claims a string, else by its position, because a
 * shapeless entry names no rail to point at.
 */
function entryFault(rail: unknown, index: number): string {
  return typeof rail === "string"
    ? `entry for ${JSON.stringify(rail)} is invalid`
    : `entry ${index + 1} is invalid`;
}

/**
 * The rails one version of the document may hold an entry for.
 *
 * A version-2 document was written before Antigravity existed, so a Claude or
 * Codex entry is all it can legitimately carry and anything else in it is a
 * hand edit rather than an older writer's work. Version 3 added the pools, and
 * still refuses the metered rail: it is never read and so has nothing to cache.
 */
function readableRail(rail: unknown, version: ReadableVersion): rail is VendorRail {
  if (!isRail(rail) || rail === "deepseek") return false;
  return version === 3 || !isAntigravityRail(rail);
}

/** One entry of the document, validated, or the fault that makes the whole file unusable. */
function fileEntry(
  value: unknown,
  index: number,
  version: ReadableVersion,
): { entry: FileEntry } | { fault: string } {
  if (value === null || typeof value !== "object") return { fault: entryFault(undefined, index) };
  const e = value as Record<string, unknown>;
  const rail = e.rail;
  if (!readableRail(rail, version)) return { fault: entryFault(rail, index) };
  if (typeof e.credential !== "string" || e.credential === "") return { fault: entryFault(rail, index) };
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return { fault: entryFault(rail, index) };
  const latest = decodeReading(e.latest, rail);
  if (latest === undefined) return { fault: entryFault(rail, index) };
  let lastGood: GoodReading | undefined;
  if (e.lastGood !== undefined) {
    const decoded = decodeReading(e.lastGood, rail);
    if (decoded === undefined || !decoded.ok) return { fault: entryFault(rail, index) };
    lastGood = decoded;
  }
  return {
    entry: {
      rail,
      credential: e.credential,
      at: e.at,
      latest,
      ...(lastGood === undefined ? {} : { lastGood }),
    },
  };
}

/**
 * The gates one credential's entry holds, as the store's shape.
 *
 * A copy, so nothing aliases the decoded document; the *last* entry wins, so a
 * document with two entries for one credential still answers with one, and the
 * rewrite that follows a patch collapses them.
 */
function gateFrom(document: FileDocument, credential: string): CredentialGates {
  let found: GateEntry | undefined;
  for (const gate of document.gates) {
    if (gate.credential === credential) found = gate;
  }
  if (found === undefined) return {};
  return {
    ...(found.cooldown === undefined ? {} : { cooldown: found.cooldown }),
    ...(found.halt === undefined ? {} : { halt: found.halt }),
  };
}

/** Whether gates carry anything at all; an empty pair is stored nowhere. */
function hasGates(gates: CredentialGates): boolean {
  return gates.cooldown !== undefined || gates.halt !== undefined;
}

/**
 * Apply one patch to gates, field by field.
 *
 * A patch is a field-level write rather than a replacement because its caller
 * knows about one field at a time: the dispatcher arms a halt without having
 * read the cooldown, and clears that halt without knowing what else this
 * process or a peer holds. `clearHalt` beats `halt` so that a caller which
 * passes both gets the removal it asked for last.
 */
function applyGatePatch(gates: CredentialGates, patch: GatePatch): CredentialGates {
  const next: CredentialGates = {};
  if (gates.cooldown !== undefined) next.cooldown = gates.cooldown;
  if (gates.halt !== undefined) next.halt = gates.halt;
  if (patch.cooldown !== undefined) next.cooldown = patch.cooldown;
  if (patch.clearHalt === true) delete next.halt;
  else if (patch.halt !== undefined) next.halt = patch.halt;
  return next;
}

/**
 * Whether two sticky halts name the same halt.
 *
 * A field comparison rather than a deep-equal, because the identity pair is
 * `string`/`number` or `null`/`null` and nothing else can be a `StickyHalt`: two
 * halts with the same three fields are the same halt, whatever produced them.
 */
function sameSticky(a: StickyHalt | null | undefined, b: StickyHalt | null | undefined): boolean {
  if (a === null || a === undefined) return a === b;
  if (b === null || b === undefined) return false;
  return a.note === b.note && a.claudePath === b.claudePath && a.claudeMtimeMs === b.claudeMtimeMs;
}

/**
 * The sticky halt one document field states, or `undefined` when it states one
 * this version cannot read.
 *
 * The identity is either a resolved install or the recorded fact that none could
 * be resolved, and nothing in between: a path with no mtime, or an mtime with no
 * path, would be a halt no later reader could compare against the install it was
 * armed from, which is the one thing the pair is for. Fields are copied rather
 * than trusted, so an unknown key in a hand edit cannot travel into the store's
 * answer.
 */
function stickyHaltField(value: unknown): StickyHalt | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.note !== "string") return undefined;
  if (s.claudePath === null && s.claudeMtimeMs === null) {
    return { note: s.note, claudePath: null, claudeMtimeMs: null };
  }
  if (typeof s.claudePath !== "string") return undefined;
  if (typeof s.claudeMtimeMs !== "number" || !Number.isFinite(s.claudeMtimeMs)) return undefined;
  return { note: s.note, claudePath: s.claudePath, claudeMtimeMs: s.claudeMtimeMs };
}

/** The cooldown one gate states, or `undefined` when it states one that is not one. */
function cooldownField(value: unknown): { at: number; note: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.at !== "number" || !Number.isFinite(c.at)) return undefined;
  if (typeof c.note !== "string") return undefined;
  return { at: c.at, note: c.note };
}

/** The fault one gate fails on, named by the credential it claims when it claims a string. */
function gateFault(credential: unknown, index: number): string {
  return typeof credential === "string"
    ? `gates for ${JSON.stringify(credential)} are invalid`
    : `gate ${index + 1} is invalid`;
}

/** One gate of the document, validated, or the fault that makes the whole file unusable. */
function fileGate(value: unknown, index: number): { gate: GateEntry } | { fault: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { fault: gateFault(undefined, index) };
  }
  const g = value as Record<string, unknown>;
  if (typeof g.credential !== "string" || g.credential === "") {
    return { fault: gateFault(g.credential, index) };
  }
  if (g.halt !== undefined && typeof g.halt !== "string") {
    return { fault: gateFault(g.credential, index) };
  }
  let cooldown: { at: number; note: string } | undefined;
  if (g.cooldown !== undefined) {
    cooldown = cooldownField(g.cooldown);
    if (cooldown === undefined) return { fault: gateFault(g.credential, index) };
  }
  return {
    gate: {
      credential: g.credential,
      ...(cooldown === undefined ? {} : { cooldown }),
      ...(typeof g.halt === "string" ? { halt: g.halt } : {}),
    },
  };
}

/**
 * Decode the document text, or name the one fault that discards it all.
 *
 * All-or-nothing is deliberate. The file is one writer's replacement of the
 * whole document, and a single invalid entry means a writer published something
 * this version cannot read — a future version's shape, a hand edit, a truncated
 * write that still parses. Reading the entries that happened to validate would
 * be trusting a document nobody wrote, so the file reads as empty and the user
 * is told; the next successful write repairs it.
 */
function decode(text: string): Decoded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { fault: "it is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fault: "it is not a readings document" };
  }
  const doc = parsed as Record<string, unknown>;
  const version = doc.version;
  if (typeof version !== "number" || !isReadableVersion(version)) {
    return { fault: `unknown version ${String(version)}` };
  }
  if (!Array.isArray(doc.entries)) return { fault: "its entries are not a list" };
  const entries: FileEntry[] = [];
  for (const [index, raw] of doc.entries.entries()) {
    const result = fileEntry(raw, index, version);
    if ("fault" in result) return result;
    entries.push(result.entry);
  }
  const gates: GateEntry[] = [];
  if (doc.gates !== undefined) {
    if (!Array.isArray(doc.gates)) return { fault: "its gates are not a list" };
    for (const [index, raw] of doc.gates.entries()) {
      const result = fileGate(raw, index);
      if ("fault" in result) return result;
      gates.push(result.gate);
    }
  }
  let stickyHalt: StickyHalt | undefined;
  if (doc.stickyHalt !== undefined) {
    stickyHalt = stickyHaltField(doc.stickyHalt);
    if (stickyHalt === undefined) return { fault: "its sticky halt is invalid" };
  }
  return { entries, gates, ...(stickyHalt === undefined ? {} : { stickyHalt }) };
}

/**
 * The document text one document is published as. Always the current version,
 * whatever version it was read as.
 *
 * `gates` and `stickyHalt` are omitted rather than written empty or null: a key
 * that is absent cannot be mistaken for a value a later version gave a meaning
 * to, and a file holding nothing but readings is the smallest shape a reader has
 * to understand.
 */
function encode(document: FileDocument): string {
  const { entries, gates, stickyHalt } = document;
  return `${JSON.stringify(
    {
      version: READINGS_FILE_VERSION,
      entries,
      ...(gates.length === 0 ? {} : { gates }),
      ...(stickyHalt === undefined ? {} : { stickyHalt }),
    },
    null,
    2,
  )}\n`;
}

/** The process-local cache key: a rail and the credential its entry belongs to, in one string no rail name can contain. */
function storeKey(rail: VendorRail, credential: string): string {
  return `${rail}\u0000${credential}`;
}

/** The file's own key for an entry, which is the same shape as the in-memory one. */
function entryKey(entry: FileEntry): string {
  return storeKey(entry.rail, entry.credential);
}

/** One entry as the store's shape; a fresh object so nothing aliases the decoded document. */
function toCached(entry: FileEntry): CachedReadings {
  return {
    at: entry.at,
    latest: entry.latest,
    ...(entry.lastGood === undefined ? {} : { lastGood: entry.lastGood }),
  };
}

/** The newest entry a decoded document holds for `key`, or `undefined` when it holds none. */
function newestFor(entries: FileEntry[], key: string): CachedReadings | undefined {
  let best: CachedReadings | undefined;
  for (const entry of entries) {
    if (entryKey(entry) !== key) continue;
    const cached = toCached(entry);
    if (best === undefined || cached.at > best.at) best = cached;
  }
  return best;
}

/**
 * The entry this process should see, given its overlay and the file.
 *
 * A tie on `at` keeps `a`, the process-local overlay: the entry already in
 * memory is the one the last read returned, and a test that asserts object
 * identity on a `lastGood` across a failure is asserting exactly that this
 * process did not replace it with a byte-identical decode of its own file. The
 * combination is otherwise `mergeEntry`'s: the newer view supplies `latest`, and
 * a `lastGood` either view holds is not dropped because the other's `latest`
 * won.
 */
function newer(a: CachedReadings | undefined, b: CachedReadings | undefined): CachedReadings | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return mergeEntry(b, a);
}

/** The newest of the good readings, or whichever exists; a tie keeps the first, so the caller orders the incoming one first. */
function newestGood(readings: readonly (GoodReading | undefined)[]): GoodReading | undefined {
  let best: GoodReading | undefined;
  for (const reading of readings) {
    if (reading === undefined) continue;
    if (best === undefined || reading.readAt > best.readAt) best = reading;
  }
  return best;
}

/**
 * The entry two views of one key combine into: the newer by `at` supplies
 * `latest`, and `lastGood` is the newest good reading either view holds.
 *
 * `fetchWaitMs` bounds a waiter, so two processes can and do fetch one lapsed
 * rail at once: the one that took the fetch lock finishes last, holding an
 * answer older than the one the bounded waiter already stored. `at` is what
 * tells the two apart — it is stamped when the finished reading is stored, so a
 * later stamp is a newer answer — and the newer stamp supplies `latest`, which
 * is what keeps a slow failure from clobbering a fast success. A tie keeps
 * `entry`, the incoming view, so this process's reading is not replaced by a
 * byte-identical decode of its own file.
 *
 * `latest` and `lastGood` are chosen independently, because they answer
 * different questions and a losing `latest` must not cost the newer `lastGood`:
 * a slow failure that wins `latest` can carry forward a success the failure's
 * writer never saw. `lastGood` is the newest good reading by the vendor's own
 * `readAt` among the incoming `latest` when it succeeded, the existing `latest`
 * when *it* succeeded, the incoming `lastGood` and the existing `lastGood`;
 * `newestGood` keeps the first on a tie and the incoming candidates are ordered
 * first, so "ties keep the incoming" holds. A winning success is its own last
 * good reading, as `asReadings` pairs one.
 */
function mergeEntry(existing: CachedReadings | undefined, entry: CachedReadings): CachedReadings {
  if (existing === undefined) return entry;
  const winner = existing.at > entry.at ? existing : entry;
  const lastGood = newestGood([
    entry.latest.ok ? entry.latest : undefined,
    entry.lastGood,
    existing.latest.ok ? existing.latest : undefined,
    existing.lastGood,
  ]);
  return {
    at: winner.at,
    latest: winner.latest,
    ...(lastGood === undefined ? {} : { lastGood }),
  };
}

/**
 * Whether two views name the same fetch, ignoring which decode produced them.
 *
 * A forced read decides whether to join by comparing the entry it observed
 * before the lock with the entry under it: the same entry means no *fetch* was
 * published while it waited and it must fetch for itself. Identity cannot
 * answer that — the file is re-decoded on every look, so the same entry is a
 * fresh object each time — and neither can `at` alone, since a refresh that
 * completes within one injected clock's millisecond shares the stamp. `at`
 * together with `latest` is what names one vendor answer: when it was stored,
 * and what it said.
 *
 * `lastGood` is deliberately ignored. A merge that only enriched `lastGood` (a
 * peer's success carried forward beside a loser's failure) republished no
 * vendor answer, so joining it would hand a forced read the stale `latest` it
 * asked to replace. A false "same" would drop the refresh the caller asked
 * for, while a false "different" costs only a duplicate request.
 */
function sameEntry(a: CachedReadings | undefined, b: CachedReadings | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.at === b.at && JSON.stringify(a.latest) === JSON.stringify(b.latest);
}

/**
 * The key one fetch is locked and joined under.
 *
 * A single-rail read keeps its per-rail key. Antigravity's three pools share one
 * key, which is what makes two processes — and two rails of one process — agree
 * to make one request. The group key lives in its own domain rather than reusing
 * any member's: `antigravity` is not a rail name, so no `storeKey` can collide
 * with it, and Codex — which is configured from the same `auth.json` — is not
 * swept into the group merely by sharing a credential path.
 */
function sourceKey(source: ReadSource, credential: string): string {
  return source.kind === "single" ? storeKey(source.rail, credential) : `antigravity\u0000${credential}`;
}

/** One thing a source files its readings under: a rail and that rail's entry key. */
interface SourceMember {
  readonly rail: VendorRail;
  readonly key: string;
}

/** The rails one source answers for, in the order the store keeps them. */
function sourceMembers(source: ReadSource, credential: string): readonly SourceMember[] {
  const members = source.kind === "single" ? [source.rail] : ANTIGRAVITY_RAILS;
  return members.map((rail) => ({ rail, key: storeKey(rail, credential) }));
}

/**
 * `entry` filed under `rail`, with the correlation the type states.
 *
 * The cast is the one place this module asserts it, and it is guarded rather
 * than trusted: `newestFor`/`mergeEntry` speak in the rail-agnostic
 * `CachedReadings`, so the correlation cannot survive them in the type, while the
 * *decoder* already refused any entry whose `rail` field is not the rail it was
 * validated as. A mismatch that reached here is an invariant failure — a bug in
 * this module — and throwing it is the honest report, not delivering another
 * pool's numbers as this one's.
 */
function correlated<R extends AntigravityRail>(
  rail: R,
  entry: CachedReadings,
): CachedReadings & { readonly latest: VendorReading & { readonly rail: R } } {
  if (entry.latest.rail !== rail) {
    throw new Error(`readings entry filed under ${rail} carries ${entry.latest.rail}`);
  }
  return entry as CachedReadings & { readonly latest: VendorReading & { readonly rail: R } };
}

/** A group of three entries, in the rails' canonical order. */
function antigravityGroup(
  entries: Readonly<Record<AntigravityRail, CachedReadings>>,
): AntigravityCachedReadings {
  return {
    "antigravity-argon": correlated("antigravity-argon", entries["antigravity-argon"]),
    "antigravity-gemini": correlated("antigravity-gemini", entries["antigravity-gemini"]),
    "antigravity-3p": correlated("antigravity-3p", entries["antigravity-3p"]),
  };
}

/**
 * The source's answer, from the entry each of its members settled on.
 *
 * Every member must be present: a single fetch answers for its one rail, and an
 * Antigravity fetch answers for all three pools whatever the vendor omitted —
 * the omitted pool's `latest` is its failure. An absent member is therefore a bug
 * here, never a reading this module invents.
 */
function sourceReadings(
  source: ReadSource,
  settled: readonly (CachedReadings | undefined)[],
): SourceReadings {
  if (source.kind === "single") {
    const [entry] = settled;
    if (entry === undefined) throw new Error(`no reading settled for ${source.rail}`);
    return { kind: "single", rail: source.rail, entry };
  }
  const [argon, gemini, threeParty] = settled;
  if (argon === undefined || gemini === undefined || threeParty === undefined) {
    throw new Error("the antigravity group settled without all three pools");
  }
  return {
    kind: "antigravity",
    entries: antigravityGroup({
      "antigravity-argon": argon,
      "antigravity-gemini": gemini,
      "antigravity-3p": threeParty,
    }),
  };
}

/** One member's entry out of a source's answer. */
function memberEntry(readings: SourceReadings, rail: VendorRail): CachedReadings {
  if (readings.kind === "single") {
    if (readings.rail !== rail) throw new Error(`this read settled ${readings.rail}, not ${rail}`);
    return readings.entry;
  }
  if (!isAntigravityRail(rail)) throw new Error(`${rail} is not an antigravity pool`);
  return readings.entries[rail];
}

/**
 * Whether two looks at a source name the same vendor answer, member by member.
 *
 * The group version of `sameEntry`: a forced read compares the vector it saw
 * before taking the lock with the vector under it, and only a group in which
 * every member is unchanged republished nothing. An incomplete vector never
 * equals a complete one, because an absent member is not the reading a peer
 * published.
 */
function sameSourceReadings(a: readonly (CachedReadings | undefined)[], b: readonly (CachedReadings | undefined)[]): boolean {
  return a.length === b.length && a.every((entry, index) => sameEntry(entry, b[index]));
}

/**
 * Write `text` to `path` as an atomic `0600` replace.
 *
 * Atomic in the same sense `replaceFileAtomically` is: a unique temp file, then
 * a same-directory `rename`, so a reader sees the whole old document or the
 * whole new one. Unlike that function this one *creates* `path`, so the mode
 * cannot be copied from a target that does not exist yet: the temp is opened
 * `0600` and the rename leaves that mode on the published file. The contents can
 * carry account details, so the staging file must not be readable while it is
 * being filled — the same reason the agent-file staging is private.
 */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temp = tempPathFor(path);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (err) {
    try {
      await unlink(temp);
    } catch (unlinkErr) {
      if (!errnoIs(unlinkErr, "ENOENT")) {
        throw new AggregateError(
          [err, unlinkErr],
          "the readings write failed and its staging file could not be removed",
        );
      }
    }
    throw err;
  }
}

/**
 * The store: one shared file, a process-local cache per thing it holds, and the
 * locks over it.
 *
 * The caches are what make the file an optimisation rather than a dependency.
 * `overlay` holds every entry this process has read or produced, so a read
 * inside the TTL costs no file I/O at all; `inFlight` joins concurrent reads of
 * one key so this process never queues behind its *own* fetch lock and never
 * makes two requests for one rail. The file is what the overlay cannot express:
 * an entry another process wrote, and the record that survives this process
 * exiting.
 *
 * The refresh gates are not overlaid the same way. A gate is what stops this
 * process paying again, so it must hold even when the file write fails — but a
 * gate this process *did* publish must not go on hiding the file, or a peer's
 * later clear or re-arm would be invisible here forever (the defect this
 * replaces a permanent overlay for). So what is kept is only the operations this
 * process has not yet published: `pendingGatePatches` and `pendingSticky`,
 * applied on top of a freshly loaded document by `gates()`. A successful write
 * retires exactly the operations it applied, by identity, and a failed one
 * leaves them pending — the process-local fallback. A published op therefore
 * stops shadowing the file the moment it lands, which is what lets a peer's
 * clear be seen and keeps a failed write from being lost or resurrected.
 */
export function createSharedReadings(deps: SharedReadingsDeps): SharedReadings {
  const { path, pacing } = deps;
  const now = deps.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  const overlay = new Map<string, CachedReadings>();
  const inFlight = new Map<string, InFlight>();
  const pendingGatePatches = new Map<string, GatePatch[]>();
  let pendingSticky: PendingSticky | undefined;
  const warningLines: string[] = [];
  const seenWarnings = new Set<string>();

  const fileLock = lockPathFor(path);
  const writePacing: FileWritePacing = {
    staleMs: pacing.staleMs,
    waitMs: pacing.writeWaitMs,
    pollMs: pacing.pollMs,
  };
  const fetchPacing: FileWritePacing = {
    staleMs: pacing.staleMs,
    waitMs: pacing.fetchWaitMs,
    pollMs: pacing.pollMs,
  };

  /**
   * The fetch lock for one key. The key names an absolute credential path, which
   * cannot sit in a filename, so it is hashed: the digest is stable across
   * processes and machines, so two pi processes on one credential take the same
   * lock, while two credentials on one rail take different ones and are not
   * needlessly serialised.
   */
  function fetchLockFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return join(dirname(path), `.${basename(path)}.${digest}.fetch.lock`);
  }

  /** Record one line of warning text, once, however many reads trip it. */
  function warn(fault: string): void {
    const line = `${READINGS_FILE_NAME} is unusable (${fault}); ignoring it`;
    if (seenWarnings.has(line)) return;
    seenWarnings.add(line);
    warningLines.push(line);
  }

  /**
   * The document, or an empty one. Never throws: an absent file is an empty
   * store, and any other read failure is treated the same because a cache the
   * process cannot read is a cache it does not have. Only a file that *was* read
   * and could not be decoded warns, because that is the one case where a user
   * can act on what the report tells them.
   */
  async function loadDocument(): Promise<FileDocument> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { entries: [], gates: [] };
    }
    const decoded = decode(text);
    if ("fault" in decoded) {
      warn(decoded.fault);
      return { entries: [], gates: [] };
    }
    return decoded;
  }

  /** The entry the file holds for `key`, at any age, or `undefined`. */
  async function entryFromFile(key: string): Promise<CachedReadings | undefined> {
    return newestFor((await loadDocument()).entries, key);
  }

  /**
   * Ask, remember, and publish the answer for one source — one rail, or the
   * whole Antigravity group.
   *
   * `prior` is what this process knew before asking — the entries a failure must
   * carry forward as their `lastGood`. It is passed in rather than read here
   * because it must be the value from *before* the fetch, not the overlay after
   * a concurrent read has moved it.
   *
   * One `at` stamps the whole answer, because it is one vendor answer: the TTL
   * counts from when the group was stored, and a group whose members carried
   * three different stamps would be three half-groups pretending to be one read.
   * Each member's `lastGood` is still its own, computed from that member's own
   * prior entry — never a neighbour's.
   */
  async function fetchAndStore(
    source: ReadSource,
    credential: string,
    prior: readonly (CachedReadings | undefined)[],
    members: readonly SourceMember[],
  ): Promise<SourceReadings> {
    const asked = await ask(source);
    const at = now();
    const incoming = members.map((member, index) => {
      const latest = asked[index];
      const before = prior[index];
      const lastGood = latest.ok ? latest : before?.lastGood ?? (before?.latest.ok ? before.latest : undefined);
      const entry: CachedReadings = { at, latest, ...(lastGood === undefined ? {} : { lastGood }) };
      return { member, entry };
    });
    // The merged entries, not the ones fetched: the file can hold a newer answer
    // from a process that self-fetched past our fetch lock, and the overlay is
    // the copy this process answers from, so it must agree with the file.
    const merged = await writeEntries(credential, incoming);
    for (const { member, entry } of merged) overlay.set(member.key, entry);
    return sourceReadings(source, merged.map(({ entry }) => entry));
  }

  /** What one source's request answered, in its members' order. */
  async function ask(source: ReadSource): Promise<readonly VendorReading[]> {
    if (source.kind === "single") {
      const latest = await source.fetch();
      if (latest.rail !== source.rail) {
        throw new Error(`the ${source.rail} read answered for ${latest.rail}`);
      }
      return [latest];
    }
    const answered = await source.fetch();
    // The group's own type is what makes every pool reachable here: a fetch that
    // omitted one would not be an `AntigravityReadings` at all.
    return ANTIGRAVITY_RAILS.map((rail) => answered[rail]);
  }

  /**
   * Replace one source's entries in the file, under the file's one write lock,
   * and return the entries the file holds afterwards.
   *
   * The whole read-modify-write is inside the lock because two processes adding
   * *different* keys must both survive: a plain whole-file write would let the
   * second publish a document without the first's entry. The lock is also what
   * lets this write merge rather than clobber: a process that self-fetched past
   * `fetchWaitMs` finishes holding an answer older than the one the lock holder
   * it could not wait for already stored, so each entry is compared by `at` and
   * the newer one wins (see `mergeEntry`). Returning the merges is what lets
   * `fetchAndStore` publish the same readings in its overlay.
   *
   * A group is written in **one** replace, so a reader — or a crash — never sees
   * two of three pools published. Everything unrelated in the document, the
   * gates and the sticky halt included, is carried forward untouched.
   *
   * A lock that cannot be taken in time skips the write and nothing else — the
   * readings are already in the overlay, which is the copy this process answers
   * from — and every error is swallowed for the same reason: a cache that could
   * not be written must not fail the evaluation that read it. Those cases return
   * the incoming entries, since without the lock there is no stored entry to
   * merge against.
   */
  async function writeEntries(
    credential: string,
    incoming: readonly { readonly member: SourceMember; readonly entry: CachedReadings }[],
  ): Promise<readonly { readonly member: SourceMember; readonly entry: CachedReadings }[]> {
    try {
      const placed = await withLockPath(fileLock, writePacing, now, sleep, async () => {
        const loaded = await loadDocument();
        const merged = new Map<string, CachedReadings>();
        for (const { member, entry } of incoming) {
          merged.set(member.key, mergeEntry(newestFor(loaded.entries, member.key), entry));
        }
        const others = loaded.entries.filter((e) => !merged.has(entryKey(e)));
        for (const { member } of incoming) {
          const entry = merged.get(member.key)!;
          others.push({
            rail: member.rail,
            credential,
            at: entry.at,
            latest: entry.latest,
            ...(entry.lastGood === undefined ? {} : { lastGood: entry.lastGood }),
          });
        }
        await writeAtomically(path, encode({ ...loaded, entries: others }));
        return incoming.map(({ member }) => ({ member, entry: merged.get(member.key)! }));
      });
      if (placed.ok) return placed.value;
    } catch {
      // Deliberately silent: this is a cache write. The readings are in the
      // overlay, so the caller already has everything it asked for.
    }
    return incoming;
  }

  /**
   * The one read: serve what is fresh, join a fetch already in flight, or take
   * the fetch lock and make the request.
   *
   * The freshness question is asked of three places in order, because each can
   * answer where the previous cannot: the overlay costs nothing, the file is
   * where another process's answer lives, and the lock is where two processes
   * agree to make one request. `force` skips the freshness tests but keeps the
   * join, which is what makes an explicit `refresh` share a fetch this process
   * already started rather than starting a second one.
   *
   * A source is answered as a whole. Its cache hit is every member present and
   * fresh — one missing pool means the group this store could serve is not the
   * group it was asked to keep, so it fetches rather than handing back two
   * pools and a guess. A pool the vendor omitted is not a missing entry: it is a
   * failure entry, which is a reading like any other and is honoured for the
   * TTL.
   *
   * Taking the fetch lock is best effort. The lock file needs a writable parent
   * directory and may be held by a process this host cannot confirm, and neither
   * is a reason to refuse a read the caller asked for: a failure to create,
   * judge, or release the lock falls through to the same self-fetch a bound that
   * ran out takes. An answer that already produced readings keeps them —
   * `produced` — because a release that fails after a successful fetch must not
   * cost the caller the read it came for, and must not ask the vendor twice.
   *
   * `markFetched` tells the caller's in-flight record that this operation either
   * asked the vendor or is returning a vendor answer a peer published while it
   * waited — the two things a `refresh` may honestly join. A read answered from
   * the local cache marks nothing, so a forced caller that joined it knows the
   * result is not the fetch it asked for and runs its own.
   */
  async function performSource(input: {
    source: ReadSource;
    credential: string;
    ttlMs: number;
    force: boolean;
    markFetched: () => void;
  }): Promise<SourceReadings> {
    const { source, credential, ttlMs, force, markFetched } = input;
    const members = sourceMembers(source, credential);
    const fresh = (entry: CachedReadings): boolean => now() - entry.at < ttlMs;
    const complete = (
      entries: readonly (CachedReadings | undefined)[],
    ): entries is readonly CachedReadings[] =>
      entries.every((entry): entry is CachedReadings => entry !== undefined);
    /** Publish entries this process now answers from, so a sibling read is free. */
    const install = (entries: readonly CachedReadings[]): void => {
      members.forEach((member, index) => overlay.set(member.key, entries[index]));
    };

    // The warm-overlay fast path: every member present and fresh, so this read
    // costs no file I/O at all — the same courtesy a single-rail read gets.
    const warm = members.map((member) => overlay.get(member.key));
    if (!force && complete(warm) && warm.every(fresh)) return sourceReadings(source, warm);

    // What the store knows before the lock is taken. For a forced read this is
    // the baseline a joining fetch is measured against: `force` means "give me a
    // reading taken after I asked", and only a *different* entry under the lock
    // is such a reading. A fetch that finished before the command does not count,
    // and neither does the same entry the file already held, however many times
    // it is re-decoded.
    const before = await combineMembers(members);
    if (!force && complete(before) && before.every(fresh)) {
      install(before);
      return sourceReadings(source, before);
    }

    // The readings the lock body produced, captured so a release failure after a
    // successful body does not cost the caller the read it came for. `undefined`
    // is what says the body never produced one — it never ran because the lock
    // could not be created, which is a coordination failure the caller survives,
    // or it ran and threw, which is the body's own fault and is re-raised.
    let produced: SourceReadings | undefined;
    let bodyStarted = false;
    let attempt: LockAttempt<SourceReadings> | undefined;
    try {
      attempt = await withLockPath(fetchLockFor(sourceKey(source, credential)), fetchPacing, now, sleep, async () => {
        bodyStarted = true;
        const current = await combineMembers(members);
        if (!force && complete(current) && current.every(fresh)) {
          // Fresh here where `before` was stale or absent means a peer's fetch
          // was published while we waited; it is exactly what our caller would
          // join, so this operation counts as having fetched.
          markFetched();
          install(current);
          produced = sourceReadings(source, current);
          return produced;
        }
        if (force && complete(current) && !sameSourceReadings(current, before)) {
          markFetched();
          install(current);
          produced = sourceReadings(source, current);
          return produced;
        }
        markFetched();
        produced = await fetchAndStore(source, credential, priorOf(members, current, before), members);
        return produced;
      });
    } catch (err) {
      // A lock that could not be created is a cache that cannot coordinate, not
      // a reading the caller cannot have, so fall through to the self-fetch
      // below. A failure *inside* the body is the fetch's own and is re-raised —
      // retrying it here would ask the vendor twice for one command.
      if (bodyStarted && produced === undefined) throw err;
    }

    if (attempt?.ok) return attempt.value;
    if (produced !== undefined) return produced;
    // The bound ran out — a holder this host could not confirm, or one stalled
    // past the longest a read can take — or the lock failed outright. Fetching
    // here rather than waiting longer is the promise that a stuck process, a
    // missing directory, or a read-only one cannot stall an evaluation.
    markFetched();
    return fetchAndStore(source, credential, priorOf(members, [], before), members);
  }

  /**
   * Every member's entry as this process should see it: the overlay and the file
   * combined, from **one** read of the document so the members are one picture.
   */
  async function combineMembers(
    members: readonly SourceMember[],
  ): Promise<readonly (CachedReadings | undefined)[]> {
    const loaded = await loadDocument();
    return members.map((member) => newer(overlay.get(member.key), newestFor(loaded.entries, member.key)));
  }

  /**
   * The entries a fetch's failures must carry forward as `lastGood`.
   *
   * The under-lock view wins, and the pre-lock view stands in where the current
   * one has nothing to say — the same relationship `newer` has, so a bounded
   * waiter's history is not lost to a slower holder's failure. The overlay is
   * re-combined in so a reading this process published after `before` was taken
   * is not discarded.
   */
  function priorOf(
    members: readonly SourceMember[],
    current: readonly (CachedReadings | undefined)[],
    before: readonly (CachedReadings | undefined)[],
  ): readonly (CachedReadings | undefined)[] {
    return members.map((member, index) =>
      newer(overlay.get(member.key), newer(current[index], before[index])),
    );
  }

  /**
   * One source's readings, from the process-local record it joins or the one it
   * registers.
   *
   * The record is keyed by the *source*, not by the rail that asked: every caller
   * wanting any pool of one Antigravity credential joins one operation, and each
   * projects its own rail out of the answer afterwards. That is what makes three
   * concurrent pool reads one request, both within this process and — through the
   * fetch lock the operation itself takes — across processes.
   */
  async function sourceReadingsFor(
    source: ReadSource,
    credential: string,
    opts: { ttlMs: number; force?: boolean },
  ): Promise<SourceReadings> {
    const key = sourceKey(source, credential);
    const force = opts.force === true;
    for (;;) {
      const joined = inFlight.get(key);
      if (joined === undefined) break;
      const result = await joined.promise;
      // A forced read is answered only by an operation that fetched or joined a
      // fetch. One that answered out of the local cache is the very reading
      // `force` exists to skip; every other caller, and a forced caller joining
      // a real request, takes what it joined.
      if (!force || joined.fetched) return result;
      // This forced read joined a pure cache hit. Look again rather than
      // installing a second record over a concurrent forced caller's real
      // fetch: that caller's record is now in the map, and joining it makes the
      // two share one request instead of racing two.
    }
    // No fetch is in flight. The record is registered before the first `await`,
    // so two reads of one source arriving in the same tick share one promise
    // rather than installing two. `fetched` is set by `markFetched`, which runs
    // only after `performSource` has awaited a vendor answer — by then this
    // initializer has finished, so the self-reference is safe.
    const record: InFlight = {
      fetched: false,
      promise: performSource({
        source,
        credential,
        ttlMs: opts.ttlMs,
        force,
        markFetched: () => {
          record.fetched = true;
        },
      }).finally(() => {
        if (inFlight.get(key) === record) inFlight.delete(key);
      }),
    };
    inFlight.set(key, record);
    return record.promise;
  }

  async function read(
    rail: SingleFetchRail,
    credential: string,
    opts: { ttlMs: number; force?: boolean; fetch: () => Promise<VendorReading> },
  ): Promise<VendorRailReadings> {
    const settled = await sourceReadingsFor({ kind: "single", rail, fetch: opts.fetch }, credential, opts);
    return asReadings(memberEntry(settled, rail));
  }

  async function readAntigravity(
    rail: AntigravityRail,
    credential: string,
    opts: { ttlMs: number; force?: boolean; fetch: () => Promise<AntigravityReadings> },
  ): Promise<VendorRailReadings> {
    const settled = await sourceReadingsFor({ kind: "antigravity", fetch: opts.fetch }, credential, opts);
    return asReadings(memberEntry(settled, rail));
  }

  /**
   * Whatever entry the store already holds, at any age; no fetch.
   *
   * The overlay and the file are combined rather than one preferred, because the
   * file can hold a `lastGood` a process's own overlay lost: a peer that
   * published a failure while this process was mid-fetch leaves the success in
   * the file, and the read that follows must see it.
   */
  async function known(rail: VendorRail, credential: string): Promise<VendorRailReadings | undefined> {
    const key = storeKey(rail, credential);
    const entry = newer(overlay.get(key), await entryFromFile(key));
    if (entry === undefined) return undefined;
    overlay.set(key, entry);
    return asReadings(entry);
  }

  /**
   * The gates one credential's next refresh ping obeys.
   *
   * The file is the base and the unpublished operations are the delta, so a
   * peer's write in between is never hidden: the document is freshly loaded and
   * the queue applied on top of it, one credential at a time. A pending clear's
   * `expected` is compared against *this* document, which is what makes an
   * unwritten clear hide only the halt it actually saw rather than whatever a
   * peer armed meanwhile.
   */
  async function gates(credential: string): Promise<RefreshGates> {
    const document = await loadDocument();
    let credentialGates = gateFrom(document, credential);
    for (const patch of pendingGatePatches.get(credential) ?? []) {
      credentialGates = applyGatePatch(credentialGates, patch);
    }
    let sticky: StickyHalt | undefined = document.stickyHalt;
    if (pendingSticky !== undefined) {
      if (pendingSticky.kind === "set") sticky = pendingSticky.sticky;
      else if (pendingSticky.expected === undefined) sticky = undefined;
      else if (sameSticky(document.stickyHalt, pendingSticky.expected)) sticky = undefined;
    }
    return {
      ...credentialGates,
      ...(sticky === undefined ? {} : { sticky }),
    };
  }

  /**
   * A field-level write of one credential's gates.
   *
   * The patch is queued before the file is touched, so it protects this process
   * whether or not the write lands, and `gates()` applies it on top of whatever
   * the file holds. The locked read-modify-write re-applies every operation this
   * process still owes — not just the new one — to the document as it is *now*,
   * so a patch that follows a failed write merges rather than replaces it: a
   * halt armed against an unwritable file survives the next cooldown patch, and
   * a halt cleared against an unwritable file is not resurrected by one.
   *
   * Retiring an operation by identity is what keeps the file authoritative
   * again after publication: only the operations actually written and applied
   * leave the queue, so one queued while this write awaited the lock survives,
   * and the process stops shadowing a gate it no longer has to protect. The
   * snapshot and the retire both happen *inside* the lock — the snapshot after
   * the document is loaded, the retire immediately after a successful publish
   * — because releasing the lock is itself an await, and a peer can clear the
   * gate before it resolves. Leaving a published operation pending across that
   * window would let an overlapping write snapshot and resurrect it; an
   * overlapping call may also have published and retired an earlier operation
   * before this one acquired the lock, which a pre-lock snapshot would replay.
   *
   * A failed write is deliberately silent, like every other write here: the
   * gates are protection, not state the caller asked for, and a read-only
   * directory must not turn arming one into an error. The cost is that the
   * protection stays process-local until a write succeeds.
   */
  async function setGates(credential: string, patch: GatePatch): Promise<void> {
    const queued = pendingGatePatches.get(credential);
    if (queued === undefined) pendingGatePatches.set(credential, [patch]);
    else queued.push(patch);
    try {
      await withLockPath(fileLock, writePacing, now, sleep, async () => {
        const loaded = await loadDocument();
        // The snapshot is taken here, not before the lock: a call that
        // overlapped this one may have already published and retired an
        // operation, and replaying it would write back a gate the file no
        // longer holds. An operation pushed after this point stays queued for
        // its own flush, because retiring is by identity against this list.
        const applied = (pendingGatePatches.get(credential) ?? []).slice();
        if (applied.length === 0) return;
        let next = gateFrom(loaded, credential);
        for (const op of applied) next = applyGatePatch(next, op);
        const gates: GateEntry[] = [];
        let replaced = false;
        for (const gate of loaded.gates) {
          if (gate.credential !== credential) {
            gates.push(gate);
            continue;
          }
          // A second entry for the same credential is dropped rather than
          // written back: `gateFrom` reads the last one, so the entries written
          // here are the only ones that could be current, and leaving the older
          // one would resurrect values the operations replaced.
          if (replaced) continue;
          replaced = true;
          if (hasGates(next)) gates.push({ credential, ...next });
        }
        if (!replaced && hasGates(next)) gates.push({ credential, ...next });
        await writeAtomically(path, encode({ ...loaded, gates }));
        // Retire while the lock is still held: only a write that returned
        // published these operations, and a delayed or failed release must not
        // leave them pending for an overlapping write to replay.
        retireGateOps(credential, applied);
      });
    } catch {
      // Silent: the queue already holds the answer, and a cache that could not
      // be written must not fail the read that is relying on the gate.
    }
  }

  /** Drop the operations a successful write applied, by identity, leaving any queued after it. */
  function retireGateOps(credential: string, applied: readonly GatePatch[]): void {
    const remaining = (pendingGatePatches.get(credential) ?? []).filter((op) => !applied.includes(op));
    if (remaining.length === 0) pendingGatePatches.delete(credential);
    else pendingGatePatches.set(credential, remaining);
  }

  /**
   * Set the machine-wide sticky halt, or clear it.
   *
   * A conditional clear (`expected`) is the one that matters: a reader that saw
   * a halt and then found the resolved `claude` unchanged must not erase a halt
   * a peer armed from a *different* install in between, so it clears only the
   * halt it saw. That comparison happens inside the lock, against the document
   * the write will publish — comparing outside it would let a peer's replacement
   * land in the window and be deleted unconditionally. An unconditional clear is
   * the user's `/quota-dispatch refresh`, which is a statement about the machine
   * and needs no comparison.
   *
   * The write is best effort for the same reason `setGates`' is, and the pending
   * operation carries the protection either way: a clear leaves this process
   * hiding the halt it named, so a failed write cannot resurrect it locally.
   *
   * A conditional clear that finds the halt it named already gone writes
   * nothing at all. It is a no-op, not an empty publish: there is no change to
   * make, and replacing the file would churn its inode (and, to a peer watching
   * the path, look like a fresh write).
   *
   * The pending operation is retired inside the lock — after a successful write,
   * or after a no-op decision — and only while it is still the newest, so a
   * newer operation queued during the await keeps governing `gates()` and a
   * delayed or failed lock release cannot leave a published one pending.
   */
  async function setStickyHalt(sticky: StickyHalt | undefined, expected?: StickyHalt): Promise<void> {
    const op: PendingSticky = sticky !== undefined
      ? { kind: "set", sticky }
      : (expected === undefined ? { kind: "clear" } : { kind: "clear", expected });
    pendingSticky = op;
    try {
      await withLockPath(fileLock, writePacing, now, sleep, async () => {
        const loaded = await loadDocument();
        // The expected halt is gone (or replaced), so the clear does not apply:
        // leave the document and the file exactly as they are, but retire the
        // operation — it asked for a change that needs no making.
        if (op.kind === "clear" && op.expected !== undefined && !sameSticky(loaded.stickyHalt, op.expected)) {
          if (pendingSticky === op) pendingSticky = undefined;
          return;
        }
        const document: FileDocument = { ...loaded };
        if (op.kind === "set") document.stickyHalt = op.sticky;
        else delete document.stickyHalt;
        await writeAtomically(path, encode(document));
        if (pendingSticky === op) pendingSticky = undefined;
      });
    } catch {
      // Silent: see `setGates`.
    }
  }

  return { read, readAntigravity, known, gates, setGates, setStickyHalt, warnings: () => warningLines };
}
