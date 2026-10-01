/**
 * Coordination for writes to shared agent files.
 *
 * The agent dir is global state: every pi process under this OS user reads and
 * writes the same files, and so does every project. Two passes that overlap on
 * one file can lose each other's edits, and a whole-file `writeFile` is visible
 * to a reader half-finished. This module is the two guarantees that fix it, and
 * they are deliberately separate:
 *
 *   - a **per-file lock**, so two cooperating processes do not rewrite one agent
 *     file at the same time;
 *   - an **atomic replace** through a temp file and a `rename`, so a reader sees
 *     the old file or the new one and never a truncated one. This one holds even
 *     where the lock does not — see `replaceFileAtomically`.
 *
 * It knows nothing about frontmatter or decisions: what to write, and whether a
 * write should be refused, is `applyDecision`'s business.
 */
import type { Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Pacing for one coordinated agent-file write, all of it in milliseconds.
 */
export interface FileWritePacing {
  /**
   * How long a lock whose holder cannot be confirmed may sit before a later
   * process takes it over. A record naming a live process on this host is not
   * taken over by this bound, at any age; this bound is what a lock with no
   * confirmable holder — a record with no pid, a pid on another host, or one
   * this platform will not answer about — falls back to. A live holder is still
   * reached by `ABANDONED_LOCK_MS`, which is an abandoned-release rule rather
   * than a staleness one.
   */
  staleMs: number;
  /** How long a pass keeps trying to take a lock before it holds instead. */
  waitMs: number;
  /** How long to sleep between attempts. */
  pollMs: number;
}

/**
 * Patience is seconds, not minutes: the critical section is one read, one string
 * rewrite and one rename. A lock still held after a few seconds therefore
 * belongs to one of three holders: one that no longer exists, one this host
 * cannot confirm, or one that is alive but paused — a stopped process, a slow
 * `fsync`. `staleMs` bounds waiting for the second; the third is waited past
 * `waitMs` into a hold rather than a takeover, and is only ever taken over by
 * the far longer `ABANDONED_LOCK_MS`.
 */
export const DEFAULT_FILE_WRITE: FileWritePacing = { staleMs: 10_000, waitMs: 3_000, pollMs: 25 };

/**
 * How long a lock whose holder is unambiguously alive may sit before a later
 * process treats it as an abandoned release and takes it over.
 *
 * The critical section is one read, one string rewrite and one rename:
 * milliseconds. A live-pid lock ten minutes old is therefore not active work —
 * it is the residue of a failed release or a failed acquisition while the
 * process itself lived on, and the liveness rule would otherwise protect it
 * until that process exits, which can be days. The cost is symmetric: a holder
 * stopped inside the critical section for longer than this can be overtaken
 * when it resumes.
 */
export const ABANDONED_LOCK_MS = 10 * 60_000;

/**
 * The seams a coordinated write needs beyond the filesystem.
 *
 * `now` and `sleep` are injected for the same reason the quota read's timings
 * are: a test that has to wait out real seconds to exercise a stale lock is a
 * test nobody runs.
 */
export interface Coordination {
  pacing?: Partial<FileWritePacing>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Who held a lock when a write gave up waiting for it: what the lock file said,
 * when it could be read at all.
 */
export interface LockHolder {
  pid?: number;
  /** When the holder said it took the lock, on the holder's clock. */
  at?: number;
}

/**
 * The outcome of one acquisition. A refusal is not a failure.
 *
 * `held` means the file is there and another process is coordinating it;
 * `holder` is what the lock file said about that process, so a caller can name
 * it rather than report an error. `gone` means there was nothing to coordinate —
 * the file does not exist — which is not a failure either, and maps to the same
 * outcome as a missing-file pre-check rather than to a lock taken on a name.
 */
export type LockAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "held"; holder?: LockHolder }
  | { ok: false; reason: "gone" };

/**
 * The canonical path of an existing `file`, resolved once.
 *
 * An agent file is allowed to be a symlink — `readAgentFiles` follows one on
 * purpose — and both exclusion and replacement have to name the same file, or a
 * write through an alias proceeds while the target's own lock is held. This is
 * the one place the canonical identity is computed. On macOS it also collapses
 * `/tmp/x` and `/private/tmp/x`, so the two names share one lock rather than each
 * getting its own.
 *
 * It is a best-effort resolution at one instant, not a promise that a later
 * write lands there: the target can be retargeted or removed afterwards, and
 * only a caller that holds this string still names what it resolved. A missing
 * file is `realpath`'s `ENOENT` and is left to the caller — there is no name to
 * invent for it, since locking a path the file may never occupy is how two
 * processes come to coordinate different files.
 */
export async function agentFileTarget(file: string): Promise<string> {
  return realpath(file);
}

/**
 * The lock file that guards writes to `file`.
 *
 * It is a sibling rather than a path in one shared lock directory, so the lock
 * for an agent file lives wherever that file's directory does — including a
 * relocated agent dir. The name keeps the agent file's own name and ends in
 * `.lock`, so the agent dir's `*.md` listing (and pi's own agent loading) never
 * sees it.
 *
 * `file` must be a resolved target (`agentFileTarget`), never the path a caller
 * named: an alias and its target must not get a lock each. Nothing here enforces
 * that — the type is a string either way — so the prerequisite is the caller's
 * to keep, and it lives in one place: whichever function first resolves a name.
 */
export function lockPathFor(file: string): string {
  return join(dirname(file), `.${basename(file)}.lock`);
}

/** The record this process writes into its own lock file. */
interface HeldLock {
  pid: number;
  host: string;
  at: number;
}

/** A lock file's parsed contents; any field the JSON did not carry is absent. */
interface LockRecord {
  pid?: number;
  host?: string;
  at?: number;
}

/** One acquisition: the record we wrote, and the inode we wrote it into. */
interface Acquisition {
  record: HeldLock;
  ino: number;
}

/** The lock file a staleness verdict was made on, which is what removing it must still see. */
interface LockIdentity {
  ino: number;
  mtimeMs: number;
}

/** What one read of an existing lock file said about it. */
type LockVerdict =
  /** It was released between the failed create and this read: nobody to wait for. */
  | { state: "gone" }
  /** Held, and by whom; `identity` names the file the verdict was made on. */
  | { state: "stale"; holder: LockHolder; identity: LockIdentity }
  | { state: "live"; holder: LockHolder };

export function errnoIs(err: unknown, code: string): boolean {
  return (err as { code?: unknown } | null)?.code === code;
}

/**
 * The most times one acquisition's loop may go round, whatever the outcomes:
 * `waitMs` bounds the waiting, this bounds the loop. Without it, timings whose
 * quotient is large enough to lose integer precision — a decrement that changes
 * nothing — would leave the loop with no bound at all.
 */
const MAX_ATTEMPTS = 1_000;

/**
 * A duration the loop's arithmetic can survive, or the default.
 *
 * A `pollMs` of zero would make the attempt count `waitMs / 0` — an infinity of
 * attempts rather than a fast poll — and a `NaN` reaching the count would leave
 * the loop with no bound at all. Both are inert as a shipped value and reachable
 * only through the test seam, so an unusable number is read as "not stated"
 * rather than repaired into something arbitrary.
 */
function duration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The record a lock file's JSON states, or nothing for a file that is empty,
 * not JSON, or not the shape this module writes. Empty is a legal state — see
 * `createLock` — so it is not an error.
 *
 * Each field is validated here rather than left to a consumer. `at` is the one
 * that matters most: JSON can carry `1e400`, which parses to `Infinity`, and an
 * age comparison against an infinite timestamp is false forever — a lock with no
 * confirmable holder that could then never age out and never be cleared. An
 * unusable value is dropped rather than repaired, so the verdict falls back to
 * something a holder cannot forge: the lock's own mtime for `at`, and an
 * unconfirmable holder for a missing or impossible pid. A finite but far-future
 * `at` is accepted here and rejected where the age is computed, because whether
 * a timestamp can be measured against is a question about now, not about shape.
 */
function parseLock(text: string): LockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Malformed JSON is the empty record this function documents. Anything else
    // — a read rejection, a fault in the parser itself — is not this seam's to
    // swallow.
    if (err instanceof SyntaxError) return {};
    throw err;
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const { pid, host, at } = parsed as { pid?: unknown; host?: unknown; at?: unknown };
  return {
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof host === "string" && host !== "" ? { host } : {}),
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
}

