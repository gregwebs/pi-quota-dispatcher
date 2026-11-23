/**
 * Whether a config file has changed since the configuration in force was read.
 *
 * The dispatcher adopts an edited config instead of waiting for `/reload` (see
 * `docs/adr/0025-a-config-edit-is-adopted-by-the-next-pass.md`), and this is the
 * one fact that decides whether to re-read: the files as they looked when the
 * active configuration was loaded. Comparing stamps has to be cheaper than
 * re-reading, or "is this still the config?" would cost a load on every pass —
 * which, for a file that is unusable, means a warning in the log every `pollMs`.
 *
 * A stamp is taken *before* the read that produces the configuration, not after
 * it. Taken after, an edit landing mid-read would be recorded as adopted and
 * never picked up; taken before, that same edit leaves a stamp that looks stale
 * to the next check, so the worst case is one extra re-read.
 */
import { stat } from "node:fs/promises";

/**
 * The stat facts a stamp compares — everything a save or a permission change
 * moves.
 *
 * `ctimeMs` is here for the change `mtimeMs` cannot see: `chmod` and `chown` move
 * nothing else, and a config file that became readable again is a file whose
 * routes the configuration in force does not have. It also moves on every write,
 * so it is a second witness beside `mtimeMs`.
 */
export interface StampFacts {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly ino: number;
}

/** One config file, as a stamp describes it. */
export type FileStamp =
  | { readonly path: string; readonly kind: "absent" }
  | ({ readonly path: string; readonly kind: "present" } & StampFacts)
  /**
   * The file is there and could not be examined. The error code is part of the
   * stamp so that an unreadable file settles: without it the two sides could
   * never be equal, and every pass would re-read it — a load, a warning, a boot
   * and an evaluation — until someone fixed the permissions.
   */
  | { readonly path: string; readonly kind: "unreadable"; readonly code: string | undefined };

/** The config files one load consulted, in the order it consulted them. */
export type ConfigStamp = readonly FileStamp[];

/** How one path is examined. Injected by tests; production reads the filesystem. */
export type StampStat = (path: string) => Promise<StampFacts>;

const statPath: StampStat = (path) => stat(path);

/**
 * The stamp of each path, in the order given. Never rejects: a file this cannot
 * examine is described rather than thrown over, because a stamp is a question
 * about "has this changed?", and every answer is more useful to the caller than
 * an exception from a check.
 */
export async function readConfigStamp(
  paths: readonly string[],
  statFile: StampStat = statPath,
): Promise<ConfigStamp> {
  return Promise.all(paths.map((path) => stampOf(path, statFile)));
}

async function stampOf(path: string, statFile: StampStat): Promise<FileStamp> {
  try {
    return { path, kind: "present", ...(await statFile(path)) };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code !== "string") return { path, kind: "unreadable", code: undefined };
    if (code === "ENOENT") return { path, kind: "absent" };
    return { path, kind: "unreadable", code };
  }
}

/**
 * The paths whose stamp moved between two reads, in the order of `fresh`.
 *
 * A path the held stamp has and the fresh one does not counts as moved: the file
 * stopped being one a load consults, which changes what the configuration is. The
 * two stamps are never the same length in practice — they come from the same path
 * list — but answering for it costs one line and removes an assumption about a
 * caller.
 */
export function changedConfigPaths(held: ConfigStamp, fresh: ConfigStamp): string[] {
  const before = new Map(held.map((file) => [file.path, file]));
  const changed: string[] = [];
  for (const now of fresh) {
    const was = before.get(now.path);
    before.delete(now.path);
    if (was === undefined || !sameStamp(was, now)) changed.push(now.path);
  }
  return [...changed, ...before.keys()];
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  if (a.kind === "present" && b.kind === "present") {
    // Almost every difference a save makes shows up here: an editor or a
    // generator replaces the file by rename (moving `ino`), an in-place write
    // moves `mtimeMs`/`ctimeMs`, and anything added or removed moves `size`.
    //
    // The exception is a same-size in-place save inside one timestamp granule,
    // which no stat can distinguish — HFS+, FAT and some network shares report
    // to the second, and ADR 0015 names a shared VM config as a real setup. It
    // costs a delayed adoption until the file is saved again, which is the one
    // shape of missed edit this cannot see; the ADR records it rather than
    // hiding it behind a claim the stat cannot support.
    return (
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs &&
      a.size === b.size &&
      a.ino === b.ino
    );
  }
  if (a.kind === "unreadable" && b.kind === "unreadable") return a.code === b.code;
  return a.kind === "absent" && b.kind === "absent";
}
