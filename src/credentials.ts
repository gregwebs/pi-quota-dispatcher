/**
 * The three credentials this extension reads, and nothing about what they are
 * read for.
 *
 * A credential is text in a file or in the login keychain, parsed into the
 * `{ token }` or `{ error, reason }` shape one rail's read needs. Deciding
 * *whether* a credential is worth renewing is not done here: the Claude token's
 * refresh gate belongs to the dispatcher, which holds the machine-wide gates and
 * the one ping, so `readClaudeToken` only ever reports what the stores said. See
 * docs/adr/0021-a-rail-read-is-its-own-module.md.
 *
 * The Antigravity credential is the one that is renewed by this extension
 * asking someone else to, and that orchestration lives here because it is
 * acquisition — but it delegates the write to pi and never posts a refresh token
 * itself, for the reason ADR 0007 gives about Claude. See
 * docs/adr/0007-refresh-pings.md and docs/adr/0020-codex-credential-seam.md.
 */
import { existsSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, resolve } from "node:path";

import { execFileRunner, type CommandRunner, type CredentialRead } from "./exec.ts";
import { jsonObject } from "./json.ts";

// ---------------------------------------------------------------- the keychain

/**
 * The raw JSON text of the macOS login keychain item Claude Code keeps its
 * subscription credential in.
 */
export type KeychainRead = () => Promise<CredentialRead>;

/** The keychain item Claude Code writes its subscription credential to. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The macOS login keychain reader, or `undefined` on a platform that has no
 * such store — so that no caller can consult one that does not exist, and a
 * Linux install pays neither a subprocess nor an error line for it.
 *
 * On darwin it runs `security find-generic-password -a $USER -w -s "Claude
 * Code-credentials"`: the same call Claude Code and the Agent SDK make, against
 * the same item they write. `run` exists so that this argv is testable; the
 * real runner passes `security` a timeout, because a wedged keychain must not
 * stall the session start this is awaited from.
 */
export function keychainReader(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = execFileRead,
): KeychainRead | undefined {
  if (platform !== "darwin") return undefined;
  return () => run("security", keychainArgs());
}

/**
 * `security find-generic-password -a <user> -w -s "Claude Code-credentials"`,
 * the call that reads back what Claude Code wrote. `-a` is omitted only when
 * the user cannot be determined at all, in which case searching by service
 * alone is still the right guess; the keychain is per-user either way.
 */
function keychainArgs(): string[] {
  const account = currentUser();
  return [
    "find-generic-password",
    ...(account ? ["-a", account] : []),
    "-w",
    "-s",
    CLAUDE_KEYCHAIN_SERVICE,
  ];
}

/** `$USER` first, as the SDK does, then the passwd entry — which can be absent. */
function currentUser(): string | undefined {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * A stalled keychain must not stall the session start this read is awaited
 * from, so the read is bounded the way the vendors' own clients bound it.
 */
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5_000;

/** The keychain read: `security`'s stdout is the credential JSON itself. */
const execFileRead: CommandRunner = execFileRunner(CLAUDE_KEYCHAIN_TIMEOUT_MS);

// ------------------------------------------------------------------- Claude

/**
 * Why no store supplied a token, as the one distinction the caller acts on.
 *
 *   `expired`   a store answered and the token it holds has run out. Claude
 *               Code refreshing that store is exactly the fix, so this is the
 *               one failure a refresh ping is started for.
 *   `unusable`  no store answered, or none held a token at all. A ping would
 *               leave every one of those reasons standing.
 *
 * The message names the store and the cause; the tag exists so that nothing has
 * to read the message to know whether a ping is worth trying.
 */
export type TokenFailure = "expired" | "unusable";

/** One store's refusal, or both stores' refusals joined into one message. */
export interface ClaudeTokenError {
  error: string;
  reason: TokenFailure;
}

/** The Claude rail's token, or why no store supplied one. */
export type ClaudeToken = { token: string } | ClaudeTokenError;

/**
 * A store that answered with a failure of its own — a keychain read that could
 * not run, a file that could not be opened. Nothing a refresh ping fixes, which
 * is what makes it `unusable` rather than `expired`: the store never got as far
 * as a token whose age could be the problem.
 */
function storeFailure(error: string): ClaudeTokenError {
  return { error, reason: "unusable" };
}

/**
 * Pulls `claudeAiOauth.accessToken` out of one store's JSON text.
 *
 * `now` is a parameter rather than a call to `Date.now()` so that the expiry
 * comparison stays a pure function of its inputs. A token carrying no
 * `expiresAt` is used: the shaping Claude Code writes always carries one, and a
 * missing field is not evidence of expiry.
 *
 * The expiry message is the *fact* only — "claude token expired" — because it
 * is the first half of the note `fetchClaude` composes, and the second half is
 * whatever decision was made about it. Naming an action here would tell a
 * bridge user to run a command that only refreshes a credential the bridge
 * already owns.
 */
export function parseClaudeToken(text: string, now: number): ClaudeToken {
  let oauth: any;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch (err) {
    return storeFailure(`unreadable claude credentials: ${(err as Error).message}`);
  }
  if (!oauth?.accessToken) return storeFailure("no claudeAiOauth.accessToken");
  // Claude Code refreshes this on use; we only read it.
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < now) {
    return { error: "claude token expired", reason: "expired" };
  }
  return { token: oauth.accessToken };
}

