/**
 * The Codex CLI refresh: one diverted CLI run, and the file it may have changed.
 *
 * Nothing in this extension writes a Codex credential. The CLI is the only
 * writer, and a second writer of a rotating refresh token is a way to end the
 * user's session (docs/adr/0022). So the fix for an expired token is to make the
 * CLI run once, and this module is that: `/quota-dispatch refresh-codex` spawns
 * `codex exec` against a loopback listener so the model request never reaches a
 * model, waits for it, and then says what the credential file holds now.
 *
 * It claims exactly what it can check. The eight refusals below are cheap local
 * facts about where the file is, which store the CLI is configured to use, and
 * whether a `codex` can be run at all; they are admission checks, not proof
 * about what the CLI will do next. The after-check compares a digest of the
 * token before and after, so "the file changed to a new, future-dated token for
 * the same account" is observable — which writer changed it is not. ADR 0024
 * states the residual risks that leaves, and `codex login` is the recovery for
 * both of the ones that matter.
 *
 * Every line this module prints is built from string literals here, the eight
 * refusal sentences, an ISO timestamp, an errno, a pid and a deadline. Nothing
 * the child printed, no path, no account id and no token byte is ever rendered:
 * the child's output is a credential's own client talking about an account.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { codexTokenExpiry } from "./credentials.ts";
import { spawnProcess, type ProcessRunner } from "./exec.ts";
import { jsonObject } from "./json.ts";
import { loopbackListener, type PingListener, type PingListenerFactory } from "./refresh.ts";

/**
 * How long one diverted run may take.
 *
 * The CLI's own refresh is a single token exchange — the launch notice says
 * "usually about 15 seconds" from measurement — and the bound is loose because
 * being wrong is expensive in one direction only: a run killed while its token
 * request is in flight can have rotated the refresh token on the server without
 * saving it, which is the one failure `codex login` exists to repair. Loose
 * enough to let a slow network finish, bounded so a hang cannot hold the command
 * forever; docs/adr/0024 states what the deadline can and cannot prevent.
 */
export const CODEX_REFRESH_DEADLINE_MS = 90_000;

/** How long each of TERM and KILL may take to work before the next step. */
export const CODEX_REFRESH_KILL_GRACE_MS = 5_000;

/**
 * The window in which a token is due for a refresh.
 *
 * A token that is still good for more than this is not worth a subprocess: the
 * CLI's own proactive refresh begins at the same five minutes (`manager.rs:233`
 * in the pinned release), so a run started outside this window would not rotate
 * anything — it would be a subprocess for nothing. At or inside the window the
 * CLI refreshes as it starts, which is what makes the command work, and an
 * already-expired token is repaired by the same `refresh_token` exchange, so
 * there is nothing to gain by waiting for the expiry itself.
 */
export const CODEX_DUE_WINDOW_MS = 5 * 60_000;

/**
 * What the user is told just before a run starts.
 *
 * Printed before the spawn rather than after it, because the command is
 * foreground and silent for as long as the run takes: a notice that appeared
 * afterwards would explain a wait the user had already sat through.
 */
export const CODEX_REFRESH_LAUNCH_NOTICE =
  "quota-dispatcher: running codex once to let it refresh its own credential (usually about 15 seconds; timed out after 90).";

/**
 * The largest file this module will read: `config.toml` or `auth.json`.
 *
 * Both are small documents a CLI owns, and a bound checked before the read is
 * what keeps a file that is not one of those — a disk image, a FIFO someone
 * pointed the path at — from being read into memory to be rejected afterwards.
 */
const MAX_CODEX_FILE_BYTES = 1_048_576;

/**
 * The environment a run is admitted from, and the platform it is filtered on.
 *
 * Taken as a value rather than read from `process` at each use so that the whole
 * admission list is a pure function of the target and the clock, and so that a
 * test can state a machine — a Windows host, a `CODEX_HOME`, a `PATH` — without
 * being one. `env` is snapshotted by the run before it is checked and used, so
 * the checks and the child cannot see two different environments.
 */
