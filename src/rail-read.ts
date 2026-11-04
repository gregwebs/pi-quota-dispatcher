/**
 * One rail read: the credential is already in hand, the vendor is asked, and the
 * answer becomes a **rail reading**.
 *
 * The module has no state and no store, config, pi or credential-acquisition
 * dependency: not the rail readings file, not a configuration object, not pi, and
 * not the refresh gates or the paid ping — it is handed a credential that some
 * other module already acquired. Its unit is a source rather than a rail — one
 * request answers for `claude`, one for `codex`, and one for all three
 * Antigravity pools — so a pool group is never three requests. Credential
 * *acquisition* is deliberately outside: the Claude token may only be found by
 * consulting the machine-wide refresh gates, which is the dispatcher's state,
 * not a read's.
 *
 * What it does depend on is the vocabulary of the answer: the outbound
 * allow-list table in `endpoints.ts`, so the URLs a request uses and the URLs a
 * firewall is told about cannot drift apart, and the parsers and payload types
 * in `rail-reading.ts`, because turning a document into a reading is the last
 * thing a read does. See
 * docs/adr/0021-a-rail-read-is-its-own-module.md.
 */
import type { AntigravityAccess, AntigravityToken, CodexCredential } from "./credentials.ts";
import type { AntigravityRail } from "./rail.ts";
import { ANTIGRAVITY_QUOTA_URL, CLAUDE_USAGE_URL, CODEX_USAGE_URL } from "./endpoints.ts";
import {
  parseAntigravityUsage,
  parseClaudeUsage,
  parseCodexUsage,
  type AntigravityReadings,
  type FailedReading,
  type RailWindow,
  type VendorRail,
  type VendorReading,
} from "./rail-reading.ts";

// ------------------------------------------------------------------- pacing

/**
 * How long one quota read may stall, and how many times it is asked again
 * before the rail reads as unreadable.
 *
 * Both numbers are small on purpose. The read is awaited by `session_start`, so
 * the point of the bound is that a vendor which has gone quiet costs a session
 * a few seconds rather than the rest of the session. The retry is the other
 * half: without it a single dropped connection reads as an outage and holds
 * every agent on the route, which is a decision made on evidence a second
 * request would have supplied.
 *
 * They are a seam rather than config-file keys: how long to wait for a socket
 * is a fact about this network, not a routing preference, and the two timings
 * only mean anything together.
 *
 * See docs/adr/0006-bounded-quota-reads.md for why the retry does not soften the
 * hold rule.
 */
export interface QuotaReadPacing {
  /** One attempt is abandoned after this long, signal and all. */
  timeoutMs: number;
  /** Attempts per rail, the first one included. */
  attempts: number;
  /** The pause before each attempt after the first. */
  backoffMs: number;
}

/** The shipped timings — see `QuotaReadPacing`. */
export const DEFAULT_QUOTA_READ: QuotaReadPacing = {
  timeoutMs: 5_000,
  attempts: 2,
  backoffMs: 250,
};

/**
 * The longest one rail's own attempts can take: every attempt running out its
 * deadline, plus the pauses between them.
 *
 * What a caller adds to this — the cost of renewing a credential, say — is the
 * caller's business, because only it knows what else it does inside a read.
 */
export function readBoundMs(pacing: QuotaReadPacing): number {
  return pacing.attempts * pacing.timeoutMs + (pacing.attempts - 1) * pacing.backoffMs;
}

// ---------------------------------------------------------------- transport

/**
 * One request as a transport receives it: where to go, what to say, and how long
 * it has.
 *
 * A deadline rather than a signal, because the adapter owns the whole attempt
 * including reading the body: a body that stalls mid-stream must be abandoned by
 * the same deadline as the request that opened it.
 */
export interface TransportRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

/**
 * Why no document came back, as the three cases a reader has to act on
 * differently. The transport says *what* happened and the read says what it is
 * called, so no vendor-facing sentence is written here.
 */
export type TransportFailure =
  /** The deadline passed with no answer, or with a body still arriving. */
  | { readonly kind: "timeout" }
  /** An answer whose body is not JSON: truncation and a captive portal look like this. */
  | { readonly kind: "unreadable-body"; readonly detail: string }
  /** The request never produced a response — a refused connection, a DNS failure, TLS. */
  | { readonly kind: "network"; readonly code?: string };

