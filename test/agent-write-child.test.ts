import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixture } from "./fixtures/agent-write-child.ts";

// The child fixture decodes a JSON job, so the model it carries is a raw string
// again. This is the one place the migration plan asks the fixture to validate:
// an id the config seam would never accept is refused before any file is
// touched, rather than handed to `applyDecision` through a cast.
test("a child job whose model cannot be a provider/model id is refused before it writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqd-child-model-"));
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
