import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodexHost } from "../../src/codex-refresh.ts";

// One fixture per test: a `bin` holding a `codex` that can be executed, a Codex
// CLI home holding a managed login, and a `HOME` of its own. Nothing here reads
// the developer's own `~/.codex`, and nothing runs a real Codex CLI.

/**
 * Every directory this helper made, so a test file can remove them all.
 *
 * Registered rather than returned per fixture because a fixture is made inside a
 * test body and the removal belongs to the file's `after` hook, where the trap's
 * zero-invocation assertion can run first.
 */
const created: string[] = [];

/** Removes every fixture and trap directory this module created. */
export async function removeCodexFixtures(): Promise<void> {
  const roots = created.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

/**
 * The installed CLI's stand-in, run through an absolute `process.execPath`.
 *
 * A `.ts` file, because the test runner already runs the sources that way: the
 * fixture needs no build step to be driven by `bin/codex`.
 */
const CLI_STAND_IN = fileURLToPath(new URL("../fixtures/codex-cli.ts", import.meta.url));

/** A JWT-shaped string with the payload this test wants it to state. */
export function jwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${segment({ alg: "none", typ: "JWT" })}.${segment(payload)}.${segment("signature")}`;
}

/** The managed ChatGPT login the Codex CLI writes, as text. */
export function managedLogin(
  input: { expiresAt: number; accountId?: string; access?: string } = { expiresAt: Date.now() - 60_000 },
): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: input.access ?? jwt({ exp: Math.floor(input.expiresAt / 1_000) }),
      account_id: input.accountId ?? "acct-fixture",
      refresh_token: "refresh-fixture",
    },
    last_refresh: "2026-11-03T00:00:00Z",
  });
}

export interface CodexFixture {
  /** The root every other path is under, and the string a redaction check forbids. */
  readonly root: string;
  /** Holds the executable `codex`. */
  readonly bin: string;
  /** Where the stand-in reads `mode.json` and writes `invocations.jsonl`. */
  readonly control: string;
  /** `CODEX_HOME`: the CLI's own home, holding `auth.json`. */
  readonly codexHome: string;
  /** `HOME`, empty unless a test fills it. */
  readonly home: string;
  readonly authPath: string;
  /** pi's own `auth.json`, which no fixture creates: absence is the ordinary case. */
  readonly piAuthPath: string;
  readonly host: CodexHost;
}

/**
 * A machine that could run the refresh, in a temp dir.
 *
 * The `codex` is written with an absolute interpreter and no `/usr/bin/env`, so
 * a `PATH` holding nothing but `bin` is enough to run it — which is what makes
 * "the child PATH keeps only absolute entries" testable — and so no shell
 * process outlives the run.
 */
export async function codexFixture(): Promise<CodexFixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-codex-fx-"));
  created.push(root);
  const bin = join(root, "bin");
  const control = join(root, "control");
  const codexHome = join(root, "codex-home");
  const home = join(root, "home");
  for (const dir of [bin, control, codexHome, home]) await mkdir(dir);
  const executable = join(bin, "codex");
  // The control directory is baked into the wrapper rather than inherited, so the
  // environment the run builds is exactly what a real run would have.
  await writeFile(
    executable,
    `#!/bin/sh\nexport QD_CODEX_FIXTURE='${control}'\nexec "${process.execPath}" "${CLI_STAND_IN}" "$@"\n`,
    "utf8",
  );
  await chmod(executable, 0o755);
  await assertExecutable(executable);

  const authPath = join(codexHome, "auth.json");
  await writeFile(authPath, managedLogin(), "utf8");
  return {
    root,
    bin,
    control,
    codexHome,
    home,
    authPath,
    piAuthPath: join(root, "pi-auth.json"),
    host: { env: { PATH: bin, HOME: home, CODEX_HOME: codexHome }, platform: "darwin" },
  };
}

export interface CodexTrap {
  /** Prepended to `PATH` so a stray spawn records itself instead of running. */
  readonly dir: string;
  /** How many times the trap ran. Zero in every correct run. */
  invocations(): Promise<number>;
}

/**
 * A `codex` that does nothing but record that it was started.
 *
 * The tripwire for the paths that must spawn nothing: a test that tries to run a
 * refresh it should have refused leaves an invocation behind rather than a
 * credential exchange against the developer's own account.
 */
export async function installCodexTrap(): Promise<CodexTrap> {
  const dir = await mkdtemp(join(tmpdir(), "pqd-codex-trap-"));
  created.push(dir);
  const log = join(dir, "invocations.log");
  const trap = join(dir, "codex");
  await writeFile(trap, `#!/bin/sh\necho "$@" >> '${log}'\nexit 99\n`, "utf8");
  await chmod(trap, 0o755);
  await assertExecutable(trap);
  return {
    dir,
    invocations: async () => {
      try {
        return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0).length;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Refuses to let a fixture-based test run if the fixture cannot be executed.
 *
 * `execvp` skips a file whose executable bit is missing and runs the next
 * `codex` on `PATH`, so a fixture on a `noexec` temp mount would silently become
 * whatever this developer has installed. Failing before any run is the safe
 * outcome; skipping is not.
 */
async function assertExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(
      `the codex fixture at ${path} is not executable — ${dirname(path)} is probably a ` +
        "noexec mount. Refusing to run: the next codex on PATH may be a real one.",
    );
  }
}

/**
 * Fails when a line carries anything the outcome lines must never carry.
 *
 * The fixtures embed a sentinel in the places vendor text would arrive from
 * (stdout, stderr, a token payload), so a leak is caught by name rather than by
 * a reader noticing. The fixture root stands for every path; `eyJ` for a JWT
 * segment; `sk-` and `Bearer` for an API key and a header.
 */
export function assertRedacted(lines: readonly string[], fixtureRoot: string): void {
  for (const line of lines) {
    for (const forbidden of ["SENTINEL", "Bearer", "eyJ", "sk-", fixtureRoot]) {
      assert.ok(
        !line.includes(forbidden),
        `an outcome line must not carry ${JSON.stringify(forbidden)}: ${line}`,
      );
    }
    assert.ok(!line.includes("\n"), `an outcome line is one line: ${JSON.stringify(line)}`);
  }
}
