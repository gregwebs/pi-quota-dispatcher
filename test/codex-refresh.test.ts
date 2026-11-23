import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type {
  CodexHost,
  CodexReadiness,
  CodexRefreshResult,
  CodexRefreshTarget,
  CodexRefusalId,
} from "../src/codex-refresh.ts";
import { spawnProcess, type ProcessRunner } from "../src/exec.ts";
import { CODEX_TOKEN_EXPIRED } from "../src/credentials.ts";
import type { DispatcherConfig } from "../src/config.ts";
import type { Dispatcher } from "../src/index.ts";
import { agentTable } from "./helpers/identifiers.ts";
import { failureOf, fakeReads, readingOf } from "./helpers/rails.ts";
import {
  assertRedacted,
  codexFixture,
  installCodexTrap,
  jwt,
  managedLogin,
  removeCodexFixtures,
  type CodexFixture,
} from "./helpers/codex-fixture.ts";

// The admission list and the argv this command runs, pinned as values. Nothing in
// this file may spawn: the trap below is the only `codex` on `PATH` outside a
// fixture, and a correct run never runs one.

const trap = await installCodexTrap();
const EMPTY_HOME = await mkdtemp(join(tmpdir(), "pqd-codex-home-"));
const EMPTY_CODEX_HOME = await mkdtemp(join(tmpdir(), "pqd-codex-ch-"));
process.env.PATH = trap.dir;
process.env.HOME = EMPTY_HOME;
process.env.CODEX_HOME = EMPTY_CODEX_HOME;

// One hook, in this order: the trap is read before anything is removed, so a
// spawn that fell through to it is a failure rather than an empty log, and every
// fixture and temp dir this file made is then cleaned up.
after(async () => {
  assert.equal(await trap.invocations(), 0, "no test may start a real codex");
  await removeCodexFixtures();
  await Promise.all(
    [EMPTY_HOME, EMPTY_CODEX_HOME].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Loaded after the environment is redirected: `refresh.ts` and `config.ts` build
// load-time defaults out of the home directory, and a production default must
// only ever point into a directory this suite owns.
const { createDispatcher } = await import("../src/index.ts");
const { DEFAULT_CONFIG } = await import("../src/config.ts");
const {
  CODEX_DUE_WINDOW_MS,
  codexExpiredHint,
  codexRefreshArgs,
  codexRefreshEnv,
  codexRefreshReadiness,
  createCodexRefresh,
  describeCodexRefresh,
  refusalText,
  resolveCodexExecutable,
} = await import("../src/codex-refresh.ts");

/** A fixed instant, so the due check is a comparison this file states. */
const NOW = Date.now();

const isRoot = (): boolean => process.getuid?.() === 0;

function targetOf(fx: CodexFixture, over: Partial<CodexRefreshTarget> = {}): CodexRefreshTarget {
  return { credsPath: fx.authPath, piAuthPath: fx.piAuthPath, host: fx.host, ...over };
}

function readinessOf(fx: CodexFixture, over: Partial<CodexRefreshTarget> = {}): Promise<CodexReadiness> {
  return codexRefreshReadiness(targetOf(fx, over), NOW);
}

/**
 * A host with the fixture's platform and a different environment.
 *
 * The platform is stated rather than inherited so a `win32` reading is explicit
 * where one is wanted, and every other test reads as "some POSIX machine".
 */
function hostWith(env: NodeJS.ProcessEnv): CodexHost {
  return { env, platform: "darwin" };
}

async function expectRefusal(readiness: Promise<CodexReadiness>, refusal: CodexRefusalId): Promise<void> {
  assert.deepEqual(await readiness, { kind: "refused", refusal });
}

// ---------------------------------------------------------------- the argv and the environment

test("the argv is the measured diverted exec, with the listener's URL as a TOML string", () => {
  assert.deepEqual(codexRefreshArgs("http://127.0.0.1:34567"), [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-c",
    'chatgpt_base_url="http://127.0.0.1:34567"',
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="read-only"',
    "hi",
  ]);
});

test("the child environment drops every OPENAI_ and CODEX_ variable but CODEX_HOME, and RUST_LOG", () => {
  const out = codexRefreshEnv({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/u",
    CODEX_HOME: "/home/u/.codex",
    OPENAI_API_KEY: "sk-should-not-survive",
    OPENAI_BASE_URL: "https://example.invalid",
    CODEX_API_KEY: "should-not-survive",
    CODEX_SANDBOX_MODE: "workspace-write",
    RUST_LOG: "debug",
    TMPDIR: "/tmp/here",
    LANG: "en_GB.UTF-8",
  });

  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_SANDBOX_MODE", "RUST_LOG"]) {
    assert.ok(!(key in out), `${key} must not reach the child`);
  }
  // Everything a child needs to be an ordinary CLI run is inherited, and the one
  // `CODEX_` variable that says *where* its credential lives is kept as it was.
  assert.equal(out.CODEX_HOME, "/home/u/.codex");
  assert.equal(out.HOME, "/home/u");
  assert.equal(out.TMPDIR, "/tmp/here");
  assert.equal(out.LANG, "en_GB.UTF-8");
  assert.equal(out.PATH, "/usr/local/bin:/usr/bin");
});

test("the child PATH keeps only absolute entries, in order", () => {
  const out = codexRefreshEnv({ PATH: ":/usr/bin:relative/bin:/bin/:/:" });
  // The empty and relative entries would mean "look where the child happens to
  // be", which is not a directory this process can vouch for.
  assert.equal(out.PATH, "/usr/bin:/bin/:/");
});

test("NO_PROXY and no_proxy both gain 127.0.0.1 and keep what was there", () => {
  const absent = codexRefreshEnv({ PATH: "/usr/bin" });
  assert.equal(absent.NO_PROXY, "127.0.0.1");
  assert.equal(absent.no_proxy, "127.0.0.1");

  const upper = codexRefreshEnv({ PATH: "/usr/bin", NO_PROXY: "example.com" });
  assert.equal(upper.NO_PROXY, "example.com,127.0.0.1");
  assert.equal(upper.no_proxy, "example.com,127.0.0.1");

  // The lowercase spelling is the fallback, so a machine that sets only that one
  // still gets its list carried over rather than replaced.
  const lower = codexRefreshEnv({ PATH: "/usr/bin", no_proxy: "example.com" });
  assert.equal(lower.NO_PROXY, "example.com,127.0.0.1");
  assert.equal(lower.no_proxy, "example.com,127.0.0.1");

  const present = codexRefreshEnv({ PATH: "/usr/bin", NO_PROXY: "127.0.0.1,example.com" });
  assert.equal(present.NO_PROXY, "127.0.0.1,example.com");

  // Two different lists are two different lists: the fallback is for a spelling
  // that says nothing, not for one that says something else.
  const both = codexRefreshEnv({ PATH: "/usr/bin", NO_PROXY: "a.corp", no_proxy: "b.corp" });
  assert.equal(both.NO_PROXY, "a.corp,127.0.0.1");
  assert.equal(both.no_proxy, "b.corp,127.0.0.1");

  // An empty value is "unset here", so the other spelling still reaches both.
  const emptyUpper = codexRefreshEnv({ PATH: "/usr/bin", NO_PROXY: "", no_proxy: "b.corp" });
  assert.equal(emptyUpper.NO_PROXY, "b.corp,127.0.0.1");
  assert.equal(emptyUpper.no_proxy, "b.corp,127.0.0.1");
});

// ---------------------------------------------------------------- the eight refusals

test("readiness refuses windows", async () => {
  const fx = await codexFixture();
  await expectRefusal(readinessOf(fx, { host: { ...fx.host, platform: "win32" } }), "windows");
});

test("readiness refuses bad-home", async () => {
  const fx = await codexFixture();
  for (const env of [
    { ...fx.host.env, CODEX_HOME: "" },
    { ...fx.host.env, CODEX_HOME: "codex-home" },
    { ...fx.host.env, CODEX_HOME: undefined, HOME: "" },
    { ...fx.host.env, CODEX_HOME: undefined, HOME: "home" },
    { ...fx.host.env, CODEX_HOME: undefined, HOME: undefined },
  ]) {
    await expectRefusal(readinessOf(fx, { host: hostWith(env) }), "bad-home");
  }
});

test("readiness refuses pi-auth", async () => {
  // The same path: the credential file *is* pi's.
  const same = await codexFixture();
  await writeFile(same.piAuthPath, managedLogin(), "utf8");
  await expectRefusal(readinessOf(same, { credsPath: same.piAuthPath }), "pi-auth");

  // A second name for the same file: `dev` and `ino` say so even though the
  // paths look unrelated.
  const hardLinked = await codexFixture();
  await link(hardLinked.authPath, hardLinked.piAuthPath);
  await expectRefusal(readinessOf(hardLinked), "pi-auth");

  // pi's path exists but cannot be looked up for a reason other than absence, so
  // "could not tell" has to refuse rather than assume it is a different file.
  const unchecked = await codexFixture();
  await expectRefusal(readinessOf(unchecked, { piAuthPath: join(unchecked.authPath, "auth.json") }), "pi-auth");
});

test("readiness refuses not-cli-file", async () => {
  // The same login, published at another path.
  const published = await codexFixture();
  const copy = join(published.root, "published-auth.json");
  await writeFile(copy, managedLogin(), "utf8");
  await expectRefusal(readinessOf(published, { credsPath: copy }), "not-cli-file");

  // Nothing the CLI would write.
  const missing = await codexFixture();
  await rm(missing.authPath);
  await expectRefusal(readinessOf(missing), "not-cli-file");

  // A home spelled with a symlink and a `..`: the OS resolves `link` first and
  // lands in `alt/home`, while a lexical collapse would name `home`. The real
  // file is admitted and the decoy at the collapsed path is refused, which is
  // the difference native `realpath` makes.
  const tricky = await codexFixture();
  await mkdir(join(tricky.root, "alt", "sub"), { recursive: true });
  await mkdir(join(tricky.root, "alt", "home"));
  const realHome = join(tricky.root, "alt", "home");
  await writeFile(join(realHome, "auth.json"), managedLogin(), "utf8");
  await symlink(join(tricky.root, "alt", "sub"), join(tricky.root, "link"));
  const rawHome = `${tricky.root}/link/../home`;
  await writeFile(join(tricky.root, "home", "auth.json"), managedLogin(), "utf8");
  const host = hostWith({ ...tricky.host.env, CODEX_HOME: rawHome });

  const ready = await readinessOf(tricky, { credsPath: join(realHome, "auth.json"), host });
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  await expectRefusal(
    readinessOf(tricky, { credsPath: join(tricky.root, "home", "auth.json"), host }),
    "not-cli-file",
  );
});

test("readiness refuses dotenv", async () => {
  // Any entry type: the CLI reads the file, and a directory or a dangling
  // symlink named `.env` is still a name that could hold one tomorrow.
  for (const prepare of [
    async (path: string) => writeFile(path, "CODEX_HOME=/elsewhere\n", "utf8"),
    async (path: string) => mkdir(path),
    async (path: string) => symlink(join(tmpdir(), "pqd-no-such-env"), path),
  ]) {
    const fx = await codexFixture();
    await prepare(join(fx.codexHome, ".env"));
    await expectRefusal(readinessOf(fx), "dotenv");
  }
});

test("readiness refuses config-store", async () => {
  const cases = [
    'cli_auth_credentials_store = "keyring"\n',
    '"cli_auth_credentials_store" = "keyring"\n',
    "[profiles.work]\ncli_auth_credentials_store = 'keyring'\n",
    'cli_auth_credentials_store = "keyring"', // no trailing newline
    'some\\.key = "file"\n',
  ];
  for (const text of cases) {
    const fx = await codexFixture();
    await writeFile(join(fx.codexHome, "config.toml"), text, "utf8");
    await expectRefusal(readinessOf(fx), "config-store");
  }

  // A `config.toml` that is not a regular file cannot be read as one.
  const notAFile = await codexFixture();
  await mkdir(join(notAFile.codexHome, "config.toml"));
  await expectRefusal(readinessOf(notAFile), "config-store");

  // A file bigger than the bound is refused before it is read: a config that
  // size is not one this command can vouch for, whatever it says.
  const oversized = await codexFixture();
  await writeFile(
    join(oversized.codexHome, "config.toml"),
    `# ${"x".repeat(1_048_576)}\n`,
    "utf8",
  );
  await expectRefusal(readinessOf(oversized), "config-store");
});

test(
  "readiness refuses a config.toml it cannot read",
  { skip: isRoot() ? "permissions do not stop root" : false },
  async () => {
    const fx = await codexFixture();
    const config = join(fx.codexHome, "config.toml");
    await writeFile(config, 'cli_auth_credentials_store = "file"\n', "utf8");
    await chmod(config, 0o000);
    await expectRefusal(readinessOf(fx), "config-store");
  },
);

test("readiness refuses not-managed-login", async () => {
  const documents = [
    JSON.stringify({ "openai-codex": { access: "a", accountId: "b" } }),
    JSON.stringify({ OPENAI_API_KEY: null }),
    JSON.stringify({ tokens: { access_token: "", account_id: "b", refresh_token: "c" } }),
    JSON.stringify({ tokens: { access_token: "a", account_id: "", refresh_token: "c" } }),
    JSON.stringify({ tokens: { access_token: "a", account_id: "b", refresh_token: "" } }),
    JSON.stringify({ tokens: { access_token: "a", account_id: "b" } }),
    JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "a", account_id: "b", refresh_token: "c" } }),
    JSON.stringify({ OPENAI_API_KEY: "sk-live", tokens: { access_token: "a", account_id: "b", refresh_token: "c" } }),
    JSON.stringify({ personal_access_token: "p", tokens: { access_token: "a", account_id: "b", refresh_token: "c" } }),
    JSON.stringify({ tokens: ["not an object"] }),
    "not json at all",
  ];
  for (const text of documents) {
    const fx = await codexFixture();
    await writeFile(fx.authPath, text, "utf8");
    await expectRefusal(readinessOf(fx), "not-managed-login");
  }
});