/**
 * A transport's answer, in three cases rather than one optional body.
 *
 * `document` is a 2xx whose body is already parsed, because the adapter is the
 * only code that may know what a `Response` is. `status` is any other answer,
 * unread: a 4xx is the endpoint's reply and its body would only be a vendor's
 * error prose, which this extension must not repeat.
 */
export type TransportResult =
  | { readonly kind: "document"; readonly body: unknown }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "failed"; readonly failure: TransportFailure };

/**
 * The one network seam: a single method, and a union that says what happened
 * rather than throwing.
 *
 * Two adapters exist: `httpTransport` over `fetch`, and whatever a test hands in
 * — which is the reason the retry, the notes and the "is this worth asking
 * again" judgment are testable without a server, a `Response`, or a timer.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResult>;

/**
 * The real transport over one `fetch`, injectable so a test can answer without a
 * network and still drive the real classification.
 *
 * The exchange is mechanical on purpose: it applies the deadline, reads the body
 * only from a 2xx, and reduces whatever went wrong to one of three kinds. It
 * never retries (the read owns the attempts) and never writes a sentence a user
 * reads (the read owns the phrasing).
 */
export function httpTransport(http: typeof fetch = fetch): Transport {
  return async ({ url, method, headers, body, timeoutMs }: TransportRequest): Promise<TransportResult> => {
    let res: Response;
    try {
      res = await http(url, {
        ...(method === undefined ? {} : { method }),
        headers: { ...headers },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { kind: "failed", failure: networkFailure(err) };
    }
    if (!res.ok) return { kind: "status", status: res.status };
    try {
      return { kind: "document", body: await res.json() };
    } catch (err) {
      // The body read is what a deadline usually interrupts, so a timeout here
      // is the same failure as one before the response arrived.
      if (timedOut(err)) return { kind: "failed", failure: { kind: "timeout" } };
      return { kind: "failed", failure: { kind: "unreadable-body", detail: (err as Error).message } };
    }
  };
}

function timedOut(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

/**
 * A thrown request reduced to its kind, reported by the code its cause carries —
 * `ECONNREFUSED`, `ENOTFOUND`, a TLS failure — and never by its message.
 *
 * undici flattens a network failure to a bare "fetch failed" anyway, while an
 * error thrown while *building* the request quotes the header value it rejected
 * — and one of those headers is the credential. Not repeating what a request
 * error says about itself is how this extension keeps its promise that no
 * credential is ever logged.
 */
function networkFailure(err: unknown): TransportFailure {
  if (timedOut(err)) return { kind: "timeout" };
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return { kind: "network", ...(code === undefined ? {} : { code }) };
}

// --------------------------------------------------------------- the reads

/**
 * The three reads, by credential shape rather than by a rail tag.
 *
 * Each takes the credential a caller already acquired, so a caller never asks
 * "which rail is this?" twice: it acquired that rail's credential by name and
 * calls the read written for it. The Antigravity read takes the *acquired*
 * result rather than an access value because a credential failure is one
 * document's worth of failure — three pools share it.
 */
export interface RailRead {
  /** The Claude rail's usage document, with a token already in hand. */
  readonly claude: (token: string) => Promise<VendorReading>;
  /** The Codex rail's usage document. */
  readonly codex: (credential: CodexCredential) => Promise<VendorReading>;
  /** The one document that answers for all three Antigravity pools. */
  readonly antigravity: (credential: AntigravityToken) => Promise<AntigravityReadings>;
}

export interface RailReadDeps {
  /** The one network seam. Defaults to `httpTransport()` over the global `fetch`. */
  readonly transport?: Transport;
  /** Attempts, deadline and backoff. Defaults to `DEFAULT_QUOTA_READ`. */
  readonly pacing?: QuotaReadPacing;
  /** The clock `readAt` is stamped with. Defaults to `Date.now()`. */
  readonly now?: () => number;
}

/**
 * The three reads bound to one transport, one pacing and one clock.
 *
 * A factory rather than three functions taking the same arguments, so the
 * caller states the vendored facts once and a test that wants a different
 * transport does not have to know how many reads exist.
 */
export function createRailRead(deps: RailReadDeps = {}): RailRead {
  const transport = deps.transport ?? httpTransport();
  const pacing = deps.pacing ?? DEFAULT_QUOTA_READ;
  const now = deps.now ?? (() => Date.now());

  /**
   * The pause between two attempts. Deliberately not injectable: `deps.sleep`
   * elsewhere moves a lock waiter, and a clock that also shortened this backoff
   * would make "asked again and gave up" unobservable in the tests that pin it.
   */
  const backoff = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  /**
   * One vendor's document, under the deadline, retried while the failure is one
   * another attempt could fix.
   *
   * What comes back is either the parsed document or the note the rail is
   * unreadable for. The note carries an attempt count only when the read was
   * given up on: an answer another request would only repeat — a 4xx, a 429 —
   * is reported as that answer alone. The shape problem ("no usage windows
   * returned") is left to each read, because a well-formed answer we cannot use
   * is still an answer.
   */
  async function document(
    url: string,
    request: { method?: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<{ body: unknown } | { note: string }> {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await backoff(pacing.backoffMs);
      const result = await transport({ url, ...request, timeoutMs: pacing.timeoutMs });
      if (result.kind === "document") return { body: result.body };
      const note =
        result.kind === "status" ? `HTTP ${result.status}` : failureNote(result.failure, pacing.timeoutMs);
      const retry = result.kind === "failed" || retryableStatus(result.status);
      if (!retry) return { note };
      if (attempt >= pacing.attempts) return { note: afterAttempts(note, attempt) };
    }
  }

  /** The Claude rail's ordinary read, once a token has supplied the request. */
  async function claude(token: string): Promise<VendorReading> {
    const read = await document(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
    if ("note" in read) return failedReading("claude", read.note, now());

    const readAt = now();
    const windows = parseClaudeUsage(read.body);
    if (!windows.length) return failedReading("claude", "no usage windows returned", readAt);
    return { rail: "claude", ok: true, windows, readAt, raw: read.body };
  }

  /** The Codex rail's usage document, and the one answer that means "blocked outright". */
  async function codex(credential: CodexCredential): Promise<VendorReading> {
    const read = await document(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "ChatGPT-Account-Id": credential.accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if ("note" in read) return failedReading("codex", read.note, now());

    const readAt = now();
    const { windows, limited } = parseCodexUsage(read.body, { readAt });
    if (!windows.length) return failedReading("codex", "no rate_limit windows returned", readAt);
    if (!limited) return { rail: "codex", ok: true, windows, readAt, raw: read.body };
    // `limit_reached` means blocked outright, not merely close, so every budget
    // reads full rather than leaving a comfortable-looking percentage behind.
    return {
      rail: "codex",
      ok: true,
      windows: windows.map((w) => ({ ...w, used: 100 })),
      readAt,
      raw: read.body,
      note: "limit_reached=true",
    };
  }

  /**
   * The one vendor request that answers for all three Antigravity pools.
   *
   * The body carries the project only when the credential names one, an empty
   * object otherwise: a `{"project": ""}` would ask the vendor about a project
   * that has no id. The `User-Agent` is the pinned one, whose default is what
   * makes the vendor report the Argon pool at all.
   */
  async function antigravity(credential: AntigravityToken): Promise<AntigravityReadings> {
    if (!("token" in credential)) return poolFailure(credential.error, now());
    const access: AntigravityAccess = credential;
    const read = await document(ANTIGRAVITY_QUOTA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": antigravityUserAgent(),
      },
      body: JSON.stringify(access.projectId === undefined ? {} : { project: access.projectId }),
    });
    const readAt = now();
    if ("note" in read) return poolFailure(read.note, readAt);
    return poolReadings(parseAntigravityUsage(read.body), readAt, read.body);
  }

  return { claude, codex, antigravity };
}

/**
 * A failed reading, stamped with the clock at the moment the read gave up. That
 * is `readAt` — when the answer turned out to be unusable — not the TTL origin,
 * which is the store's own stamp.
 *
 * Generic in the rail so the answer a caller gets back still carries the rail it
 * was asked about: `AntigravityReadings` is a mapped type whose pool entries are
 * correlated with their key, and a constructor declared over the plain union
 * (`rail: VendorRail`) would widen the literal and hand back a value no caller
 * could put in that slot without an assertion.
 */
export function failedReading<R extends VendorRail>(
  rail: R,
  note: string,
  readAt: number,
): FailedReading & { readonly rail: R } {
  return { rail, ok: false, windows: [], readAt, note };
}

/**
 * The note one failed attempt earns, in the single line a note has room for.
 *
 * A timeout is reported by its budget rather than by the exception's own text
 * ("The operation was aborted due to timeout"), because the number is the
 * actionable part — it is the one the pacing chose and the one someone would
 * change. A body that is not JSON is named as such: a reply truncated without
 * framing and a captive portal both arrive looking like this, and the parse
 * error is the only thing that can hint at which one it was.
 */
function failureNote(failure: TransportFailure, timeoutMs: number): string {
  switch (failure.kind) {
    case "timeout":
      return `no answer within ${timeoutMs}ms`;
    case "unreadable-body":
      return `unreadable body (${failure.detail})`;
    case "network":
      return failure.code === undefined ? "request failed" : `request failed (${failure.code})`;
  }
}

/**
 * Whether asking again could get a different answer. A 4xx is the endpoint's
 * reply — an expired token stays expired and a moved endpoint stays moved — so
 * only a server-side failure is worth a second request. A 429 is deliberately
 * not on this list: it says "too many requests", and asking again 250ms later
 * without honouring `Retry-After` is the thing it is asking us not to do.
 */
function retryableStatus(status: number): boolean {
  return status >= 500;
}

/**
 * The note a rail reads as when a failure worth retrying outlived its attempts.
 *
 * The count is said out loud only when there was more than one, so the report
 * separates the two failures `unreadable` used to cover: a reading another
 * request would not have fixed — a 401, a 429, a credential store with nothing
 * to give — from one that was asked again and given up on. Both hold, but only
 * the second is about the request rather than about what the endpoint said.
 */
function afterAttempts(note: string, attempts: number): string {
  return attempts > 1 ? `${note} after ${attempts} attempts` : note;
}

// ------------------------------------------------------------- Antigravity

/**
 * The `User-Agent` Antigravity's own current client sends, and the reason it is
 * pinned rather than borrowed from whatever called pi.
 *
 * Load-bearing, not cosmetic: Google omits the Argon group from
 * `retrieveUserQuotaSummary` for older agent strings, so a request that looks
 * like an old CLI silently reports two pools instead of three — an honest failed
 * Argon rail whose cause is nowhere in the body. Bumping the version is a change
 * to what the vendor is willing to tell us, so it is one constant with one
 * documented override.
 */
export const DEFAULT_ANTIGRAVITY_USER_AGENT =
  "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

/**
 * The `User-Agent` one request carries: the pinned default, unless the
 * environment overrides it.
 *
 * The override exists so a machine behind a proxy that rewrites the header — or
 * a future vendor build that demands a newer string — does not need a release of
 * this extension. It is read per request rather than at import, so a session
 * that sets it before its first quota read is honoured.
 */
export function antigravityUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_USER_AGENT?.trim() || DEFAULT_ANTIGRAVITY_USER_AGENT;
}

/** The three pools one summary describes; a pool it said nothing about is that pool's own failure. */
function poolReadings(
  windows: Record<AntigravityRail, readonly RailWindow[]>,
  readAt: number,
  raw: unknown,
): AntigravityReadings {
  const pool = <R extends AntigravityRail>(rail: R): VendorReading & { rail: R } => {
    const found = windows[rail];
    if (!found.length) return failedReading(rail, "no usage windows returned", readAt);
    return { rail, ok: true, windows: found, readAt, raw };
  };
  return {
    "antigravity-argon": pool("antigravity-argon"),
    "antigravity-gemini": pool("antigravity-gemini"),
    "antigravity-3p": pool("antigravity-3p"),
  };
}

/**
 * One failure for the whole group, stamped once.
 *
 * A credential or transport failure happened once, at one instant; giving each
 * pool its own `now()` would date one failure three ways. `raw` is absent, not
 * carried from an earlier read: a failure reports why it failed and nothing
 * else.
 *
 * Exported because a caller that acquires the credential is the one that knows
 * a group failed before any request was made, and building three rails' worth of
 * that answer is this module's shape to know.
 */
export function poolFailure(note: string, readAt: number): AntigravityReadings {
  const pool = <R extends AntigravityRail>(rail: R): VendorReading & { rail: R } =>
    failedReading(rail, note, readAt);
  return {
    "antigravity-argon": pool("antigravity-argon"),
    "antigravity-gemini": pool("antigravity-gemini"),
    "antigravity-3p": pool("antigravity-3p"),
  };
}
