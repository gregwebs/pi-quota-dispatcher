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
 * The type-only import of the reading shape is what keeps this module free of a
 * runtime cycle: `index.ts` imports `createSharedReadings` from here, and this
 * module learns the reading types from `index.ts` in a form the compiler erases.
 */
import { createHash } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errnoIs, lockPathFor, withLockPath, type FileWritePacing, type LockAttempt } from "./agent-file.ts";
import { READINGS_FILE_NAME } from "./config.ts";
import type {
  FailedReading,
  GoodReading,
  RailWindow,
  VendorRail,
  VendorRailReadings,
} from "./index.ts";

/**
 * The version this module writes and the only one it reads.
 *
 * 2 added the refresh gates and the sticky halt beside the entries. A 1 document
 * is an unknown version and faults the whole file, which is what the field is
 * for: a version this writer does not know is a shape it cannot promise to
 * preserve, and the entries are a cache that the next write repairs anyway.
 */
export const READINGS_FILE_VERSION = 2;

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

/** A reading that came from asking: every rail but the metered one, and the only kind the file holds. */
export type VendorReading = GoodReading | FailedReading;

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
 * What a shared store answers, in the three forms the dispatcher needs.
 *
 * `read` is the policy's path — a reading fresh within its TTL, a fetch when it
 * has lapsed — and `known` is the generator path, which is deliberately
 * age-blind (see ADR 0015). `warnings` is a rendering, not state: the report is
 * where a corrupt file becomes visible, and nowhere else is allowed to refuse
 * work over one.
 */
