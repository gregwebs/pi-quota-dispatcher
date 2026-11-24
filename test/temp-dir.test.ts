import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { removeTempRoots, tempDir, tempRoot } from "./helpers/temp-dir.ts";

// What this file guards: that a test run leaves no directory behind (issue #101).
// The makers are checked by running them and looking, because that is the
// behaviour that matters. Two mistakes the behaviour cannot see are checked by
// reading the suite instead: a file that makes a temp directory by hand, and a
// file that fills the registry without draining it.

const SELF = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(SELF);
const HELPER = "helpers/temp-dir.ts";

// Spelled in two pieces so this file does not match its own scan.
const RAW_MAKER = ["mkd", "temp"].join("");
const REGISTRY = "temp" + "Root";
const DRAINER = "removeTempRoots";

test("a directory tempDir makes exists during its test and is gone after it", async (t) => {
  let made = "";
  await t.test("a test that owns one", async (inner) => {
    made = await tempDir(inner, "guard");
    assert.ok(made.startsWith(join(tmpdir(), "pqd-guard-")), `a recognised name: ${made}`);
    assert.ok(existsSync(made), "the directory is there for the test that asked for it");
  });
  assert.equal(existsSync(made), false, "and is removed once that test finishes");
});

test("a directory tempRoot makes survives its test and goes when the file drains the registry", async () => {
  const made = await tempRoot("guard-root");
  assert.ok(made.startsWith(join(tmpdir(), "pqd-guard-root-")), `a recognised name: ${made}`);
  assert.ok(existsSync(made), "a module-level fixture is still there during a test");

  await removeTempRoots();
  assert.equal(existsSync(made), false, "and is removed by the file's one call");
});

test("only the helper makes a temp directory, and every file that fills the registry drains it", async () => {
  const sources = await suiteSources(TEST_DIR);
  // Two self-references that prove the scan reached this directory and the
  // subdirectory below it: a scan that found nothing has no files to check, and
  // would pass everything else here.
  assert.ok(sources.includes(basename(SELF)), `the scan missed ${basename(SELF)} in ${TEST_DIR}`);
  assert.ok(sources.includes(HELPER), `the scan missed ${HELPER} under ${TEST_DIR}`);

  const handmade: string[] = [];
  const forgotDrain: string[] = [];
  for (const source of sources) {
    if (source === HELPER) continue;
    const text = await readFile(join(TEST_DIR, source), "utf8");
    if (text.includes(RAW_MAKER)) handmade.push(source);
    // A fixture helper fills the registry on a caller's behalf, and the file that
    // owns the run is the one that drains it, so the obligation stops at helpers/.
    if (dirname(source) !== "helpers" && text.includes(REGISTRY) && !text.includes(DRAINER)) {
      forgotDrain.push(source);
    }
  }

  assert.deepEqual(
    handmade,
    [],
    `these make a temp directory no hook will remove — use tempDir/tempRoot from test/${HELPER}: ${handmade.join(", ")}`,
  );
  assert.deepEqual(
    forgotDrain,
    [],
    `these add to the temp-dir registry and name no drain, so their directories live to the end of the ` +
      `process — add after(${DRAINER}) beside the file's other hooks: ${forgotDrain.join(", ")}`,
  );
});

/** Every file under `dir`, as paths relative to it. No name is skipped: a hidden fixture is one a shell glob would not have listed. */
async function suiteSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}