/**
 * What can be established about a lock's holder from its record.
 *
 * The distinction is the whole recovery policy. `gone` is a crash and is
 * recovered at once; `unknown` — no pid, a pid on another host, or a pid this
 * platform will not answer about — is bounded by `staleMs`; and `alive` is not
 * reached by `staleMs` at all, however old it looks, only by the far longer
 * `ABANDONED_LOCK_MS`. Reading "could not ask" as "gone" would let a pass evict
 * a live holder it merely failed to check, which is the overlap the lock exists
 * to prevent.
 */
type Liveness = "alive" | "gone" | "unknown";

/**
 * Answer `process.kill(pid, 0)` without turning uncertainty into permission.
 *
 * `ESRCH` is the one failure that proves the pid is gone; `EPERM` proves the
 * opposite, that the process is there and not ours to signal. A record naming
 * another host proves nothing here, and neither does any other failure — a pid
 * the platform will not even ask about. Both are `unknown`, and an unknown
 * holder is only ever aged out, never evicted as though it had died.
 *
 * A record with no host at all is read as this host: the field is newer than the
 * locks already on disk, and treating absence as another machine would make an
 * old lock unconfirmable and age a live holder out at `staleMs` early. That is
 * a compatibility assumption — a hostless record is assumed to name a pid of
 * this host — not a check that the pid is ours.
 */
