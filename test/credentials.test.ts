import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type AgentRoute,
  type CommandRunner,
  type KeychainRead,
  CLAUDE_KEYCHAIN_SERVICE,
  DEFAULT_CONFIG,
  createDispatcher,
  isDefaultClaudeCredsPath,
  keychainReader,
  parseClaudeToken,
  readClaudeToken,
} from "../src/index.ts";

// This file pins the credential-store contract: the macOS login keychain is the
// live home of the Claude subscription credential, the on-disk file is a legacy
// fallback, and either store can answer on equal terms.

// ---------------------------------------------------------------- fixtures

/** A fixed instant, so every expiry comparison in this file is deterministic. */
const FIXED = 1_700_000_000_000;

/** The credential JSON Claude Code writes, shaped for one store. */
function cred(oauth: unknown): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

/** Write a credential file in a fresh tmp dir and return its path. */
async function credsFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pqd-cred-"));
  const path = join(dir, "credentials.json");
  await writeFile(path, contents, "utf8");
  return path;
}

/** A path that no store has written, in its own tmp dir. */
async function absentPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pqd-cred-"));
  return join(dir, "absent.json");
}

// ---------------------------------------------------------------- parseClaudeToken

test("parseClaudeToken returns an unexpired accessToken", () => {
  assert.deepEqual(
    parseClaudeToken(cred({ accessToken: "tok", expiresAt: FIXED + 60_000 }), FIXED),
    { token: "tok" },
  );
});

test("parseClaudeToken rejects a missing, blank, or absent accessToken", () => {
  const shaped = cred({ accessToken: "", expiresAt: FIXED + 60_000 });
  // An empty token is no token, so it must not be handed to the usage endpoint.
  assert.deepEqual(parseClaudeToken(shaped, FIXED), {
    error: "no claudeAiOauth.accessToken",
    reason: "unusable",
  });
  assert.deepEqual(parseClaudeToken(cred({ expiresAt: FIXED + 60_000 }), FIXED), {
    error: "no claudeAiOauth.accessToken",
    reason: "unusable",
  });
  // The section itself missing is the same shape of failure.
  assert.deepEqual(parseClaudeToken(JSON.stringify({}), FIXED), {
    error: "no claudeAiOauth.accessToken",
    reason: "unusable",
  });
});

test("parseClaudeToken reports malformed JSON with the parse message", () => {
  const out = parseClaudeToken("this is not json", FIXED);
  assert.ok("error" in out);
  // The message after the prefix is JSON.parse's own, so it is not pinned.
  assert.ok(out.error.startsWith("unreadable claude credentials: "), out.error);
});

test("parseClaudeToken uses a token expiring in the future", () => {
  assert.deepEqual(
    parseClaudeToken(cred({ accessToken: "tok", expiresAt: FIXED + 1 }), FIXED),
    { token: "tok" },
  );
});

// The fault this catches: an off-by-one that rejects a token the instant it is
// stamped, so a freshly refreshed credential is declared expired.
test("parseClaudeToken treats a token whose expiresAt equals now as still usable", () => {
  assert.deepEqual(
    parseClaudeToken(cred({ accessToken: "tok", expiresAt: FIXED }), FIXED),
    { token: "tok" },
  );
});

// The tag is what a caller acts on: an expiry is the one store failure a refresh
// ping fixes, and the message alone no longer has to be parsed to learn that.
test("parseClaudeToken rejects a token that expired in the past", () => {
  assert.deepEqual(parseClaudeToken(cred({ accessToken: "tok", expiresAt: FIXED - 1 }), FIXED), {
    // The fact alone: the advice ("run Claude Code to refresh") is the caller's
    // decision to state, and a note that repeats it would tell a bridge user to
    // do by hand what the dispatcher may already have done for them.
    error: "claude token expired",
    reason: "expired",
  });
});

// A shape without an expiry is not evidence of expiry, so the token is used
// rather than the rail declared unavailable.
test("parseClaudeToken uses a token with no numeric expiresAt", () => {
  assert.deepEqual(parseClaudeToken(cred({ accessToken: "tok" }), FIXED), { token: "tok" });
  // A non-numeric value is not an expiry either.
  assert.deepEqual(parseClaudeToken(cred({ accessToken: "tok", expiresAt: "soon" }), FIXED), {
    token: "tok",
  });
});

