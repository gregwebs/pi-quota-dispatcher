import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Types are erased, so this import does not evaluate `src/index.ts`; the value
// import below is dynamic and deliberately happens after `HOME` is redirected.
import type {
  AgentRoute,
  ClaudeRefresh,
  CommandRunner,
  KeychainRead,
  PingListener,
  PingListenerFactory,
} from "../src/index.ts";

// This file pins the refresh-ping contract (issue #30): the argv a ping runs,
// the verdict each way a run can end, the loopback listener the diversion lands
// on, and how the dispatcher bounds and reports the attempt.

// `isDefaultClaudeCredsPath` compares against `DEFAULT_CONFIG.claudeCredsPath`,
// which is derived from the home directory when the module is loaded. The two
// tests that must exercise the *default* path therefore need that path to point
// into a temp dir we own rather than at the developer's real
// `~/.claude/.credentials.json`, and the only way to move a load-time default is
// to set `HOME` before the import. `node --test` runs each file in its own
// process, so this cannot bleed into any other test file.
const TMP_HOME = await mkdtemp(join(tmpdir(), "pqd-refresh-home-"));
process.env.HOME = TMP_HOME;

// Spec-8: the default-path rule is the only thing between a test and the real
// `claude` binary. A stub first on `PATH` turns a regression of that gate into a
// recorded invocation and a failed assertion, instead of a real run against the
// developer's keychain (which costs money). Nothing in this file is allowed to
// run the real binary, so every test that resolves a production refresher
// asserts the stub was never invoked.
const STUB_BIN = await mkdtemp(join(tmpdir(), "pqd-claude-stub-"));
const STUB_LOG = join(STUB_BIN, "invocations");
const STUB_CLAUDE = join(STUB_BIN, "claude");
await writeFile(STUB_CLAUDE, `#!/bin/sh\necho "$@" >> '${STUB_LOG}'\nexit 1\n`, "utf8");
await chmod(STUB_CLAUDE, 0o755);
process.env.PATH = `${STUB_BIN}:${process.env.PATH ?? ""}`;

/**
 * Refuses to let the file run if the stub cannot be executed.
 *
 * `execvp` *skips* a file whose executable bit is missing and runs the next
 * `claude` on `PATH`, so a stub on a `noexec` temp mount would make the
 * tripwire below — and every "no claude was spawned" check that leans on it —
 * fall through to the real binary, which is a paid call. Failing before any
 * spawn is the safe outcome; skipping is not.
 */
async function assertStubExecutable(): Promise<void> {
  try {
    await access(STUB_CLAUDE, constants.X_OK);
  } catch {
    throw new Error(
      `the claude tripwire stub at ${STUB_CLAUDE} is not executable — ${STUB_BIN} is ` +
        "probably a noexec mount. Refusing to run: execvp would skip the stub and " +
        "spawn the next claude on PATH.",
    );
  }
}

// Before any test body can spawn anything, so the whole file fails safe.
await assertStubExecutable();