function holderLiveness(record: LockRecord): Liveness {
  if (record.pid === undefined) return "unknown";
  if (record.host !== undefined && record.host !== hostname()) return "unknown";
  try {
    process.kill(record.pid, 0);
    return "alive";
  } catch (err) {
    if (errnoIs(err, "EPERM")) return "alive";
    if (errnoIs(err, "ESRCH")) return "gone";
    return "unknown";
  }
}

/**
 * Create `lockPath` exclusively and write our record into it, or `undefined`
 * when someone already holds it.
 *
 * The record goes through the same handle the exclusive create returned, so a
 * holder that crashes after the create leaves a zero-length lock rather than a
 * half-written one; both read as "no record" and are then judged on mtime. The
 * inode is read back with it because it is what a later release and a later
 * staleness verdict must still be looking at the same file to act.
 *
 * Once the exclusive create succeeds the file names this process, so anything
 * that fails before the acquisition is returned — the record write, reading the
 * inode back, closing the handle — must remove it again. Left behind it is a
 * live-pid lock for an invocation that never entered a critical section: an
 * `alive` record defeats `staleMs`, so later passes wait it out and only the
 * abandoned-release bound removes it, minutes after it was made. A failure to
 * remove it is raised alongside the original, which stays first.
 */
async function createLock(lockPath: string, record: HeldLock): Promise<Acquisition | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (err) {
    if (errnoIs(err, "EEXIST")) return undefined;
    throw err;
  }
  let acquisition: Acquisition | undefined;
  let failure: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    const info = await handle.stat();
    acquisition = { record, ino: info.ino };
  } catch (err) {
    failure = err;
  }
  try {
    await handle.close();
  } catch (err) {
    failure ??= err;
  }
  if (failure === undefined) return acquisition;
  try {
    await unlink(lockPath);
  } catch (cleanupErr) {
    if (!errnoIs(cleanupErr, "ENOENT")) {
      throw new AggregateError(
        [failure, cleanupErr],
        "a lock could not be completed and could not be removed",
      );
    }
  }
  throw failure;
}

/**
 * Read an existing lock file and decide whether it is still held.
 *
 * A record naming a pid that is gone is stale at once — the holder no longer
 * exists to release it, and making the next writer wait out `staleMs` would
 * answer a crash with a delay rather than with recovery.
 *
 * Everything else has no holder this host can confirm, so it is bounded by
 * `staleMs`. A live holder is the harder case: it is not evicted by `staleMs`
 * — the lock is doing its job, and evicting it would let a second writer inside
 * while the first can still publish — but it cannot be protected forever either,
 * or a release that failed would block the file until that process exits.
 * `ABANDONED_LOCK_MS` is that floor: a live-pid lock older than it is far older
 * than the millisecond critical section, so it reads as an abandoned release
 * rather than as active work.
 *
 * A record's `at` is used only when it is not in the future: a timestamp this
 * clock cannot measure against is replaced by the lock's own mtime, which no
 * field in the record can forge into immortality. A record with no usable `at`
 * — or an empty lock, which is what a crash between the exclusive create and
 * the record write leaves — is judged on that mtime for the same reason.
 */