export interface SharedReadings {
  /** Fresh-within-ttl entry, else lock/recheck/fetch/write. Never routes on lastGood. */
  read(
    rail: VendorRail,
    credential: string,
    opts: { ttlMs: number; force?: boolean; fetch: () => Promise<VendorReading> },
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
 * One operation this process has in flight, and whether it counts as a fetch.
 *
 * `fetched` is mutable because only `perform` knows when the question is
 * settled: a read registered before its first `await` cannot say yet whether it
 * will answer from the local cache, ask the vendor, or return a vendor answer a
 * peer published while it waited. Those last two are what a forced read may
 * join, so they set the flag; a forced read that joined a record whose flag
 * stayed false knows the result is a cache hit and runs a fetch of its own.
 */
interface InFlight {
  promise: Promise<VendorRailReadings>;
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
 * The fault one entry fails on, named the way the report can point at it: by the
 * rail it claims when it claims a string, else by its position, because a
 * shapeless entry names no rail to point at.
 */
function entryFault(rail: unknown, index: number): string {
  return typeof rail === "string"
    ? `entry for ${JSON.stringify(rail)} is invalid`
    : `entry ${index + 1} is invalid`;
}

/** One entry of the document, validated, or the fault that makes the whole file unusable. */
function fileEntry(value: unknown, index: number): { entry: FileEntry } | { fault: string } {
  if (value === null || typeof value !== "object") return { fault: entryFault(undefined, index) };
  const e = value as Record<string, unknown>;
  const rail = e.rail;
  if (rail !== "claude" && rail !== "codex") return { fault: entryFault(rail, index) };
  if (typeof e.credential !== "string" || e.credential === "") return { fault: entryFault(rail, index) };
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return { fault: entryFault(rail, index) };
  const latest = goodReading(e.latest, rail) ?? failedReading(e.latest, rail);
  if (latest === undefined) return { fault: entryFault(rail, index) };
  let lastGood: GoodReading | undefined;
  if (e.lastGood !== undefined) {
    lastGood = goodReading(e.lastGood, rail);
    if (lastGood === undefined) return { fault: entryFault(rail, index) };
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
  if (doc.version !== READINGS_FILE_VERSION) {
    return { fault: `unknown version ${String(doc.version)}` };
  }
  if (!Array.isArray(doc.entries)) return { fault: "its entries are not a list" };
  const entries: FileEntry[] = [];
  for (const [index, raw] of doc.entries.entries()) {
    const result = fileEntry(raw, index);
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
 * The document text one document is published as.
 *
 * `gates` and `stickyHalt` are omitted rather than written empty or null: a
 * file holding nothing but readings is the shape every version-2 writer can
 * read, and a key that is absent cannot be mistaken for a value a later version
 * gave a meaning to.
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
   * Ask, remember, and publish the answer.
   *
   * `prior` is what this process knew before asking — the entry a failure must
   * carry forward as its `lastGood`. It is passed in rather than read here
   * because it must be the value from *before* the fetch, not the overlay after
   * a concurrent read has moved it.
   */
  async function fetchAndStore(
    rail: VendorRail,
    credential: string,
    prior: CachedReadings | undefined,
    fetch: () => Promise<VendorReading>,
  ): Promise<VendorRailReadings> {
    const latest = await fetch();
    const lastGood = latest.ok ? latest : prior?.lastGood ?? (prior?.latest.ok ? prior.latest : undefined);
    const entry: CachedReadings = { at: now(), latest, ...(lastGood === undefined ? {} : { lastGood }) };
    // The merged entry, not the one fetched: the file can hold a newer answer
    // from a process that self-fetched past our fetch lock, and the overlay is
    // the copy this process answers from, so it must agree with the file.
    const merged = await writeEntry(rail, credential, entry);
    overlay.set(storeKey(rail, credential), merged);
    return asReadings(merged);
  }

  /**
   * Replace one key's entry in the file, under the file's write lock, and return
   * the entry the file holds for that key afterwards.
   *
   * The whole read-modify-write is inside the lock because two processes adding
   * *different* keys must both survive: a plain whole-file write would let the
   * second publish a document without the first's entry. The lock is also what
   * lets this write merge rather than clobber: a process that self-fetched past
   * `fetchWaitMs` finishes holding an answer older than the one the lock holder
   * it could not wait for already stored, so the stored entry is compared by
   * `at` and the newer one wins (see `mergeEntry`). Returning the merge is what
   * lets `fetchAndStore` publish the same reading in its overlay.
   *
   * A lock that cannot be taken in time skips the write and nothing else — the
   * reading is already in the overlay, which is the copy this process answers
   * from — and every error is swallowed for the same reason: a cache that could
   * not be written must not fail the evaluation that read it. Those cases return
   * the incoming entry, since without the lock there is no stored entry to merge
   * against.
   */
  async function writeEntry(
    rail: VendorRail,
    credential: string,
    entry: CachedReadings,
  ): Promise<CachedReadings> {
    const key = storeKey(rail, credential);
    try {
      const placed = await withLockPath(fileLock, writePacing, now, sleep, async () => {
        const loaded = await loadDocument();
        const merged = mergeEntry(newestFor(loaded.entries, key), entry);
        const others = loaded.entries.filter((e) => entryKey(e) !== key);
        others.push({
          rail,
          credential,
          at: merged.at,
          latest: merged.latest,
          ...(merged.lastGood === undefined ? {} : { lastGood: merged.lastGood }),
        });
        await writeAtomically(path, encode({ ...loaded, entries: others }));
        return merged;
      });
      if (placed.ok) return placed.value;
    } catch {
      // Deliberately silent: this is a cache write. The reading is in the
      // overlay, so the caller already has everything it asked for.
    }
    return entry;
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
   * Taking the fetch lock is best effort. The lock file needs a writable parent
   * directory and may be held by a process this host cannot confirm, and neither
   * is a reason to refuse a read the caller asked for: a failure to create,
   * judge, or release the lock falls through to the same self-fetch a bound that
   * ran out takes. A body that already produced a reading keeps it —
   * `produced` — because a release that fails after a successful fetch must not
   * cost the caller the reading it came for, and must not ask the vendor twice.
   *
   * `markFetched` tells the caller's in-flight record that this operation either
   * asked the vendor or is returning a vendor answer a peer published while it
   * waited — the two things a `refresh` may honestly join. A read answered from
   * the local cache marks nothing, so a forced caller that joined it knows the
   * result is not the fetch it asked for and runs its own.
   */
  async function perform(
    key: string,
    rail: VendorRail,
    credential: string,
    opts: {
      ttlMs: number;
      force: boolean;
      fetch: () => Promise<VendorReading>;
      markFetched: () => void;
    },
  ): Promise<VendorRailReadings> {
    const { ttlMs, force, fetch, markFetched } = opts;
    const fresh = (entry: CachedReadings): boolean => now() - entry.at < ttlMs;

    const overlayEntry = overlay.get(key);
    if (!force && overlayEntry !== undefined && fresh(overlayEntry)) return asReadings(overlayEntry);

    // What the store knows before the lock is taken. For a forced read this is
    // the baseline a joining fetch is measured against: `force` means "give me a
    // reading taken after I asked", and only a *different* entry under the lock
    // is such a reading. A fetch that finished before the command does not count,
    // and neither does the same entry the file already held, however many times
    // it is re-decoded.
    const before = newer(overlayEntry, await entryFromFile(key));
    if (!force && before !== undefined && fresh(before)) {
      overlay.set(key, before);
      return asReadings(before);
    }

    // The reading the lock body produced, captured so a release failure after a
    // successful body does not cost the caller the read it came for. `undefined`
    // is what says the body never produced one — it never ran because the lock
    // could not be created, which is a coordination failure the caller survives,
    // or it ran and threw, which is the body's own fault and is re-raised.
    let produced: VendorRailReadings | undefined;
    let bodyStarted = false;
    let attempt: LockAttempt<VendorRailReadings> | undefined;
    try {
      attempt = await withLockPath(fetchLockFor(key), fetchPacing, now, sleep, async () => {
        bodyStarted = true;
        const current = newer(overlay.get(key), await entryFromFile(key));
        if (!force && current !== undefined && fresh(current)) {
          // Fresh here where `before` was stale or absent means a peer's fetch
          // was published while we waited; it is exactly what our caller would
          // join, so this operation counts as having fetched.
          markFetched();
          produced = asReadings(current);
          return produced;
        }
        if (force && current !== undefined && !sameEntry(current, before)) {
          markFetched();
          produced = asReadings(current);
          return produced;
        }
        markFetched();
        produced = await fetchAndStore(rail, credential, current ?? before, fetch);
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
    return fetchAndStore(rail, credential, newer(overlay.get(key), before), fetch);
  }

  async function read(
    rail: VendorRail,
    credential: string,
    opts: { ttlMs: number; force?: boolean; fetch: () => Promise<VendorReading> },
  ): Promise<VendorRailReadings> {
    const key = storeKey(rail, credential);
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
    // No fetch is in flight. Registered before the first `await`: two reads of
    // one rail that arrive in the same tick must share one promise, and there
    // is no `await` between this check and the `inFlight.set` below, so two
    // callers cannot both install. The record is handed its flag by
    // `markFetched`, which runs only after `perform` has awaited a vendor answer
    // — by then this initializer has finished, so the self-reference is safe.
    const record: InFlight = {
      fetched: false,
      promise: perform(key, rail, credential, {
        ttlMs: opts.ttlMs,
        force,
        fetch: opts.fetch,
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

  return { read, known, gates, setGates, setStickyHalt, warnings: () => warningLines };
}
