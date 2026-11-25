import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { runFixture, spawnFixture, waitUntil } from "./fixtures/agent-write-child.ts";
import { tempDir } from "./helpers/temp-dir.ts";

test("a child that exits before its marker reports its diagnostic", async () => {
  const child = spawnFixture({
    kind: "exit-before-marker",
    exitCode: 23,
    stderr: "intentional fixture failure\n",
  });

  await assert.rejects(
    waitUntil("the child marker", () => false, { child }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /the child exited before writing the child marker/);
      assert.match(error.message, /exit code: 23/);
      assert.match(error.message, /signal: null/);
      assert.match(error.message, /intentional fixture failure/);
      return true;
    },
  );
  assert.equal((await child.done).code, 23);
});

// The child fixture decodes a JSON job, so the model it carries is a raw string
// again. This is the one place the migration plan asks the fixture to validate:
// an id the config seam would never accept is refused before any file is
// touched, rather than handed to `applyDecision` through a cast.
test("a child job whose model cannot be a provider/model id is refused before it writes", async (t) => {
  const dir = await tempDir(t, "child-model");
  const file = join(dir, "planner.md");
  const before = '---\nname: planner\nmodel: "claude-bridge/claude-opus-5-5"\n---\n\nBody.\n';
  await writeFile(file, before, "utf8");

  const result = await runFixture({
    kind: "apply",
    file,
    model: "nomodel",
    base: "claude-bridge/claude-opus-5-5",
  });

  assert.equal(result.kind, "held");
  assert.match(result.why, /provider\/model id/);
  assert.equal(await readFile(file, "utf8"), before, "the file is left exactly as the pass found it");
});
