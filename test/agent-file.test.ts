/**
 * Coordination of writes to a shared agent file.
 *
 * The agent dir is global state, so the faults this suite is built around are
 * the ones two pi processes produce together: a write that cannot have seen the
 * line it replaces, and a reader that opens the file while it is being rewritten.
 * Where a second process is the only honest way to produce one, the tests spawn
 * the fixture in `test/fixtures/agent-write-child.ts` rather than pretending an
 * in-process stand-in is a second pi.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type WriteResult,
  ABANDONED_LOCK_MS,
  agentFileTarget,
  applyDecision,
  lockPathFor,
  readAgentFiles,
  replaceFileAtomically,
  withFileLock,
} from "../src/index.ts";
import { modelId } from "./helpers/identifiers.ts";
import {
  FAST,
  assertCleanExit,
  spawnFixture,
  startHolder,
  waitUntil,
} from "./fixtures/agent-write-child.ts";

/**
 * A complete agent file: the `model:` the dispatcher owns, wrapped in the name,
 * key and body a write must leave untouched.
 */
function agentFileText(model: string, thinking?: string): string {
  const level = thinking === undefined ? "" : `\nthinking: ${thinking}`;
  return `---\nname: agent\nmodel: "${model}"${level}\ntools: read\n---\n\nBody.\n`;
}

/**
 * The lock a write to `file` uses. `withFileLock` and `replaceFileAtomically`
 * key off the resolved target, so a test asserting on the lock must resolve it
 * the same way: on macOS `os.tmpdir()` is `/tmp`, whose `realpath` is
 * `/private/tmp`, and those are different lock paths.
 */
async function lockFor(file: string): Promise<string> {
  return lockPathFor(await agentFileTarget(file));
}

/**
 * The staging files a replacement may leave behind. Its names are
 * `<target>.tmp.<pid>.<n>`, so the shared marker is `.tmp` anywhere in the name —
 * `endsWith(".tmp")` matches none of them and so asserts nothing.
 */
async function stagingFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => entry.includes(".tmp"));
}

/** The `model:` a file states, read the plain way so the test is not the parser. */
async function modelIn(file: string): Promise<string> {
  const found = /^model: "(.*)"$/m.exec(await readFile(file, "utf8"));
  assert.ok(found, `${file} states no model`);
  return found[1];
}

