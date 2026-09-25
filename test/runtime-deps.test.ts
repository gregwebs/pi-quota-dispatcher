import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { findRuntimeDependencyProblems } from "../scripts/check-runtime-deps.js";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "check-runtime-deps.js");

/**
 * The published package installs nothing of its own: pi is a peer the host
 * provides. These are the shapes that would break that, each one a change
 * someone could plausibly make by accident.
 */
function packageJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "pi-quota-dispatcher",
    peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
    peerDependenciesMeta: { "@earendil-works/pi-coding-agent": { optional: true } },
    ...overrides,
  };
}

test("the repository's own package.json has no runtime dependency footprint", async () => {
  const real = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  assert.deepEqual(findRuntimeDependencyProblems(real), []);
});

test("a real dependency is reported", () => {
  const problems = findRuntimeDependencyProblems(packageJson({ dependencies: { zod: "^3" } }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /dependencies\.zod/);
});

test("an optional dependency is reported", () => {
  const problems = findRuntimeDependencyProblems(
    packageJson({ optionalDependencies: { lodash: "*" } }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /optionalDependencies\.lodash/);
});

test("a peer that is not declared optional is reported", () => {
  const problems = findRuntimeDependencyProblems(packageJson({ peerDependenciesMeta: {} }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@earendil-works\/pi-coding-agent/);
});

test("a package with no peer dependency at all is reported", () => {
  const problems = findRuntimeDependencyProblems({
    peerDependencies: undefined,
    peerDependenciesMeta: undefined,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no peer dependency/);
});

test("every problem is reported, not only the first", () => {
  const problems = findRuntimeDependencyProblems({
    dependencies: { zod: "^3" },
    optionalDependencies: { lodash: "*" },
  });
  // One message for the whole runtime-dependency list, plus the missing peer.
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /dependencies\.zod.*optionalDependencies\.lodash/);
  assert.match(problems[1], /no peer dependency/);
});

test("running the script as CI does exits 0 and names what it checked", async () => {
  const { stdout } = await run(process.execPath, [SCRIPT], { cwd: REPO });
  assert.match(stdout, /dependencies: none/);
  assert.match(stdout, /peers optional: @earendil-works\/pi-coding-agent/);
});

/**
 * The exit code is the half of the contract CI actually consumes: a detector
 * that finds a problem but still exits 0 would let a bad package.json ship.
 */
async function runAgainst(manifest: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "pqd-deps-"));
  const path = join(dir, "package.json");
  await writeFile(path, JSON.stringify(manifest), "utf8");
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, path]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("the script exits non-zero and explains why for a real dependency", async () => {
  const result = await runAgainst(packageJson({ dependencies: { zod: "^3" } }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /dependencies\.zod/);
});

test("the script exits non-zero for a peer that is not optional", async () => {
  const result = await runAgainst(packageJson({ peerDependenciesMeta: {} }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /@earendil-works\/pi-coding-agent/);
});

test("the script exits 0 for an intact manifest", async () => {
  const { code, stdout } = await runAgainst(packageJson());
  assert.equal(code, 0);
  assert.match(stdout, /dependencies: none/);
});