async function judgeLock(
  lockPath: string,
  pacing: FileWritePacing,
  now: () => number,
): Promise<LockVerdict> {
  let info: Stats;
  try {
    info = await stat(lockPath);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return { state: "gone" };
    throw err;
  }
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return { state: "gone" };
    throw err;
  }
  const record = parseLock(text);
  const holder: LockHolder = {
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    ...(record.at !== undefined ? { at: record.at } : {}),
  };
  const liveness = holderLiveness(record);
  const t = now();
  const at = record.at !== undefined && record.at <= t ? record.at : info.mtimeMs;
  const age = t - at;
  const stale =
    liveness === "gone" ||
    (liveness === "unknown" && age >= pacing.staleMs) ||
    (liveness === "alive" && age >= ABANDONED_LOCK_MS);
  return stale
    ? { state: "stale", holder, identity: { ino: info.ino, mtimeMs: info.mtimeMs } }
    : { state: "live", holder };
}

/**
 * Remove a stale lock, but only the one the verdict was about.
 *
 * The re-`stat` is the point: between the verdict and the `unlink`, the old
 * holder may have released and another process taken the lock over, and
 * unlinking then would delete a live lock. Inode and mtime together name the
 * exact file the staleness was judged on; anything else is a different lock and
 * is left alone.
 *
 * That narrows the window rather than closing it — POSIX has no unlink-if, so a
 * second `stat` immediately before the unlink is as close to a compare-and-swap
 * as a file can get. What a lost race costs is bounded by the write it lets
 * through, not by what a reader sees: see `replaceFileAtomically` for why two
 * writers cannot produce a half-written file even when both believe they hold
 * the lock.
 */
async function clearStaleLock(lockPath: string, identity: LockIdentity): Promise<void> {
  let current: Stats;
  try {
    current = await stat(lockPath);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return;
    throw err;
  }
  if (current.ino !== identity.ino || current.mtimeMs !== identity.mtimeMs) return;
  try {
    await unlink(lockPath);
  } catch (err) {
    // Another recoverer got there between the stat and the unlink. The lock is
    // gone either way, which is all this was for.
    if (!errnoIs(err, "ENOENT")) throw err;
  }
}

/**
 * Release our lock, and only ours.
 *
 * A release can be late: the lock may have been taken over — by a recoverer that
 * judged the record's holder gone or unconfirmable — and the file now holds
 * someone else's record in someone else's inode. Both are checked, because the
 * record alone does not survive a takeover that happens to reuse our pid and
 * clock reading, and the inode alone does not survive a filesystem reusing a
 * number.
 */
async function releaseLock(lockPath: string, held: Acquisition): Promise<void> {
  let info: Stats;
  let text: string;
  try {
    info = await stat(lockPath);
    text = await readFile(lockPath, "utf8");
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return;
    throw err;
  }
  const mine = parseLock(text);
  if (info.ino !== held.ino) return;
  if (mine.pid !== held.record.pid || mine.at !== held.record.at) return;
  try {
    await unlink(lockPath);
  } catch (err) {
    if (!errnoIs(err, "ENOENT")) throw err;
  }
}

/**
 * Whether the lock file is still the one this acquisition created.
 *
 * `createLock` publishes the record after the exclusive create, so between the
 * two another recoverer can read the still-empty lock, judge it stale and replace
 * it. Entering then would put two writers inside; instead the creator treats the
 * miss as the next writer's lock and goes round the loop again. It is the same
 * "someone got there first" as an `EEXIST`, and nothing is released — the lock
 * at `lockPath` is no longer ours to release.
 *
 * This closes the empty-record window for a creator. It does not close the
 * two-recoverers race, which needs two processes to have already judged the same
 * lock stale, nor a lock cleared after this check.
 */
