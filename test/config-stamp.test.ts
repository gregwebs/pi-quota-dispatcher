/**
 * "Has a config file changed since we read it?", as the stamp module answers it.
 *
 * The answer decides whether a pass adopts an edited config without a `/reload`,
 * and it has to be right in both directions: a stamp that never moves pins the
 * session to a configuration the file no longer holds, and one that moves when
 * nothing happened re-reads, re-boots and re-evaluates on every poll tick — with
 * a warning in the log each time a file is unusable. So the cases below are the
 * two failures, not a tour of the fields.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  changedConfigPaths,
  readConfigStamp,
  type ConfigStamp,
  type StampFacts,
  type StampStat,
} from "../src/config-stamp.ts";

function facts(mtimeMs: number, size = 100, ino = 1, ctimeMs = mtimeMs): StampFacts {
  return { mtimeMs, ctimeMs, size, ino };
}

/** A stat that answers from a table, and records what it was asked about. */
function statTable(table: Record<string, StampFacts | Error>): StampStat & { asked: string[] } {
  const asked: string[] = [];
  const statFile = (async (path: string) => {
    asked.push(path);
    const answer = table[path];
    if (answer === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as StampStat & { asked: string[] };
  statFile.asked = asked;
  return statFile;
}

const FAILED = Object.assign(new Error("permission denied"), { code: "EACCES" });

test("a stamp reads every path it is given, in order", async () => {
  const statFile = statTable({ "/a.json": facts(1), "/b.json": facts(2) });

  const stamp = await readConfigStamp(["/a.json", "/b.json"], statFile);

  assert.deepEqual(statFile.asked, ["/a.json", "/b.json"]);
  assert.deepEqual(
    stamp.map((file) => [file.path, file.kind]),
    [
      ["/a.json", "present"],
      ["/b.json", "present"],
    ],
  );
});

test("a missing file is absent, not a failure", async () => {
  const stamp = await readConfigStamp(["/gone.json"], statTable({}));

  assert.deepEqual(stamp, [{ path: "/gone.json", kind: "absent" }]);
});

test("a file that cannot be examined describes its error instead of throwing", async () => {
  const stamp = await readConfigStamp(["/locked.json"], statTable({ "/locked.json": FAILED }));

  assert.deepEqual(stamp, [{ path: "/locked.json", kind: "unreadable", code: "EACCES" }]);
});

test("no change means no changed paths", async () => {
  const statFile = statTable({ "/a.json": facts(1) });

  const held = await readConfigStamp(["/a.json"], statFile);
  const fresh = await readConfigStamp(["/a.json"], statFile);

  assert.deepEqual(changedConfigPaths(held, fresh), []);
});

test("each field a save moves is a change on its own", async () => {
  const held: ConfigStamp = [{ path: "/a.json", kind: "present", mtimeMs: 1, ctimeMs: 1, size: 100, ino: 1 }];

  // An in-place save keeps the inode and the size and moves the mtime; an editor's
  // rename-replace keeps the mtime's millisecond and the size and moves the inode.
  // Either alone is a save, and a comparison that needed two of them would miss one
  // of the two shapes every day.
  const moved: StampFacts[] = [facts(2), facts(1, 101), facts(1, 100, 2)];
  for (const now of moved) {
    const fresh: ConfigStamp = [{ path: "/a.json", kind: "present", ...now }];
    assert.deepEqual(changedConfigPaths(held, fresh), ["/a.json"], JSON.stringify(now));
  }
});

test("a file appearing, disappearing or becoming unreadable is a change", async () => {
  const present: ConfigStamp = [{ path: "/a.json", kind: "present", mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1 }];

  assert.deepEqual(changedConfigPaths([{ path: "/a.json", kind: "absent" }], present), ["/a.json"]);
  assert.deepEqual(changedConfigPaths(present, [{ path: "/a.json", kind: "absent" }]), ["/a.json"]);
  assert.deepEqual(
    changedConfigPaths(present, [{ path: "/a.json", kind: "unreadable", code: "EACCES" }]),
    ["/a.json"],
  );
});

test("an unreadable file settles on its error code, so a broken install is read once", async () => {
  const held: ConfigStamp = [{ path: "/a.json", kind: "unreadable", code: "EACCES" }];
  const same: ConfigStamp = [{ path: "/a.json", kind: "unreadable", code: "EACCES" }];
  const other: ConfigStamp = [{ path: "/a.json", kind: "unreadable", code: "EISDIR" }];

  // Re-reading on every tick would mean a load, a warning, a boot and an
  // evaluation every `pollMs` for as long as the permissions are wrong.
  assert.deepEqual(changedConfigPaths(held, same), []);
  assert.deepEqual(changedConfigPaths(held, other), ["/a.json"]);
});

test("a path the fresh stamp no longer has counts as moved", async () => {
  const held: ConfigStamp = [{ path: "/a.json", kind: "present", mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1 }];

  assert.deepEqual(changedConfigPaths(held, []), ["/a.json"]);
});

test("every moved path is named, and only the moved ones", async () => {
  const held: ConfigStamp = [
    { path: "/a.json", kind: "present", mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1 },
    { path: "/b.json", kind: "present", mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1 },
    { path: "/c.json", kind: "absent" },
  ];
  const fresh: ConfigStamp = [
    { path: "/a.json", kind: "present", mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1 },
    { path: "/b.json", kind: "present", mtimeMs: 9, ctimeMs: 9, size: 1, ino: 1 },
    { path: "/c.json", kind: "absent" },
  ];

  assert.deepEqual(changedConfigPaths(held, fresh), ["/b.json"]);
});

/**
 * The production `stat` against a real file. The injected table above pins the
 * comparison; this pins the part that has to agree with the filesystem — that a
 * save moves the stamp, and that a permission change does too, because `chmod`
 * moves nothing else. That second one is what a broken install needs: a config
 * file the extension could not read becomes readable again with the same size,
 * mtime and inode, and a stamp without `ctimeMs` would never notice.
 */
test("a real file's save and permission change both move the stamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-stamp-"));
  const file = join(dir, "quota-dispatch.json");
  try {
    await writeFile(file, JSON.stringify({ margin: 20 }), "utf8");
    const held = await readConfigStamp([file]);

    // An in-place save of the same length: only the timestamps move.
    await writeFile(file, JSON.stringify({ margin: 21 }), "utf8");
    const rewritten = await readConfigStamp([file]);
    assert.deepEqual(changedConfigPaths(held, rewritten), [file], "a same-length rewrite is a change");

    // `stat` sees a mode-000 file; only `read` fails, which is why the stamp has
    // to carry ctime rather than a "could not read it" outcome.
    await chmod(file, 0o000);
    const unreadable = await readConfigStamp([file]);
    assert.deepEqual(changedConfigPaths(rewritten, unreadable), [file], "chmod 000 is a change");

    await chmod(file, 0o644);
    const restored = await readConfigStamp([file]);
    assert.deepEqual(changedConfigPaths(unreadable, restored), [file], "chmod 644 is a change");

    // And an unchanged file settles: the next read of the same stamp is quiet.
    assert.deepEqual(changedConfigPaths(restored, await readConfigStamp([file])), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A file that appears between two stamps is a change, from the production `stat`. */
test("a file created after the first stamp is a change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-stamp-"));
  const file = join(dir, "quota-dispatch.json");
  try {
    const missing = await readConfigStamp([file]);
    assert.deepEqual(missing, [{ path: file, kind: "absent" }]);

    await writeFile(file, "{}", "utf8");
    assert.deepEqual(changedConfigPaths(missing, await readConfigStamp([file])), [file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