export interface CodexHost {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

/** This machine, as the checks see it. */
export function processCodexHost(): CodexHost {
  return { env: process.env, platform: process.platform };
}

/** What a refresh would act on: one credential file, and the machine it lives on. */
export interface CodexRefreshTarget {
  /** The codex rail's `codexCredsPath`. */
  readonly credsPath: string;
  /** pi's own `auth.json`, which the Codex CLI never writes. */
  readonly piAuthPath: string;
  readonly host: CodexHost;
}

/** Which admission check refused, in the order the checks run. */
export type CodexRefusalId =
  | "windows"
  | "bad-home"
  | "pi-auth"
  | "not-cli-file"
  | "dotenv"
  | "config-store"
  | "not-managed-login"
  | "no-codex";

/**
 * The one sentence each refusal is reported by.
 *
 * Fixed text rather than a sentence assembled from what was found: every one of
 * these messages reaches a terminal, and a sentence built from a path, a file's
 * contents or an OS message would be the one place this module could print
 * something about the user's machine that is not its own words.
 */
const REFUSAL_TEXT: Readonly<Record<CodexRefusalId, string>> = {
  windows: "the Codex CLI refresh is not supported on Windows",
  "bad-home":
    "CODEX_HOME or HOME is not a usable absolute path, so the Codex CLI home cannot be found",
  "pi-auth": "codexCredsPath is pi's own auth.json, which the Codex CLI does not write",
  "not-cli-file": "codexCredsPath is not the Codex CLI's own auth.json",
  dotenv:
    "the Codex CLI home has a .env file (or could not be checked), which could change the run's environment",
  "config-store":
    "the Codex CLI's config.toml chooses a credential store other than the file, or could not be checked",
  "not-managed-login": "the file is not the Codex CLI's managed ChatGPT login",
  "no-codex": "no executable codex on PATH (only absolute PATH entries are searched)",
};

/** The refusal in its one sentence. */
export function refusalText(id: CodexRefusalId): string {
  return REFUSAL_TEXT[id];
}

/**
 * The login a ready run was admitted against.
 *
 * `accessDigest` rather than the token: the before/after comparison needs a
 * fingerprint, and the token itself has no use here. `destination` is the
 * canonical path the file resolved to, which is what the after-check compares
 * against so that a path that moved between the two reads is noticed.
 */
export interface CodexLogin {
  /** The Codex CLI home as the environment spelled it, before resolution. */
  readonly rawHome: string;
  /** The same home with every link and `..` resolved by the OS. */
  readonly homeReal: string;
  /** The CLI's `auth.json`, canonicalised. */
  readonly destination: string;
  readonly accountId: string;
  /** SHA-256 of the access token, hex. The token is discarded after hashing. */
  readonly accessDigest: string;
}

/**
 * What the admission list says: run it, wait, or run nothing.
 *
 * `not-due` is not a refusal — the machine is fine, the token simply is not old
 * enough to be worth a subprocess — so it is a separate case with its own
 * sentence rather than the ninth refusal.
 */
export type CodexReadiness =
  | { readonly kind: "ready"; readonly codex: string; readonly login: CodexLogin }
  | { readonly kind: "not-due"; readonly expiresAt: number }
  | { readonly kind: "refused"; readonly refusal: CodexRefusalId };

/**
 * One check's answer: what it read, or the refusal it owns.
 *
 * Uniform so the sequence reads as the order of the table it implements, and so
 * a check that fails has no third way to say so.
 */
type Step<T> = { readonly ok: T } | { readonly refusal: CodexRefusalId };

const ok = <T>(value: T): Step<T> => ({ ok: value });

const refused = <T>(refusal: CodexRefusalId): Step<T> => ({ refusal });

/** An error's errno, when it stated one as a string. */
function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Runs one check, and answers with the refusal that check owns if it throws.
 *
 * `codexRefreshReadiness` is total by construction rather than by one `try`
 * around the whole sequence: every filesystem answer — `EACCES`, `ELOOP`, a path
 * with a NUL byte in it, a lookup Node refuses to make at all — becomes the
 * refusal whose sentence already covers "could not be checked". A single
 * catch-all would have to choose one of those sentences afterwards, and could
 * only guess which step it came from.
 */
async function guarded<T>(refusal: CodexRefusalId, check: () => Promise<Step<T>>): Promise<Step<T>> {
  try {
    return await check();
  } catch {
    return { refusal };
  }
}

/**
 * Where the Codex CLI keeps its home, before anything is resolved.
 *
 * Refuses Windows first because every later check would work differently there:
 * `~/.codex` is not a path the CLI spells that way, and `:` is not how a `PATH`
 * is separated. Refusing one obviously-wrong platform is honest; making eight
 * checks platform-correct for a platform nothing here has measured is not.
 *
 * The value is the environment's own spelling, not a joined path, because it is
 * resolved by the OS in `matchCliAuthFile` and a lexical join would resolve `..`
 * the wrong way.
 */
function codexHomeOf(host: CodexHost): Step<string> {
  if (host.platform === "win32") return refused("windows");
  const configured = host.env.CODEX_HOME;
  if (configured !== undefined) {
    if (configured === "" || !isAbsolute(configured)) return refused("bad-home");
    return ok(configured);
  }
  const home = host.env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home)) return refused("bad-home");
  return ok(`${home}/.codex`);
}

/**
 * Whether the credential file is the same file as pi's own `auth.json`.
 *
 * `dev` and `ino` rather than a path comparison, because the same file can have
 * any number of names — a hard link, a symlink, a `..` — and the fact to
 * establish is which file it is, not which path was typed. A credential path
 * that does not exist is not this check's answer: the next one says what it is.
 *
 * `"unchecked"` is the fail-closed answer for pi's path being unreadable for any
 * reason other than absence. Only `ENOENT` means "there is no pi login here,
 * so this cannot be it"; a permission error or a loop could be the same file
 * behind a name this process may not resolve, and admitting that is the one
 * mistake that would run the CLI against pi's credential.
 */
async function sameFileAsPi(credsPath: string, piAuthPath: string): Promise<boolean | "unchecked"> {
  let creds;
  try {
    creds = await stat(credsPath, { bigint: true });
  } catch {
    return false;
  }
  try {
    const pi = await stat(piAuthPath, { bigint: true });
    return pi.dev === creds.dev && pi.ino === creds.ino;
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? false : "unchecked";
  }
}

/** The resolved CLI home and the resolved `auth.json` inside it. */
interface CliAuthFile {
  readonly homeReal: string;
  readonly destination: string;
}

/**
 * The Codex CLI's own `auth.json`, resolved the way the OS resolves it.
 *
 * Native `realpath` on both sides is the whole point, and `path.join` before it
 * would defeat it. `path.join` and the legacy `realpathSync` collapse `..`
 * lexically, *before* symlinks are resolved, so `CODEX_HOME=/tmp/t/link/../home`
 * with `link -> /tmp/t/alt/sub` becomes `/tmp/t/home` for a lexical join while
 * the OS and the CLI resolve `link` first and land in `/tmp/t/alt/home`. A checker
 * that disagreed with the writer about which file it had been shown would refuse
 * a working install, or admit a file that is not the one the CLI will write. So:
 * resolve the home first, join `"auth.json"` onto the resolved home, and resolve
 * the credential path on its own.
 *
 * Every error refuses, including a home that is not a directory and an
 * `auth.json` that is not a regular file. A lookup this process cannot make is
 * not evidence the path is wrong, but the question being asked is "is this the
 * CLI's file", and "could not tell" is not an answer to run a subprocess on.
 */
