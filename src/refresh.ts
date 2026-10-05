/**
 * The refresh ping delegates credential writes to Claude Code; its loopback
 * listener proves diversion without inspecting credentials. See
 * docs/adr/0007-refresh-pings.md.
 *
 * The shared runner and default-profile predicate live here so index.ts can
 * call them without this module importing the extension at runtime. The types
 * coming back from index.ts are erased, as in readings-file.ts.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  DEFAULT_CONFIG,
  errorText,
  type ClaudeRefreshMode,
  type DispatcherConfig,
} from "./config.ts";
import type { CommandRunner, CredentialRead } from "./index.ts";

/**
 * How long one refresh ping may run.
 *
 * Longer than a keychain read because it does far more work — a binary's start
 * plus a token refresh — and because its failure lasts longer: an expired token
 * stays expired for the rest of the day, where a missed keychain read costs one
 * reading. The measurements behind the number, and the residual risk of killing
 * a run whose token request is in flight, are in
 * docs/adr/0007-refresh-pings.md.
 *
 * The bound need not be tight to be safe, which is what makes it holdable: the
 * refresh is written *before* the request is dispatched, so whatever landed is
 * found by the re-read either way.
 */
export const CLAUDE_PING_TIMEOUT_MS = 10_000;

/**
 * How long after a failed ping before another may be made.
 *
 * A dead refresh token must not mean a subprocess per poll: `pollMs` ships at
 * five minutes, so without this every poll for the rest of the day would start
 * one. This is a time gate, armed by a `failed` attempt only — a transient
 * failure worth exactly one retry, a missing binary or a stall before any
 * request. An attempt that could have spent money, or ran without effect, arms
 * a per-episode `halted` instead (see `recordVerdict`).
 */
export const CLAUDE_PING_COOLDOWN_MS = 900_000;

/**
 * Whether the login keychain belongs to the credential file at this path.
 *
 * The keychain holds the credential of the *default* Claude Code profile only:
 * a `CLAUDE_CONFIG_DIR` profile keeps its credential in its own file and never
 * writes the keychain. A `claudeCredsPath` naming anything but the default file
 * therefore belongs to a different account, and the keychain must not answer
 * for it — reporting one account's headroom while work draws on another is
 * worse than reporting nothing.
 */
export function isDefaultClaudeCredsPath(path: string): boolean {
  return path === DEFAULT_CONFIG.claudeCredsPath;
}

/**
 * The real runner, for one subprocess: its stdout is the value read back, and a
 * failure is reported as the one line a reader can act on — what the command
 * said, its exit code when it said nothing, or the reason the process never ran.
 *
 * `env` narrows the child's environment; left off, the child inherits this
 * process's, which is what every runner here but the refresh ping wants.
 */
export function execFileRunner(timeoutMs: number, env?: NodeJS.ProcessEnv): CommandRunner {
  return (file, args) =>
    new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          ...(env === undefined ? {} : { env }),
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ text: stdout.trim() });
          resolve({ error: failureDetail(err, stderr, timeoutMs) });
        },
      );
      // A child that reads stdin would otherwise wait for input that is never
      // coming until the timeout kills it; ending the pipe hands it EOF instead.
      //
      // Spawn's `stdio: ["ignore", ...]` cannot do this, because `execFile`
      // discards that option and rebuilds its own spawn options — a `cat` run
      // through the documented form still hung for the full timeout.
      child.stdin?.end();
    });
}

/**
 * One line, because this ends up in a one-line report: the command's own
 * message when it printed one, otherwise the spawn failure's.
 */