test("parseClaudeToken ignores unknown sibling fields", () => {
  assert.deepEqual(
    parseClaudeToken(
      cred({ accessToken: "tok", expiresAt: FIXED + 60_000, scopes: ["a"], subscriptionType: "max" }),
      FIXED,
    ),
    { token: "tok" },
  );
});

// ---------------------------------------------------------------- keychainReader

test("keychainReader offers no store off darwin and runs nothing", () => {
  for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
    let ran = false;
    const reader = keychainReader(platform, async () => {
      ran = true;
      return { text: "should never be read" };
    });
    assert.equal(reader, undefined, `${platform} must have no keychain`);
    // The fault this catches: a Linux install paying a subprocess (and an error
    // line) for a store that cannot exist.
    assert.equal(ran, false, `${platform} must not spawn security`);
  }
});

test("keychainReader on darwin runs security with the exact argv and yields stdout", async () => {
  const previousUser = process.env.USER;
  process.env.USER = "pqd-test-user";
  try {
    const calls: Array<{ file: string; args: string[] }> = [];
    const run: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      return { text: cred({ accessToken: "keychain-token" }) };
    };
    const reader = keychainReader("darwin", run);
    assert.ok(reader, "darwin must have a keychain reader");

    assert.deepEqual(await reader!(), { text: cred({ accessToken: "keychain-token" }) });

    assert.equal(calls.length, 1, "exactly one security invocation");
    assert.equal(calls[0].file, "security");
    // The account is the current user, and the service is the constant, so the
    // argv is the same call Claude Code itself makes.
    assert.deepEqual(calls[0].args, [
      "find-generic-password",
      "-a",
      "pqd-test-user",
      "-w",
      "-s",
      "Claude Code-credentials",
    ]);
    assert.equal(calls[0].args.at(-1), CLAUDE_KEYCHAIN_SERVICE);
  } finally {
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
  }
});

test("keychainReader takes the account name from USER, falling back to the OS user", async () => {
  const previousUser = process.env.USER;
  delete process.env.USER;
  try {
    let account = "";
    const reader = keychainReader("darwin", async (_file, args) => {
      account = args[2];
      return { text: cred({ accessToken: "keychain-token" }) };
    });
    await reader!();
    assert.equal(account, userInfo().username);
  } finally {
    if (previousUser !== undefined) process.env.USER = previousUser;
  }
});

test("keychainReader surfaces a runner failure unchanged", async () => {
  const reader = keychainReader("darwin", async () => ({ error: "security: item not found" }));
  assert.deepEqual(await reader!(), { error: "security: item not found" });
});

// ---------------------------------------------------------------- isDefaultClaudeCredsPath

test("isDefaultClaudeCredsPath is true only for the default credential path", () => {
  assert.equal(isDefaultClaudeCredsPath(DEFAULT_CONFIG.claudeCredsPath), true);
  // A relocated profile keeps its credential in its own file, which the
  // keychain never holds, so it must not be offered the fallback.
  assert.equal(isDefaultClaudeCredsPath("/some/other/profile/credentials.json"), false);
  assert.equal(isDefaultClaudeCredsPath(`${DEFAULT_CONFIG.claudeCredsPath}.bak`), false);
});

// ---------------------------------------------------------------- readClaudeToken

test("readClaudeToken uses the file and never reads the keychain when the file is usable", async () => {
  const path = await credsFile(cred({ accessToken: "file-token", expiresAt: FIXED + 60_000 }));
  let keychainCalls = 0;
  const out = await readClaudeToken(path, {
    now: FIXED,
    keychain: async () => {
      keychainCalls++;
      return { text: cred({ accessToken: "keychain-token", expiresAt: FIXED + 60_000 }) };
    },
  });

  assert.deepEqual(out, { token: "file-token" });
  // The fault this catches: a healthy macOS install spawning `security` (and
  // potentially prompting) on every evaluation.
  assert.equal(keychainCalls, 0, "a usable file must not consult the keychain");
});

test("readClaudeToken falls back to the keychain when the file is missing", async () => {
  const out = await readClaudeToken(await absentPath(), {
    now: FIXED,
    keychain: async () => ({ text: cred({ accessToken: "keychain-token", expiresAt: FIXED + 60_000 }) }),
  });
  assert.deepEqual(out, { token: "keychain-token" });
});