async function matchCliAuthFile(input: {
  readonly credsPath: string;
  readonly piAuthPath: string;
  readonly rawHome: string;
}): Promise<Step<CliAuthFile>> {
  const sameAsPi = await sameFileAsPi(input.credsPath, input.piAuthPath);
  if (sameAsPi === "unchecked") return refused("pi-auth");
  if (sameAsPi) return refused("pi-auth");
  try {
    const homeReal = await realpath(input.rawHome);
    if (!(await stat(homeReal)).isDirectory()) return refused("not-cli-file");
    const destination = await realpath(join(homeReal, "auth.json"));
    if ((await realpath(input.credsPath)) !== destination) return refused("not-cli-file");
    if (!(await stat(destination)).isFile()) return refused("not-cli-file");
    return ok({ homeReal, destination });
  } catch {
    return refused("not-cli-file");
  }
}

/**
 * The CLI's home must not carry a `.env`.
 *
 * The CLI loads `.env` from its home into its own environment, and this module
 * hands the child an environment it has deliberately stripped: a `.env` could put
 * back a base URL, a credential or a provider selection that the diversion
 * assumes away. Existence is enough — the file cannot be audited without
 * understanding the CLI's own parser — so any entry type refuses.
 */
async function checkCliHome(homeReal: string): Promise<CodexRefusalId | undefined> {
  try {
    await lstat(join(homeReal, ".env"));
    return "dotenv";
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? undefined : "dotenv";
  }
}

/**
 * A line of `config.toml` that assigns something: not blank, not a comment.
 *
 * The narrow text checks below run only on these, so a commented-out
 * `# cli_auth_credentials_store = "keyring"` neither refuses nor excuses.
 */
function isConfigLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed !== "" && !trimmed.startsWith("#");
}

/**
 * A key written with an escape before its `=`.
 *
 * `a\.b = "file"` is a different key from `cli_auth_credentials_store`, and the
 * text checks below match on the plain spelling. Since a clever key can only
 * hide a non-`file` store from them, an escaped key anywhere refuses: parsing
 * TOML properly to find out is re-implementing the CLI, and the honest reading
 * of "I cannot tell which store this config chooses" is not to run.
 */