test("readiness refuses no-codex", async () => {
  const empty = await codexFixture();
  await expectRefusal(readinessOf(empty, { host: hostWith({ ...empty.host.env, PATH: "" }) }), "no-codex");
  // A relative entry names a different file for the child than for this process,
  // so it is skipped rather than resolved.
  await expectRefusal(
    readinessOf(empty, { host: hostWith({ ...empty.host.env, PATH: "bin:.:relative/bin" }) }),
    "no-codex",
  );

  const notExecutable = await codexFixture();
  await chmod(join(notExecutable.bin, "codex"), 0o644);
  await expectRefusal(readinessOf(notExecutable), "no-codex");
});

// ---------------------------------------------------------------- readiness edges

test("readiness admits a symlink to the CLI's auth.json and a file-store config.toml", async () => {
  const fx = await codexFixture();
  const alias = join(fx.root, "codex-auth-link.json");
  await symlink(fx.authPath, alias);
  await writeFile(
    join(fx.codexHome, "config.toml"),
    [
      "# cli_auth_credentials_store = \"keyring\"",
      'model = "gpt-6"',
      "cli_auth_credentials_store = 'file'",
      'cli_auth_credentials_store = "file" # the default, stated',
      "",
    ].join("\n"),
    "utf8",
  );

  const ready = await readinessOf(fx, { credsPath: alias });
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  if (ready.kind !== "ready") return;
  assert.equal(ready.codex, join(fx.bin, "codex"));
  assert.equal(ready.login.destination, await realpath(fx.authPath));
  assert.equal(ready.login.rawHome, fx.codexHome);
  assert.equal(ready.login.accountId, "acct-fixture");
  // The token never leaves the digest.
  assert.match(ready.login.accessDigest, /^[0-9a-f]{64}$/);
});