test("readClaudeToken falls back to the keychain when the file holds an expired token", async () => {
  const path = await credsFile(cred({ accessToken: "stale", expiresAt: FIXED - 1 }));
  const out = await readClaudeToken(path, {
    now: FIXED,
    keychain: async () => ({ text: cred({ accessToken: "keychain-token", expiresAt: FIXED + 60_000 }) }),
  });
  assert.deepEqual(out, { token: "keychain-token" });
});

test("readClaudeToken falls back to the keychain when the file is not JSON", async () => {
  const path = await credsFile("legacy non-JSON credentials");
  const out = await readClaudeToken(path, {
    now: FIXED,
    keychain: async () => ({ text: cred({ accessToken: "keychain-token", expiresAt: FIXED + 60_000 }) }),
  });
  assert.deepEqual(out, { token: "keychain-token" });
});

test("readClaudeToken falls back to the keychain when the file has no accessToken", async () => {
  const path = await credsFile(JSON.stringify({}));
  const out = await readClaudeToken(path, {
    now: FIXED,
    keychain: async () => ({ text: cred({ accessToken: "keychain-token", expiresAt: FIXED + 60_000 }) }),
  });
  assert.deepEqual(out, { token: "keychain-token" });
});

test("readClaudeToken falls back to the keychain when the file cannot be read", async () => {
  // A directory at the credential path makes readFile fail with EISDIR, the
  // "unreadable" case distinct from "shapeless".
  const dir = await mkdtemp(join(tmpdir(), "pqd-cred-"));
  const out = await readClaudeToken(dir, {
    now: FIXED,
    keychain: async () => ({ text: cred({ accessToken: "keychain-token", expiresAt: FIXED + 60_000 }) }),
  });
  assert.deepEqual(out, { token: "keychain-token" });
});

test("readClaudeToken names both reasons when neither store yields a token", async () => {
  const path = await credsFile(cred({ accessToken: "stale", expiresAt: FIXED - 1 }));
  const out = await readClaudeToken(path, {
    now: FIXED,
    keychain: async () => ({ error: "no claudeAiOauth.accessToken" }),
  });
  // File's reason first, keychain's after the separator, so the user learns both
  // stores were tried and how each failed.
  assert.deepEqual(out, {
    error: "claude token expired; keychain: no claudeAiOauth.accessToken",
    // One store's expiry is enough to make a ping worth trying.
    reason: "expired",
  });
});

test("readClaudeToken names a keychain token's own expiry", async () => {
  const out = await readClaudeToken(await absentPath(), {
    now: FIXED,
    keychain: async () => ({ text: cred({ accessToken: "stale", expiresAt: FIXED - 1 }) }),
  });
  assert.deepEqual(out, {
    error: "no claude credentials file; keychain: claude token expired",
    reason: "expired",
  });
});

test("readClaudeToken keeps the pre-keychain single-store message with no keychain", async () => {
  // A missing file stays exactly "no claude credentials file", unchanged from
  // before the keychain existed.
  assert.deepEqual(await readClaudeToken(await absentPath()), {
    error: "no claude credentials file",
    reason: "unusable",
  });

  const expired = await credsFile(cred({ accessToken: "stale", expiresAt: FIXED - 1 }));
  assert.deepEqual(await readClaudeToken(expired, { now: FIXED }), {
    error: "claude token expired",
    reason: "expired",
  });

  const shapeless = await credsFile(JSON.stringify({}));
  assert.deepEqual(await readClaudeToken(shapeless, { now: FIXED }), {
    error: "no claudeAiOauth.accessToken",
    reason: "unusable",
  });
});

// ---------------------------------------------------------------- dispatcher

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

/** `planner` is claude-primary, so an unusable claude rail holds it. */
const AGENT_ROUTES: Record<string, AgentRoute> = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  },
  reviewer: {
    primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
    alternates: [{ model: "claude-bridge/claude-opus-5-5", rail: "claude" }],
  },
};

interface Fixture {
  agentDir: string;
  claudeCredsPath: string;
  piAuthPath: string;
  readingsPath: string;
}

/**
 * A self-contained dispatcher fixture: agent files, a credential path, and a pi
 * auth file, all under tmp. Nothing here reads the developer's real
 * `~/.claude/.credentials.json` or `~/.pi/agent/auth.json`.
 */