const ESCAPED_KEY_LINE = /^\s*[^#=\r\n]*\\[^=\r\n]*=/;

/**
 * The one assignment that selects the file store, in any spelling TOML allows a
 * bare key and with an optional inline comment.
 *
 * A line that mentions the key and is not this line is a line this module cannot
 * vouch for: `"keyring"`, a table profile's own entry, an expression, a value
 * this regex has not seen. Refusing on all of them is the narrow fail-closed
 * reading, and the cost of being wrong is one `codex login` the user did not
 * need.
 */
const FILE_STORE_LINE =
  /^\s*(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=\s*(?:"file"|'file')\s*(?:#.*)?$/;

const STORE_KEY = "cli_auth_credentials_store";

/**
 * Whether the CLI's `config.toml` chooses the file store, as far as text can say.
 *
 * Not a TOML parser: a parser would have to be right about tables, profiles,
 * includes and multi-line strings that this module never uses, and being wrong
 * about them would admit a config the CLI reads differently. Two narrow checks —
 * no escaped keys, and every mention of the store key is the plain `"file"`
 * assignment — reject what cannot be vouched for and pass everything else.
 */
function configChoosesFileStore(text: string): boolean {
  const lines = text.split(/\r?\n/).filter(isConfigLine);
  for (const line of lines) {
    if (ESCAPED_KEY_LINE.test(line)) return false;
    if (line.includes(STORE_KEY) && !FILE_STORE_LINE.test(line)) return false;
  }
  return true;
}

/**
 * Refusal #6: the CLI's `config.toml` must leave the credential where it is.
 *
 * A store other than the file means the run would mutate a keychain this
 * extension cannot observe, or leave `auth.json` untouched while rotating the
 * token — both of which would be reported as "nothing happened" when something
 * did. Unreadable, oversized, non-regular and non-UTF-8 files refuse for the same
 * reason: an unexamined config is a config that might do either.
 */
async function checkConfigStore(homeReal: string): Promise<Step<undefined>> {
  const path = join(homeReal, "config.toml");
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    // Absent is the ordinary case: the CLI then uses its own default, the file
    // store, which is exactly what this command needs.
    return errnoOf(err) === "ENOENT" ? ok(undefined) : refused("config-store");
  }
  if (!info.isFile() || info.size > MAX_CODEX_FILE_BYTES) return refused("config-store");
  const text = decodeUtf8(await readFile(path));
  if (text === undefined || !configChoosesFileStore(text)) return refused("config-store");
  return ok(undefined);
}

/**
 * The bytes as text, or nothing when they are not valid UTF-8.
 *
 * A `fatal` decoder rather than a lossy one: a document with invalid bytes is a
 * document this module cannot claim to have read, and the lossy replacement
 * character would be a silent edit to a credential.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The ChatGPT login a managed Codex CLI document holds. */
interface ManagedLogin {
  readonly access: string;
  readonly accountId: string;
}

/**
 * The fields the CLI writes as `null` when the login does not use them.
 *
 * A non-`null` value means the document carries another kind of credential —
 * an API key, a Bedrock identity, an agent identity — and the CLI would use that
 * instead of refreshing the ChatGPT token this command is for.
 */
const FOREIGN_CREDENTIAL_FIELDS = [
  "personal_access_token",
  "agent_identity",
  "bedrock_api_key",
  "bedrock_access_keys",
] as const;

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Refusal #7's predicate, and the shape every later check reads.
 *
 * A managed ChatGPT login is the only document this command can help: the CLI
 * refreshes `tokens` and only `tokens`, so a document that is pi's
 * (`openai-codex`), or that carries an API key, an agent identity or another
 * `auth_mode`, is a file whose refresh would either not happen or not be the
 * refresh this command reports. Every part is required and validated, including
 * `refresh_token` — which this module never reads, but whose absence means the
 * CLI cannot rotate the token at all.
 */
function parseManagedCodexLogin(text: string): ManagedLogin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = jsonObject(parsed);
  if (document === undefined) return undefined;
  if (Object.hasOwn(document, "openai-codex")) return undefined;
  /** Whether a field is present and says something other than `null`. */
  const set = (key: string): boolean => Object.hasOwn(document, key) && document[key] !== null;
  if (set("OPENAI_API_KEY")) return undefined;
  if (set("auth_mode") && document["auth_mode"] !== "chatgpt") return undefined;
  for (const key of FOREIGN_CREDENTIAL_FIELDS) if (set(key)) return undefined;
  const tokens = jsonObject(document["tokens"]);
  if (tokens === undefined) return undefined;
  const access = tokens["access_token"];
  const accountId = tokens["account_id"];
  if (!nonEmptyString(access) || !nonEmptyString(accountId) || !nonEmptyString(tokens["refresh_token"])) {
    return undefined;
  }
  return { access, accountId };
}

/**
 * The managed login in a file, with the size bound applied before it is read.
 *
 * The bound is checked against `stat` rather than against what came back from
 * `readFile` for the reason it exists: a file that is not a login should not be
 * read into memory to be rejected.
 */
async function readManagedLogin(path: string): Promise<Step<ManagedLogin>> {
  const info = await stat(path);
  if (info.size > MAX_CODEX_FILE_BYTES) return refused("not-managed-login");
  const text = decodeUtf8(await readFile(path));
  if (text === undefined) return refused("not-managed-login");
  const login = parseManagedCodexLogin(text);
  return login === undefined ? refused("not-managed-login") : ok(login);
}

/**
 * Refusal #8: a `codex` that can actually be executed.
 *
 * Only absolute `PATH` entries are searched, and the entry is checked for both
 * "is a file" and "is executable" here rather than left to the spawn: the report
 * the user gets from a failed spawn would be an errno after a listener and a
 * workdir were already made, and the sentence "no executable codex on PATH" is
 * the one that says what to do. A relative entry is skipped because this process
 * and the child do not share a working directory — resolving one would name a
 * different file for the child than for us.
 *
 * The candidate is returned as found, not resolved: the child is what runs it,
 * and resolving a symlink here would only make the argv differ from the `PATH`
 * the user configured.
 */
export async function resolveCodexExecutable(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const segment of (env.PATH ?? "").split(":")) {
    if (segment === "" || !isAbsolute(segment)) continue;
    // Raw concatenation: a trailing slash is trimmed, and a root segment stays a
    // root. `path.join` would be another lexical rewrite of a configured path.
    const candidate = `${segment.replace(/\/+$/, "") || "/"}/codex`;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** SHA-256, hex, of a string this module holds only long enough to hash it. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The admission list, the due check, and nothing else: what a run would act on.
 *
 * Checks run in the order the refusals are numbered, and the first failure ends
 * the evaluation — nothing is spawned, and the caller is told why in one of eight
 * sentences. The due check sits between the seventh and the eighth because it is
 * the only reason to refuse *after* having read a usable login: a file that is
 * not worth refreshing should not be followed by a `PATH` search whose failure
 * would then be reported ahead of the truth.
 *
 * `now` in epoch milliseconds, passed in rather than read, so the comparison
 * against the token's own `exp` is a pure function of its inputs.
 */
export async function codexRefreshReadiness(
  target: CodexRefreshTarget,
  now: number,
): Promise<CodexReadiness> {
  const stop = (refusal: CodexRefusalId): CodexReadiness => ({ kind: "refused", refusal });

  const home = codexHomeOf(target.host);
  if ("refusal" in home) return stop(home.refusal);

  const auth = await guarded("not-cli-file", () =>
    matchCliAuthFile({
      credsPath: target.credsPath,
      piAuthPath: target.piAuthPath,
      rawHome: home.ok,
    }),
  );
  if ("refusal" in auth) return stop(auth.refusal);

  const dotenv = await guarded("dotenv", async () => {
    const refusal = await checkCliHome(auth.ok.homeReal);
    return refusal === undefined ? ok(undefined) : refused<undefined>(refusal);
  });
  if ("refusal" in dotenv) return stop(dotenv.refusal);

  const store = await guarded("config-store", () => checkConfigStore(auth.ok.homeReal));
  if ("refusal" in store) return stop(store.refusal);

  const login = await guarded("not-managed-login", () => readManagedLogin(auth.ok.destination));
  if ("refusal" in login) return stop(login.refusal);

  const expiresAt = codexTokenExpiry(login.ok.access);
  if (expiresAt !== undefined && expiresAt > now + CODEX_DUE_WINDOW_MS) {
    return { kind: "not-due", expiresAt };
  }

  const codex = await guarded("no-codex", async () => {
    const found = await resolveCodexExecutable(target.host.env);
    return found === undefined ? refused<string>("no-codex") : ok(found);
  });
  if ("refusal" in codex) return stop(codex.refusal);

  return {
    kind: "ready",
    codex: codex.ok,
    login: {
      rawHome: home.ok,
      homeReal: auth.ok.homeReal,
      destination: auth.ok.destination,
      accountId: login.ok.accountId,
      accessDigest: sha256Hex(login.ok.access),
    },
  };
}

/**
 * What an expired Codex rail's note is followed by: the one command that can fix
 * it, or why there is none from here.
 *
 * A hint rather than a claim: it is computed at print time from the same
 * admission list the command itself runs, so the report cannot tell a reader to
 * run something that would refuse. It is never stored on a reading, in the
 * readings file, or in the gauge — the note it decorates is about a read, and the
 * hint is about what to do next.
 */
export function codexExpiredHint(readiness: CodexReadiness): string {
  if (readiness.kind === "ready") {
    return "run /quota-dispatch refresh-codex to have the Codex CLI refresh it";
  }
  if (readiness.kind === "not-due") {
    return `the file now holds a token ${formatExpiry(readiness.expiresAt)}; /quota-dispatch refresh reads it again`;
  }
  return `not refreshable from here: ${refusalText(readiness.refusal)}`;
}

/**
 * An expiry as one clause, for a line that has to state one.
 *
 * The range check is the whole function: `Date.toISOString` throws on a value
 * outside the `Date` range, and `codexTokenExpiry` multiplies a token's `exp` by
 * 1 000 without a range check of its own (it only requires a finite number), so a
 * document with an absurd `exp` would otherwise turn a report line into a crash.
 * A value that cannot be a date is stated as the fact it is, and never passed to
 * `toISOString`.
 */
function formatExpiry(ms: number): string {
  return Number.isInteger(ms) && Math.abs(ms) <= 8_640_000_000_000_000
    ? `valid until ${new Date(ms).toISOString()}`
    : "valid (expiry out of date range)";
}

/**
 * The argv of one diverted run.
 *
 * `chatgpt_base_url` is the loopback listener, so the model request is answered by
 * this process and the run reaches no model: it ends promptly, and it spends no
 * budget. That override is the measured way to move the request on the pinned CLI
 * (docs/adr/0024 records the version and the source), and the model id is
 * deliberately absent — the diverted request carries no model to reject.
 *
 * `--ignore-user-config` keeps the user's `config.toml` out of the run, which is
 * the same file refusal #6 admits: the defaults this command was measured against
 * are the CLI's own. `--ephemeral` keeps the run from writing a session file,
 * `--skip-git-repo-check` because the working directory is a private temp dir
 * rather than a repository, and the approval and sandbox settings because a
 * prompt nobody can answer would hang the run until its deadline.
 *
 * The listener's URL is a value in the CLI's own `-c key="value"` spelling, which
 * is how one setting is stated without a config file. It is always this
 * extension's own `http://127.0.0.1:<port>`: the port is the OS's to choose, so
 * there is no fixed port to collide with and no URL a caller could substitute.
 */
export function codexRefreshArgs(listenerUrl: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-c",
    `chatgpt_base_url="${listenerUrl}"`,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="read-only"',
    "hi",
  ];
}

/** The loopback address the diverted request goes to. */
const LOOPBACK = "127.0.0.1";

/**
 * A child environment with the selection surface taken out of it.
 *
 * The run exists to make the CLI refresh *this* credential, and a selection
 * variable is a way to point it somewhere else: an API key instead of a login, a
 * different base URL, a different provider. Every `OPENAI_*` and `CODEX_*`
 * variable goes, except `CODEX_HOME` — which says where the credential it is
 * meant to refresh lives, and so is the one thing the run must keep exactly as it
 * was. `RUST_LOG` goes with them because it only changes what the child prints,
 * and nothing it prints may reach the report.
 *
 * A denylist rather than an allowlist, as `claudePingEnv` is and for the same
 * reason: the child still has to be an ordinary CLI run, and an allowlist would
 * have to be right about `HOME`, proxies, locale and certificate stores too.
 * `PATH` is narrowed to absolute entries because a relative one names a different
 * file for a child with its own working directory than for this process, and
 * `NO_PROXY`/`no_proxy` gain the loopback address in both spellings so a machine
 * with a proxy configured does not route the diverted request through it.
 */
export function codexRefreshEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "CODEX_HOME") clean[key] = value;
    else if (key.startsWith("OPENAI_") || key.startsWith("CODEX_") || key === "RUST_LOG") continue;
    else clean[key] = value;
  }
  clean.PATH = (env.PATH ?? "")
    .split(":")
    .filter((segment) => segment !== "" && isAbsolute(segment))
    .join(":");
  // Each spelling is its own value with the other as fallback, not one shared
  // value: a machine may set both to different hosts, and `NO_PROXY=""` means
  // "unset here", not "erase the other spelling's list".
  clean.NO_PROXY = withLoopback(env.NO_PROXY || env.no_proxy || "");
  clean.no_proxy = withLoopback(env.no_proxy || env.NO_PROXY || "");
  return clean;
}

