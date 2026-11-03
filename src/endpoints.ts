/**
 * Every outbound request this extension can make, in one table.
 *
 * The table is the source of truth for the fetches themselves and for the
 * allow-list the `urls` form prints. Both have to agree: an endpoint moved in the
 * fetch path but not in the list would leave a firewall rule pointing at a host
 * nothing uses, and a list that named a request no code makes would widen an
 * allow-list for no reason. Reading the URLs out of one place is what makes that
 * disagreement impossible rather than merely unlikely.
 *
 * Only requests this extension issues belong here. A credential refresh that pi
 * performs on its own — the Antigravity token, for instance — is not a URL this
 * module owns, and a `claude` subprocess started by `claudeRefresh` makes its own
 * requests in Claude Code's own client. See the README's "Where the numbers come
 * from" for that boundary.
 */
import { type Rail } from "./rail.ts";

/**
 * Claude's usage document, read with the OAuth token Claude Code refreshes.
 *
 * Undocumented, as are the two beside it.
 */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Codex's usage document, read with `openai-codex` credentials from pi's auth file. */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * The quota-summary endpoint Antigravity's own CLI calls.
 *
 * Undocumented, like the two vendor endpoints beside it, and the only place the
 * three pools' bucket ids appear. See `docs/adr/0019-antigravity-pool-rails.md`.
 */
export const ANTIGRAVITY_QUOTA_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

/**
 * One request in the table: what it asks, and which rails its answer reports on.
 *
 * `rails` is a list because one request can answer for several pools — the
 * Antigravity summary does — and a reader allow-listing by rail needs to know
 * that the three pools share one host rather than three.
 */
export interface OutboundRequest {
  readonly rails: readonly Rail[];
  readonly method: "GET" | "POST";
  readonly url: string;
  /** What the request is for, in a reader's terms rather than the vendor's. */
  readonly purpose: string;
}

/**
 * The requests, in the order the report prints their rails: Claude, Codex, then
 * Antigravity's three pools. Order is part of the list because this is also what
 * the command prints, and a stable order lets a reader compare two runs.
 */
export const OUTBOUND_REQUESTS: readonly OutboundRequest[] = [
  {
    rails: ["claude"],
    method: "GET",
    url: CLAUDE_USAGE_URL,
    purpose: "session and weekly budgets",
  },
  {
    rails: ["codex"],
    method: "GET",
    url: CODEX_USAGE_URL,
    purpose: "session and weekly budgets",
  },
  {
    rails: ["antigravity-argon", "antigravity-gemini", "antigravity-3p"],
    method: "POST",
    url: ANTIGRAVITY_QUOTA_URL,
    purpose: "one request answers all three pools",
  },
];

/**
 * A rail whose numbers cost no request, and why — so the list says DeepSeek is
 * deliberately absent rather than leaving a reader to guess it was forgotten.
 */
export interface UnrequestedRail {
  readonly rail: Rail;
  readonly why: string;
}

export const UNREQUESTED_RAILS: readonly UnrequestedRail[] = [
  { rail: "deepseek", why: "metered per token; no request is made" },
];

/**
 * The `urls` form's answer: the complete allow-list, one URL per line so it can
 * be read aloud into a firewall rule without parsing a table.
 */
export function describeOutboundRequests(): string[] {
  const lines = ["quota-dispatcher: outbound requests made by this extension"];
  for (const request of OUTBOUND_REQUESTS) {
    lines.push(
      `${request.rails.join(", ")}: ${request.purpose}`,
      `  ${request.method} ${request.url}`,
    );
  }
  for (const { rail, why } of UNREQUESTED_RAILS) lines.push(`${rail}: ${why}`);
  return lines;
}