export interface ClaudeTokenDeps {
  /**
   * Fallback store, consulted only when the file yields no usable token.
   *
   * On macOS the file is the store Claude Code *used* to write: the live token
   * lives in the login keychain, and only Claude Code refreshes it there. A file
   * that has gone stale is therefore the normal state for a machine driven
   * through a bridge rather than through `claude` directly.
   */
  keychain?: KeychainRead;
  /** Epoch milliseconds for the expiry comparison. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * The Claude rail's token, or why no store could supply one.
 *
 * The credential file is read first, so a healthy file behaves exactly as it
 * did before the keychain was consulted at all and an install with no keychain
 * pays nothing for it. Only when the file cannot answer — absent, unreadable,
 * shapeless, or holding an expired token — is the fallback read, and either
 * store's token wins on equal terms: the first one that yields an unexpired
 * token is the answer.
 *
 * When neither yields a token the error names both reasons, the file's first
 * and the keychain's as `; keychain: <reason>`, because "why can't the Claude
 * rail be read" is only answerable if the user learns that both stores were
 * tried and how each failed. With no fallback the note is the file's reason
 * alone.
 *
 * The reason the read failed travels beside that message. A ping is worth
 * starting when *any* store answered with an expiry — Claude Code refreshes the
 * store it writes, which on Linux is this file and on macOS is the login
 * keychain, and either one expiring is the case the ping fixes. A store that
 * could not be read at all is a different problem, a locked keychain or a
 * permission, and does not on its own call for one.
 */
export async function readClaudeToken(
  path: string,
  deps: ClaudeTokenDeps = {},
): Promise<ClaudeToken> {
  const now = deps.now ?? Date.now();

  let file: CredentialRead;
  if (!existsSync(path)) {
    file = { error: "no claude credentials file" };
  } else {
    try {
      file = { text: await readFile(path, "utf8") };
    } catch (err) {
      file = { error: `unreadable claude credentials: ${(err as Error).message}` };
    }
  }
  const fromFile: ClaudeToken = "text" in file ? parseClaudeToken(file.text, now) : storeFailure(file.error);
  if ("token" in fromFile) return fromFile;
  if (!deps.keychain) return fromFile;

  const read = await deps.keychain();
  const fromKeychain: ClaudeToken =
    "text" in read ? parseClaudeToken(read.text, now) : storeFailure(read.error);
  if ("token" in fromKeychain) return fromKeychain;
  return {
    error: `${fromFile.error}; keychain: ${fromKeychain.error}`,
    reason: fromFile.reason === "expired" || fromKeychain.reason === "expired" ? "expired" : "unusable",
  };
}

// --------------------------------------------------------------- Antigravity

/**
 * What `auth.json`'s `antigravity` entry yielded: a usable credential, or why not.
 *
 * `expired` is separated from `unusable` for the same reason Claude's are: an
 * expiry is the one failure a delegated refresh can fix, and a missing entry or
 * an unreadable file is not.
 *
 * `projectId` rides along because the vendor's own client sends it in the
 * request body, and a user on a project-scoped account needs the quota summary
 * of *that* project.
 */
export interface AntigravityAccess {
  readonly token: string;
  readonly projectId?: string;
}

/** The Antigravity credential, or why no store supplied one. */
export type AntigravityToken =
  | AntigravityAccess
  | { readonly error: string; readonly reason: TokenFailure };

/**
 * Pulls the Antigravity credential out of `auth.json`'s text.
 *
 * `pi-antigravity` registers an OAuth provider with pi, and pi persists what it
 * obtained in exactly this shape: `access`, an optional `expires` in epoch
 * milliseconds, and an optional `projectId`. Reading it is all this parser does
 * — no refresh token is handled here, and nothing is written back.
 *
 * The expiry test is `<=` rather than Claude's `<`: a token whose expiry *is*
 * this instant has no remaining life, and using it would spend a request on a
 * credential that is already gone. An absent `expires` is not evidence of
 * expiry, so the token is used; an `expires` that is present but not a number is
 * a shape this cannot judge, and inventing a lifetime for it is worse than
 * saying so.
 *
 * The expired check comes *before* the access check on purpose: an entry the
 * provider has expired may have had its `access` cleared already, and the
 * expiry is still the reason a delegated refresh is worth attempting.
 */
export function parseAntigravityToken(text: string, context: { now: number }): AntigravityToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately fixed text: a JSON syntax error's own message quotes the
    // document, and this document is a credential file.
    return { error: "unreadable pi auth: it is not valid JSON", reason: "unusable" };
  }
  const entry = jsonObject(jsonObject(parsed)?.["antigravity"]);
  if (entry === undefined) return { error: "no antigravity.access", reason: "unusable" };
  const expires = entry.expires;
  if (expires !== undefined) {
    if (typeof expires !== "number" || !Number.isFinite(expires)) {
      return { error: "antigravity credential has no usable expiry", reason: "unusable" };
    }
    if (expires <= context.now) return { error: "antigravity token expired", reason: "expired" };
  }
  const access = entry.access;
  if (typeof access !== "string" || access === "") {
    return { error: "no antigravity.access", reason: "unusable" };
  }
  const project = entry.projectId;
  const projectId = typeof project === "string" && project !== "" ? project : undefined;
  return { token: access, ...(projectId === undefined ? {} : { projectId }) };
}