/**
 * A no-proxy list that names the loopback address.
 *
 * The list is carried over rather than replaced, because whatever it excludes is
 * still a host the child may need to reach for its own token refresh. An entry
 * that is already there is left alone: a duplicate would only be noise.
 */
function withLoopback(list: string): string {
  if (list.split(",").some((entry) => entry.trim() === LOOPBACK)) return list;
  return list === "" ? LOOPBACK : `${list},${LOOPBACK}`;
}

// ------------------------------------------------------------------ the run

/**
 * What a completed run left in the credential file, and whether the file moved.
 *
 * `refreshed` is the only success: a new token digest, the same `account_id`, and
 * an `exp` in the future. `unusable` is kept separate from `refreshed` because a
 * new token that is already expired, or that states no expiry at all, is
 * *something happened* — just not something to rely on.
 */
export type CodexAfter =
  | { readonly kind: "refreshed"; readonly expiresAt: number }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unusable"; readonly why: "expired" | "no-expiry" }
  | { readonly kind: "account-changed" }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly code?: string }
  | { readonly kind: "moved" }
  | { readonly kind: "not-login" };

/** Whether a request reached the loopback listener during the run. */
export type Arrival = "listener-failed" | "arrived" | "none";

/**
 * Everything `/quota-dispatch refresh-codex` can conclude.
 *
 * Cases rather than a boolean, because each of these is a different sentence a
 * user acts on, and because the differences are the point: a refused run, a run
 * that finished and changed nothing, and a run that finished with a *new* token
 * are three answers, not one answer and two caveats.
 */
export type CodexRefreshResult =
  | { readonly kind: "refused"; readonly refusal: CodexRefusalId }
  | { readonly kind: "not-due"; readonly expiresAt: number }
  | { readonly kind: "busy" }
  | { readonly kind: "listener-failed"; readonly code?: string }
  | { readonly kind: "workdir-failed"; readonly code?: string }
  | { readonly kind: "workdir-in-project" }
  | { readonly kind: "not-started"; readonly code?: string }
  | {
      readonly kind: "finished";
      readonly after: CodexAfter;
      readonly arrival: Arrival;
      readonly exitedZeroUndiverted: boolean;
    }
  | { readonly kind: "signaled"; readonly after: CodexAfter }
  | {
      readonly kind: "timed-out";
      readonly after: CodexAfter;
      readonly deadlineMs: number;
      readonly exited: boolean;
      readonly pid?: number;
    }
  | { readonly kind: "unexpected" };