async function fixture(models: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-cred-"));
  const agentDir = join(root, "agents");
  await mkdir(agentDir, { recursive: true });
  for (const [name, model] of Object.entries(models)) {
    await writeFile(join(agentDir, `${name}.md`), TEMPLATE(name, model), "utf8");
  }
  const claudeCredsPath = join(root, "claude-credentials.json");
  const piAuthPath = join(root, "pi-auth.json");
  await writeFile(
    piAuthPath,
    JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct-test" } }),
    "utf8",
  );
  return { agentDir, claudeCredsPath, piAuthPath, readingsPath: join(root, "quota-dispatch-readings.json") };
}

interface StubReadings {
  claude?: { session?: number; weekly?: number };
  codex?: { session?: number; weekly?: number };
}

/** The only network boundary; records the bearer token each call carried. */
function stubFetch(opts: StubReadings = {}, seenAuth: string[] = []) {
  return (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const auth = init?.headers?.Authorization;
    if (auth) seenAuth.push(auth);
    if (u.includes("anthropic.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: opts.claude?.session ?? 0 },
          seven_day: { utilization: opts.claude?.weekly ?? 0 },
        }),
      };
    }
    if (u.includes("chatgpt.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            limit_reached: false,
            primary_window: { used_percent: opts.codex?.session ?? 0, limit_window_seconds: 18000, reset_after_seconds: 3600 },
            secondary_window: { used_percent: opts.codex?.weekly ?? 0, limit_window_seconds: 604800, reset_after_seconds: 400000 },
          },
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

test("a stale file with a working keychain leaves the claude rail available", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: Date.now() - 1000 }),
    "utf8",
  );

  const seenAuth: string[] = [];
  let keychainCalls = 0;
  const readKeychain: KeychainRead = async () => {
    keychainCalls++;
    return { text: cred({ accessToken: "live-keychain", expiresAt: Date.now() + 3_600_000 }) };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, agents: AGENT_ROUTES },
    { fetchImpl: stubFetch({ claude: { session: 42 }, codex: { session: 10 } }, seenAuth), readKeychain },
  );

  const lines = await d.report({ force: true });
  // The defect this fixes: the report said claude was unavailable while the
  // user was actively driving Claude through a bridge.
  assert.ok(
    !lines.some((l) => l.startsWith("claude: unavailable")),
    `claude must be available:\n${lines.join("\n")}`,
  );
  assert.equal(keychainCalls, 1, "the stale file must send the read to the keychain");
  // The keychain token is what actually authorized the usage call.
  assert.ok(seenAuth.includes("Bearer live-keychain"), seenAuth.join(", "));
});

test("with both stores failing the claude rail is unavailable and its agent is held", async () => {
  const fx = await fixture({ planner: "claude-bridge/claude-opus-5-5" });
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: Date.now() - 1000 }),
    "utf8",
  );
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, agents: AGENT_ROUTES },
    {
      fetchImpl: stubFetch({ claude: { session: 95 }, codex: { session: 10 } }),
      readKeychain: async () => ({ error: "keychain unavailable" }),
    },
  );

  const lines = await d.report({ force: true });
  const reported = lines.find((l) => l.startsWith("claude: unavailable — "));
  assert.ok(reported, `claude must be unavailable:\n${lines.join("\n")}`);
  const note = reported.slice("claude: unavailable — ".length);
  // The rail note is the credential layer's fact — expired, and both stores' —
  // followed by the decision about it: no ping, because this fixture's
  // credential path is not the default one.
  assert.ok(!note.includes("\n"), note);
  assert.ok(note.includes("claude token expired"), note);
  // The other store's reason is a distinct, user-fixable problem, so the
  // decision must be appended to the credential fact rather than replace it.
  assert.ok(note.includes("keychain unavailable"), note);
  assert.ok(note.includes("refresh ping"), note);
  // The path rule is the reason that decided it, named once rather than beside
  // the key: `refreshPlan` resolves the mode and the path in one place.
  assert.ok(note.includes("claudeCredsPath"), note);

  const path = join(fx.agentDir, "planner.md");
  const before = await readFile(path, "utf8");
  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;

  assert.equal(planner.decision.kind, "hold", planner.decision.why);
  assert.equal(planner.outcome, "held");
  assert.equal(await readFile(path, "utf8"), before, "a held agent's file must not be rewritten");
});
