import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANTIGRAVITY_QUOTA_URL,
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  OUTBOUND_REQUESTS,
  UNREQUESTED_RAILS,
  describeOutboundRequests,
} from "../src/endpoints.ts";
import { RAILS } from "../src/rail.ts";

/**
 * The list is the allow-list, so a rail missing from it would leave a user with
 * a firewall rule that silently breaks one provider, and a rail listed twice
 * would make two requests look like one. The order is checked too: the command
 * is the report's companion, and both name rails in `RAILS` order.
 */
test("every rail appears in the outbound request list exactly once, in report order", () => {
  const listed = [
    ...OUTBOUND_REQUESTS.flatMap((request) => request.rails),
    ...UNREQUESTED_RAILS.map(({ rail }) => rail),
  ];
  assert.deepEqual(listed, [...RAILS]);
});

/**
 * The entries the fetch path actually uses. Spelled with the scheme because
 * these are copied into firewall rules by hand, where a bare host and a path
 * are not the same thing.
 */
test("the table names the three vendor requests and the metered rail's absence", () => {
  assert.deepEqual(
    OUTBOUND_REQUESTS.map(({ rails, method, url }) => ({ rails, method, url })),
    [
      { rails: ["claude"], method: "GET", url: "https://api.anthropic.com/api/oauth/usage" },
      { rails: ["codex"], method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" },
      {
        rails: ["antigravity-argon", "antigravity-gemini", "antigravity-3p"],
        method: "POST",
        url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      },
    ],
  );
  // The named constants are what the fetch path imports; a table that spelled
  // its URLs again could drift from them.
  assert.deepEqual(
    [CLAUDE_USAGE_URL, CODEX_USAGE_URL, ANTIGRAVITY_QUOTA_URL],
    OUTBOUND_REQUESTS.map((request) => request.url),
  );
});

test("the urls answer puts each URL on its own line and says deepseek costs no request", () => {
  const lines = describeOutboundRequests();
  assert.equal(lines[0], "quota-dispatcher: outbound requests made by this extension");
  for (const request of OUTBOUND_REQUESTS) {
    assert.ok(
      lines.includes(`  ${request.method} ${request.url}`),
      `${request.url} must be copyable from its own line:\n${lines.join("\n")}`,
    );
  }
  assert.ok(lines.some((line) => line.startsWith("deepseek: ") && line.includes("no request")), lines.join("\n"));
});