/**
 * How long a delegated provider-token refresh is waited for, in milliseconds.
 *
 * Generous because the refresh is a real OAuth exchange under pi's own file lock,
 * and deliberately finite because the registry exposes no cancellation: when the
 * bound passes, the wait ends and the refresh is left to finish in the
 * background. The next credential read is what finds out whether it did.
 */
export const PROVIDER_TOKEN_TIMEOUT_MS = 10_000;

export interface AntigravityTokenDeps {
  /** The file pi persists its `antigravity` entry in. */
  readonly path: string;
  /**
   * Whether `path` is the file pi's own provider writes.
   *
   * Only that file can be refreshed by delegating: a non-default path names
   * somebody else's profile, and refreshing *this* machine's provider says
   * nothing about it — the same restriction ADR 0007 puts on the Claude ping.
   */
  readonly defaultPath: boolean;
  /**
   * pi's own provider-token resolver, feature-detected. Left unset, nothing is
   * delegated and an expired credential is simply unavailable.
   */
  readonly resolver?: (provider: "antigravity") => Promise<string | undefined>;
  /** How long to wait for a delegated refresh. Defaults to `PROVIDER_TOKEN_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** This dispatcher's clock, so a reading and its credential share one. Defaults to `Date.now()`. */
  readonly now?: () => number;
}

/**
 * The Antigravity credential, reading the file and — when its token has expired
 * — asking pi to renew it.
 *
 * A factory rather than a plain function because the delegated refresh is
 * single-flight per dispatcher, not per read: a wait that hits its bound must
 * not start a second refresh, with pi already doing one under its own lock and a
 * second attempt a second writer racing the first. Passing the file, the
 * resolver and the bound as arguments is what lets this live here rather than in
 * the dispatcher's closure.
 */