async function agentDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pqd-${prefix}-`));
}

/**
 * Runs `jobs` as real child processes, all gated on one release file, and lets
 * them go only once every one of them is loaded and waiting.
 *
 * The barrier is the whole point. Children spawned in a loop start one after
 * another — process startup is milliseconds of work — so without it a test of
 * "simultaneous writers" can pass while nothing ever overlapped, which is the
 * one schedule it exists to cover.
 */
async function runTogether<T>(dir: string, jobs: Array<Record<string, unknown>>): Promise<T[]> {
  const release = join(dir, ".start");
  const children = jobs.map((job, index) => {
    const ready = join(dir, `.ready.${index}`);
    return { ready, ...spawnFixture({ ...job, readyMarker: ready, awaitFile: release }) };
  });
  await Promise.all(
    children.map((child) => waitUntil("a child to be loaded", () => existsSync(child.ready))),
  );
  await writeFile(release, "", "utf8");
  return Promise.all(
    children.map(async (child) => {
      const result = await child.done;
      assertCleanExit(result);
      return JSON.parse(result.stdout) as T;
    }),
  );
}

// ---------------------------------------------------------------- the write

test("a coordinated write lands the model and its level and leaves the rest of the file alone", async () => {
  const dir = await agentDir("write");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const result = await applyDecision(
    { file, model: modelId("c/d"), thinking: "high", base: "a/b", dry: false },
    { pacing: FAST },
  );
  assert.deepEqual(result, { kind: "written" });

  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "c\/d"$/m);
  assert.match(after, /^thinking: high$/m);
  assert.match(after, /^name: agent$/m);
  assert.match(after, /^tools: read$/m);
  assert.match(after, /Body\./);
});

// The fault: the pass decided from one file and the file moved under it. The
// rewrite is applied to the bytes on disk now, so a body edit made in between is
// kept — only the two lines the dispatcher owns move.
test("an unrelated edit made after the pass read the file survives the write", async () => {
  const dir = await agentDir("preserve");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  // The pass has read the file: `base` is what it saw.
  const write = { file, model: modelId("c/d"), base: "a/b", dry: false };
  await writeFile(file, `${agentFileText("a/b")}\nA note added by hand.\n`, "utf8");

  assert.deepEqual(await applyDecision(write, { pacing: FAST }), { kind: "written" });
  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "c\/d"$/m);
  assert.match(after, /A note added by hand\./, "a hand edit made mid-pass was lost");
});

// The same fault across processes, which the single-process test cannot produce:
// the child's pass decides against a `base` from before another process appends
// to the file, and the note must survive the child's write exactly as it does in
// process. The child's gate is before its own pre-check, so this proves an edit
// made before the pass's read survives — not one made between its read and its
// write, which the read-under-lock test below is for.
test("an edit another process makes while a pass waits survives that pass's write", async () => {
  const dir = await agentDir("cross-process-edit");
  const file = join(dir, "agent.md");
  const ready = join(dir, ".ready");
  const release = join(dir, ".start");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const { done } = spawnFixture({
    kind: "apply",
    file,
    model: modelId("c/d"),
    base: "a/b",
    pacing: FAST,
    readyMarker: ready,
    awaitFile: release,
  });
  await waitUntil("the child to load", () => existsSync(ready));
  // The child's snapshot is the model from before this edit; the edit is a body
  // note no pass wrote.
  await writeFile(file, `${agentFileText("a/b")}\nA note added by another process.\n`, "utf8");
  await writeFile(release, "", "utf8");

  const result = await done;
  assertCleanExit(result);
  assert.equal((JSON.parse(result.stdout) as WriteResult).kind, "written");
  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "c\/d"$/m);
  assert.match(after, /A note added by another process\./, "an edit made by another process was lost");
});

// The pass has to read the file *after* it takes the lock. A pass that composes
// its bytes from the earlier, unlocked read publishes a snapshot that never saw
// an edit made while it waited — and the cross-process test above cannot tell
// the two apart, because its gate is before even that earlier read. Here the
// lock is held by another process and the edit lands while this pass waits for
// it, so an edit missing from the result can only have been dropped by the
// read.
test("the write reads the file after the lock, so an edit made while it waits survives", async () => {
  const dir = await agentDir("read-under-lock");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const holder = await startHolder(file);
  let noted = false;
  const note = "\nA note added while the pass waited.\n";
  const pending = applyDecision(
    { file, model: modelId("c/d"), base: "a/b", dry: false },
    {
      pacing: { staleMs: 10_000, waitMs: 5_000, pollMs: 2 },
      // The pass sleeps only while a live holder blocks it, which is exactly the
      // window this test needs the edit to land in. The edit and the release go
      // first, then the real delay, so the next poll finds the lock free.
      sleep: async (ms) => {
        if (!noted) {
          noted = true;
          await writeFile(file, `${agentFileText("a/b")}${note}`, "utf8");
          await holder.release();
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
  );

  assert.deepEqual(await pending, { kind: "written" });
  const after = await readFile(file, "utf8");
  assert.match(after, /^model: "c\/d"$/m);
  assert.match(
    after,
    /A note added while the pass waited\./,
    "the write composed from bytes read before the lock",
  );
});

// Two passes reaching the same answer is the normal case, and it must not write:
// a write here would be one process undoing and redoing another's work.
test("a file another pass already brought to the target is unchanged", async () => {
  const dir = await agentDir("converge");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("c/d"), "utf8");

  assert.deepEqual(
    await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST }),
    { kind: "unchanged" },
  );
  assert.equal(await readFile(file, "utf8"), agentFileText("c/d"));
});

// The lock is for writes. A pass that has nothing to write should not need one,
// which is what keeps a poll from creating and deleting a lock file per agent,
// and what keeps an agent dir this process cannot write to reportable.
test("a pass with nothing to write takes no lock", async () => {
  const dir = await agentDir("no-write");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("c/d"), "utf8");

  const holder = await startHolder(file);
  try {
    const started = Date.now();
    assert.deepEqual(
      await applyDecision(
        { file, model: modelId("c/d"), base: "c/d", dry: false },
        { pacing: { staleMs: 10_000, waitMs: 30, pollMs: 2 } },
      ),
      { kind: "unchanged" },
    );
    assert.ok(Date.now() - started < 5_000, "an unchanged pass waited on a lock it has no use for");
  } finally {
    await holder.release();
  }
});

// The same fact from the side a user can hit: an agent dir that cannot hold a
// lock file is not an install where every agent reads as held. The lock is a
// file, and a directory that refuses new files refuses it; a pass with no write
// to make never asks.
test("an agent dir that cannot hold a lock file still reports an unchanged agent", async () => {
  const dir = await agentDir("read-only");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("c/d"), "utf8");
  await chmod(dir, 0o555);
  try {
    assert.deepEqual(
      await applyDecision({ file, model: modelId("c/d"), base: "c/d", dry: false }, { pacing: FAST }),
      { kind: "unchanged" },
    );
  } finally {
    await chmod(dir, 0o755);
  }
});

test("a conflicting assignment is held, and the reason names both models", async () => {
  const dir = await agentDir("conflict");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  // The pass read `a/b`; another process assigned `x/y` before this write.
  await writeFile(file, agentFileText("x/y"), "utf8");

  const result = await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST });
  if (result.kind !== "held") assert.fail(`expected a hold, got ${JSON.stringify(result)}`);
  assert.match(result.why, /another pi process/);
  assert.match(result.why, /"x\/y"/, "the reason must name the assignment it refused to overwrite");
  assert.match(result.why, /"c\/d"/, "the reason must name the model this pass wanted");
  assert.equal(await readFile(file, "utf8"), agentFileText("x/y"), "a held write must leave the file alone");
});

// The model a conflicting file carries is evidence, not a validated value, so a
// malformed spelling survives the refusal and is named as it stands rather than
// being rejected on the way into the reason.
test("a malformed raw model on disk survives conflict detection and is named verbatim", async () => {
  const dir = await agentDir("raw-conflict");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  await writeFile(file, agentFileText("nomodel"), "utf8");

  const result = await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST });
  if (result.kind !== "held") assert.fail(`expected a hold, got ${JSON.stringify(result)}`);
  assert.match(result.why, /"nomodel"/, "the raw spelling must be reported as it stands");
  assert.equal(await readFile(file, "utf8"), agentFileText("nomodel"));
});

// `undefined` is not a model, and a reason that named it would send the reader
// looking for a model id that does not exist. The refusal is the same one.
test("a file whose model line vanished mid-pass is held in words that name no model", async () => {
  const dir = await agentDir("removed");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const after = `---\nname: agent\ntools: read\n---\n\nBody.\n`;
  await writeFile(file, after, "utf8");

  const result = await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST });
  if (result.kind !== "held") assert.fail(`expected a hold, got ${JSON.stringify(result)}`);
  assert.match(result.why, /another pi process removed the model line from this file mid-pass/);
  assert.doesNotMatch(result.why, /undefined/);
  assert.match(result.why, /"c\/d"/);
  assert.equal(await readFile(file, "utf8"), after);
});

test("a missing file, and a file with no usable frontmatter, are skipped rather than held", async () => {
  const dir = await agentDir("skip");
  const absent = join(dir, "absent.md");
  assert.deepEqual(
    await applyDecision({ file: absent, model: modelId("c/d"), base: undefined, dry: false }, { pacing: FAST }),
    { kind: "skipped (no file)" },
  );

  const bare = join(dir, "bare.md");
  await writeFile(bare, "no frontmatter here\n", "utf8");
  assert.deepEqual(
    await applyDecision({ file: bare, model: modelId("c/d"), base: undefined, dry: false }, { pacing: FAST }),
    { kind: "skipped (no frontmatter)" },
  );
  assert.equal(await readFile(bare, "utf8"), "no frontmatter here\n");
});

test("a dry pass reports what a write would do and touches nothing", async () => {
  const dir = await agentDir("dry");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  assert.deepEqual(
    await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: true }, { pacing: FAST }),
    { kind: "would-write" },
  );
  assert.equal(await readFile(file, "utf8"), agentFileText("a/b"));
  // A report must not be able to block a real write, so it takes no lock at all.
  assert.equal(existsSync(await lockFor(file)), false, "a dry pass took the lock");
});

// The sharper half of the same rule: with a lock another process is holding, a
// dry pass must still answer at once. Taking the lock would make it wait, and
// failing to take it would make the report describe a hold the real pass would
// only reach after its own wait.
test("a dry pass answers even while another process holds the lock", async () => {
  const dir = await agentDir("dry-held");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const holder = await startHolder(file);
  try {
    const started = Date.now();
    assert.deepEqual(
      await applyDecision(
        { file, model: modelId("c/d"), base: "a/b", dry: true },
        { pacing: { staleMs: 10_000, waitMs: 30, pollMs: 2 } },
      ),
      { kind: "would-write" },
    );
    assert.ok(Date.now() - started < 5_000, "a dry pass waited on a lock it should never take");
    assert.equal(await readFile(file, "utf8"), agentFileText("a/b"));
  } finally {
    await holder.release();
  }
});

// The check is the same one the real write makes, made without the lock: a
// report that could not see a conflict would describe a write that then refuses.
test("a dry pass reports a conflicting assignment it can see", async () => {
  const dir = await agentDir("dry-conflict");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("x/y"), "utf8");

  const result = await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: true }, { pacing: FAST });
  if (result.kind !== "held") assert.fail(`expected a hold, got ${JSON.stringify(result)}`);
  assert.match(result.why, /"x\/y"/);
});

// ------------------------------------------------ the atomic replace

/**
 * The replace is the half of the guarantee a reader is owed, and it is not the
 * lock: a handle opened before the write must keep reading the file it opened,
 * because the new text went to a different inode and was renamed over the old
 * one. An implementation that truncated and rewrote in place fails this.
 */
test("a replacement is one step: a reader that already opened the file keeps the old one", async () => {
  const dir = await agentDir("atomic");
  const file = join(dir, "agent.md");
  const before = agentFileText("a/b");
  await writeFile(file, before, "utf8");

  const handle = await open(file, "r");
  try {
    await replaceFileAtomically(file, agentFileText("c/d"));
    assert.equal(
      await handle.readFile({ encoding: "utf8" }),
      before,
      "an open reader was shown content from the file it did not open",
    );
  } finally {
    await handle.close();
  }

  assert.equal(await modelIn(file), "c/d");
  assert.deepEqual(await stagingFiles(dir), [], "a replaced file left its staging file behind");
});

/**
 * Two replacements of one file with no lock between them, which is what a
 * stolen lock amounts to. Each has to publish one writer's *whole* text: a temp
 * file named after the target rather than after this write is a staging file two
 * writers share, and the second can then publish the first's half-written bytes
 * — or truncate the file the first has already renamed into place.
 */
test("two replacements with no lock between them each publish a whole file", async () => {
  const dir = await agentDir("racing");
  const file = join(dir, "agent.md");
  const texts = [agentFileText("c/1"), agentFileText("c/2")];
  await writeFile(file, texts[0], "utf8");

  await Promise.all(texts.map((text) => replaceFileAtomically(file, text)));

  const published = await readFile(file, "utf8");
  assert.ok(
    texts.includes(published),
    `two concurrent replacements published something that is neither: ${JSON.stringify(published)}`,
  );
  assert.deepEqual(await stagingFiles(dir), [], "a replacement left its staging file behind");
});

test("the file's permission bits survive the replacement", async () => {
  const dir = await agentDir("mode");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), { mode: 0o600 });

  assert.deepEqual(
    await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST }),
    { kind: "written" },
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600, "the replacement changed the file's mode");
});

/**
 * The guarantee a reader is owed, taken from a reader's side. A truncate-and-
 * rewrite implementation fails this — the reader catches the file between the
 * two, with the frontmatter gone — while an atomic replace cannot fail it,
 * because there is no instant at which the target is anything but one complete
 * version or the other. The writer alternates so that every round really writes.
 */
test("a reader never sees a partial file while it is being rewritten", async () => {
  const dir = await agentDir("reader");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  let writing = true;
  const reader = (async () => {
    while (writing) {
      const seen = await readFile(file, "utf8");
      assert.match(
        seen,
        /^---\nname: agent\nmodel: "[^"]*"\ntools: read\n---\n\nBody\.\n$/,
        `a reader saw something that is not a whole file: ${JSON.stringify(seen)}`,
      );
    }
  })();

  let current = "a/b";
  for (let round = 0; round < 50; round += 1) {
    const next = round % 2 === 0 ? "c/1" : "c/2";
    assert.deepEqual(
      await applyDecision({ file, model: modelId(next), base: current, dry: false }, { pacing: FAST }),
      { kind: "written" },
    );
    current = next;
  }
  writing = false;
  await reader;
});

/**
 * An agent file is allowed to be a symlink: `readAgentFiles` follows one on
 * purpose, and a user who keeps their definitions in a dotfiles repository has
 * exactly that. Renaming onto the path the user named would replace their link
 * with a regular file and quietly detach the copy they edit.
 */
test("a symlinked agent file is written through, not replaced by a regular file", async () => {
  const dir = await agentDir("symlink");
  const target = join(dir, "dotfiles.md");
  const link = join(dir, "agent.md");
  await writeFile(target, agentFileText("a/b"), "utf8");
  await symlink(target, link);

  assert.deepEqual(
    await applyDecision({ file: link, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST }),
    { kind: "written" },
  );
  assert.equal((await lstat(link)).isSymbolicLink(), true, "the user's symlink was replaced");
  assert.equal(await modelIn(target), "c/d", "the file the link names was not the one written");
});

/**
 * Exclusion has to name the same file replacement does. A write through a
 * symlink whose target is already locked must be refused: if the lock followed
 * the name the caller used, an alias would be a second way into a file another
 * process is rewriting.
 */
test("a write through a symlink waits behind the target's own lock", async () => {
  const dir = await agentDir("alias");
  const target = join(dir, "dotfiles.md");
  const link = join(dir, "agent.md");
  await writeFile(target, agentFileText("a/b"), "utf8");
  await symlink(target, link);

  const holder = await startHolder(target);
  try {
    const refused = await applyDecision(
      { file: link, model: modelId("c/d"), base: "a/b", dry: false },
      { pacing: { staleMs: 10_000, waitMs: 30, pollMs: 2 } },
    );
    if (refused.kind !== "held") assert.fail(`expected a hold, got ${JSON.stringify(refused)}`);
    assert.equal(
      await readFile(target, "utf8"),
      agentFileText("a/b"),
      "a write through an alias changed the target while its lock was held",
    );
  } finally {
    await holder.release();
  }
});

/**
 * The identity a pass pins has to outlive its own wait. While it is blocked on
 * the lock, the pinned path can be turned into a symlink onto another agent
 * file, and a publication that resolved the name a second time would follow
 * that link — landing this pass's bytes in a file another process is holding.
 * The lock pins one string, and the write must land on exactly that string, so
 * the retargeted link is replaced and the file it points at is left untouched.
 */
test("a retarget must not redirect a publication into another locked file", async () => {
  const dir = await agentDir("retarget");
  const a = join(dir, "a.md");
  const b = join(dir, "b.md");
  // Both files state the model the pass decided against, so only the landing
  // site is at issue; B's note makes any overwrite of its bytes visible.
  await writeFile(a, agentFileText("a/b"), "utf8");
  const bBefore = `${agentFileText("a/b")}\nB-NOTE\n`;
  await writeFile(b, bBefore, "utf8");

  const holderB = await startHolder(b);
  const holderA = await startHolder(a);
  let retargeted = false;
  try {
    const result = await applyDecision(
      { file: a, model: modelId("c/d"), base: "a/b", dry: false },
      {
        pacing: { staleMs: 10_000, waitMs: 2_000, pollMs: 2 },
        // The wait on A's lock is the only window a pass gives up, so the
        // retarget and A's release are driven from the sleep that fills it.
        sleep: async () => {
          if (retargeted) return;
          retargeted = true;
          await unlink(a);
          await symlink(b, a);
          await holderA.release();
        },
      },
    );
    assert.deepEqual(result, { kind: "written" });
    assert.equal(await readFile(b, "utf8"), bBefore, "a pass published into another locked file");
    assert.equal(existsSync(await lockFor(b)), true, "B's lock was lost during the retarget");
  } finally {
    await holderB.release();
  }
});

// A name with no file behind it is not something to lock. Resolving the target
// is what picks the lock path, and a missing target has no path to pick: this is
// a skip, not a hold, and nothing invents `<name>.lock` for a file that may
// never be occupied — locking that would coordinate a name while another process
// coordinates the file it points at.
test("a lock is refused, without running its body, when the target has vanished", async () => {
  const dir = await agentDir("gone");
  const target = join(dir, "dotfiles.md");
  const link = join(dir, "agent.md");
  await writeFile(target, agentFileText("a/b"), "utf8");
  await symlink(target, link);
  await unlink(target);

  let entered = 0;
  const attempt = await withFileLock(link, { pacing: FAST }, async () => {
    entered += 1;
    return "ran";
  });
  assert.deepEqual(attempt, { ok: false, reason: "gone" });
  assert.equal(entered, 0, "a body ran with no file behind the name");
  assert.equal(existsSync(await lockPathFor(link)), false, "a lock was made for a vanished target");
});

// ------------------------------------------------ the lock

test("a second attempt at a held lock waits, and reports the holder when it gives up", async () => {
  const dir = await agentDir("exclusion");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  let entered = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const first = withFileLock(file, { pacing: FAST }, async () => {
    entered += 1;
    await held;
    return "first";
  });
  await waitUntil("the first holder to enter", () => entered === 1);

  const refused = await withFileLock(
    file,
    { pacing: { staleMs: 10_000, waitMs: 30, pollMs: 2 } },
    async () => {
      entered += 1;
      return "second";
    },
  );
  if (refused.ok || refused.reason !== "held") assert.fail("the second attempt did not report a held lock");
  assert.equal(entered, 1, "the second attempt ran its body while the lock was held");
  assert.equal(refused.holder?.pid, process.pid, "the refusal lost the holder's pid");

  release();
  assert.deepEqual(await first, { ok: true, value: "first" });
  assert.equal(existsSync(await lockFor(file)), false, "the lock outlived its holder");
});

test("the lock is released on the way out, including when the body throws", async () => {
  const dir = await agentDir("release");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  await assert.rejects(
    withFileLock(file, { pacing: FAST }, async () => {
      throw new Error("the body failed");
    }),
    /the body failed/,
  );
  assert.equal(existsSync(await lockFor(file)), false, "a throwing body leaked its lock");

  // The point of the release, from the outside: the next writer gets in.
  assert.deepEqual(
    await withFileLock(file, { pacing: FAST }, async () => "next"),
    { ok: true, value: "next" },
  );
});

/**
 * `staleMs` is not evidence of death. A holder whose local live pid the record
 * confirms keeps its file even when the clock is far past that bound: a process
 * stopped, or stuck in a slow `fsync`, must not lose its write to a pass that
 * only measured the time. The second writer holds and names it instead. Only
 * `ABANDONED_LOCK_MS` — the bound no millisecond critical section can reach —
 * is allowed past this.
 */
test("a lock whose holder is alive is not taken over by the staleness bound", async () => {
  const dir = await agentDir("alive");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  let entered = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const first = withFileLock(
    file,
    { pacing: { staleMs: 1_000, waitMs: 1_000, pollMs: 2 }, now: () => 0 },
    async () => {
      entered += 1;
      await held;
      return "first";
    },
  );
  await waitUntil("the live holder to enter", () => entered === 1);

  // A clock far past `staleMs` — but inside the abandoned bound — and a pid that
  // is this very process, alive: `staleMs` alone would take the lock over, and
  // it must not.
  const second = await withFileLock(
    file,
    { pacing: { staleMs: 1_000, waitMs: 30, pollMs: 2 }, now: () => 100_000 },
    async () => {
      entered += 1;
      return "second";
    },
  );
  if (second.ok) assert.fail("a live holder was evicted by age");
  assert.equal(entered, 1, "the second writer entered over a live holder");
  if (second.reason !== "held") assert.fail("the refusal must report a held lock");
  assert.equal(second.holder?.pid, process.pid, "the refusal must name the live holder");

  release();
  assert.deepEqual(await first, { ok: true, value: "first" });
});

/**
 * The other side of the liveness rule: a live holder cannot block the file
 * forever either. A release that failed, or an acquisition that failed after
 * publishing its record, leaves a lock naming a process that is still alive, and
 * age is the only thing left that can free it. The critical section is
 * milliseconds, so a lock ten minutes old is an abandoned release rather than
 * active work.
 */
test("a lock whose live holder is older than the abandoned bound is taken over", async () => {
  const dir = await agentDir("abandoned");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  let entered = 0;
  let releaseFirst!: () => void;
  const firstBody = new Promise<void>((resolve) => (releaseFirst = resolve));
  const first = withFileLock(
    file,
    { pacing: { staleMs: 1_000, waitMs: 1_000, pollMs: 2 }, now: () => 0 },
    async () => {
      entered += 1;
      await firstBody;
      return "first";
    },
  );
  await waitUntil("the live holder to enter", () => entered === 1);

  const second = await withFileLock(
    file,
    { pacing: { staleMs: 1_000, waitMs: 200, pollMs: 2 }, now: () => ABANDONED_LOCK_MS },
    async () => {
      entered += 1;
      return "second";
    },
  );
  assert.ok(second.ok, "a lock past the abandoned bound was never taken over");
  assert.equal(entered, 2, "the second writer never entered the critical section");

  releaseFirst();
  assert.deepEqual(await first, { ok: true, value: "first" });
});

/**
 * A release can be late: the holder's body outlives a takeover, so by the time
 * the release runs the lock is not the file it took. Unlinking it would leave
 * the new holder's write unguarded. The release checks the inode and the record
 * together, because either alone can match a takeover by coincidence — the
 * filesystem can reuse a number, and a recoverer can rewrite a record that
 * happens to carry our pid and clock reading. These two tests drive each defense
 * on its own, as the old combined one did not.
 */
test("a late release does not unlink a lock rewritten in place with another record", async () => {
  const dir = await agentDir("late-record");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const lock = await lockFor(file);

  let inside!: () => void;
  const entered = new Promise<void>((resolve) => (inside = resolve));
  let releaseBody!: () => void;
  const body = new Promise<void>((resolve) => (releaseBody = resolve));
  const first = withFileLock(file, { pacing: FAST }, async () => {
    inside();
    await body;
    return "first";
  });
  await entered;

  // The same inode, a different record: another process rewrote the lock where
  // it stands. Only the record distinguishes it, so the release's record check
  // is the defense under test here.
  const other = { pid: process.pid, host: hostname(), at: 1 };
  await writeFile(lock, JSON.stringify(other), "utf8");

  releaseBody();
  assert.deepEqual(await first, { ok: true, value: "first" });
  assert.equal(existsSync(lock), true, "the late release deleted a lock another record now owns");
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), other);
});

test("a late release does not unlink a different inode that holds our record", async () => {
  const dir = await agentDir("late-inode");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const lock = await lockFor(file);

  // A fixed clock makes the record this pass writes knowable, so the replacement
  // below can carry the exact same one.
  const at = 12_345;
  let inside!: () => void;
  const entered = new Promise<void>((resolve) => (inside = resolve));
  let releaseBody!: () => void;
  const body = new Promise<void>((resolve) => (releaseBody = resolve));
  const first = withFileLock(file, { pacing: FAST, now: () => at }, async () => {
    inside();
    await body;
    return "first";
  });
  await entered;

  // A new inode with exactly the record this pass wrote — what a recoverer that
  // reused the pid and clock reading would produce. The old inode is kept alive
  // under another name so the replacement cannot be handed the same number, and
  // only the inode distinguishes the two, which is the defense under test.
  await rename(lock, `${lock}.moved`);
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), at }), "utf8");

  releaseBody();
  assert.deepEqual(await first, { ok: true, value: "first" });
  assert.equal(existsSync(lock), true, "the late release deleted a lock in a different inode");
});

test("the lock file is not an agent file", async () => {
  const dir = await agentDir("not-an-agent");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const holder = await startHolder(file);
  try {
    assert.deepEqual(
      (await readAgentFiles(dir)).map((found) => found.file),
      [file],
      "pi would see the lock as something in the agent dir",
    );
  } finally {
    await holder.release();
  }
});

/**
 * A lock whose holder cannot be confirmed is bounded by its own mtime, and the
 * record's `at` is only trusted when it is a real timestamp. JSON's `1e400`
 * parses to `Infinity`, and an age comparison against it is false forever, which
 * would wedge the file behind a lock no pass could ever clear.
 */
test("a lock record with an unusable timestamp ages out on the lock's mtime", async () => {
  const dir = await agentDir("record");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const lock = await lockFor(file);
  // The documented record shape, with a live pid this host will not vouch for
  // because the host is not its own: the holder is unconfirmed, so only age can
  // clear the lock. `at` is the `1e400` the parser must reject.
  await writeFile(lock, `{"pid": ${process.pid}, "host": "elsewhere", "at": 1e400}\n`, "utf8");

  const held = await applyDecision(
    { file, model: modelId("c/d"), base: "a/b", dry: false },
    { pacing: { staleMs: 10_000, waitMs: 20, pollMs: 2 } },
  );
  assert.equal(held.kind, "held", `a fresh unconfirmable lock should not be evicted: ${JSON.stringify(held)}`);

  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.deepEqual(
    await applyDecision(
      { file, model: modelId("c/d"), base: "a/b", dry: false },
      { pacing: { staleMs: 10_000, waitMs: 200, pollMs: 2 } },
    ),
    { kind: "written" },
  );
});

// The parser turns away `Infinity`, but a finite timestamp far in the future is
// just as unmeasurable: `now - at` is negative, so the lock would never reach
// `staleMs` however long it sat. The record's `at` is therefore used only when it
// is not in the future, and a future one falls back to the lock's own mtime.
test("a record whose timestamp is in the future ages out on the lock's mtime", async () => {
  const dir = await agentDir("future-record");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const lock = await lockFor(file);
  // A foreign host keeps the holder unconfirmable even though the pid is real,
  // so age is the only thing that can clear this lock.
  const future = Date.now() + 3_600_000;
  await writeFile(lock, `{"pid": ${process.pid}, "host": "elsewhere", "at": ${future}}\n`, "utf8");

  const held = await applyDecision(
    { file, model: modelId("c/d"), base: "a/b", dry: false },
    { pacing: { staleMs: 10_000, waitMs: 20, pollMs: 2 } },
  );
  assert.equal(held.kind, "held", `a fresh future-stamped lock should not be evicted: ${JSON.stringify(held)}`);

  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.deepEqual(
    await applyDecision(
      { file, model: modelId("c/d"), base: "a/b", dry: false },
      { pacing: { staleMs: 10_000, waitMs: 200, pollMs: 2 } },
    ),
    { kind: "written" },
  );
});

// No `host` is read as this host, not as unknown: the field is newer than the
// locks already on disk, and an absent host treated as another machine would age
// a live holder out at `staleMs`. This asserts the compatibility assumption, not
// that the pid is proven to belong here.
test("a record with no host is read as this host, so its live pid is not aged out early", async () => {
  const dir = await agentDir("hostless-record");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const lock = await lockFor(file);
  // A live pid, an age past `staleMs` but well inside the abandoned bound, and
  // no host: this must hold, because a hostless record is this host's.
  await writeFile(lock, `{"pid": ${process.pid}, "at": ${Date.now() - 60_000}}\n`, "utf8");

  const result = await applyDecision(
    { file, model: modelId("c/d"), base: "a/b", dry: false },
    { pacing: { staleMs: 10_000, waitMs: 20, pollMs: 2 } },
  );
  assert.equal(result.kind, "held", `a hostless live record was aged out: ${JSON.stringify(result)}`);
});

// ------------------------------------------------ across processes

test("a write refuses while another process holds the lock, and lands once it lets go", async () => {
  const dir = await agentDir("busy");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const holder = await startHolder(file);
  const refused = await applyDecision(
    { file, model: modelId("c/d"), base: "a/b", dry: false },
    { pacing: { staleMs: 10_000, waitMs: 30, pollMs: 2 } },
  );
  if (refused.kind !== "held") assert.fail(`expected a hold, got ${JSON.stringify(refused)}`);
  assert.match(refused.why, /another pi process holds this file's lock/);
  assert.match(refused.why, new RegExp(`pid ${holder.pid}`), "the reason must name the process holding it");
  assert.equal(await readFile(file, "utf8"), agentFileText("a/b"), "a refused write changed the file");

  const exited = await holder.release();
  assert.equal(exited.signal, null, `the holder was killed: ${exited.stderr}`);

  assert.deepEqual(
    await applyDecision({ file, model: modelId("c/d"), base: "a/b", dry: false }, { pacing: FAST }),
    { kind: "written" },
  );
  assert.equal(await modelIn(file), "c/d");
});

// The recovery half of the crash story, from the outside: an hour of staleness
// means the age rule cannot possibly explain the recovery, so only the dead
// holder's pid can — and the write must not wait out an hour to find that out.
test("a lock left by a killed process is taken over at once", async () => {
  const dir = await agentDir("crash");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const marker = join(dir, "crashed.marker");

  const crashed = spawnFixture({
    kind: "hold-then-die",
    file,
    marker,
    pacing: { staleMs: 30_000, waitMs: 100, pollMs: 2 },
  });
  await waitUntil("the doomed child to take the lock", () => existsSync(marker));
  const killed = await crashed.done;
  assert.equal(killed.signal, "SIGKILL", "the child was supposed to leave its lock behind");
  assert.equal(existsSync(await lockFor(file)), true, "the crash left no lock to recover from");

  const started = Date.now();
  assert.deepEqual(
    await applyDecision(
      { file, model: modelId("c/d"), base: "a/b", dry: false },
      { pacing: { staleMs: 30_000, waitMs: 200, pollMs: 5 } },
    ),
    { kind: "written" },
  );
  assert.ok(Date.now() - started < 10_000, "the write waited on a holder that no longer exists");
  assert.equal(existsSync(await lockFor(file)), false, "the recovered lock was never released");
  assert.match(await readFile(file, "utf8"), /Body\./);
});

/**
 * Identical assignments from several processes at once. The file must end
 * complete and correct, and exactly one process does the writing: the lock is
 * what makes the others see the work already done rather than redo it.
 */
test("children assigning the same model converge on one complete file", async () => {
  const dir = await agentDir("same");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");

  const results = await runTogether<WriteResult>(
    dir,
    Array.from({ length: 5 }, () => ({ kind: "apply", file, model: modelId("c/d"), base: "a/b", pacing: FAST })),
  );

  assert.equal(
    results.filter((result) => result.kind === "written").length,
    1,
    `exactly one process writes, the rest find it done: ${JSON.stringify(results)}`,
  );
  assert.equal(results.filter((result) => result.kind === "unchanged").length, 4, JSON.stringify(results));
  const after = await readFile(file, "utf8");
  assert.equal(await modelIn(file), "c/d");
  assert.match(after, /^tools: read$/m, "the write lost part of the frontmatter");
  assert.match(after, /Body\./);
});

/**
 * Different assignments to one file, which is what two project overrides
 * disagreeing looks like. Every child read the same base, so exactly one can
 * have written: the rest found an assignment that is not theirs and held rather
 * than overwriting it, and the file is left as one complete answer.
 */
test("children assigning different models: one wins, the rest hold, and no answer is mixed in", async () => {
  const dir = await agentDir("different");
  const file = join(dir, "agent.md");
  await writeFile(file, agentFileText("a/b"), "utf8");
  const models = ["c/1", "c/2", "c/3", "c/4"];

  const results = await runTogether<WriteResult>(
    dir,
    models.map((model) => ({ kind: "apply", file, model, base: "a/b", pacing: FAST })),
  );

  const winners = models.filter((_, index) => results[index].kind === "written");
  assert.equal(winners.length, 1, `exactly one assignment can land: ${JSON.stringify(results)}`);
  for (const [index, result] of results.entries()) {
    if (result.kind === "held") {
      assert.match(result.why, /another pi process/);
      assert.match(result.why, new RegExp(`"${models[index].replace("/", "\\/")}"`), "the hold must name the model it wanted");
    } else {
      assert.equal(result.kind, "written", `a child neither wrote nor held: ${JSON.stringify(result)}`);
    }
  }
  assert.equal(await modelIn(file), winners[0]);
  assert.match(await readFile(file, "utf8"), /Body\./, "the surviving answer is a partial file");
});