/**
 * The seams one refresh is built from.
 *
 * `run` and `listen` exist for the same reason they do on `claudeRefresher`: no
 * test may spawn a real Codex CLI, and a socket is a thing to be able to replace.
 * `makeWorkdir` is a seam so "a private directory could not be created" and "the
 * directory is inside a project" can be produced without a hostile filesystem.
 * `now` is the wall clock the due check and the after-check read, not the
 * monotonic deadline clock — that one belongs to the runner.
 */
export interface CodexRefreshDeps {
  run?: ProcessRunner;
  listen?: PingListenerFactory;
  makeWorkdir?: () => Promise<string>;
  now?: () => number;
  deadlineMs?: number;
  killGraceMs?: number;
}

/**
 * One refresh. `onLaunch` is called once, immediately before the spawn — the
 * caller's one chance to say "this is about to take about fifteen seconds"
 * before it does.
 */
export type CodexRefresh = (
  target: CodexRefreshTarget,
  opts?: { onLaunch?: () => void },
) => Promise<CodexRefreshResult>;

/** An errno fit to print: `E` and up to twenty upper-case characters, or nothing. */
function safeErrno(err: unknown): string | undefined {
  const code = typeof err === "string" ? err : errnoOf(err);
  return code !== undefined && /^E[A-Z0-9]{1,20}$/.test(code) ? code : undefined;
}

/** A workdir of this process's own, in the temp directory, named for this command. */
const defaultWorkdir = (): Promise<string> => mkdtemp(join(tmpdir(), "pqd-codex-refresh-"));

/** What asking for one path's entry said. */
type EntryLookup = "present" | "absent" | "error";

/**
 * Whether a name exists, without following it.
 *
 * `lstat` rather than `stat` so a dangling symlink counts as present: both
 * `.git` and `.codex` are names the CLI would act on if it followed them, and a
 * broken one is not evidence of absence.
 */
async function entryOf(path: string): Promise<EntryLookup> {
  try {
    await lstat(path);
    return "present";
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? "absent" : "error";
  }
}

/** Every directory above `path`, not including `path` itself. */
function strictAncestors(path: string): string[] {
  const ancestors: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) return ancestors;
  }
}

/**
 * Whether the workdir is somewhere the CLI would not pick up project config.
 *
 * The child runs in a temp directory that this command just made, but a project
 * *above* it is still discovered by the CLI walking upwards: a `.git` there means
 * the run is inside a repository, whose config the CLI reads even with
 * `--ignore-user-config`, and a `.codex` there is another Codex home, which is a
 * second credential the run might write instead. The one `.codex` that is
 * expected is this machine's own, above the workdir, so it is skipped by
 * comparing resolved paths rather than by name.
 *
 * An error other than absence refuses: "I could not check" is not "there is
 * nothing there".
 */