async function stillHolds(lockPath: string, held: Acquisition): Promise<boolean> {
  let info: Stats;
  try {
    info = await stat(lockPath);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return false;
    throw err;
  }
  return info.ino === held.ino;
}

/**
 * Take `file`'s lock, run `body` with the resolved target, release it.
 *
 * A lock is a create-exclusive file: `open(path, "wx")` either makes a new file
 * or fails with `EEXIST`, atomically, which is the one primitive available here
 * that is a genuine mutual exclusion rather than a check-then-act.
 *
 * The target is resolved once, here, and handed to the body: the lock, the
 * release and everything the body publishes have to name the file the lock
 * actually guards. A body that resolved the name again could be sent by a
 * symlink retargeted while this pass waited to a file this pass never locked.
 *
 * Not throwing on contention is deliberate. A write that cannot take the lock
 * has left the file alone, which is a state this extension already has a name
 * for — the caller turns it into a hold rather than an error nobody can act on.
 * A file that is not there is its own refusal: `gone` is not a hold and not an
 * error, and the caller reports it as a skip, the same as its missing-file
 * pre-check.
 */
export async function withFileLock<T>(
  file: string,
  coordination: Coordination,
  body: (target: string) => Promise<T>,
): Promise<LockAttempt<T>> {
  const pacing: FileWritePacing = {
    staleMs: duration(coordination.pacing?.staleMs, DEFAULT_FILE_WRITE.staleMs),
    waitMs: duration(coordination.pacing?.waitMs, DEFAULT_FILE_WRITE.waitMs),
    pollMs: duration(coordination.pacing?.pollMs, DEFAULT_FILE_WRITE.pollMs),
  };
  const now = coordination.now ?? (() => Date.now());
  const sleep = coordination.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  // Resolved once, and used for the body's whole lifetime: the lock, the release
  // and everything the body publishes name this one string, so an alias and its
  // target share one lock rather than each getting its own.
  let target: string;
  try {
    target = await agentFileTarget(file);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) return { ok: false, reason: "gone" };
    throw err;
  }
  const lockPath = lockPathFor(target);

  // Patience is a count of attempts rather than a deadline, because a test can
  // inject a clock that never advances and a loop waiting for that clock would
  // then never give up. Recovery is counted too, and not to slow it down: a
  // `staleMs` small enough to be reached within a few microseconds, or two
  // processes each clearing the lock the other has just made, would otherwise
  // make "clear it and look again" a spin with no way out. A stale lock is still
  // retried at once rather than slept over, and the floor of two is what lets a
  // recovery have the attempt that takes the field it just cleared.
  let attempts = Math.min(
    MAX_ATTEMPTS,
    Math.max(2, Math.ceil(pacing.waitMs / pacing.pollMs)),
  );
  let holder: LockHolder = {};

  for (;;) {
    // Stamped with the moment the lock is taken rather than the moment this call
    // started: `at` is what tells the next process how long the lock has been
    // held, so a stamp from before a long wait would make a lock we have just
    // taken look older than it is — and looking older is what gets a live lock
    // taken over.
    const held = await createLock(lockPath, { pid: process.pid, host: hostname(), at: now() });
    if (held !== undefined) {
      // Verified before the body: a lock created but not yet confirmed is one a
      // recoverer may already have cleared as an empty record. A lost lock is
      // judged below like any other contender rather than entered alongside it.
      if (await stillHolds(lockPath, held)) {
        let value: T;
        try {
          value = await body(target);
        } catch (err) {
          // The lock is still released, and a failure to release it must not hide
          // either failure. The body's fault is the one the caller can act on and
          // stays first; a failed release is its own operational problem, since
          // the next writer then waits out the lock until `ABANDONED_LOCK_MS` or
          // a human removes it. Both are raised rather than one being deleted.
          try {
            await releaseLock(lockPath, held);
          } catch (releaseErr) {
            throw new AggregateError(
              [err, releaseErr],
              "the locked write failed and its lock could not be released",
            );
          }
          throw err;
        }
        await releaseLock(lockPath, held);
        return { ok: true, value };
      }
    }

    const verdict = await judgeLock(lockPath, pacing, now);
    switch (verdict.state) {
      case "gone":
        // Nothing to wait for and nothing to clear: look again at once.
        break;
      case "stale":
        holder = verdict.holder;
        await clearStaleLock(lockPath, verdict.identity);
        break;
      case "live":
        holder = verdict.holder;
        await sleep(pacing.pollMs);
        break;
    }
    if (--attempts <= 0) return { ok: false, reason: "held", holder };
  }
}