/** How many times the stub `claude` ran. Zero in every correct run. */
async function claudeInvocations(): Promise<number> {
  try {
    return (await readFile(STUB_LOG, "utf8")).split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

const {
  CLAUDE_PING_COOLDOWN_MS,
  CLAUDE_REFRESH_MODES,
  DEFAULT_CONFIG,
  claudePingArgs,
  claudePingEnv,
  claudeRefresher,
  createDispatcher,
  defaultConfig,
  describeConfig,
  execFileRunner,
  isClaudeRefreshMode,
  loopbackListener,
  mergeConfig,
  refreshPlan,
} = await import("../src/index.ts");

// ---------------------------------------------------------------- fixtures

/** A fixed instant, so the expiry comparisons and the clock are deterministic. */
const NOW = 1_700_000_000_000;

/** The credential JSON Claude Code writes. */
function cred(oauth: unknown): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

/** An injected fallback store that cannot answer, so the file's reason stands. */
const noKeychain: KeychainRead = async () => ({ error: "no keychain" });

/**
 * A fake listener factory, and the counters that prove the seam was used.
 *
 * The real listener is a socket; the refresher's verdict logic is what this
 * replaces, so every offline-ping path can be driven without one.
 */
interface ListenerProbe {
  factory: PingListenerFactory;
  listener: PingListener;
  url: string;
  /** How many times the refresher asked for a listener. */
  opened: number;
  /** How many times it closed one. */
  closes: number;
}

/**
 * A listener whose request arrival and socket error are fixed up front, so the
 * refresher's verdict can be read off the outcome alone.
 */
function listenerProbe(arrived: boolean, socketError?: string): ListenerProbe {
  const probe: ListenerProbe = {
    url: "http://127.0.0.1:41234",
    opened: 0,
    closes: 0,
    listener: undefined as unknown as PingListener,
    factory: async () => {
      probe.opened++;
      return probe.listener;
    },
  };
  probe.listener = {
    url: probe.url,
    arrived: () => arrived,
    error: () => socketError,
    close: async () => {
      probe.closes++;
    },
  };
  return probe;
}

// ---------------------------------------------------------------- claudePingArgs

test("claudePingArgs pins the diverted argv byte for byte", () => {
  // The diversion rides in `--settings` because that is the only way to hand the
  // base URL over without widening `CommandRunner` past `(file, args)`.
  assert.deepEqual(claudePingArgs("http://127.0.0.1:1234"), [
    "-p",
    "hi",
    "--settings",
    '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1234"}}',
  ]);
});

test("claudePingArgs with no diversion is the undiverted ping", () => {
  assert.deepEqual(claudePingArgs(), ["-p", "hi"]);
});

// ---------------------------------------------------------------- claudePingEnv

// The ping must refresh *the credential the dispatcher read*. pi's own
// environment can point a child at a different credential entirely, and the
// default-path rule never sees the environment, so the selecting variables are
// dropped and everything a normal Claude Code run needs is inherited.
//
// The full selection surface, not a sample: a provider switch or an extra base
// URL that survived would send the model request somewhere else and make the
// ping a billed request against another provider (round-2 New-2 / contract §B).
// The residual — a selection variable not listed — shows up as `undiverted`,
// which halts for the session, so it is one request at worst.
test("claudePingEnv drops the whole selection surface and keeps PATH", () => {
  const dropped = [
    // Which credential it uses.
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    // Which provider serves the request.
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_CCR_V",
    // Where the request goes.
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "CLAUDE_CODE_API_BASE_URL",
    // Which credential store or OAuth endpoint.
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    // Which model answers: an unrecognised id is rejected before authentication.
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
  ];
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/someone",
    LANG: "en_US.UTF-8",
    HTTPS_PROXY: "http://proxy.example:8080",
    ...Object.fromEntries(dropped.map((key) => [key, "should-not-survive"])),
    // A variable that merely starts like one of the dropped ones.
    ANTHROPICALLY: "kept",
  };

  const out = claudePingEnv(env);

  for (const key of dropped) {
    assert.equal(Object.hasOwn(out, key), false, `${key} must not reach the child`);
  }
  // The child still has to be a normal Claude Code run, so anything else is
  // inherited, not blanked: the binary, its config dir's parent, its locale, its
  // proxy.
  assert.equal(out.PATH, "/usr/bin:/bin");
  assert.equal(out.HOME, "/home/someone");
  assert.equal(out.LANG, "en_US.UTF-8");
  assert.equal(out.HTTPS_PROXY, "http://proxy.example:8080");
  assert.equal(out.ANTHROPICALLY, "kept");
});

// ---------------------------------------------------------------- claudeRefresher

test("claudeRefresher off yields no refresher and touches neither seam", () => {
  let ran = 0;
  let listened = 0;
  const refresh = claudeRefresher(
    "off",
    async () => {
      ran++;
      return { text: "" };
    },
    async () => {
      listened++;
      throw new Error("off must not listen");
    },
  );
  assert.equal(refresh, undefined);
  assert.equal(ran, 0, "off must not run claude");
  assert.equal(listened, 0, "off must not open a listener");
});

test("offline-ping runs claude exactly once with the listener's URL in the argv", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const probe = listenerProbe(true);
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { error: "exit 1" };
  };
  const refresh = claudeRefresher("offline-ping", run, probe.factory)!;

  await refresh();

  assert.equal(probe.opened, 1, "one listener per attempt");
  assert.equal(calls.length, 1, "exactly one claude invocation");
  assert.equal(calls[0].file, "claude");
  assert.deepEqual(calls[0].args, claudePingArgs(probe.url));
  // The URL rides inside the `--settings` JSON, so it is not an argv element of
  // its own — what matters is that it reached the command at all.
  assert.ok(
    calls[0].args.some((arg) => arg.includes(probe.url)),
    `the base URL must be in argv: ${calls[0].args.join(" ")}`,
  );
  assert.equal(probe.closes, 1, "the listener must be released");
});

// The defect this catches: a naive exit-status check. A diverted request is
// answered 400, so claude exits non-zero on its own 400 — which is not evidence
// that the refresh failed.
test("a diverted ping is pinged when the request arrived, whatever the runner returned", async () => {
  const probe = listenerProbe(true);
  const refresh = claudeRefresher("offline-ping", async () => ({ error: "exit 1" }), probe.factory)!;

  assert.deepEqual(await refresh(), { outcome: "pinged" });
  assert.equal(probe.closes, 1);
});

test("a ping with a failed command and no arrival is failed, in one line", async () => {
  const probe = listenerProbe(false);
  // Multi-line on purpose: a note is what the one-line rail reports verbatim,
  // so a runner that printed a paragraph must not put a newline in the note.
  // Feeding one line here would make the assertion below unfalsifiable.
  const multiLine = "claude: command not found\n  (a second line the rail must drop)\nthird";
  const refresh = claudeRefresher("offline-ping", async () => ({ error: multiLine }), probe.factory)!;

  const out = await refresh();

  assert.equal(out.outcome, "failed");
  assert.equal(out.note, "claude: command not found");
  assert.equal(out.note.split("\n").length, 1, `the note must be one line: ${JSON.stringify(out.note)}`);
  assert.equal(probe.closes, 1);
});

test("a ping that collided with the refresh lock is deferred, not failed", async () => {
  // Again multi-line: the lock is matched in the full error but the note keeps
  // only its first line.
  const lock =
    "OAuth access token could not be refreshed: another Claude Code process is holding the refresh lock\n(retry after it releases)";
  const probe = listenerProbe(false);
  const refresh = claudeRefresher("offline-ping", async () => ({ error: lock }), probe.factory)!;

  const out = await refresh();

  // The other process is doing the work, so the next read is what finds its
  // result — a deferral rather than a failure the caller should back off from.
  assert.equal(out.outcome, "deferred");
  assert.ok(out.note.includes("refresh lock"), out.note);
  assert.equal(out.note.split("\n").length, 1, `the note must be one line: ${JSON.stringify(out.note)}`);
  assert.equal(probe.closes, 1);
});