test("readiness reports the first failing check in table order", async () => {
  const fx = await codexFixture();
  await writeFile(join(fx.codexHome, ".env"), "", "utf8");
  await writeFile(join(fx.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n', "utf8");
  await writeFile(fx.authPath, JSON.stringify({ "openai-codex": { access: "a", accountId: "b" } }), "utf8");

  await expectRefusal(readinessOf(fx, { host: { ...fx.host, platform: "win32" } }), "windows");
  await expectRefusal(
    readinessOf(fx, { host: hostWith({ ...fx.host.env, CODEX_HOME: "relative" }) }),
    "bad-home",
  );
  await expectRefusal(readinessOf(fx), "dotenv");
  await rm(join(fx.codexHome, ".env"));
  await expectRefusal(readinessOf(fx), "config-store");
  await rm(join(fx.codexHome, "config.toml"));
  await expectRefusal(readinessOf(fx), "not-managed-login");
});

test("a token inside the five-minute window is due; outside it is not-due", async () => {
  const fx = await codexFixture();
  const inside = NOW + CODEX_DUE_WINDOW_MS - 1_000;
  await writeFile(fx.authPath, managedLogin({ expiresAt: inside }), "utf8");
  assert.equal((await readinessOf(fx)).kind, "ready");

  const outside = NOW + CODEX_DUE_WINDOW_MS + 60_000;
  await writeFile(fx.authPath, managedLogin({ expiresAt: outside }), "utf8");
  assert.deepEqual(await readinessOf(fx), {
    kind: "not-due",
    expiresAt: Math.floor(outside / 1_000) * 1_000,
  });
});

test("readiness never rejects on unreadable paths or NUL bytes", async () => {
  const fx = await codexFixture();

  // A path Node refuses to look up at all.
  const nul = join(fx.root, "nul\0path.json");
  await expectRefusal(readinessOf(fx, { credsPath: nul }), "not-cli-file");
  await expectRefusal(readinessOf(fx, { piAuthPath: nul }), "pi-auth");
  // A home that is not a path at all is refused before any lookup is attempted.
  await expectRefusal(
    readinessOf(fx, { host: hostWith({ ...fx.host.env, CODEX_HOME: "nul\0home" }) }),
    "bad-home",
  );
});

test(
  "readiness refuses a credential file it cannot read",
  { skip: isRoot() ? "permissions do not stop root" : false },
  async () => {
    const fx = await codexFixture();
    await chmod(fx.authPath, 0o000);
    await expectRefusal(readinessOf(fx), "not-managed-login");
  },
);

// ---------------------------------------------------------------- the executable

test("resolveCodexExecutable takes the first executable absolute entry, as found", async () => {
  const fx = await codexFixture();
  assert.equal(await resolveCodexExecutable(fx.host.env), join(fx.bin, "codex"));
  assert.equal(await resolveCodexExecutable({ PATH: `relative:${fx.bin}` }), join(fx.bin, "codex"));
  assert.equal(await resolveCodexExecutable({}), undefined);
});

// The hint is part of this module and is rendered at print time; these two
// assertions hold it to the readiness answer it is given.
test("an expired rail's hint names the command when readiness says ready", async () => {
  const fx = await codexFixture();
  const ready = await readinessOf(fx);
  assert.equal(ready.kind, "ready");
  assert.equal(
    codexExpiredHint(ready),
    "run /quota-dispatch refresh-codex to have the Codex CLI refresh it",
  );
  assert.equal(
    codexExpiredHint({ kind: "not-due", expiresAt: Date.UTC(2026, 10, 21, 17, 13) }),
    "the file now holds a token valid until 2026-11-21T17:13:00.000Z; /quota-dispatch refresh reads it again",
  );
  assert.equal(
    codexExpiredHint({ kind: "refused", refusal: "no-codex" }),
    "not refreshable from here: no executable codex on PATH (only absolute PATH entries are searched)",
  );
});

test("every refusal sentence is fixed text with no path or account in it", async () => {
  const fx = await codexFixture();
  const results: CodexReadiness[] = [
    { kind: "refused", refusal: "windows" },
    { kind: "refused", refusal: "bad-home" },
    { kind: "refused", refusal: "pi-auth" },
    { kind: "refused", refusal: "not-cli-file" },
    { kind: "refused", refusal: "dotenv" },
    { kind: "refused", refusal: "config-store" },
    { kind: "refused", refusal: "not-managed-login" },
    { kind: "refused", refusal: "no-codex" },
  ];
  for (const readiness of results) {
    const hint = codexExpiredHint(readiness);
    assert.ok(hint.startsWith("not refreshable from here: "), hint);
    assert.ok(!hint.includes("refresh-codex"), hint);
    assertRedacted([hint], fx.root);
  }
});

// ---------------------------------------------------------------- the run

/**
 * The mode the stand-in CLI runs in.
 *
 * Written rather than exported from the helper, because the mode is the one thing
 * each test chooses and the helper's job is the machine around it.
 */
async function setMode(fx: CodexFixture, control: Record<string, unknown>): Promise<void> {
  await writeFile(join(fx.control, "mode.json"), JSON.stringify(control), "utf8");
}

/** What the stand-in CLI recorded about each time it ran. */
interface Invocation {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly envKeys: string[];
  readonly stdinIsTTY: boolean;
  readonly cwdEntries: string[];
}

async function invocations(fx: CodexFixture): Promise<Invocation[]> {
  try {
    const text = await readFile(join(fx.control, "invocations.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Invocation);
  } catch {
    return [];
  }
}

/** The lines and level a result would be notified with, for the table's assertions. */
function said(result: CodexRefreshResult): { level: "info" | "warning"; lines: string[] } {
  return describeCodexRefresh(result);
}

/** Fails with the result in the message when it is not the `finished` case. */
function finished(result: CodexRefreshResult): Extract<CodexRefreshResult, { kind: "finished" }> {
  assert.equal(result.kind, "finished", JSON.stringify(result));
  if (result.kind !== "finished") throw new Error("unreachable");
  return result;
}

test("a refresh run reports the new expiry for the same account", async () => {
  const fx = await codexFixture();
  await setMode(fx, { mode: "refresh" });
  const target = targetOf(fx, {
    host: hostWith({ ...fx.host.env, RUST_LOG: "debug", OPENAI_API_KEY: "sk-nope", no_proxy: "example.com" }),
  });
  let launched = 0;

  const result = await createCodexRefresh()(target, {
    onLaunch: () => {
      launched += 1;
    },
  });

  const done = finished(result);
  assert.equal(done.after.kind, "refreshed");
  if (done.after.kind === "refreshed") assert.ok(done.after.expiresAt > Date.now());
  assert.equal(done.arrival, "arrived");
  assert.equal(done.exitedZeroUndiverted, false);
  assert.equal(launched, 1, "the launch notice is sent once, before the spawn");

  const [call, ...rest] = await invocations(fx);
  assert.ok(call, "the run must have started the CLI once");
  assert.deepEqual(rest, [], "one run, one invocation");
  // The argv is the measured diverted exec, and the URL is this extension's own
  // listener rather than anything a caller could state.
  assert.deepEqual(call.argv, codexRefreshArgs(listenerUrlOf(call.argv, fx)));
  // A private directory of its own, empty, and gone again afterwards.
  assert.deepEqual(call.cwdEntries, []);
  assert.ok(
    call.cwd.startsWith(await realpath(tmpdir())),
    `the cwd must be the temp dir this command made: ${call.cwd}`,
  );
  assert.equal(await stat(call.cwd).then(() => true, () => false), false, "the workdir is removed");

  // The environment the child got: the selection surface gone, CODE_HOME and the
  // no-proxy list kept, and no terminal to read a prompt from.
  assert.equal(call.env.CODEX_HOME, fx.codexHome);
  assert.ok(!call.envKeys.includes("RUST_LOG"), "RUST_LOG must not reach the child");
  assert.ok(!call.envKeys.includes("OPENAI_API_KEY"), "an API key must not reach the child");
  assert.ok(call.env.NO_PROXY?.includes("127.0.0.1"), String(call.env.NO_PROXY));
  assert.equal(call.env.no_proxy, "example.com,127.0.0.1");
  assert.equal(call.stdinIsTTY, false);

  const lines = said(result);
  assert.equal(lines.level, "info");
  assert.equal(lines.lines.length, 2);
  assert.match(
    lines.lines[0],
    /^quota-dispatcher: after the run the credential file holds a new token for the same account \(valid until \d{4}-.*Z\)\.$/,
  );
  assert.equal(lines.lines[1], "Run /quota-dispatch refresh to read the codex rail again.");
});

/**
 * The listener URL the child was handed, taken back out of its argv so the whole
 * argv can be compared against the builder's own answer.
 */
function listenerUrlOf(argv: readonly string[], fx: CodexFixture): string {
  const setting = argv.find((arg) => arg.startsWith("chatgpt_base_url="));
  assert.ok(setting, `the argv must carry the base URL: ${argv.join(" ")}`);
  const url = setting.slice("chatgpt_base_url=".length).replace(/^"|"$/g, "");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, `${fx.root} is not the listener's address`);
  return url;
}

test("refusals and not-due spawn nothing and send no launch notice", async () => {
  const fx = await codexFixture();
  await setMode(fx, { mode: "refresh" });
  const refresh = createCodexRefresh();
  let launched = 0;
  const onLaunch = () => {
    launched += 1;
  };

  await writeFile(fx.piAuthPath, managedLogin(), "utf8");
  const refused = await refresh(
    { credsPath: fx.piAuthPath, piAuthPath: fx.piAuthPath, host: fx.host },
    { onLaunch },
  );
  assert.deepEqual(refused, { kind: "refused", refusal: "pi-auth" });
  assert.deepEqual(said(refused).lines, [
    "quota-dispatcher: refresh-codex ran nothing: codexCredsPath is pi's own auth.json, which the Codex CLI does not write.",
  ]);
  assert.equal(said(refused).level, "warning");

  await writeFile(fx.authPath, managedLogin({ expiresAt: Date.now() + 3_600_000 }), "utf8");
  const notDue = await refresh(targetOf(fx), { onLaunch });
  assert.equal(notDue.kind, "not-due");
  assert.equal(said(notDue).level, "info");
  assert.match(
    said(notDue).lines[0],
    /^quota-dispatcher: refresh-codex ran nothing: the codex token is valid until .+, outside this command's 5-minute refresh window\.$/,
  );

  assert.equal(launched, 0, "nothing was launched, so nothing may be announced");
  assert.deepEqual(await invocations(fx), [], "a refused run must spawn nothing");
});

test("no new token reports listener arrival, and a silent run reports non-arrival", async () => {
  const fx = await codexFixture();
  const refresh = createCodexRefresh();

  await setMode(fx, { mode: "no-refresh" });
  const arrived = finished(await refresh(targetOf(fx)));
  assert.equal(arrived.after.kind, "unchanged");
  assert.equal(arrived.arrival, "arrived");
  assert.equal(arrived.exitedZeroUndiverted, false);
  assert.deepEqual(said(arrived).lines, [
    "quota-dispatcher: after the run the credential file still holds the same token (a request reached the loopback listener).",
    "If codex login status says the login is no longer valid, run codex login.",
  ]);
  assert.equal(said(arrived).level, "warning");

  await setMode(fx, { mode: "silent" });
  const silent = finished(await refresh(targetOf(fx)));
  assert.equal(silent.arrival, "none");
  assert.equal(silent.exitedZeroUndiverted, false, "a non-zero exit is not the undiverted anomaly");
  assert.match(said(silent).lines[0], /\(no request reached the loopback listener\)\.$/);
});

test("exit 0 without arrival adds the undiverted warning", async () => {
  const fx = await codexFixture();
  await setMode(fx, { mode: "exit-zero" });
  const result = finished(await createCodexRefresh()(targetOf(fx)));
  assert.equal(result.arrival, "none");
  assert.equal(result.exitedZeroUndiverted, true);
  const lines = said(result);
  assert.equal(lines.level, "warning");
  assert.deepEqual(lines.lines.slice(1), [
    "If codex login status says the login is no longer valid, run codex login.",
    "codex exited 0 while no request reached the loopback listener, which the diverted run is not expected to do; its prompt may have been answered elsewhere.",
  ]);
});

test("a run that switches the account is not reported as a refresh", async () => {
  const fx = await codexFixture();
  await setMode(fx, { mode: "switch-account" });
  const result = finished(await createCodexRefresh()(targetOf(fx)));
  assert.equal(result.after.kind, "account-changed");
  assert.deepEqual(said(result).lines, [
    "quota-dispatcher: after the run the credential file holds a different account; not reported as a refresh.",
  ]);
});

test("a missing file, a moved alias, an expired or exp-less token, and a non-login are never success", async () => {
  const fx = await codexFixture();
  const refresh = createCodexRefresh();

  // Each case pins its whole line, because the difference between them is the
  // sentence a user acts on — an expired token and one that states no expiry are
  // not the same finding.
  const cases: Array<{ mode: Record<string, unknown>; after: string; line: string }> = [
    {
      mode: { mode: "remove" },
      after: "missing",
      line: "quota-dispatcher: after the run the credential file is missing; not reported as a refresh.",
    },
    {
      mode: { mode: "write-expired" },
      after: "unusable",
      line: "quota-dispatcher: after the run the credential file holds a new token that is already expired; not reported as a refresh.",
    },
    {
      mode: { mode: "write-no-exp" },
      after: "unusable",
      line: "quota-dispatcher: after the run the credential file holds a new token without an expiry; not reported as a refresh.",
    },
    {
      mode: { mode: "write-api-key" },
      after: "not-login",
      line: "quota-dispatcher: after the run the credential file is no longer the Codex CLI's managed ChatGPT login; not reported as a refresh.",
    },
  ];
  for (const { mode, after, line } of cases) {
    await writeFile(fx.authPath, managedLogin(), "utf8");
    await setMode(fx, mode);
    const result = finished(await refresh(targetOf(fx)));
    assert.equal(result.after.kind, after, `${String(mode.mode)} must be ${after}`);
    assert.equal(said(result).level, "warning");
    assert.deepEqual(said(result).lines, [line]);
  }

  // A home whose `auth.json` was replaced by a link to somewhere else is not the
  // file the run started from, whatever the link points at.
  await writeFile(fx.authPath, managedLogin(), "utf8");
  const elsewhere = join(fx.root, "elsewhere.json");
  await writeFile(elsewhere, managedLogin({ expiresAt: Date.now() + 3_600_000 }), "utf8");
  const moved = await createCodexRefresh({
    run: async () => {
      await rm(fx.authPath);
      await symlink(elsewhere, fx.authPath);
      return { kind: "exited", code: 1, signal: null };
    },
  })(targetOf(fx));
  assert.equal(finished(moved).after.kind, "moved");
  assert.equal(
    said(moved).lines[0],
    "quota-dispatcher: after the run codexCredsPath no longer resolves to the Codex CLI's auth.json; not reported as a refresh.",
  );
});

test("timeout branches: a deadline hit, a late exit, an ignored TERM, and a run that never exited", async () => {
  // The deadline fires while the child hangs, and a token written before it hung
  // is still not a success: the run did not finish. The deadline is loose enough
  // that a loaded machine still starts the child, writes the token and only then
  // hangs — the assertion is about the rule, not about startup jitter.
  const writeFirst = await codexFixture();
  await setMode(writeFirst, { mode: "hang", writeFirst: true });
  const hit = await createCodexRefresh({ deadlineMs: 2_000, killGraceMs: 500 })(targetOf(writeFirst));
  const timedOut = finishedTimeout(hit);
  assert.equal(timedOut.exited, true);
  assert.equal(timedOut.after.kind, "refreshed");
  assert.deepEqual(said(hit).lines, [
    "quota-dispatcher: codex did not finish within 2 seconds (exit observed after the deadline); not reported as a refresh.",
    "After the run the file holds a new future-dated token for the same account, but the run did not finish normally; do not rely on it until codex login status agrees.",
    "Check codex login status; if it says the login is no longer valid, run codex login.",
  ]);

  // The same shape reached by the runner's own verdict, so the wording is pinned
  // independently of how a real child ends.
  const late = await createCodexRefresh({ run: async () => ({ kind: "timed-out", exited: true }) })(targetOf(
    await codexFixture(),
  ));
  assert.equal(finishedTimeout(late).exited, true);
  assert.match(said(late).lines[0], /\(exit observed after the deadline\); not reported as a refresh\.$/);

  // A child that ignores TERM is escalated to KILL, and only an observed exit
  // ends the wait.
  const stubborn = await codexFixture();
  await setMode(stubborn, { mode: "hang-ignore-term" });
  const gated: ProcessRunner = async (spec) => {
    const pending = spawnProcess(spec);
    await waitForFile(join(stubborn.control, "ready"));
    return pending;
  };
  const killed = await createCodexRefresh({ run: gated, deadlineMs: 2_000, killGraceMs: 500 })(targetOf(stubborn));
  assert.equal(finishedTimeout(killed).exited, true);
  // The child ignored TERM and the run still ended, which only SIGKILL explains —
  // and the marker the handler wrote proves TERM was delivered before it.
  assert.equal(
    await stat(join(stubborn.control, "term-seen")).then(() => true, () => false),
    true,
    "SIGTERM must reach the child before the grace period runs out",
  );

  // No exit at all: the wording says so, names the pid, and does not pretend the
  // child stopped.
  const never = await createCodexRefresh({
    run: async () => ({ kind: "timed-out", exited: false, pid: 4321 }),
    deadlineMs: 90_000,
  })(targetOf(await codexFixture()));
  assert.equal(finishedTimeout(never).exited, false);
  assert.equal(
    said(never).lines[0],
    "quota-dispatcher: codex did not finish within 90 seconds and no exit was observed after termination attempts (pid 4321); not reported as a refresh.",
  );
});

/** Fails with the result in the message when it is not the `timed-out` case. */
function finishedTimeout(
  result: CodexRefreshResult,
): Extract<CodexRefreshResult, { kind: "timed-out" }> {
  assert.equal(result.kind, "timed-out", JSON.stringify(result));
  if (result.kind !== "timed-out") throw new Error("unreachable");
  return result;
}

/** Waits for a file a child writes, so a test never races the deadline. */
async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      // Not yet.
    }
    if (Date.now() > until) throw new Error(`the child never wrote ${path}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("a pre-deadline signal is not reported as success", async () => {
  const fx = await codexFixture();
  const result = await createCodexRefresh({
    run: async () => ({ kind: "exited", code: null, signal: "SIGTERM" }),
  })(targetOf(fx));
  assert.equal(result.kind, "signaled");
  assert.deepEqual(said(result).lines, [
    "quota-dispatcher: codex exited on a signal before finishing; not reported as a refresh.",
    "After the run the file still holds the same token.",
    "Check codex login status; if it says the login is no longer valid, run codex login.",
  ]);
});

test("a second concurrent run returns busy immediately", async () => {
  const fx = await codexFixture();
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = createCodexRefresh({
    run: async () => {
      await held;
      return { kind: "exited", code: 1, signal: null };
    },
  });

  const first = refresh(targetOf(fx));
  const second = await refresh(targetOf(fx));
  assert.deepEqual(second, { kind: "busy" });
  assert.deepEqual(said(second).lines, ["quota-dispatcher: refresh-codex is already running."]);

  release();
  finished(await first);
  // The flag is cleared when the run ends, so the command is usable again.
  await writeFile(fx.authPath, managedLogin(), "utf8");
  assert.equal(finished(await refresh(targetOf(fx))).arrival, "none");
});

test("failed run setup is reported as itself, and nothing is launched", async () => {
  const fx = await codexFixture();
  let launched = 0;
  const onLaunch = () => {
    launched += 1;
  };

  const listenerFailed = await createCodexRefresh({
    listen: async () => {
      throw Object.assign(new Error("bind failed"), { code: "EADDRINUSE" });
    },
  })(targetOf(fx), { onLaunch });
  assert.deepEqual(listenerFailed, { kind: "listener-failed", code: "EADDRINUSE" });
  assert.deepEqual(said(listenerFailed).lines, [
    "quota-dispatcher: refresh-codex ran nothing: the loopback listener could not be opened (EADDRINUSE).",
  ]);

  const workdirFailed = await createCodexRefresh({
    makeWorkdir: async () => {
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    },
  })(targetOf(fx), { onLaunch });
  assert.deepEqual(workdirFailed, { kind: "workdir-failed", code: "ENOSPC" });
  assert.deepEqual(said(workdirFailed).lines, [
    "quota-dispatcher: refresh-codex ran nothing: a private working directory could not be created (ENOSPC).",
  ]);

  // A workdir under a project is refused: a `.git` above it means the run is
  // inside a repository whose config the CLI would read.
  const inProject = await createCodexRefresh({
    makeWorkdir: async () => {
      const dir = join(fx.root, "project", "tmp");
      await mkdir(join(fx.root, "project", ".git"), { recursive: true });
      await mkdir(dir, { recursive: true });
      return dir;
    },
  })(targetOf(fx), { onLaunch });
  assert.deepEqual(inProject, { kind: "workdir-in-project" });

  // The before-check admitted a codex that the spawn cannot run: a script with no
  // interpreter is executable and not startable.
  const brokenBin = join(fx.root, "broken-bin");
  await mkdir(brokenBin);
  await writeFile(join(brokenBin, "codex"), "#!/definitely/not/an/interpreter\n", "utf8");
  await chmod(join(brokenBin, "codex"), 0o755);
  const notStarted = await createCodexRefresh()(
    targetOf(fx, { host: hostWith({ ...fx.host.env, PATH: brokenBin }) }),
    { onLaunch },
  );
  assert.deepEqual(notStarted, { kind: "not-started", code: "ENOENT" });
  assert.deepEqual(said(notStarted).lines, [
    "quota-dispatcher: codex could not be started (ENOENT); nothing was run.",
  ]);
  // The notice goes out before the spawn, so a spawn that then fails carries one:
  // there is no way to know a binary will not start without starting it.
  assert.equal(launched, 1, "the launch notice precedes the spawn it announces");

  // The re-assessment before the spawn sees what the first check could not: a
  // `makeWorkdir` that changes the world in between must stop the run.
  let ran = 0;
  const reassessed = await createCodexRefresh({
    makeWorkdir: async () => {
      await writeFile(fx.authPath, "{ not a login", "utf8");
      return mkdtemp(join(tmpdir(), "pqd-codex-late-"));
    },
    run: async () => {
      ran += 1;
      return { kind: "exited", code: 0, signal: null };
    },
  })(targetOf(fx), { onLaunch });
  assert.deepEqual(reassessed, { kind: "refused", refusal: "not-managed-login" });
  assert.equal(ran, 0, "a run refused by the second check must not spawn");
  assert.equal(launched, 1, "the launch notice comes after the second check, so a refusal adds none");
});

test("an out-of-range or overflow expiry renders the fixed note without throwing", async () => {
  const outOfRange = 8_640_000_000_001; // seconds: past the last instant a Date can hold
  const fx = await codexFixture();
  await setMode(fx, { mode: "refresh", expiresAt: outOfRange });
  const result = finished(await createCodexRefresh()(targetOf(fx)));
  assert.equal(result.after.kind, "refreshed");
  assert.ok(
    said(result).lines[0].includes("valid (expiry out of date range)"),
    said(result).lines[0],
  );

  const overflow = await codexFixture();
  await setMode(overflow, { mode: "refresh", expiresAt: 1e308 });
  const infinite = finished(await createCodexRefresh()(targetOf(overflow)));
  assert.equal(infinite.after.kind, "refreshed");
  assert.ok(said(infinite).lines[0].includes("valid (expiry out of date range)"));

  // The hint shares the formatter, so it has the same two answers and no throw.
  assert.equal(
    codexExpiredHint({ kind: "not-due", expiresAt: Infinity }),
    "the file now holds a token valid (expiry out of date range); /quota-dispatch refresh reads it again",
  );
  assert.equal(
    codexExpiredHint({ kind: "not-due", expiresAt: outOfRange * 1_000 }),
    "the file now holds a token valid (expiry out of date range); /quota-dispatch refresh reads it again",
  );
});

test("no output, header, path, account id, or token reaches any outcome line", async () => {
  const fx = await codexFixture();
  const outcomes: CodexRefreshResult[] = [];
  const refresh = createCodexRefresh();

  for (const mode of [
    { mode: "refresh" },
    { mode: "no-refresh" },
    { mode: "silent" },
    { mode: "exit-zero" },
    { mode: "switch-account" },
    { mode: "remove" },
    { mode: "write-api-key" },
  ]) {
    await writeFile(fx.authPath, managedLogin(), "utf8");
    await setMode(fx, mode);
    outcomes.push(await refresh(targetOf(fx)));
  }
  outcomes.push(
    { kind: "finished", after: { kind: "unreadable", code: "EACCES" }, arrival: "arrived", exitedZeroUndiverted: false },
    { kind: "finished", after: { kind: "unchanged" }, arrival: "listener-failed", exitedZeroUndiverted: false },
    await createCodexRefresh({ run: async () => ({ kind: "timed-out", exited: false, pid: 7 }) })(
      targetOf(fx),
    ),
    await createCodexRefresh({ run: async () => ({ kind: "exited", code: null, signal: "SIGKILL" }) })(
      targetOf(fx),
    ),
    { kind: "busy" },
    { kind: "unexpected" },
    { kind: "workdir-in-project" },
    { kind: "not-due", expiresAt: Date.now() + 3_600_000 },
    { kind: "refused", refusal: "config-store" },
  );

  const lines = outcomes.flatMap((result) => said(result).lines);
  assert.ok(lines.length > 10, "the sweep must cover the table, not one row of it");
  assertRedacted(lines, fx.root);
  for (const line of lines) {
    assert.ok(!line.includes("acct-fixture"), `an account id must never be printed: ${line}`);
    assert.ok(!line.includes("acct-other"), `an account id must never be printed: ${line}`);
  }
});

// ---------------------------------------------------------------- the report's hint

/**
 * A dispatcher over one Codex fixture's machine, with the codex rail's read
 * stated.
 *
 * The rail's note and the machine are set independently on purpose: the hint is
 * computed from the machine, and the note from a read that already happened, so
 * the two can legitimately disagree — which is the case the hint exists for.
 */
async function dispatcherOver(
  fx: CodexFixture,
  input: {
    host?: CodexHost;
    codexCredsPath?: string;
    codex?: Parameters<typeof fakeReads>[0] extends infer Given
      ? Given extends { codex?: infer Answer }
        ? Answer
        : never
      : never;
  } = {},
) {
  await mkdir(join(fx.root, "agents"), { recursive: true });
  const cfg: DispatcherConfig = {
    ...DEFAULT_CONFIG,
    agentDir: join(fx.root, "agents"),
    readingsPath: join(fx.root, "readings.json"),
    claudeCredsPath: join(fx.root, "claude-credentials.json"),
    piAuthPath: fx.piAuthPath,
    codexCredsPath: input.codexCredsPath ?? fx.authPath,
    agents: agentTable({}),
  };
  return createDispatcher(cfg, {
    read: fakeReads({
      claude: readingOf("claude", { session: 5 }),
      codex: input.codex ?? failureOf("codex", CODEX_TOKEN_EXPIRED),
    }),
    codexHost: input.host ?? fx.host,
    now: () => NOW,
  });
}

/** The codex line of a report, which is the one line these tests are about. */
async function codexLine(d: Dispatcher): Promise<string> {
  const lines = await d.report({ force: true });
  const line = lines.find((l) => l.startsWith("codex: unavailable"));
  assert.ok(line, lines.join("\n"));
  return line;
}

test("an expired eligible codex rail tells the user to run refresh-codex", async () => {
  const fx = await codexFixture();
  assert.equal(
    await codexLine(await dispatcherOver(fx)),
    "codex: unavailable — codex token expired; run /quota-dispatch refresh-codex to have the Codex CLI refresh it",
  );
});

test("an expired codex rail that is now valid points at /quota-dispatch refresh", async () => {
  const fx = await codexFixture();
  const expiresAt = NOW + 3 * 3_600_000;
  await writeFile(fx.authPath, managedLogin({ expiresAt }), "utf8");
  const held = new Date(Math.floor(expiresAt / 1_000) * 1_000).toISOString();
  assert.equal(
    await codexLine(await dispatcherOver(fx)),
    `codex: unavailable — codex token expired; the file now holds a token valid until ${held}; /quota-dispatch refresh reads it again`,
  );
});

test("every refusal renders a hint without naming refresh-codex", async () => {
  // One fixture per refusal, because each one moves a different part of the
  // machine the admission list reads.
  const setups: Array<{
    refusal: CodexRefusalId;
    prepare: (fx: CodexFixture) => Promise<{ credsPath?: string; host?: CodexHost }>;
  }> = [
    { refusal: "windows", prepare: async (fx) => ({ host: { ...fx.host, platform: "win32" } }) },
    {
      refusal: "bad-home",
      prepare: async (fx) => ({ host: hostWith({ ...fx.host.env, CODEX_HOME: "relative/home" }) }),
    },
    {
      refusal: "pi-auth",
      prepare: async (fx) => {
        await writeFile(fx.piAuthPath, managedLogin(), "utf8");
        return { credsPath: fx.piAuthPath };
      },
    },
    {
      refusal: "not-cli-file",
      prepare: async (fx) => {
        // The same expired login at another path: the rail's read still says the
        // token expired, while the CLI would write the file in its own home.
        const published = join(fx.root, "published.json");
        await writeFile(published, managedLogin(), "utf8");
        return { credsPath: published };
      },
    },
    {
      refusal: "dotenv",
      prepare: async (fx) => {
        await writeFile(join(fx.codexHome, ".env"), "", "utf8");
        return {};
      },
    },
    {
      refusal: "config-store",
      prepare: async (fx) => {
        await writeFile(join(fx.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n', "utf8");
        return {};
      },
    },
    {
      refusal: "not-managed-login",
      prepare: async (fx) => {
        // pi's own document: the rail reads it (and finds the token expired),
        // while admission refuses it as something other than the CLI's login.
        await writeFile(
          fx.authPath,
          JSON.stringify({
            "openai-codex": {
              access: jwt({ exp: Math.floor((NOW - 60_000) / 1_000) }),
              accountId: "acct-fixture",
            },
          }),
          "utf8",
        );
        return {};
      },
    },
    {
      refusal: "no-codex",
      prepare: async (fx) => ({ host: hostWith({ ...fx.host.env, PATH: "" }) }),
    },
  ];

  for (const setup of setups) {
    const fx = await codexFixture();
    const prepared = await setup.prepare(fx);
    const line = await codexLine(
      await dispatcherOver(fx, { codexCredsPath: prepared.credsPath, host: prepared.host }),
    );
    assert.ok(
      line.includes(`not refreshable from here: ${refusalText(setup.refusal)}`),
      `${setup.refusal}: ${line}`,
    );
    assert.ok(!line.includes("refresh-codex"), `${setup.refusal}: ${line}`);
  }
});

test("healthy and HTTP 401 codex lines carry no hint", async () => {
  const fx = await codexFixture();
  // A token the credential read can use: only then is the rail's read reached at
  // all, so only then does the note come from the endpoint rather than the file.
  await writeFile(fx.authPath, managedLogin({ expiresAt: NOW + 3_600_000 }), "utf8");
  const healthy = await dispatcherOver(fx, { codex: readingOf("codex", { session: 10 }) });
  const healthyLine = (await healthy.report({ force: true })).find((l) => l.startsWith("codex:"));
  assert.ok(healthyLine !== undefined && healthyLine.includes("5h 10%"), healthyLine);
  assert.ok(!(healthyLine ?? "").includes("refresh-codex"), healthyLine);

  const refused = await dispatcherOver(fx, { codex: failureOf("codex", "HTTP 401") });
  assert.equal(await codexLine(refused), "codex: unavailable — HTTP 401");
});

test("the hint is never stored on knownReadings or the readings file", async () => {
  const fx = await codexFixture();
  const d = await dispatcherOver(fx);
  const lines = await d.report({ force: true });
  assert.ok(
    lines.some((l) => l.includes("run /quota-dispatch refresh-codex")),
    lines.join("\n"),
  );

  const known = await d.knownReadings();
  const latest = known.codex.latest;
  assert.equal(latest.ok, false);
  if (!latest.ok) assert.equal(latest.note, CODEX_TOKEN_EXPIRED);
  assert.ok(!JSON.stringify(known).includes("refresh-codex"), "the hint is not part of a reading");

  const stored = await readFile(join(fx.root, "readings.json"), "utf8").catch(() => "");
  assert.ok(!stored.includes("refresh-codex"), "the hint is not written to the readings file");
});

// ------------------------------------------------- what the reviews asked for

/** A Codex login document with `extra` merged over the required fields. */
function loginWith(extra: Record<string, unknown>): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ exp: Math.floor((NOW - 60_000) / 1_000) }),
      account_id: "acct-fixture",
      refresh_token: "refresh-fixture",
    },
    ...extra,
  });
}

test(
  "a credential file that becomes unreadable after the run is unreadable, not unchanged",
  { skip: isRoot() ? "permissions do not stop root" : false },
  async () => {
    const fx = await codexFixture();
    const result = finished(
      await createCodexRefresh({
        run: async () => {
          await chmod(fx.authPath, 0o000);
          return { kind: "exited", code: 1, signal: null };
        },
      })(targetOf(fx)),
    );
    assert.deepEqual(result.after, { kind: "unreadable", code: "EACCES" });
    assert.deepEqual(said(result).lines, [
      "quota-dispatcher: after the run the credential file could not be read (EACCES); not reported as a refresh.",
    ]);
  },
);

test("a workdir under a foreign .codex is refused, and one under the CLI's own home is not", async () => {
  const fx = await codexFixture();
  const foreign = await createCodexRefresh({
    makeWorkdir: async () => {
      const dir = join(fx.root, "outer", "tmp");
      await mkdir(join(fx.root, "outer", ".codex"), { recursive: true });
      await mkdir(dir, { recursive: true });
      return dir;
    },
    run: async () => {
      throw new Error("a workdir under a foreign Codex home must not run");
    },
  })(targetOf(fx));
  assert.deepEqual(foreign, { kind: "workdir-in-project" });

  // The CLI's own home above the workdir is the one `.codex` that is expected, so
  // it is skipped by resolved path rather than refused by name.
  const own = await codexFixture();
  const cliHome = join(own.home, ".codex");
  await mkdir(cliHome, { recursive: true });
  await writeFile(join(cliHome, "auth.json"), managedLogin(), "utf8");
  await setMode(own, { mode: "refresh" });
  const allowed = await createCodexRefresh({
    makeWorkdir: async () => {
      const dir = join(cliHome, "tmp");
      await mkdir(dir, { recursive: true });
      return dir;
    },
  })(
    targetOf(own, {
      credsPath: join(cliHome, "auth.json"),
      host: hostWith({ ...own.host.env, CODEX_HOME: cliHome }),
    }),
  );
  assert.equal(allowed.kind, "finished", JSON.stringify(allowed));
});

test("an unexpected throw is reported as itself, and its message reaches nothing", async () => {
  const fx = await codexFixture();
  const result = await createCodexRefresh({
    run: async () => {
      throw new Error(`boom at ${fx.root} with SENTINEL and eyJhbGciOi`);
    },
  })(targetOf(fx));
  assert.deepEqual(result, { kind: "unexpected" });
  const lines = said(result).lines;
  assert.deepEqual(lines, [
    "quota-dispatcher: refresh-codex stopped on an unexpected error; nothing is claimed about the credential.",
  ]);
  assertRedacted(lines, fx.root);
});

test("a listener that fails during the run is reported as that, beside the file's own fact", async () => {
  const fx = await codexFixture();
  const broken = async () => ({
    url: "http://127.0.0.1:9",
    arrived: () => false,
    error: () => "socket failed",
    close: async () => undefined,
  });
  const result = finished(
    await createCodexRefresh({
      listen: broken,
      run: async () => ({ kind: "exited", code: 1, signal: null }),
    })(targetOf(fx)),
  );
  assert.equal(result.arrival, "listener-failed");
  assert.deepEqual(result.after, { kind: "unchanged" });
  assert.deepEqual(said(result).lines, [
    "quota-dispatcher: after the run the credential file still holds the same token (the loopback listener failed during the run).",
    "If codex login status says the login is no longer valid, run codex login.",
  ]);
});

test("invalid UTF-8 is refused in either document, before and after the run", async () => {
  const invalid = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);

  const badConfig = await codexFixture();
  await writeFile(join(badConfig.codexHome, "config.toml"), invalid);
  await expectRefusal(readinessOf(badConfig), "config-store");

  const badLogin = await codexFixture();
  await writeFile(badLogin.authPath, invalid);
  await expectRefusal(readinessOf(badLogin), "not-managed-login");

  const afterRun = await codexFixture();
  const result = finished(
    await createCodexRefresh({
      run: async () => {
        await writeFile(afterRun.authPath, invalid);
        return { kind: "exited", code: 1, signal: null };
      },
    })(targetOf(afterRun)),
  );
  assert.deepEqual(result.after, { kind: "not-login" });
});

test("readiness refuses an oversized auth.json without reading it", async () => {
  const fx = await codexFixture();
  await writeFile(fx.authPath, `{"tokens": "${"x".repeat(1_048_576)}"}`);
  await expectRefusal(readinessOf(fx), "not-managed-login");
});

test("only the managed ChatGPT login is admitted, whatever else a document carries", async () => {
  // `auth_mode` is written as `null` or `"chatgpt"` by the CLI; either is fine.
  for (const extra of [{ auth_mode: "chatgpt" }, { auth_mode: null }]) {
    const fx = await codexFixture();
    await writeFile(fx.authPath, loginWith(extra), "utf8");
    assert.equal((await readinessOf(fx)).kind, "ready", JSON.stringify(extra));
  }

  // Anything that names another kind of credential is not the login this command
  // can refresh: the CLI would use it instead of rotating `tokens`.
  for (const extra of [
    { agent_identity: { id: "a" } },
    { bedrock_api_key: "b" },
    { bedrock_access_keys: { access: "c" } },
    { auth_mode: "apikey" },
  ]) {
    const fx = await codexFixture();
    await writeFile(fx.authPath, loginWith(extra), "utf8");
    await expectRefusal(readinessOf(fx), "not-managed-login");
  }
});

test("resolveCodexExecutable skips a directory named codex", async () => {
  const fx = await codexFixture();
  const shadow = join(fx.root, "shadow-bin");
  await mkdir(join(shadow, "codex"), { recursive: true });
  assert.equal(await resolveCodexExecutable({ PATH: `${shadow}:${fx.bin}` }), join(fx.bin, "codex"));
  assert.equal(await resolveCodexExecutable({ PATH: shadow }), undefined);
});

test("a refreshed file under a clean, undiverted run keeps its anomaly line", async () => {
  const fx = await codexFixture();
  const quiet = async () => ({
    url: "http://127.0.0.1:9",
    arrived: () => false,
    error: () => undefined,
    close: async () => undefined,
  });
  const expiresAt = NOW + 3_600_000;
  const result = finished(
    await createCodexRefresh({
      listen: quiet,
      run: async () => {
        await writeFile(fx.authPath, managedLogin({ expiresAt }), "utf8");
        return { kind: "exited", code: 0, signal: null };
      },
    })(targetOf(fx)),
  );
  assert.equal(result.after.kind, "refreshed");
  assert.equal(result.exitedZeroUndiverted, true);
  const lines = said(result);
  assert.equal(lines.level, "info", "a refresh is still the success it is");
  assert.equal(lines.lines.length, 3);
  assert.equal(
    lines.lines[2],
    "codex exited 0 while no request reached the loopback listener, which the diverted run is not expected to do; its prompt may have been answered elsewhere.",
  );
});

test("a termination line names a pid only when it is a finite integer", () => {
  const result = describeCodexRefresh({
    kind: "timed-out",
    after: { kind: "unchanged" },
    deadlineMs: 90_000,
    exited: false,
    pid: Number.NaN,
  });
  assert.ok(!result.lines[0].includes("pid"), result.lines[0]);
  assert.match(result.lines[0], /termination attempts; not reported as a refresh\.$/);

  const named = describeCodexRefresh({
    kind: "timed-out",
    after: { kind: "unchanged" },
    deadlineMs: 90_000,
    exited: false,
    pid: 4242,
  });
  assert.ok(named.lines[0].includes("(pid 4242)"), named.lines[0]);
});

// ------------------------------------------------- what the order decides

test("the due check runs before the executable search", async () => {
  const fx = await codexFixture();
  await writeFile(fx.authPath, managedLogin({ expiresAt: NOW + 3_600_000 }), "utf8");
  // No `codex` anywhere on PATH: a token that is not due is answered by the
  // clock, not by a search whose failure would then be reported ahead of the
  // truth. This is the one ordering the admission list states separately from
  // its numbered checks.
  const notDue = await readinessOf(fx, { host: hostWith({ ...fx.host.env, PATH: "" }) });
  assert.equal(notDue.kind, "not-due", JSON.stringify(notDue));
  // The command answers the clock too, and announces no launch: nothing ran.
  const result = await createCodexRefresh()(targetOf(fx, { host: hostWith({ ...fx.host.env, PATH: "" }) }));
  assert.equal(result.kind, "not-due");
  assert.match(said(result).lines[0], /outside this command's 5-minute refresh window\.$/);
  assert.deepEqual(await invocations(fx), []);
});

test("pi's path is refused only when it is the same file", async () => {
  // A symlink is another name for that file, and `dev`/`ino` say so even though
  // the paths look unrelated.
  const linked = await codexFixture();
  await writeFile(linked.piAuthPath, managedLogin(), "utf8");
  await symlink(linked.piAuthPath, join(linked.root, "pi-alias.json"));
  await expectRefusal(readinessOf(linked, { credsPath: join(linked.root, "pi-alias.json") }), "pi-auth");

  // pi's own login existing somewhere else is not evidence against this file:
  // refusing whenever the path exists would make any ordinary install refuse.
  const other = await codexFixture();
  await writeFile(other.piAuthPath, JSON.stringify({ "openai-codex": { access: "a", accountId: "b" } }), "utf8");
  assert.equal((await readinessOf(other)).kind, "ready");
});

test("an auth.json that is not a regular file is not the CLI's file", async () => {
  const fx = await codexFixture();
  await rm(fx.authPath);
  await mkdir(fx.authPath);
  await expectRefusal(readinessOf(fx), "not-cli-file");
});

test("a workdir that cannot be canonicalised is workdir-failed", async () => {
  const fx = await codexFixture();
  // The seam answers a path that does not exist, so the `realpath` after it is
  // the failure: creation succeeded and canonicalisation did not.
  const result = await createCodexRefresh({ makeWorkdir: async () => join(fx.root, "never-created") })(
    targetOf(fx),
  );
  assert.deepEqual(result, { kind: "workdir-failed", code: "ENOENT" });
  assert.deepEqual(said(result).lines, [
    "quota-dispatcher: refresh-codex ran nothing: a private working directory could not be created (ENOENT).",
  ]);
});

// ------------------------------------------------- the after-check's order

test("the after-check judges the account before the digest", async () => {
  const fx = await codexFixture();
  const before = JSON.parse(await readFile(fx.authPath, "utf8")) as { tokens: { access_token: string } };
  // The digest is untouched; only the account moved. Both facts cannot be
  // reported, and "a different account" is the one that explains the other.
  const result = finished(
    await createCodexRefresh({
      run: async () => {
        await writeFile(
          fx.authPath,
          JSON.stringify({
            OPENAI_API_KEY: null,
            tokens: {
              access_token: before.tokens.access_token,
              account_id: "acct-other",
              refresh_token: "refresh-fixture",
            },
          }),
          "utf8",
        );
        return { kind: "exited", code: 1, signal: null };
      },
    })(targetOf(fx)),
  );
  assert.deepEqual(result.after, { kind: "account-changed" });
});

test("the after-check's clock: expiring at the sampled instant is expired, a moment later is a refresh", async () => {
  const expired = await codexFixture();
  const expiredResult = finished(
    await createCodexRefresh({
      now: () => NOW,
      run: async () => {
        // `exp` reads as `NOW` once a millisecond value is derived from it.
        await writeFile(expired.authPath, managedLogin({ expiresAt: NOW }), "utf8");
        return { kind: "exited", code: 1, signal: null };
      },
    })(targetOf(expired)),
  );
  assert.deepEqual(expiredResult.after, { kind: "unusable", why: "expired" });

  const future = await codexFixture();
  const futureResult = finished(
    await createCodexRefresh({
      now: () => NOW,
      run: async () => {
        await writeFile(future.authPath, managedLogin({ expiresAt: NOW + 5_000 }), "utf8");
        return { kind: "exited", code: 1, signal: null };
      },
    })(targetOf(future)),
  );
  assert.deepEqual(futureResult.after, {
    kind: "refreshed",
    expiresAt: Math.floor((NOW + 5_000) / 1_000) * 1_000,
  });
});

test("a Codex home that moves is moved, even though codexCredsPath did not", async () => {
  const fx = await codexFixture();
  // The credential path is a stable alias, so its own resolution still names the
  // file the run started from; only `CODEX_HOME` is retargeted during the run. The
  // second realpath comparison is what notices.
  const alias = join(fx.root, "codex-auth-alias.json");
  await symlink(fx.authPath, alias);
  const alt = join(fx.root, "alt-home");
  await mkdir(alt);
  await writeFile(join(alt, "auth.json"), managedLogin(), "utf8");
  const homeLink = join(fx.root, "home-link");
  await symlink(fx.codexHome, homeLink);

  const result = finished(
    await createCodexRefresh({
      run: async () => {
        await rm(homeLink);
        await symlink(alt, homeLink);
        return { kind: "exited", code: 1, signal: null };
      },
    })(targetOf(fx, { credsPath: alias, host: hostWith({ ...fx.host.env, CODEX_HOME: homeLink }) })),
  );
  assert.deepEqual(result.after, { kind: "moved" });
});