/**
 * Distinguishes two replacements made by one process, which a pid alone does not.
 */
let tempSerial = 0;

/** The staging path for one replacement: a name no other writer can be holding. */
function tempPathFor(target: string): string {
  tempSerial += 1;
  return `${target}.tmp.${process.pid}.${tempSerial}`;
}

/**
 * Rename `text` onto exactly `target` in one step.
 *
 * `target` is the file the write lands in, not a name to resolve: `withFileLock`
 * resolved it once at acquisition and pinned the whole critical section to that
 * string. Resolving here again would be a *second* identity, and the name can be
 * changed between the two — a pass waiting on the lock has time for exactly
 * that — so the second resolution can follow a link the first did not and put
 * this pass's bytes into a file it never locked, one another process may be
 * holding. `rename` replaces a symlink at the destination rather than following
 * it, so a path that became a link under the caller is replaced, link and all,
 * and the file it pointed at is left untouched. What that does not reach is a
 * *directory* in the path being retargeted mid-pass: noticing that needs `openat`
 * against the pinned parent directory, which Node does not expose, so the parent
 * has to stay put for the critical section.
 *
 * An agent file is allowed to be a symlink — `readAgentFiles` follows one on
 * purpose, and a user who keeps their definitions in a dotfiles repository has
 * exactly that — and the rename lands on the resolved target, so the user's link
 * survives and the file it names is the one written.
 *
 * The temp name is unique to this write rather than fixed beside the target.
 * That is the difference between a lost update and a corrupt file: the lock can
 * be taken over — by a process that judged it stale, or by two recoverers at
 * once — and while a stolen lock only ever costs the assignment it was holding,
 * two writers sharing one temp path would write through each other's open
 * handle, and the file one of them publishes could be the other's half-finished
 * bytes. Nothing is shared here, so whatever the lock does, what is published is
 * one writer's whole text or the other's. The cost is that a crash between the
 * create and the rename leaves a stray `.tmp` file behind: nothing reads it, and
 * it is not an `.md` file for pi to load.
 *
 * Same-directory rename is atomic, so a reader that opens the file while this
 * runs gets one complete version or the other, which is the guarantee a reader
 * actually needs.
 */
export async function replaceFileAtomically(target: string, text: string): Promise<void> {
  const mode = (await stat(target)).mode & 0o7777;
  const temp = tempPathFor(target);
  try {
    // Exclusive, though the name is already ours alone: a collision is a bug, and
    // a bug should be an error here rather than a truncated file later. Created
    // private rather than with the target's mode, because the target's mode is
    // only applied once the content is complete — an agent file is often 0o600,
    // and a staging file readable by everyone for as long as the write takes
    // would hand its contents to anyone who looks.
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      // The sync is what keeps a crash from turning the atomic replace into a
      // truncation: the rename would otherwise be able to land on a file whose
      // bytes never reached the disk.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Staging was created 0o600 so its contents were never exposed; the target's
    // own bits may be looser (a 0o644 agent file) or tighter, so its mode is
    // copied on before the rename rather than inherited. The file therefore never
    // appears under a mode the target did not have.
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (err) {
    // The whole staging lifetime is covered, not just the rename: a write that
    // fails on a full disk is exactly when a stray 500KB file in the agent dir
    // is least welcome. A staging file already gone is the one tolerated
    // absence; any other cleanup failure is raised alongside the write's own
    // error, which stays first.
    try {
      await unlink(temp);
    } catch (unlinkErr) {
      if (!errnoIs(unlinkErr, "ENOENT")) {
        throw new AggregateError(
          [err, unlinkErr],
          "the atomic replace failed and its staging file could not be removed",
        );
      }
    }
    throw err;
  }
}