// A clean exit means the model call was answered — somewhere. If it was not
// answered on our listener, the diversion that this whole design rests on has
// silently failed, so this is its own outcome rather than `failed` (nothing
// happened) or `pinged` (a fresh token may have landed).
test("a clean exit whose request never arrived is undiverted, without echoing stdout", async () => {
  // Claude Code's own JSON names the account, so it must never reach a note, a
  // log, or a report line.
  const stdout = '{"loggedIn":true,"account":"someone@example.com"}';
  const probe = listenerProbe(false);
  const refresh = claudeRefresher("offline-ping", async () => ({ text: stdout }), probe.factory)!;

  const out = await refresh();

  assert.equal(out.outcome, "undiverted");
  assert.ok(!out.note.includes(stdout), `stdout must not reach the note: ${out.note}`);
  assert.ok(!out.note.includes("someone@example.com"), out.note);
  assert.ok(out.note.length > 0, "a fixed sentence, not an empty note");
  assert.ok(!out.note.includes("\n"), out.note);
  assert.equal(probe.closes, 1);
});

// A broken socket must not masquerade as a clean exit that never reached the
// listener — that would be `undiverted`, which halts the feature for the rest
// of the expiry. The socket's own failure is a `failed` with its error named.
test("a listener error with no arrival is failed, not undiverted", async () => {
  const probe = listenerProbe(false, "EADDRNOTAVAIL: the socket died after listen");
  const refresh = claudeRefresher("offline-ping", async () => ({ text: "{}" }), probe.factory)!;

  const out = await refresh();

  assert.equal(out.outcome, "failed");
  assert.ok(out.note.includes("the socket died"), out.note);
  assert.equal(out.note.split("\n").length, 1, `the note must be one line: ${JSON.stringify(out.note)}`);
  assert.equal(probe.closes, 1);
});

// Arrival is still valid proof: once the diverted request turned up, whatever
// the socket did afterwards cannot unmake it.
test("a listener error after a request arrived is still pinged", async () => {
  const probe = listenerProbe(true, "ECONNRESET: the peer went away");
  const refresh = claudeRefresher("offline-ping", async () => ({ error: "exit 1" }), probe.factory)!;

  assert.deepEqual(await refresh(), { outcome: "pinged" });
  assert.equal(probe.closes, 1);
});

test("the listener is released even when the runner throws", async () => {
  const probe = listenerProbe(false);
  const run: CommandRunner = async () => {
    throw new Error("claude not on PATH");
  };
  const refresh = claudeRefresher("offline-ping", run, probe.factory)!;

  // Whether the throw propagates or becomes a `failed` is not pinned; that the
  // port is not leaked on the way out is.
  await refresh().then(
    () => undefined,
    () => undefined,
  );

  assert.equal(probe.closes, 1, "the listener must be released on the throw path too");
});

test("a listener that cannot be opened fails the attempt without running claude", async () => {
  let ran = 0;
  const run: CommandRunner = async () => {
    ran++;
    return { text: "should never run" };
  };
  const listen: PingListenerFactory = async () => {
    throw new Error("EADDRINUSE: address already in use");
  };
  const refresh = claudeRefresher("offline-ping", run, listen)!;

  const out = await refresh();

  assert.equal(out.outcome, "failed");
  assert.ok(out.note.includes("listener"), `the note must name the listener: ${out.note}`);
  // Nothing is diverted to, so an undiverted run would be a real request.
  assert.equal(ran, 0, "a run with nowhere to divert must not happen");
  assert.ok(!out.note.includes("\n"), out.note);
});

test("ping mode makes a real request and opens no listener", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const refresh = claudeRefresher(
    "ping",
    async (file, args) => {
      calls.push({ file, args });
      return { text: "hello" };
    },
    // Nothing is diverted, so a listener here would be a leaked port.
    async () => {
      throw new Error("ping mode must open no listener");
    },
  )!;

  assert.deepEqual(await refresh(), { outcome: "pinged" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "claude");
  assert.deepEqual(calls[0].args, claudePingArgs());
});

test("ping mode reports a non-lock failure as failed", async () => {
  const refresh = claudeRefresher(
    "ping",
    async () => ({ error: "boom" }),
    async () => {
      throw new Error("ping mode must open no listener");
    },
  )!;

  const out = await refresh();

  assert.equal(out.outcome, "failed");
  assert.ok(!out.note.includes("\n"), out.note);
});

// ---------------------------------------------------------------- execFileRunner

// Round-2 New-4 / contract §D: nothing checked the process wiring the ping's
// *default* runner depends on — neither the stripped environment nor the closed
// stdin. `execFileRunner` is the real runner, so these drive it directly, with a
// shell rather than `claude`, and a short timeout.
test("execFileRunner hands the child the ping's environment, stripped and inherited", async () => {
  const env = claudePingEnv({
    ...process.env,
    ANTHROPIC_API_KEY: "must-not-reach-the-child",
    ANTHROPIC_BASE_URL: "http://must-not-reach-the-child",
    // Present only in the environment handed to the runner, so its arrival
    // proves the child got *this* env and not the parent's.
    PQD_ENV_PROBE: "reached-the-child",
  });
  const run = execFileRunner(5_000, env);

  const probe =
    'printf "%s\\n%s\\n%s\\n%s" "${ANTHROPIC_API_KEY-<unset>}" "${ANTHROPIC_BASE_URL-<unset>}" "${PQD_ENV_PROBE-<unset>}" "$PATH"';
  const result = await run("/bin/sh", ["-c", probe]);

  assert.ok("text" in result, `the probe must run: ${JSON.stringify(result)}`);
  const [apiKey, baseUrl, marker, path] = result.text.split("\n");
  assert.equal(apiKey, "<unset>", "a stripped credential variable must not reach the child");
  assert.equal(baseUrl, "<unset>", "a stripped base URL must not reach the child");
  assert.equal(marker, "reached-the-child", "the environment handed in must be the child's environment");
  assert.equal(path, process.env.PATH ?? "", "an inherited variable like PATH must survive");
});