function failureDetail(err: Error, stderr: string, timeoutMs: number): string {
  if ((err as { killed?: boolean }).killed) return `timed out after ${timeoutMs}ms`;
  const said = firstLine(stderr) ?? firstLine(err.message);
  const code = (err as { code?: unknown }).code;
  return said ?? (typeof code === "number" ? `exit ${code}` : "failed");
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * The loopback socket a refresh ping's model request is diverted to.
 *
 * A listener rather than an unroutable port, for two reasons measured in
 * docs/adr/0007-refresh-pings.md: it ends the run promptly, and a request
 * *arriving* is the only evidence that the diversion took effect — the command
 * exits non-zero either way, so a run that died on this socket and one that
 * failed to authenticate are indistinguishable by exit status. Without that
 * evidence an override which silently did not apply would spend a real request
 * while being reported as a failed refresh.
 */
export interface PingListener {
  /** The base URL the ping's `--settings` carries. */
  url: string;
  /**
   * Whether the diverted request turned up.
   *
   * Headers are never read: the request carries the freshly refreshed access
   * token in an `Authorization` header, and a listener that recorded one would
   * be the only place in this extension that holds a credential.
   */
  arrived(): boolean;
  /**
   * The socket's own failure after it began listening, if any.
   *
   * A live listener has no caller left to reject, so an `'error'` event cannot
   * be passed up the way a failed bind is; dropping it would take the whole pi
   * process down, and swallowing it would let a broken socket masquerade as a
   * clean exit that never reached the listener. Recorded here so the refresher
   * reports it as the failure it is.
   */
  error(): string | undefined;
  close(): Promise<void>;
}

/** Opens a listener. A seam, so the refresher's failure paths are testable. */
export type PingListenerFactory = () => Promise<PingListener>;

/**
 * What became of one refresh ping.
 *
 * Cases rather than a success flag, because the caller does three different
 * things with the answer: the rail's note is built from how the attempt went,
 * `failed` arms a cooldown, and the outcomes that could have spent money or ran
 * without effect arm a halt for the rest of the expiry. The credential is
 * re-read after any of them, including `failed`: the refresh is written *before*
 * the request is dispatched, so a command that failed afterwards can still have
 * left a fresh token behind.
 */
export type ClaudePing =
  /**
   * The command ran far enough to dispatch its model request — in the diverted
   * form, the request arrived on our own listener. Whether a fresh token came
   * back is the store's answer, not ours: re-read it.
   */
  | { outcome: "pinged" }
  /**
   * Another Claude Code process holds the refresh lock and is refreshing the
   * token itself. Benign, and a deferral rather than a failure: the next read is
   * what finds its work.
   */
  | { outcome: "deferred"; note: string }
  /**
   * The command exited cleanly with no request on the listener.
   *
   * A clean exit means the model call was *answered* — so it was answered
   * somewhere else, and the diversion this whole design rests on may have
   * silently failed at the cost of a real request. Deliberately not `failed`:
   * `failed` is "nothing appears to have happened", this is "something happened
   * and it was not what we asked for".
   */
  | { outcome: "undiverted"; note: string }
  /** The ping could not be run, or ran and failed before dispatching. */
  | { outcome: "failed"; note: string };

/** One refresh ping: makes Claude Code refresh its own credential. */
export type ClaudeRefresh = () => Promise<ClaudePing>;

/**
 * The argv of one refresh ping.
 *
 * `divertTo` is the loopback listener's base URL, carried in `--settings`
 * because that is the one way to hand it over without widening `CommandRunner`
 * past `(file, args)`. Without it the ping is a real request — the `ping` mode,
 * which spends a real answer's worth of tokens.
 *
 * There is no `--model`. An id the running install does not recognise is
 * rejected client-side, before authentication is reached, which is the one
 * outcome that would defeat the whole exercise; and the diverted form encodes
 * nothing, so no model need be named to ask for it.
 */
export function claudePingArgs(divertTo?: string): string[] {
  if (divertTo === undefined) return ["-p", "hi"];
  return ["-p", "hi", "--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: divertTo } })];
}

/**
 * Vendor text: Claude Code saying another of its processes is already holding
 * the refresh lock. Matched loosely because the wording is not ours and may
 * change; a miss is harmless — the attempt is reported as failed and arms one
 * 15-minute cooldown, which costs a retry delay and never a wrong answer.
 */
const REFRESH_LOCK_RE = /refresh lock/i;

/**
 * What a diverted ping that exited cleanly without dispatching is reported as,
 * in one line.
 *
 * Fixed rather than quoting whatever the command printed: a clean-exit run that
 * never dispatched reached its failure in Claude Code's own output, which names
 * the account, so the note must carry none of it.
 */
const PING_UNDIVERTED_NOTE = "claude exited before the request reached the loopback listener";

/**
 * The refresh ping for one mode, or `undefined` when the mode is `off` — so that
 * no caller can run one that is not enabled, the shape `keychainReader` uses for
 * a platform with no keychain.
 *
 * `run` and `listen` are seams: the first so every argument and failure path can
 * be tested without a `claude` on the machine running the tests, the second so
 * that "no request arrived" can be tested without a socket.
 *
 * The diverted mode is judged by arrival, not by exit status. The 400 the
 * listener answers with makes the command exit non-zero on its own, so a run
 * that landed the refresh and a run that failed to authenticate look identical
 * from outside; only a request on our own socket proves the diversion took
 * effect — and an override that silently did not would spend a real request.
 * `ping` mode has no listener to prove anything with, so there a clean exit is
 * the proof that a real answer came back.
 */
export function claudeRefresher(
  mode: ClaudeRefreshMode,
  run: CommandRunner = execFileRunner(CLAUDE_PING_TIMEOUT_MS, claudePingEnv(process.env)),
  listen: PingListenerFactory = loopbackListener,
): ClaudeRefresh | undefined {
  if (mode === "off") return undefined;

  if (mode === "ping") {
    return async () => {
      const result = await run("claude", claudePingArgs());
      if ("text" in result) return { outcome: "pinged" };
      if (REFRESH_LOCK_RE.test(result.error)) return { outcome: "deferred", note: oneLine(result.error) };
      return { outcome: "failed", note: oneLine(result.error) };
    };
  }

  return async () => {
    let listener: PingListener;
    try {
      listener = await listen();
    } catch (err) {
      return { outcome: "failed", note: `could not open the loopback listener: ${oneLine(errorText(err))}` };
    }
    let result: CredentialRead;
    try {
      result = await run("claude", claudePingArgs(listener.url));
    } catch (err) {
      result = { error: errorText(err) };
    } finally {
      // In a `finally` so a throwing runner still frees the port; the session
      // start awaits this path, and a socket left open is a session left waiting.
      await listener.close();
    }
    if (listener.arrived()) return { outcome: "pinged" };
    // A socket of our own that broke is a failure, and naming it keeps it from
    // reading as the clean exit that never diverted — which would arm the
    // sticky halt on the strength of our own bug.
    const listenerError = listener.error();
    if (listenerError !== undefined) {
      return { outcome: "failed", note: `loopback listener failed: ${oneLine(listenerError)}` };
    }
    if ("error" in result && REFRESH_LOCK_RE.test(result.error)) {
      return { outcome: "deferred", note: oneLine(result.error) };
    }
    // A clean exit with no arrival: the request was answered somewhere else.
    if ("text" in result) return { outcome: "undiverted", note: PING_UNDIVERTED_NOTE };
    return { outcome: "failed", note: oneLine(result.error) };
  };
}

/**
 * The variables a refresh ping must not inherit.
 *
 * The ping exists to refresh *the* credential this dispatcher read, but it
 * inherits pi's environment, and the env can point Claude Code somewhere else in
 * four ways: which credential it uses, which provider serves the request, where
 * the request goes, and which model answers. A provider switch or a base URL
 * that this extension does not know about moves the model request off our
 * listener entirely, so the diverted ping becomes a billed request against
 * another provider — the one thing the diversion exists to prevent. `HOME` and
 * `PATH` are deliberately kept: the child still has to be an ordinary Claude
 * Code run.
 *
 * A denylist rather than an allowlist because the child must still run normally:
 * an allowlist would also have to be right about everything the child *needs* —
 * `PATH`, `HOME`, the login keychain, proxies — and being wrong there turns a
 * working refresh into a silent failure. An allowlist is worth doing once
 * someone has checked one against a live credential. The residual is bounded: a
 * selection variable this list does not know about shows up as an `undiverted`
 * run, which arms the sticky halt — one request at worst, never a loop.
 */
const CLAUDE_PING_ENV_EXCLUDE = [
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
  // Which model answers: an unrecognised id is rejected before authentication,
  // which would defeat the exercise.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
] as const;

/**
 * The environment one refresh ping runs under.
 *
 * Everything else — `PATH`, `HOME`, proxies, locale — is inherited, because the
 * child still has to be an ordinary Claude Code run. Pure, so the exact set of
 * variables is pinned by a test rather than by prose.
 */
export function claudePingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of CLAUDE_PING_ENV_EXCLUDE) delete clean[key];
  return clean;
}