export function createAntigravityToken(deps: AntigravityTokenDeps): { read(): Promise<AntigravityToken> } {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TOKEN_TIMEOUT_MS;

  /**
   * `auth.json`'s Antigravity entry, or why there is none.
   *
   * Read fresh every time, never cached here: pi is the credential's writer, and
   * a token this process remembered would be exactly the stale one the next read
   * has to notice.
   *
   * A file that cannot be read is reported by its errno rather than by the error
   * message — the message quotes the path and, for a parse failure, could quote
   * the document, which is a credential file.
   */
  async function readFileToken(): Promise<AntigravityToken> {
    if (!existsSync(deps.path)) return { error: "no pi auth file", reason: "unusable" };
    let text: string;
    try {
      text = await readFile(deps.path, "utf8");
    } catch (err) {
      return { error: `unreadable pi auth: ${(err as NodeJS.ErrnoException).code ?? "read failed"}`, reason: "unusable" };
    }
    return parseAntigravityToken(text, { now: now() });
  }

  /**
   * The one delegated provider-token refresh this dispatcher has in flight.
   *
   * Single-flight until the resolver *actually settles*, not until a caller stops
   * waiting: a wait that hits the bound must not start a second refresh, because
   * pi is already doing one under its own lock and a second attempt would be a
   * second writer racing the first. The rejection is caught here and reduced to
   * `failed`, since an OAuth error body is not text this report may echo.
   */
  let delegating: Promise<"done" | "failed"> | undefined;
  function delegatedRefresh(): Promise<"done" | "failed"> {
    const resolver = deps.resolver;
    if (resolver === undefined) return Promise.resolve("failed");
    delegating ??= (async (): Promise<"done" | "failed"> => {
      try {
        await resolver("antigravity");
        return "done";
      } catch {
        return "failed";
      }
    })().finally(() => {
      delegating = undefined;
    });
    return delegating;
  }

  /**
   * Wait out one delegated refresh, but no longer than the bound.
   *
   * The registry offers no cancellation, so the choice is between waiting
   * forever and leaving the refresh to finish without us. The timer is cleared
   * either way, and the unsettled promise keeps its single-flight slot, so the
   * refresh this process stopped waiting for is still the only one it started.
   */
  async function waitForProviderToken(): Promise<"done" | "failed" | "timed out"> {
    const attempt = delegatedRefresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timed out">((done) => {
      timer = setTimeout(() => done("timed out"), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([attempt, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The Antigravity credential, refreshing it only by delegating to pi.
   *
   * Three facts decide whether a refresh may be attempted, and all three are
   * required: the stored token is expired (the one failure a refresh fixes), the
   * auth file is the default one (the one pi's registered provider owns), and a
   * resolver is wired.
   *
   * What is returned after a delegation is the re-read file, not the resolver's
   * own string: the refresh is only useful if it persisted something this
   * process can use, and the provider's return value is a JSON credential
   * document in pi's internal shape rather than a token.
   */
  async function read(): Promise<AntigravityToken> {
    const first = await readFileToken();
    if ("token" in first) return first;
    if (first.reason !== "expired") return first;
    if (deps.resolver === undefined) {
      return { error: `${first.error}; no provider token resolver is available`, reason: "expired" };
    }
    if (!deps.defaultPath) {
      return {
        error: `${first.error}; the pi auth file is not the default one, so no refresh was delegated`,
        reason: "expired",
      };
    }
    const outcome = await waitForProviderToken();
    const reread = await readFileToken();
    if ("token" in reread) return reread;
    const decision =
      outcome === "failed"
        ? "the delegated refresh failed"
        : outcome === "timed out"
          ? "the delegated refresh did not finish in time"
          : "the delegated refresh produced no usable token";
    // The re-read's own reason, not the first read's: a file that became
    // unreadable, or lost its `antigravity` entry, while the refresh ran is what
    // the user has to act on now.
    return { error: `${reread.error}; ${decision}`, reason: "expired" };
  }

  return { read };
}

// -------------------------------------------------------------------- Codex

/** The Codex credential one read must supply: the bearer token, and the account whose usage it asks about. */
export interface CodexCredential {
  readonly access: string;
  readonly accountId: string;
}

/** A Codex credential, or why the document could not supply one. */
export type CodexCredentialRead = CodexCredential | { readonly error: string };

/** One document shape a Codex credential arrives in, and the field each part is spelled under. */
interface CodexShape {
  /** The top-level section that claims the document for this shape. */
  readonly section: string;
  readonly access: string;
  readonly account: string;
}

/** pi's `auth.json`, which is where a Codex login obtained by pi lands. */
const PI_CODEX: CodexShape = { section: "openai-codex", access: "access", account: "accountId" };

/**
 * The Codex CLI's own `auth.json`.
 *
 * Read and never written: the CLI owns that file, and a launcher that shields
 * the host's credentials publishes this one when it may not publish pi's — see
 * `docs/adr/0020-codex-credential-seam.md`.
 */
const CLI_CODEX: CodexShape = { section: "tokens", access: "access_token", account: "account_id" };

/**
 * The shapes a file is read in, in the order they are tried.
 *
 * pi's first because it is the default file's own shape, so the common case
 * finds its credential on the first try. Neither is an alias for the other and
 * a shape is recognised by its section's presence, not by the file's name: one
 * path is a credential file whatever wrote it.
 */
const CODEX_SHAPES: readonly CodexShape[] = [PI_CODEX, CLI_CODEX];

/** One shape's verdict: the credential, the reason it is unusable, or `undefined` when the section is absent. */
function codexCredentialIn(document: Record<string, unknown>, shape: CodexShape): CodexCredentialRead | undefined {
  const entry = jsonObject(document[shape.section]);
  if (entry === undefined) return undefined;
  const access = entry[shape.access];
  if (typeof access !== "string" || access === "") return { error: `no ${shape.section}.${shape.access}` };
  const accountId = entry[shape.account];
  if (typeof accountId !== "string" || accountId === "") {
    return { error: `no ${shape.section}.${shape.account}` };
  }
  return { access, accountId };
}

/**
 * Pulls a Codex credential out of a credential file's text.
 *
 * Both shapes are tried and the first usable one wins, so a document carrying a
 * half-written `openai-codex` section beside a usable `tokens` one still
 * answers: the shapes are two spellings of one fact, not a precedence.
 *
 * The account id is required rather than defaulted. It is not a secret, but it
 * selects *which* account's usage the request asks about, so a guessed one would
 * report another account's headroom — what the per-credential key in
 * `docs/adr/0016-shared-rail-readings.md` exists to prevent.
 *
 * Every message is fixed text or built from field names alone: a JSON syntax
 * error's own message quotes the document, and this document is a credential.
 */
export function parseCodexCredential(text: string): CodexCredentialRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "codex credential is not valid JSON" };
  }
  const document = jsonObject(parsed) ?? {};
  const refusals: string[] = [];
  for (const shape of CODEX_SHAPES) {
    const found = codexCredentialIn(document, shape);
    if (found === undefined) continue;
    if ("access" in found) return found;
    refusals.push(found.error);
  }
  // A section that is there but unusable names what it was missing, which is
  // the actionable answer; a document with neither section names both fields a
  // file could carry, which is the one that says "this is the wrong file".
  return {
    error:
      refusals[0] ??
      `no ${PI_CODEX.section}.${PI_CODEX.access} or ${CLI_CODEX.section}.${CLI_CODEX.access}`,
  };
}

/**
 * The Codex credential, or why the file named by `codexCredsPath` gave none.
 *
 * Read fresh on every fetch rather than cached here: the file belongs to
 * whichever client writes it, and a token this process remembered would be
 * exactly the stale one the next read has to notice.
 *
 * A read failure is reported by its errno, never by the error's message: the
 * message quotes the path, and a parse failure's message could quote the
 * document, which is a credential.
 */
export async function readCodexCredential(path: string): Promise<CodexCredentialRead> {
  if (!existsSync(path)) return { error: "no codex credential file" };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return {
      error: `unreadable codex credential file: ${(err as NodeJS.ErrnoException).code ?? "read failed"}`,
    };
  }
  return parseCodexCredential(text);
}

// ------------------------------------------------------------- the claude run

export interface ClaudeIdentity {
  path: string;
  mtimeMs: number;
}

/**
 * The `claude` executable name, and the extensions a Windows PATH lookup tries
 * beside it when `PATHEXT` says nothing.
 */
const CLAUDE_EXE = "claude";
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve the `claude` this machine's ping would run, by PATH scan (never
 * spawning it), and its mtime. Skips directories and non-executable files.
 * Returns undefined when nothing resolves.
 *
 * A scan rather than a spawn because this runs on the path that decides whether
 * a ping may run at all: asking by running would be the very request the gates
 * exist to bound. `stat` follows a symlink on purpose — the mtime that moves
 * when an install is upgraded is the target's — while `realpath` is deliberately
 * not applied, so the identity is the name this PATH would select.
 *
 * Executability is part of the identity because it is part of the lookup: the
 * shell and `execvp` skip a `claude` they cannot run and take the next name on
 * PATH, so accepting a non-executable file here would key a halt to a file no
 * ping would ever reach.
 *
 * The scan mirrors the lookup the ping's own runner performs, `execvp`'s: an
 * empty segment is the working directory and a relative one is relative to it,
 * so both are resolved against the cwd and the answer is always absolute.
 */
export async function claudeInstall(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeIdentity | undefined> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((ext) => ext !== "")]
      : [""];
  for (const segment of (env.PATH ?? "").split(delimiter)) {
    // An empty segment means the working directory to `execvp` (and so to the
    // ping's `execFile`), resolved here against this process's cwd; skipping it
    // would key the halt to a different binary than the ping runs.
    const base = segment === "" ? "." : segment;
    for (const extension of extensions) {
      const candidate = resolve(base, `${CLAUDE_EXE}${extension}`);
      let found: Stats;
      try {
        found = await stat(candidate);
      } catch {
        continue;
      }
      if (!found.isFile()) continue;
      if (process.platform !== "win32" && (found.mode & 0o111) === 0) continue;
      return { path: candidate, mtimeMs: found.mtimeMs };
    }
  }
  return undefined;
}