// The fault this catches: a child that waits for stdin the caller never closes,
// so every refresh ping that reads stdin would run to the 10-second timeout.
// `cat` is the smallest reader there is; it is not `claude`.
test("execFileRunner closes the child's stdin, so a reader returns instead of timing out", async () => {
  const timeoutMs = 1_500;
  const run = execFileRunner(timeoutMs, { ...process.env });

  const started = Date.now();
  const result = await run("/bin/cat", []);
  const elapsedMs = Date.now() - started;

  // Without the stdin close this is the timeout: the runner kills `cat` and
  // answers with `timed out after …`, so `text` is what separates the two.
  assert.ok("text" in result, `cat must see EOF, not the timeout: ${JSON.stringify(result)}`);
  assert.equal(result.text, "", "cat reads stdin, which is empty at EOF");
  assert.ok(elapsedMs < timeoutMs, `EOF must not wait out the ${timeoutMs}ms timeout (took ${elapsedMs}ms)`);
});

// ---------------------------------------------------------------- refreshPlan

// The mode and the default-path decision is made in exactly one place, and the
// plan says whether the mode can spend budget — which is what makes a repeat of
// a `failed` ping in that mode pointless.
test("refreshPlan marks only ping mode as spending, for an injected ping", () => {
  const injected: ClaudeRefresh = async () => ({ outcome: "pinged" });

  const offline = refreshPlan({ ...DEFAULT_CONFIG, claudeRefresh: "offline-ping" }, injected);
  assert.ok("ping" in offline, "an injected ping is always usable");
  assert.equal(offline.ping, injected);
  assert.equal(offline.spends, false);

  const spending = refreshPlan({ ...DEFAULT_CONFIG, claudeRefresh: "ping" }, injected);
  assert.ok("ping" in spending);
  assert.equal(spending.ping, injected);
  assert.equal(spending.spends, true, "ping mode makes a real request");

  // An injected ping is used whatever the path says: it is a statement about the
  // profile already, so the default-path rule does not apply to it.
  const elsewhere = refreshPlan(
    { ...DEFAULT_CONFIG, claudeRefresh: "offline-ping", claudeCredsPath: "/other/profile/credentials.json" },
    injected,
  );
  assert.ok("ping" in elsewhere);
  assert.equal(elsewhere.ping, injected);
});

test("refreshPlan names another profile before it ever looks at the mode", () => {
  const plan = refreshPlan({
    ...DEFAULT_CONFIG,
    claudeRefresh: "offline-ping",
    claudeCredsPath: "/other/profile/credentials.json",
  });
  assert.ok("skip" in plan);
  assert.equal(plan.skip, "claudeCredsPath names another profile");
});

test("refreshPlan skips with the key when the mode is off on the default path", () => {
  const plan = refreshPlan({ ...DEFAULT_CONFIG, claudeRefresh: "off" });
  assert.ok("skip" in plan);
  assert.equal(plan.skip, 'claudeRefresh is "off"');
});

test("refreshPlan resolves the production refresher for the default path", () => {
  // HOME is redirected above, so `DEFAULT_CONFIG.claudeCredsPath` is inside a
  // temp dir and this is the default path. The plan is only inspected — calling
  // the ping would start `claude`, and the stub on PATH is a tripwire, not a
  // fixture this test leans on.
  const plan = refreshPlan({ ...DEFAULT_CONFIG, claudeRefresh: "offline-ping" });
  assert.ok("ping" in plan, "the default path and a non-off mode yield a ping");
  assert.equal(typeof plan.ping, "function");
  assert.equal(plan.spends, false);
});

// ---------------------------------------------------------------- loopbackListener

