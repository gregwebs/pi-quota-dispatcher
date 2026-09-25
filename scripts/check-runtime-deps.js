/**
 * CI guard for the published package's dependency footprint.
 *
 * This began as a `node -e` string inside `.github/workflows/ci.yml`. A shell
 * string buried in YAML is not reviewable — no syntax highlighting, no history
 * of its own, no way to run it except by running the workflow — so the detector
 * lives here and `test/runtime-deps.test.ts` exercises it directly.
 *
 * It is a static check of `package.json` only. It cannot see a runtime `import`
 * of something that exists only as a dev dependency; that is caught by the test
 * job, which installs the real dependency set, and by the package declaring no
 * `dependencies` at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * Everything that would make the published package install something of its
 * own, or make the host-supplied peer requirement optional by accident.
 *
 * Returns every problem it finds rather than the first, so one CI run says
 * everything that needs fixing. An empty array means the footprint is intact.
 */
export function findRuntimeDependencyProblems(pkg) {
  const problems = [];

  const runtime = ["dependencies", "optionalDependencies"].flatMap((field) =>
    Object.keys(pkg[field] ?? {}).map((dep) => `${field}.${dep}`),
  );
  if (runtime.length) problems.push(`runtime dependencies found: ${runtime.join(", ")}`);

  const peers = Object.keys(pkg.peerDependencies ?? {});
  if (!peers.length) {
    problems.push("no peer dependency declared; the host-provided pi peer is required");
  }
  const required = peers.filter((peer) => pkg.peerDependenciesMeta?.[peer]?.optional !== true);
  if (required.length) {
    problems.push(`peers must be optional (peerDependenciesMeta): ${required.join(", ")}`);
  }

  return problems;
}

/** @returns {number} the process exit code. */
function main(path) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const problems = findRuntimeDependencyProblems(pkg);
  if (problems.length) {
    for (const problem of problems) console.error(`${path}: ${problem}`);
    return 1;
  }
  console.log(
    "dependencies: none (dependencies, optionalDependencies); " +
      `peers optional: ${Object.keys(pkg.peerDependencies ?? {}).join(", ")}`,
  );
  return 0;
}

// Only when executed. Importing this module from a test must not read the
// repository's package.json as a side effect. An optional argument names the
// manifest to check, which is what lets a test point the CLI at a fixture.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv[2] ?? PACKAGE_JSON);
}