async function vetWorkdir(workdir: string, homeReal: string): Promise<boolean> {
  for (const ancestor of strictAncestors(workdir)) {
    if ((await entryOf(join(ancestor, ".git"))) !== "absent") return false;
    const codex = await entryOf(join(ancestor, ".codex"));
    if (codex === "absent") continue;
    if (codex === "error") return false;
    try {
      if ((await realpath(join(ancestor, ".codex"))) !== homeReal) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * What the credential file holds now, judged against what it held before.
 *
 * The order is the diagnosis: a file that vanished is `missing` before it is
 * `moved`, and one that points somewhere else is `moved` before it is
 * `not-login`, because "this is no longer the file the CLI writes" is the fact
 * that explains the rest. `destination` is compared on both sides — the
 * configured path and the CLI home's own `auth.json` — so neither a moved
 * `codexCredsPath` nor a changed home can hide behind the other.
 *
 * Never reads a file it has not bounded, and never prints what it read: the
 * bytes are a credential, and the only thing that leaves this function is which
 * of these cases it is.
 */
async function readAfter(credsPath: string, before: CodexLogin, now: () => number): Promise<CodexAfter> {
  try {
    await stat(credsPath);
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code: safeErrno(err) };
  }

  try {
    if ((await realpath(credsPath)) !== before.destination) return { kind: "moved" };
    const home = await realpath(before.rawHome);
    if ((await realpath(join(home, "auth.json"))) !== before.destination) return { kind: "moved" };
  } catch {
    return { kind: "moved" };
  }

  let info;
  try {
    info = await stat(before.destination);
  } catch (err) {
    return { kind: "unreadable", code: safeErrno(err) };
  }
  if (!info.isFile()) return { kind: "unreadable" };
  // Bounded before the read, so a file that is not a login is never read into
  // memory to be rejected.
  if (info.size > MAX_CODEX_FILE_BYTES) return { kind: "not-login" };

  let bytes: Buffer;
  try {
    bytes = await readFile(before.destination);
  } catch (err) {
    return { kind: "unreadable", code: safeErrno(err) };
  }
  const text = decodeUtf8(bytes);
  const login = text === undefined ? undefined : parseManagedCodexLogin(text);
  if (login === undefined) return { kind: "not-login" };

  if (login.accountId !== before.accountId) return { kind: "account-changed" };
  if (sha256Hex(login.access) === before.accessDigest) return { kind: "unchanged" };

  // Sampled before the claim is read, so "already expired" is judged against the
  // instant this observation was taken rather than against a later one.
  const sampledAt = now();
  const expiresAt = codexTokenExpiry(login.access);
  if (expiresAt === undefined) return { kind: "unusable", why: "no-expiry" };
  if (expiresAt <= sampledAt) return { kind: "unusable", why: "expired" };
  return { kind: "refreshed", expiresAt };
}

/**
 * One refresh command, with its own `busy` flag.
 *
 * The flag is per instance rather than machine-wide on purpose: this command is a
 * human's deliberate request, and the coordination a background poller would need
 * — claims, leases, a shared halt — is exactly the machinery
 * docs/adr/0024 says this design does not have. What the flag does buy is that a
 * second keystroke cannot start a second CLI against one credential, which is the
 * race that would matter; two pi processes still can, and ADR 0024 states that
 * residual.
 *
 * The lifecycle is: snapshot the environment, admit, listen, make a workdir, vet
 * it, admit again, run, then read the file. The second admission is not
 * redundant — a `.env` or a `config.toml` can appear between the two, and the
 * before-snapshot the after-check compares against must be the one the run
 * actually started from. Cleanup is in `finally` blocks that swallow their own
 * errors, so a failure to close a socket or remove a directory can never replace
 * the outcome the user needs to see.
 */
export function createCodexRefresh(deps: CodexRefreshDeps = {}): CodexRefresh {
  const run = deps.run ?? spawnProcess;
  const listen = deps.listen ?? loopbackListener;
  const makeWorkdir = deps.makeWorkdir ?? defaultWorkdir;
  const now = deps.now ?? (() => Date.now());
  const deadlineMs = deps.deadlineMs ?? CODEX_REFRESH_DEADLINE_MS;
  const killGraceMs = deps.killGraceMs ?? CODEX_REFRESH_KILL_GRACE_MS;
  let busy = false;

  const once = async (
    target: CodexRefreshTarget,
    opts: { onLaunch?: () => void } | undefined,
  ): Promise<CodexRefreshResult> => {
    // A copy, so the checks and the child see one environment: `process.env` is
    // mutable, and a variable that changed between the admission and the spawn
    // would make the admission describe a run that did not happen.
    const host: CodexHost = { env: { ...target.host.env }, platform: target.host.platform };
    const checked: CodexRefreshTarget = { ...target, host };

    const first = await codexRefreshReadiness(checked, now());
    if (first.kind !== "ready") return first;

    let listener: PingListener;
    try {
      listener = await listen();
    } catch (err) {
      return { kind: "listener-failed", code: safeErrno(err) };
    }

    try {
      let rawDir: string;
      try {
        rawDir = await makeWorkdir();
      } catch (err) {
        return { kind: "workdir-failed", code: safeErrno(err) };
      }
      try {
        let workdir: string;
        try {
          // Canonicalised before it is vetted: the ancestors that matter are the
          // ones the child's own `cwd` will have, which is the resolved path.
          workdir = await realpath(rawDir);
        } catch (err) {
          return { kind: "workdir-failed", code: safeErrno(err) };
        }
        if (!(await vetWorkdir(workdir, first.login.homeReal))) return { kind: "workdir-in-project" };

        const second = await codexRefreshReadiness(checked, now());
        if (second.kind !== "ready") return second;

        // The launch notice goes out *before* the spawn, so the wait it explains
        // has not already happened.
        opts?.onLaunch?.();
        const end = await run({
          file: second.codex,
          args: codexRefreshArgs(listener.url),
          cwd: workdir,
          env: codexRefreshEnv(host.env),
          deadlineMs,
          killGraceMs,
        });
        if (end.kind === "not-started") return { kind: "not-started", code: safeErrno(end.errno) };

        const after = await readAfter(target.credsPath, second.login, now);
        const arrival: Arrival =
          listener.error() !== undefined ? "listener-failed" : listener.arrived() ? "arrived" : "none";

        if (end.kind === "timed-out") {
          return end.exited
            ? { kind: "timed-out", after, deadlineMs, exited: true }
            : {
                kind: "timed-out",
                after,
                deadlineMs,
                exited: false,
                ...(end.pid === undefined ? {} : { pid: end.pid }),
              };
        }
        // A signal before the deadline is not a run that finished: the exit code
        // is the only thing that says the child stopped on its own terms.
        if (end.code === null) return { kind: "signaled", after };
        return {
          kind: "finished",
          after,
          arrival,
          exitedZeroUndiverted: end.code === 0 && arrival === "none",
        };
      } finally {
        // Swallowed on purpose: the run's outcome is what the user is waiting for,
        // and a directory that would not go away must not replace it.
        await rm(rawDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      await listener.close().catch(() => undefined);
    }
  };

  return async (target, opts) => {
    if (busy) return { kind: "busy" };
    busy = true;
    try {
      return await once(target, opts);
    } catch {
      // Never the message: it could quote a path, and this module prints no path.
      return { kind: "unexpected" };
    } finally {
      busy = false;
    }
  };
}

// --------------------------------------------------------------- what it says

/** An errno as the clause a line adds, and only when it is shaped like one. */
function errnoClause(code: string | undefined): string {
  return code !== undefined && /^E[A-Z0-9]{1,20}$/.test(code) ? ` (${code})` : "";
}

/**
 * The pid a termination line names, or nothing.
 *
 * A line may only carry a finite integer, so an absent or nonsensical pid is
 * dropped rather than interpolated: `(pid NaN)` is not a fact about a process.
 */
function pidClause(pid: number | undefined): string {
  return pid !== undefined && Number.isInteger(pid) ? ` (pid ${pid})` : "";
}

/** How a run's listener evidence reads inside a sentence. */
function arrivalText(arrival: Arrival): string {
  if (arrival === "listener-failed") return "the loopback listener failed during the run";
  if (arrival === "arrived") return "a request reached the loopback listener";
  return "no request reached the loopback listener";
}

/** What a "not a refresh" observation says, in the two renderings that share it. */
type AfterNotRefresh = Exclude<CodexAfter, { kind: "refreshed" } | { kind: "unchanged" }>;

/**
 * The fact a file-that-changed-unhelpfully outcome states.
 *
 * One function for the finished sentence and the interrupted-run sentence, so
 * `finished` and `timed-out` cannot drift into two spellings of the same fact.
 */
function notARefresh(after: AfterNotRefresh): string {
  switch (after.kind) {
    case "unusable":
      return after.why === "expired"
        ? "the credential file holds a new token that is already expired"
        : "the credential file holds a new token without an expiry";
    case "account-changed":
      return "the credential file holds a different account";
    case "missing":
      return "the credential file is missing";
    case "unreadable":
      return `the credential file could not be read${errnoClause(after.code)}`;
    case "moved":
      return "codexCredsPath no longer resolves to the Codex CLI's auth.json";
    case "not-login":
      return "the credential file is no longer the Codex CLI's managed ChatGPT login";
  }
}

/**
 * The line an interrupted run adds about the file.
 *
 * A refreshed token under a run that did not finish normally is the one case that
 * needs care: the file *does* hold a new future-dated token, and it still must
 * not be relied on, because a run killed mid-exchange may have rotated the
 * refresh token without saving anything the server will accept next time.
 */
function afterFactLine(after: CodexAfter): string {
  if (after.kind === "refreshed") {
    return "After the run the file holds a new future-dated token for the same account, but the run did not finish normally; do not rely on it until codex login status agrees.";
  }
  if (after.kind === "unchanged") return "After the run the file still holds the same token.";
  return `After the run ${notARefresh(after)}.`;
}

/**
 * What the user should check when a run did not finish on its own terms: the
 * CLI's own status, and then the one repair that exists.
 */
const CHECK_LOGIN_LINE =
  "Check codex login status; if it says the login is no longer valid, run codex login.";

/**
 * The extra line a clean-but-undiverted run earns.
 *
 * A zero exit with nothing on the listener means the model call was *answered* —
 * somewhere else. That is not something the diverted run can do, so it is stated
 * as the anomaly it is rather than folded into the exit code, which looks like
 * success.
 */
const UNDIVERTED_LINE =
  "codex exited 0 while no request reached the loopback listener, which the diverted run is not expected to do; its prompt may have been answered elsewhere.";

function describeFinished(result: {
  readonly after: CodexAfter;
  readonly arrival: Arrival;
  readonly exitedZeroUndiverted: boolean;
}): { level: "info" | "warning"; lines: string[] } {
  const lines: string[] = [];
  let level: "info" | "warning" = "warning";
  switch (result.after.kind) {
    case "refreshed":
      level = "info";
      lines.push(
        `quota-dispatcher: after the run the credential file holds a new token for the same account (${formatExpiry(
          result.after.expiresAt,
        )}).`,
        "Run /quota-dispatch refresh to read the codex rail again.",
      );
      break;
    case "unchanged":
      lines.push(
        `quota-dispatcher: after the run the credential file still holds the same token (${arrivalText(result.arrival)}).`,
        "If codex login status says the login is no longer valid, run codex login.",
      );
      break;
    default:
      lines.push(`quota-dispatcher: after the run ${notARefresh(result.after)}; not reported as a refresh.`);
  }
  if (result.exitedZeroUndiverted) lines.push(UNDIVERTED_LINE);
  return { level, lines };
}

/**
 * The one notification `refresh-codex` sends, as fixed text plus a few values.
 *
 * `info` is reserved for the two answers that are not a problem: a run that
 * observed a refresh, and a token that turned out not to be due. Everything else
 * is a warning, including the runs that finished with the credential file intact
 * — because that is not a success, and a user who is told "done" would stop
 * looking.
 *
 * Nothing here reads the result's message-bearing fields: `code` is a string the
 * runner already validated, and the rest are counts and timestamps.
 */
export function describeCodexRefresh(result: CodexRefreshResult): {
  level: "info" | "warning";
  lines: string[];
} {
  const warning = (lines: string[]) => ({ level: "warning" as const, lines });
  const info = (lines: string[]) => ({ level: "info" as const, lines });

  switch (result.kind) {
    case "refused":
      return warning([`quota-dispatcher: refresh-codex ran nothing: ${refusalText(result.refusal)}.`]);
    case "not-due":
      return info([
        `quota-dispatcher: refresh-codex ran nothing: the codex token is ${formatExpiry(
          result.expiresAt,
        )}, outside this command's 5-minute refresh window.`,
      ]);
    case "busy":
      return warning(["quota-dispatcher: refresh-codex is already running."]);
    case "listener-failed":
      return warning([
        `quota-dispatcher: refresh-codex ran nothing: the loopback listener could not be opened${errnoClause(
          result.code,
        )}.`,
      ]);
    case "workdir-failed":
      return warning([
        `quota-dispatcher: refresh-codex ran nothing: a private working directory could not be created${errnoClause(
          result.code,
        )}.`,
      ]);
    case "workdir-in-project":
      return warning([
        "quota-dispatcher: refresh-codex ran nothing: the temporary directory could not be verified as outside project config (a .git or .codex above it, or lookup failed).",
      ]);
    case "not-started":
      return warning([
        `quota-dispatcher: codex could not be started${errnoClause(result.code)}; nothing was run.`,
      ]);
    case "finished":
      return describeFinished(result);
    case "signaled":
      return warning([
        "quota-dispatcher: codex exited on a signal before finishing; not reported as a refresh.",
        afterFactLine(result.after),
        CHECK_LOGIN_LINE,
      ]);
    case "timed-out": {
      const seconds = result.deadlineMs / 1_000;
      const first = result.exited
        ? `quota-dispatcher: codex did not finish within ${seconds} seconds (exit observed after the deadline); not reported as a refresh.`
        : `quota-dispatcher: codex did not finish within ${seconds} seconds and no exit was observed after termination attempts${pidClause(
            result.pid,
          )}; not reported as a refresh.`;
      return warning([first, afterFactLine(result.after), CHECK_LOGIN_LINE]);
    }
    case "unexpected":
      return warning([
        "quota-dispatcher: refresh-codex stopped on an unexpected error; nothing is claimed about the credential.",
      ]);
  }
}