test("loopbackListener answers a real request with a 400 and records nothing about it", async () => {
  const listener = await loopbackListener();
  try {
    assert.equal(listener.arrived(), false, "nothing has arrived before a request");
    // A healthy socket that has not failed reports no error.
    assert.equal(listener.error(), undefined, "a fresh listener has no socket error");
    assert.ok(
      listener.url.startsWith("http://127.0.0.1:"),
      `the listener must bind loopback only: ${listener.url}`,
    );

    const secret = "SECRET-ACCESS-TOKEN-do-not-record";
    const res = await fetch(`${listener.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await res.text();

    assert.equal(res.status, 400, "the diverted request must be refused, not answered");
    assert.doesNotThrow(() => JSON.parse(body), `a JSON error body: ${body}`);
    assert.equal(listener.arrived(), true, "an arriving request is the evidence the diversion worked");

    // The security assertion: that request carries a live access token, so the
    // listener is the one place it must never be held.
    assert.deepEqual(Object.keys(listener).sort(), ["arrived", "close", "error", "url"]);
    assert.ok(!JSON.stringify(listener).includes(secret), "the listener must not hold the token");
    assert.ok(!body.includes(secret), `the response body must not echo the request: ${body}`);
  } finally {
    await listener.close();
  }
});

test("loopbackListener close frees the port and is safe to call twice", async () => {
  const listener = await loopbackListener();
  const url = listener.url;

  await listener.close();
  await listener.close();

  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }), (err: unknown) => {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const text = `${(err as Error).message} ${String(cause?.code ?? "")}`;
    return text.includes("ECONNREFUSED");
  }, "a closed listener's port must be free");
});

test("two loopbackListeners bind different ports", async () => {
  const first = await loopbackListener();
  const second = await loopbackListener();
  try {
    // Ephemeral ports mean there is no fixed port to collide over.
    assert.notEqual(first.url, second.url);
  } finally {
    await first.close();
    await second.close();
  }
});

// ---------------------------------------------------------------- config

test("claudeRefresh defaults to off", () => {
  assert.equal(DEFAULT_CONFIG.claudeRefresh, "off");
  assert.equal(defaultConfig("/opt/pi/agent").claudeRefresh, "off");
});

test("claudeRefresh accepts exactly the three documented modes", () => {
  assert.deepEqual(CLAUDE_REFRESH_MODES, ["off", "offline-ping", "ping"]);
  for (const mode of CLAUDE_REFRESH_MODES) assert.equal(isClaudeRefreshMode(mode), true, mode);
  for (const bad of ["ocasionally", "OFF", "", "offline", 42, null, undefined, true]) {
    assert.equal(isClaudeRefreshMode(bad), false, String(bad));
  }
});

test("claudeRefresh applies a valid mode from a layer", () => {
  const r = mergeConfig(defaultConfig("/opt/pi/agent"), [
    { source: "project", data: { claudeRefresh: "offline-ping" } },
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.claudeRefresh, "offline-ping");
  assert.equal(r.sources.claudeRefresh, "project");
});

test("an unknown claudeRefresh warns and leaves the lower layer's value standing", () => {
  const r = mergeConfig(defaultConfig("/opt/pi/agent"), [
    { source: "global", data: { claudeRefresh: "offline-ping" } },
    { source: "project", data: { claudeRefresh: "ocasionally" } },
  ]);
  // A typo must not turn the feature off, nor silently enable it: the value
  // beneath it stays.
  assert.equal(r.config.claudeRefresh, "offline-ping");
  assert.equal(r.sources.claudeRefresh, "global");
  assert.ok(
    r.warnings.some((w) =>
      w.includes('"claudeRefresh" must be one of "off", "offline-ping", "ping"'),
    ),
    r.warnings.join("\n"),
  );
});

test("describeConfig reports claudeRefresh", () => {
  const merged = mergeConfig(defaultConfig("/opt/pi/agent"), []);
  const lines = describeConfig({
    config: merged.config,
    files: [],
    sources: merged.sources,
    warnings: merged.warnings,
  });
  assert.ok(lines.includes("  claudeRefresh = off  [built-in]"), lines.join("\n"));
});

// ---------------------------------------------------------------- dispatcher

const TEMPLATE = (name: string, model: string) =>
  `---\nname: ${name}\ndescription: x\nmodel: "${model}"\nthinking: high\n---\n\nBody.\n`;

/** `planner` is claude-primary, so an unreadable claude rail must hold it. */
const AGENT_ROUTES: Record<string, AgentRoute> = {
  planner: {
    primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
    alternates: [{ model: "openai-codex/gpt-6-sol", rail: "codex" }],
  },
};

interface Fixture {
  agentDir: string;
  claudeCredsPath: string;
  piAuthPath: string;
}

/** A self-contained dispatcher fixture, so no test touches the real credential. */
async function fixture(plannerModel = "claude-bridge/claude-opus-5-5"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-refresh-"));
  const agentDir = join(root, "agents");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "planner.md"), TEMPLATE("planner", plannerModel), "utf8");
  const claudeCredsPath = join(root, "claude-credentials.json");
  const piAuthPath = join(root, "pi-auth.json");
  await writeFile(
    piAuthPath,
    JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct-test" } }),
    "utf8",
  );
  return { agentDir, claudeCredsPath, piAuthPath };
}

/** The only network boundary; records the bearer token each call carried. */
function stubFetch(seenAuth: string[] = [], codexLimited = false) {
  return (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const auth = init?.headers?.Authorization;
    if (auth) seenAuth.push(auth);
    if (u.includes("anthropic.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      };
    }
    if (u.includes("chatgpt.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            limit_reached: codexLimited,
            primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 3600 },
            secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 400000 },
          },
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

test("a healthy claude credential never starts a refresh ping", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "live", expiresAt: NOW + 3_600_000 }),
    "utf8",
  );
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "pinged" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => NOW, refreshClaude },
  );

  const state = await d.railState("claude", true);

  assert.equal(state.ok, true, state.note);
  assert.equal(refreshes, 0, "a readable credential is no reason to run anything");
});

test("a credential failure that is not an expiry is reported unchanged, with no ping", async () => {
  const fx = await fixture();
  await writeFile(fx.claudeCredsPath, JSON.stringify({}), "utf8");
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "failed", note: "x" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), now: () => NOW, refreshClaude },
  );

  const state = await d.railState("claude", true);

  assert.equal(state.ok, false);
  // A store that never yielded a token is not an expiry a ping fixes, so the
  // store's own message reaches the rail unreworded.
  assert.equal(state.note, "no claudeAiOauth.accessToken");
  assert.equal(refreshes, 0);
});

test("an expired credential is refreshed, and the rail reads with the new token", async () => {
  // The file starts on the alternate, so a decision that proceeds has somewhere
  // to move the agent *to*.
  const fx = await fixture("openai-codex/gpt-6-sol");
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  const seenAuth: string[] = [];
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    // What Claude Code does as a side effect of the ping: rewrite its own store.
    await writeFile(
      fx.claudeCredsPath,
      cred({ accessToken: "refreshed-token", expiresAt: NOW + 3_600_000 }),
      "utf8",
    );
    return { outcome: "pinged" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(seenAuth), readKeychain: noKeychain, now: () => NOW, refreshClaude },
  );

  const state = await d.railState("claude", true);

  assert.equal(state.ok, true, state.note);
  assert.equal(state.note, undefined, "a readable rail carries no note");
  assert.equal(refreshes, 1);
  // The re-read is the point: the usage request must carry the token the ping
  // landed, not the stale one.
  assert.deepEqual(seenAuth, ["Bearer refreshed-token"]);

  // A refreshed rail is not just a green reading: the decision it unblocks must
  // actually proceed, or the whole exercise bought nothing. The agent starts on
  // the alternate, so a decision that proceeds has to move it back.
  const path = join(fx.agentDir, "planner.md");
  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;
  assert.equal(planner.decision.kind, "assign", planner.decision.why);
  assert.equal(
    planner.decision.kind === "assign" ? planner.decision.model : "",
    "claude-bridge/claude-opus-5-5",
    planner.decision.why,
  );
  assert.equal(planner.outcome, "written", "the agent must move onto the refreshed rail");
  assert.match(await readFile(path, "utf8"), /^model: "claude-bridge\/claude-opus-5-5"$/m);
  assert.equal(refreshes, 1, "the freshness came from the first ping, not a second");
});

test("an expired credential the ping cannot fix holds, and the note names the attempt", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  const refreshClaude: ClaudeRefresh = async () => ({
    outcome: "failed",
    note: "claude: command not found",
  });
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => NOW, refreshClaude },
  );

  const state = await d.railState("claude", true);

  assert.equal(state.ok, false);
  assert.ok(state.note?.includes("refresh ping"), `the note must name the attempt: ${state.note}`);
  // The credential fact is the note's first half; the decision is appended to
  // it rather than replacing it.
  assert.ok(state.note?.includes("claude token expired"), state.note);
  // An offline-ping failure is a cooldown, not a halt: a transient failure is
  // worth one retry.
  assert.ok(!state.note?.includes("no further attempt will be made"), state.note);

  const path = join(fx.agentDir, "planner.md");
  const before = await readFile(path, "utf8");
  const results = await d.evaluate({ force: true });
  const planner = results.find((r) => r.decision.agent === "planner")!;

  // A failed refresh never becomes a decision made on evidence we do not have.
  assert.equal(planner.decision.kind, "hold", planner.decision.why);
  assert.equal(planner.outcome, "held");
  assert.equal(await readFile(path, "utf8"), before, "a held agent's file must not be rewritten");
});

test("claudeRefresh off skips the ping and says so in the note", async () => {
  const fx = await fixture();
  // The default path, so the skip names the key rather than a relocated profile.
  // No `refreshClaude` is injected, and `off` is the one mode that resolves none.
  const creds = DEFAULT_CONFIG.claudeCredsPath;
  await mkdir(dirname(creds), { recursive: true });
  await writeFile(creds, cred({ accessToken: "stale", expiresAt: NOW - 1_000 }), "utf8");

  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeCredsPath: creds, claudeRefresh: "off", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => NOW },
  );

  const state = await d.railState("claude", true);

  assert.equal(state.ok, false, "with no refresh the expired credential stays expired");
  assert.ok(state.note?.includes("claudeRefresh"), `the note must name the key: ${state.note}`);
  assert.ok(state.note?.includes("no refresh ping was run"), state.note);
  // The tripwire: `off` must resolve no refresher, so nothing may reach the
  // stub on PATH, let alone the real binary behind it.
  assert.equal(await claudeInvocations(), 0, "off must not spawn claude");
});

test("a non-default claudeCredsPath leaves the mode inert and says so in the note", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  // No `refreshClaude` injected: this is the path rule under test. The ping
  // refreshes this machine's default profile, so another profile's file must
  // not be able to start one.
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => NOW },
  );

  const state = await d.railState("claude", true);

  assert.equal(state.ok, false);
  assert.ok(state.note?.includes("claudeCredsPath"), `the note must name the path rule: ${state.note}`);
  // The gate is what keeps another profile's file from starting a ping; the
  // tripwire proves no `claude` was spawned when it held.
  assert.equal(await claudeInvocations(), 0, "a relocated profile must not spawn claude");
});

test("a failed ping is not retried inside the cooldown, and is after it", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "failed", note: "boom" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  for (let i = 0; i < 3; i++) {
    const state = await d.railState("claude", true);
    assert.ok(state.note?.includes("refresh ping"), `attempt ${i}: ${state.note}`);
    // A cooldown is not a halt: the note must leave the retry open.
    assert.ok(!state.note?.includes("no further attempt will be made"), state.note);
  }
  // A dead refresh token must not mean a subprocess per poll.
  assert.equal(refreshes, 1, "inside the cooldown the attempt is not repeated");

  clock = NOW + CLAUDE_PING_COOLDOWN_MS;
  await d.railState("claude", true);
  assert.equal(refreshes, 2, "the cooldown expires and the next read may try again");
});

// Round-2 New-4 / contract §D. The gate must not re-arm on a hit: `pollMs`
// ships at five minutes and the cooldown at fifteen, so a hit that reset `at`
// would push the retry past every poll that follows and the ping would never be
// tried again after one transient failure. Advancing the clock *inside* the
// window is what catches it — without a move, a re-armed gate is indistinguish-
// able from a gate that held, which is how round 1 left this untested.
test("a cooldown gate hit does not re-arm the cooldown", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "failed", note: "boom" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  await d.railState("claude", true); // arms the cooldown at NOW

  // Three polls strictly inside the window. A re-armed gate would restart the
  // window from the last of them.
  for (const offset of [60_000, 300_000, 840_000]) {
    clock = NOW + offset;
    const state = await d.railState("claude", true);
    assert.ok(state.note?.includes("refresh ping"), `offset ${offset}: ${state.note}`);
    assert.equal(refreshes, 1, `offset ${offset}: a gate hit must not attempt`);
  }

  // Exactly at the end of the window armed by the attempt — not by the last
  // hit. A re-armed gate is still holding here, so this is the assertion that
  // fails on it.
  clock = NOW + CLAUDE_PING_COOLDOWN_MS;
  await d.railState("claude", true);
  assert.equal(refreshes, 2, "the window runs from the attempt, not from the last gate hit");
});

test("a deferred ping does not arm the cooldown", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "deferred", note: "another Claude Code process is holding the refresh lock" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => NOW, refreshClaude },
  );

  const first = await d.railState("claude", true);
  const second = await d.railState("claude", true);

  // A collided ping is the other process's work in flight, so the next read
  // must try again rather than being locked out for a quarter of an hour.
  assert.equal(refreshes, 2, "a deferral is not a failure to back off from");
  assert.ok(
    first.note?.includes("another Claude Code process is holding the refresh lock"),
    first.note,
  );
  assert.ok(!second.note?.includes("no further attempt will be made"), second.note);
});

test("concurrent evaluations make exactly one ping attempt", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { outcome: "failed", note: "boom" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => NOW, refreshClaude },
  );

  await Promise.all([d.railState("claude", true), d.railState("claude", true)]);

  // startup, the poll, and `/quota-dispatch refresh` can all race here.
  assert.equal(refreshes, 1, "concurrent readers must share one attempt");
});

// ---------------------------------------------------------------- the halt

// A ping that could have spent money — or that ran and did not work — gets no
// second attempt. `undiverted` is the loudest of those: a clean exit with no
// arrival means the model call was answered somewhere else, so the diversion the
// whole design rests on may have failed at the cost of a real request.
test("an undiverted ping halts: no second attempt, and the note says so", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return {
      outcome: "undiverted",
      note: "claude exited before the request reached the loopback listener",
    };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  const first = await d.railState("claude", true);
  assert.equal(first.ok, false);
  assert.ok(first.note?.includes("no further attempt will be made"), first.note);
  assert.equal(refreshes, 1);

  // Far past the cooldown: a halt is not a cooldown that expires. A gate hit
  // never re-arms and never retries.
  clock = NOW + CLAUDE_PING_COOLDOWN_MS * 10;
  const second = await d.railState("claude", true);
  assert.equal(refreshes, 1, "a spent attempt must never be repeated");
  assert.ok(second.note?.includes("no further attempt will be made"), second.note);
});

test("a pinged ping that left the token expired halts", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  // The ping ran; the store's answer is the re-read, and it did not take.
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "pinged" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  const first = await d.railState("claude", true);
  assert.equal(first.ok, false);
  assert.ok(first.note?.includes("no further attempt will be made"), first.note);

  clock = NOW + CLAUDE_PING_COOLDOWN_MS * 10;
  await d.railState("claude", true);
  assert.equal(refreshes, 1, "a run that did not work will not work next time either");
});

// `failed` is a cooldown in the offline ping (nothing was spent), but in the
// mode that makes a real request a repeat can only pay again — so it halts.
test("a failed ping halts at once in the mode that spends budget", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "failed", note: "boom" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  const first = await d.railState("claude", true);
  assert.equal(first.ok, false);
  assert.ok(first.note?.includes("no further attempt will be made"), first.note);

  // Past where an offline failure would retry: `ping` mode must not.
  clock = NOW + CLAUDE_PING_COOLDOWN_MS * 10;
  await d.railState("claude", true);
  assert.equal(refreshes, 1, "a repeat could only pay again");
});

// Round-2 New-1 / contract §A: the case round 1 left silent. An `undiverted`
// run is a real request that may have been paid for — a property of the
// environment, not of that expiry. If the run also refreshed the token, the old
// code read a healthy rail, cleared the halt, and reported nothing, so every
// later expiry paid again. The halt is session-sticky, the anomaly rides on the
// *healthy* rail, `report` renders it, and a later expiry makes no attempt.
test("an undiverted ping is reported on the healthy rail and never retried", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    // What Claude Code may do as a side effect of a run whose request never
    // reached our listener: refresh its own store anyway. Round 1 mistook that
    // fresh token for recovery.
    await writeFile(
      fx.claudeCredsPath,
      cred({ accessToken: "fresh", expiresAt: NOW + 3_600_000 }),
      "utf8",
    );
    return {
      outcome: "undiverted",
      note: "claude exited before the request reached the loopback listener",
    };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  const first = await d.railState("claude", true);
  assert.equal(refreshes, 1);
  // The re-read *did* yield a token, so the rail is healthy — but a paid
  // anomaly is not something a usable token can undo.
  assert.equal(first.ok, true, first.note);
  assert.ok(first.note?.includes("no further attempt will be made"), first.note);
  assert.match(first.note ?? "", /undiverted/i, String(first.note));

  // §A.3: "an anomaly to report" is not met unless it reaches the report line,
  // which is the one place the user sees a healthy rail.
  const lines = await d.report({ force: true });
  const reported = lines.find((l) => l.startsWith("claude: "));
  assert.ok(reported, `the report must have a claude line:\n${lines.join("\n")}`);
  assert.ok(!reported.startsWith("claude: unavailable"), reported);
  assert.ok(reported.includes("no further attempt will be made"), reported);
  assert.match(reported, /undiverted/i, reported);

  // Sticky: the token the anomaly left behind does not clear the halt, so a
  // later expiry in the same dispatcher makes no further attempt.
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale-again", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  clock = NOW + CLAUDE_PING_COOLDOWN_MS * 10;
  const later = await d.railState("claude", true);
  assert.equal(refreshes, 1, "a sticky anomaly must never be retried");
  assert.equal(later.ok, false, later.note);
  assert.ok(later.note?.includes("no further attempt will be made"), later.note);
});

// §A.3 generalises: a note on an otherwise healthy rail must reach the reader,
// not only the sticky Claude anomaly. Codex's `limit_reached=true` was the same
// silently dropped note.
test("a healthy rail's note reaches the report line", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "live", expiresAt: NOW + 3_600_000 }),
    "utf8",
  );
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, agents: AGENT_ROUTES },
    { fetchImpl: stubFetch([], true), readKeychain: noKeychain, now: () => NOW },
  );

  const lines = await d.report({ force: true });
  const codexLine = lines.find((l) => l.startsWith("codex: "));
  assert.ok(codexLine, `the report must have a codex line:\n${lines.join("\n")}`);
  assert.ok(codexLine.includes(" — limit_reached=true"), codexLine);

  // The note is the rail's, not a blanket suffix: a rail without one stays bare.
  const claudeLine = lines.find((l) => l.startsWith("claude: "));
  assert.ok(claudeLine, `the report must have a claude line:\n${lines.join("\n")}`);
  assert.ok(!claudeLine.includes(" — "), claudeLine);
});

// Only the per-episode halves of the halt — a `pinged` run that left the store
// unusable, and a `failed` one in the spending mode — end with the expiry, so a
// token read afterwards clears them. `undiverted` is sticky and is deliberately
// not cleared here; the test above covers that.
test("a per-episode halt is cleared once the store yields a token again", async () => {
  const fx = await fixture();
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "stale", expiresAt: NOW - 1_000 }),
    "utf8",
  );
  let clock = NOW;
  let refreshes = 0;
  // The ping ran but left the store stale, so this halt is about the expiry
  // episode rather than about the environment.
  const refreshClaude: ClaudeRefresh = async () => {
    refreshes++;
    return { outcome: "pinged" };
  };
  const d = createDispatcher(
    { ...DEFAULT_CONFIG, ...fx, claudeRefresh: "offline-ping", agents: AGENT_ROUTES },
    { fetchImpl: stubFetch(), readKeychain: noKeychain, now: () => clock, refreshClaude },
  );

  const halted = await d.railState("claude", true);
  assert.equal(halted.ok, false);
  assert.ok(halted.note?.includes("no further attempt will be made"), halted.note);
  assert.equal(refreshes, 1);

  // The user fixes it by hand, so the store now holds a usable token. That is
  // the end of the expiry episode, and this halt goes with it.
  await writeFile(
    fx.claudeCredsPath,
    cred({ accessToken: "fresh", expiresAt: NOW + 3_600_000 }),
    "utf8",
  );
  const recovered = await d.railState("claude", true);
  assert.equal(recovered.ok, true, recovered.note);

  // A later expiry is a new episode, and may be met with a ping again.
  await writeFile(fx.claudeCredsPath, cred({ accessToken: "stale-again", expiresAt: clock - 1_000 }), "utf8");
  clock = NOW + CLAUDE_PING_COOLDOWN_MS * 10;
  await d.railState("claude", true);
  assert.equal(refreshes, 2, "a recovered episode must be able to ping again");
});

// The zero-count checks above are only evidence if the tripwire itself works:
// a missing, skipped, or non-executable stub would make "no claude was spawned"
// true for the wrong reason. This proves `claude` on PATH resolves to the stub,
// and that the stub records a real spawn — by absolute path, so the proof itself
// cannot fall through to a real binary. It then empties the log so it cannot
// colour any later assertion.
//
// Round-2 New-3 / contract §C: the old self-test spawned `claude` through the
// PATH lookup it was trying to prove, so on a `noexec` temp mount `execvp` would
// skip the stub and run the next `claude` on PATH — a real, possibly paid call
// before the test could fail. Executability is asserted first (again, for the
// message), and `command -v` resolves the name without running it.
test("PATH resolves claude to the stub, and the stub records a spawn", async () => {
  await assertStubExecutable();
  const before = await claudeInvocations();

  // `command -v` is a shell lookup, not an execution, so a wrong PATH answer
  // fails here without ever reaching a binary.
  const resolved = await new Promise<string>((resolve, reject) => {
    execFile("/bin/sh", ["-c", "command -v claude"], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
  assert.equal(resolved, STUB_CLAUDE, "the first executable claude on PATH must be the stub");

  await new Promise<void>((resolve) => {
    execFile(STUB_CLAUDE, ["-p", "hi"], () => resolve());
  });

  assert.equal(await claudeInvocations(), before + 1, "the stub on PATH must record the spawn");
  await writeFile(STUB_LOG, "", "utf8");
});