/** The single line a failed command is reported by, whatever length it printed. */
function oneLine(detail: string): string {
  return firstLine(detail) ?? "claude failed";
}

/**
 * A loopback listener on an ephemeral port, bound to 127.0.0.1 only.
 *
 * The port is the OS's to choose, so there is no collision to handle and no
 * fixed port to be occupied. Every request is answered at once with a 400: enough
 * for the client to give up rather than retry, and a body it never has to write.
 * The body is drained, never inspected — the request carries the freshly
 * refreshed access token in an `Authorization` header, and a listener that read
 * one would be the only place in this extension holding a credential.
 */
export const loopbackListener: PingListenerFactory = async () => {
  let arrived = false;
  let listenerError: string | undefined;
  const server = createServer((req, res) => {
    arrived = true;
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "offline ping" } }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // A listening socket has no caller left to reject, but an `'error'` event with
  // no listener takes the whole pi process down with it. Record it instead: the
  // refresher reports the socket's own failure rather than letting it masquerade
  // as a clean exit that never reached the listener.
  server.on("error", (err) => {
    listenerError ??= errorText(err);
  });

  const address = server.address();
  // A TCP listener always yields an `AddressInfo`, so anything else here is a
  // failure to report rather than a port to invent a URL around.
  if (typeof address !== "object" || address === null) {
    await closeServer(server);
    throw new Error("loopback listener bound no TCP port");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    arrived: () => arrived,
    error: () => listenerError,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
};

/**
 * Ends every open connection before closing, so the close resolves promptly.
 *
 * `server.close` otherwise waits for the ping client's keep-alive socket to
 * end, and the session start awaits this refresh, so a close that waited out a
 * keep-alive would stall the very path the ping exists to unblock.
 *
 * The callback's error is deliberately dropped: it only ever means the server
 * was not listening, and the port is free either way, so there is nothing to
 * report and nothing to do about it.
 */
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * What an expired token will be met with: a ping, or the reason none can run.
 *
 * The mode and the default-path rule are both decided here so that the read
 * which skips a ping and the setup which would run one cannot disagree about
 * why.
 */
export type RefreshPlan = { ping: ClaudeRefresh; spends: boolean } | { skip: string };

/**
 * The single place the mode and the default-path rule are resolved.
 *
 * `injected` wins over both, as it does for the keychain reader: a test's
 * injected ping is a statement about which process may be spawned, and the
 * default-path rule is about whose *platform* keychain the default credential
 * file belongs to.
 *
 * `spends` marks the one mode whose every attempt is a real request, so a
 * failure there can only be answered by paying again — which is what makes it a
 * halt rather than a cooldown.
 */
export function refreshPlan(cfg: DispatcherConfig, injected?: ClaudeRefresh): RefreshPlan {
  if (injected) return { ping: injected, spends: cfg.claudeRefresh === "ping" };
  if (!isDefaultClaudeCredsPath(cfg.claudeCredsPath)) {
    return { skip: "claudeCredsPath names another profile" };
  }
  const ping = claudeRefresher(cfg.claudeRefresh);
  if (!ping) return { skip: 'claudeRefresh is "off"' };
  return { ping, spends: cfg.claudeRefresh === "ping" };
}
