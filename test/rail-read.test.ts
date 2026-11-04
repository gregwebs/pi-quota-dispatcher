import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ANTIGRAVITY_QUOTA_URL,
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  DEFAULT_ANTIGRAVITY_USER_AGENT,
  DEFAULT_QUOTA_READ,
  createDispatcher,
  createRailRead,
  type Transport,
  type TransportRequest,
  type TransportResult,
} from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AntigravityReadings, RailWindow } from "../src/rail-reading.ts";

const NOW = 1_730_123_456_789;
const STORED_ACCESS = { token: "stored-access", projectId: "stored-project" };

// This file pins the rail read's own contract, and it is the only test that
// knows a vendor's endpoint, its document shape, or a header. Everything above
// it — policy, gauge, report, cache — hands the dispatcher a reading through
// `deps.read` and never sees any of that.

// ---------------------------------------------------------------- documents

/** One Claude `/usage` body, with resets only where a test states them. */
function claudeDoc(session = 93, weekly = 21, extra: Record<string, unknown> = {}): unknown {
  return { five_hour: { utilization: session }, seven_day: { utilization: weekly }, ...extra };
}

/** One Codex usage body: resets are relative to the response, as the vendor sends them. */
function codexDoc(options: {
  session?: number;
  weekly?: number;
  limited?: boolean;
  sessionResetSeconds?: number;
  weeklyResetSeconds?: number;
} = {}): unknown {
  return {
    rate_limit: {
      limit_reached: options.limited ?? false,
      primary_window: {
        used_percent: options.session ?? 3,
        limit_window_seconds: 18000,
        ...(options.sessionResetSeconds === undefined ? {} : { reset_after_seconds: options.sessionResetSeconds }),
      },
      secondary_window: {
        used_percent: options.weekly ?? 4,
        limit_window_seconds: 604800,
        ...(options.weeklyResetSeconds === undefined ? {} : { reset_after_seconds: options.weeklyResetSeconds }),
      },
    },
  };
}

/** One `retrieveUserQuotaSummary` body, in the vendor's own shape. */
function quotaBody(options: {
  argon?: boolean;
  geminiWeekly?: number;
  geminiSession?: number;
  threePartyWeekly?: number;
  threePartySession?: number;
} = {}): unknown {
  const weekly = "2026-11-05T16:46:22Z";
  const session = "2026-10-29T21:46:22Z";
  const bucket = (bucketId: string, window: string, remainingFraction: number, resetTime: string) => ({
    bucketId,
    window,
    resetTime,
    remainingFraction,
  });
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          bucket("gemini-weekly", "weekly", options.geminiWeekly ?? 0.88, weekly),
          bucket("gemini-5h", "5h", options.geminiSession ?? 0.58, session),
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          bucket("3p-weekly", "weekly", options.threePartyWeekly ?? 0.98, weekly),
          bucket("3p-5h", "5h", options.threePartySession ?? 1, session),
        ],
      },
      ...(options.argon === false
        ? []
        : [{ displayName: "Gemini 4 Argon", buckets: [bucket("gemini-argon-wtu-weekly", "weekly", 1, weekly)] }]),
    ],
  };
}

// --------------------------------------------------------------- the harness

/** A transport that records every request and answers with `answer`. */
function transportOf(answer: (request: TransportRequest, call: number) => TransportResult): {
  transport: Transport;
  requests: TransportRequest[];
} {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return answer(request, requests.length);
    },
  };
}

/** A read over one recorded transport, with the shipped pacing unless a test says otherwise. */
function readOver(
  transport: Transport,
  overrides: { attempts?: number; timeoutMs?: number; backoffMs?: number } = {},
) {
  return createRailRead({ transport, now: () => NOW, pacing: { ...DEFAULT_QUOTA_READ, ...overrides } });
}

/** The read's answer for one document, without a dispatcher in the way. */
function documentTransport(body: unknown, status?: number): Transport {
  return async () => (status === undefined ? { kind: "document", body } : { kind: "status", status });
}

function okWindows(reading: { ok: boolean; windows: readonly RailWindow[] } | undefined): readonly RailWindow[] {
  assert.ok(reading?.ok, "expected a successful reading");
  return reading.windows;
}

// ------------------------------------------------------------------ parsing

test("Claude resets are absolute epoch milliseconds, including fractional +00:00 timestamps", async () => {
  const sessionReset = "2024-11-02T03:04:05.123456+00:00";
  const weeklyReset = "2024-11-08T06:07:08Z";
  const reading = await readOver(documentTransport(claudeDoc(13, 29, {
    five_hour: { utilization: 13, resets_at: sessionReset },
    seven_day: { utilization: 29, resets_at: weeklyReset },
    seven_day_sonnet: { utilization: 41, resets_at: sessionReset },
  }))).claude("tok");

  assert.deepEqual(okWindows(reading), [
    { label: "5h", used: 13, budget: "session", resetsAt: Date.parse(sessionReset) },
    { label: "7d", used: 29, budget: "weekly", resetsAt: Date.parse(weeklyReset) },
    { label: "7d Sonnet", used: 41, budget: "weekly", resetsAt: Date.parse(sessionReset) },
  ]);
});

test("Claude omits absent and unparseable resets instead of undefined keys or relative resets", async () => {
  const reading = await readOver(documentTransport(claudeDoc(13, 29, {
    seven_day: { utilization: 29, resets_at: "not-a-date" },
  }))).claude("tok");

  assert.deepEqual(okWindows(reading), [
    { label: "5h", used: 13, budget: "session" },
    { label: "7d", used: 29, budget: "weekly" },
  ]);
  for (const window of okWindows(reading)) assert.ok(!("resetsInSeconds" in window));
});

test("Codex anchors both resets to a nonzero readAt even when limit_reached is true", async () => {
  const reading = await readOver(documentTransport(codexDoc({
    session: 17,
    weekly: 38,
    limited: true,
    sessionResetSeconds: 0,
    weeklyResetSeconds: 408848,
  }))).codex({ access: "tok", accountId: "acct" });

  assert.deepEqual(okWindows(reading), [
    { label: "5h", used: 100, budget: "session", resetsAt: NOW },
    { label: "7d", used: 100, budget: "weekly", resetsAt: NOW + 408_848_000 },
  ]);
  assert.equal(reading.ok ? reading.note : undefined, "limit_reached=true");
});

test("Codex omits an unreported reset without losing the other window's absolute reset", async () => {
  const reading = await readOver(documentTransport(codexDoc({
    session: 6,
    weekly: 42,
    sessionResetSeconds: 3600,
  }))).codex({ access: "tok", accountId: "acct" });

  assert.deepEqual(okWindows(reading), [
    { label: "5h", used: 6, budget: "session", resetsAt: NOW + 3_600_000 },
    { label: "7d", used: 42, budget: "weekly" },
  ]);
});

test("Codex drops a derived reset that is not an instant a Date can hold", async () => {
  const reading = await readOver(documentTransport({
    rate_limit: {
      limit_reached: false,
      // `1e308` seconds overflows the product to `Infinity`; `1e13` seconds is
      // finite but lands past the `Date` range (`8.64e15` ms). Both are valid JSON
      // and pass `num`, so only the derived instant can reject them.
      primary_window: { used_percent: 6, reset_after_seconds: 1e308 },
      secondary_window: { used_percent: 42, reset_after_seconds: 1e13 },
    },
  })).codex({ access: "tok", accountId: "acct" });

  assert.deepEqual(okWindows(reading), [
    { label: "5h", used: 6, budget: "session" },
    { label: "7d", used: 42, budget: "weekly" },
  ]);
});

test("a bucket's pool comes from its id, not the group it was filed under", async () => {
  // The vendor's display names and group order are presentation. Here every
  // bucket is in one group whose name belongs to none of them, and the pools
  // must still come out right.
  const group = await readOver(documentTransport({
    groups: [
      {
        displayName: "Miscellaneous",
        buckets: [
          { bucketId: "3p-5h", window: "5h", remainingFraction: 0.97 },
          { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 1 },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.42 },
        ],
      },
    ],
  })).antigravity(STORED_ACCESS);

  assert.deepEqual(okWindows(group["antigravity-argon"]).map((w) => w.label), ["gemini-argon-wtu-weekly"]);
  assert.deepEqual(okWindows(group["antigravity-gemini"]).map((w) => w.label), ["gemini-5h"]);
  assert.deepEqual(okWindows(group["antigravity-3p"]).map((w) => w.label), ["3p-5h"]);
});
test("Argon is matched before the general gemini prefix", async () => {
  const group = await readOver(documentTransport({
    groups: [
      {
        displayName: "Merged",
        buckets: [
          { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2026-11-05T16:46:22Z" },
          { bucketId: "gemini-3-pro-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2026-11-05T16:46:22Z" },
        ],
      },
    ],
  })).antigravity(STORED_ACCESS);

  assert.deepEqual(okWindows(group["antigravity-argon"]).map((w) => w.used), [10]);
  assert.deepEqual(okWindows(group["antigravity-gemini"]).map((w) => w.used), [20]);
});

test("hostile bodies parse to three empty pools instead of throwing or coercing", async () => {
  for (const body of [null, 42, "text", {}, { groups: "nope" }, { groups: [{ buckets: 7 }] }]) {
    const group = await readOver(documentTransport(body)).antigravity(STORED_ACCESS);
    for (const rail of ["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const) {
      const reading = group[rail];
      assert.equal(reading.ok, false, `${rail} from ${JSON.stringify(body)}`);
      assert.equal(reading.ok === false ? reading.note : "", "no usage windows returned");
      assert.ok(!("raw" in reading), "a failure carries no vendor body");
    }
  }
});

test("remainingFraction is complemented and clamped to whole percent", async () => {
  const windowsFor = async (remainingFraction: number) => {
    const group = await readOver(documentTransport({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction, resetTime: "2026-10-29T21:46:22Z" }],
        },
      ],
    })).antigravity(STORED_ACCESS);
    return okWindows(group["antigravity-gemini"]);
  };

  assert.deepEqual((await windowsFor(1)).map((w) => w.used), [0]);
  assert.deepEqual((await windowsFor(0.42)).map((w) => w.used), [58]);
  // The vendor's own number outside [0, 1] would otherwise weigh as a negative or
  // impossible usage figure.
  assert.deepEqual((await windowsFor(-0.5)).map((w) => w.used), [100]);
  assert.deepEqual((await windowsFor(2)).map((w) => w.used), [0]);
});

test("an unfamiliar window is kept as display-only and invents no budget", async () => {
  const group = await readOver(documentTransport({
    groups: [
      {
        buckets: [
          { bucketId: "gemini-monthly", window: "monthly", remainingFraction: 0.2 },
          { bucketId: "gemini-5h", window: "5hr", remainingFraction: 0.2 },
        ],
      },
    ],
  })).antigravity(STORED_ACCESS);

  assert.deepEqual(okWindows(group["antigravity-gemini"]), [
    { label: "gemini-monthly", used: 80 },
    { label: "gemini-5h", used: 80 },
  ]);
});
test("a bucket of no known pool is dropped rather than guessed into one", async () => {
  const group = await readOver(documentTransport({
    groups: [
      { displayName: "Elsewhere", buckets: [{ bucketId: "something-else", window: "weekly", remainingFraction: 0.5 }] },
    ],
  })).antigravity(STORED_ACCESS);

  for (const rail of ["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const) {
    assert.equal(group[rail].ok, false, rail);
  }
});

test("reset times are parsed as instants, and unusable ones are omitted entirely", async () => {
  const group = await readOver(documentTransport({
    groups: [
      {
        buckets: [
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5, resetTime: "2026-11-05T16:46:22Z" },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: "2026-10-29T21:46:22.123456+00:00" },
          { bucketId: "gemini-3p", window: "weekly", remainingFraction: 0.5, resetTime: "not a time" },
          { bucketId: "gemini-7d", window: "weekly", remainingFraction: 0.5, resetTime: 12 },
          { bucketId: "3p-5h", window: "5h", remainingFraction: 0.5, resetTime: "1970-01-01T00:00:00Z" },
        ],
      },
    ],
  })).antigravity(STORED_ACCESS);

  const windows = okWindows(group["antigravity-gemini"]);
  assert.deepEqual(windows, [
    { label: "gemini-weekly", used: 50, budget: "weekly", resetsAt: Date.parse("2026-11-05T16:46:22Z") },
    { label: "gemini-5h", used: 50, budget: "session", resetsAt: Date.parse("2026-10-29T21:46:22.123456+00:00") },
    // A malformed or non-string reset is dropped, and the key is absent rather
    // than present as `undefined`.
    { label: "gemini-3p", used: 50, budget: "weekly" },
    { label: "gemini-7d", used: 50, budget: "weekly" },
  ]);
  for (const window of windows) {
    assert.equal("resetsAt" in window ? typeof window.resetsAt : "absent", "resetsAt" in window ? "number" : "absent");
  }
  // Epoch 0 is a real instant, not a missing one.
  const threeParty = group["antigravity-3p"];
  assert.equal(threeParty.ok ? threeParty.windows[0]!.resetsAt : undefined, 0);
});
test("windows are kept in encounter order, one entry per bucket", async () => {
  const group = await readOver(documentTransport({
    groups: [
      { buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.9 }] },
      { buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 0.4 }] },
      { buckets: [{ bucketId: "3p-weekly-preview", window: "weekly", remainingFraction: 0.95 }] },
    ],
  })).antigravity(STORED_ACCESS);

  assert.deepEqual(okWindows(group["antigravity-3p"]).map((w) => [w.label, w.budget, w.used]), [
    ["3p-weekly", "weekly", 10],
    ["3p-5h", "session", 60],
    ["3p-weekly-preview", "weekly", 5],
  ]);
});
test("any pool read is one POST that answers for all three", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "document", body: quotaBody() }));
  const group = await readOver(transport).antigravity(STORED_ACCESS);

  assert.equal(requests.length, 1, "a pool group is one vendor request");
  const [request] = requests;
  assert.equal(request!.url, ANTIGRAVITY_QUOTA_URL);
  assert.equal(request!.method, "POST");
  assert.equal(request!.headers.Authorization, "Bearer stored-access");
  assert.equal(request!.headers["Content-Type"], "application/json");
  assert.equal(request!.headers.Accept, "application/json");
  assert.equal(request!.headers["User-Agent"], DEFAULT_ANTIGRAVITY_USER_AGENT);
  assert.deepEqual(JSON.parse(request!.body!), { project: "stored-project" });
  assert.equal(request!.timeoutMs, DEFAULT_QUOTA_READ.timeoutMs);

  // One answer, one instant: three stamps would be three answers.
  const readAts = new Set(
    (["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const).map((rail) => group[rail].ok && group[rail].readAt),
  );
  assert.equal(readAts.size, 1);
  // Each pool's raw is the whole body, so a generator reading any pool sees the
  // account-wide document.
  const raws = (["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const).map((rail) => {
    const reading = group[rail];
    return reading.ok ? reading.raw : undefined;
  });
  assert.deepEqual(raws[1], raws[0]);
  assert.deepEqual(raws[2], raws[0]);
});

test("the request body carries the project only when the credential names one", async () => {
  const withoutProject = transportOf(() => ({ kind: "document", body: quotaBody() }));
  await readOver(withoutProject.transport).antigravity({ token: "stored-access" });
  assert.deepEqual(JSON.parse(withoutProject.requests[0]!.body!), {}, "an empty project id is not sent as one");

  const withProject = transportOf(() => ({ kind: "document", body: quotaBody() }));
  await readOver(withProject.transport).antigravity(STORED_ACCESS);
  assert.deepEqual(JSON.parse(withProject.requests[0]!.body!), { project: "stored-project" });
});

test("the User-Agent is the pinned one unless the environment overrides it, trimmed", async (t) => {
  const previous = process.env.ANTIGRAVITY_USER_AGENT;
  t.after(() => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_USER_AGENT;
    else process.env.ANTIGRAVITY_USER_AGENT = previous;
  });

  const userAgentSent = async () => {
    const { transport, requests } = transportOf(() => ({ kind: "document", body: quotaBody() }));
    await readOver(transport).antigravity(STORED_ACCESS);
    return requests[0]!.headers["User-Agent"];
  };

  delete process.env.ANTIGRAVITY_USER_AGENT;
  assert.equal(await userAgentSent(), DEFAULT_ANTIGRAVITY_USER_AGENT);

  // Blank is not an override: falling back to the pinned string is the only way
  // the vendor is asked in a way that reports the Argon pool at all.
  process.env.ANTIGRAVITY_USER_AGENT = "   ";
  assert.equal(await userAgentSent(), DEFAULT_ANTIGRAVITY_USER_AGENT);

  process.env.ANTIGRAVITY_USER_AGENT = "  antigravity/cli/2.0.0  ";
  assert.equal(await userAgentSent(), "antigravity/cli/2.0.0");
});

test("each rail's request carries its own URL, headers and method", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "document", body: claudeDoc() }));
  await readOver(transport).claude("claude-token");
  assert.equal(requests[0]!.url, CLAUDE_USAGE_URL);
  assert.equal(requests[0]!.method, undefined, "a read is a GET unless it says otherwise");
  assert.equal(requests[0]!.headers.Authorization, "Bearer claude-token");
  assert.equal(requests[0]!.headers["anthropic-beta"], "oauth-2025-04-20");

  const codex = transportOf(() => ({ kind: "document", body: codexDoc() }));
  await readOver(codex.transport).codex({ access: "codex-token", accountId: "acct-42" });
  assert.equal(codex.requests[0]!.url, CODEX_USAGE_URL);
  assert.equal(codex.requests[0]!.headers.Authorization, "Bearer codex-token");
  assert.equal(codex.requests[0]!.headers["ChatGPT-Account-Id"], "acct-42");
});

// ---------------------------------------------------------- failure, retry

test("a 5xx is asked again, and every attempt is the same request", async () => {
  const attempts: TransportRequest[] = [];
  const read = readOver(async (request) => {
    attempts.push(request);
    return attempts.length === 1 ? { kind: "status", status: 503 } : { kind: "document", body: quotaBody() };
  }, { backoffMs: 1 });

  const group = await read.antigravity(STORED_ACCESS);
  assert.equal(attempts.length, 2);
  for (const request of attempts) {
    assert.equal(request.url, ANTIGRAVITY_QUOTA_URL);
    assert.equal(request.method, "POST");
    assert.deepEqual(JSON.parse(request.body!), { project: "stored-project" });
    assert.equal(request.headers.Authorization, "Bearer stored-access");
  }
  assert.equal(group["antigravity-gemini"].ok, true, "the second attempt's answer is the reading");
});

test("a 401 is the endpoint's answer, so it is not retried", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "status", status: 401 }));
  const reading = await readOver(transport, { backoffMs: 1 }).codex({ access: "tok", accountId: "acct" });

  assert.equal(requests.length, 1, "HTTP 401 is an answer");
  assert.equal(reading.ok, false);
  assert.equal(reading.ok === false ? reading.note : "", "HTTP 401");
});

test("a 429 asks us to slow down, so it is not retried", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "status", status: 429 }));
  await readOver(transport, { backoffMs: 1 }).claude("tok");
  assert.equal(requests.length, 1, "HTTP 429 is an answer");
});

test("a definite answer on the retry carries no attempt count", async () => {
  const { transport, requests } = transportOf((_request, call) =>
    call === 1 ? { kind: "status", status: 503 } : { kind: "status", status: 401 },
  );
  const reading = await readOver(transport, { backoffMs: 1 }).codex({ access: "tok", accountId: "acct" });

  assert.equal(requests.length, 2);
  assert.equal(reading.ok === false ? reading.note : "", "HTTP 401", "an answer, not a read that was given up on");
});

test("a rail that failed every attempt says how many were spent", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "status", status: 500 }));
  const reading = await readOver(transport, { backoffMs: 1 }).claude("tok");

  assert.equal(requests.length, 2);
  assert.equal(reading.ok === false ? reading.note : "", "HTTP 500 after 2 attempts");
});

test("a body that is not JSON reads as an unreadable body, not as a shape problem", async () => {
  const { transport, requests } = transportOf(() => ({
    kind: "failed",
    failure: { kind: "unreadable-body", detail: "Unexpected token '<'" },
  }));
  const reading = await readOver(transport, { backoffMs: 1 }).codex({ access: "tok", accountId: "acct" });

  assert.equal(requests.length, 2);
  assert.match(reading.ok === false ? reading.note : "", /^unreadable body \(.*\) after 2 attempts$/);
});

test("a timeout is reported by its budget, and attempted again", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "failed", failure: { kind: "timeout" } }));
  const reading = await readOver(transport, { backoffMs: 1, timeoutMs: 20 }).claude("tok");

  assert.equal(requests.length, 2);
  assert.equal(reading.ok === false ? reading.note : "", "no answer within 20ms after 2 attempts");
});

test("a network failure is reported by its code and never by its message", async () => {
  const exchange = transportOf(() => ({
    kind: "failed",
    // The message a request error carries can quote the header value it
    // rejected, and one of those headers is the credential.
    failure: { kind: "network", code: "ECONNREFUSED" },
  }));
  const reading = await readOver(exchange.transport, { backoffMs: 1 }).claude("tok");

  assert.equal(reading.ok === false ? reading.note : "", "request failed (ECONNREFUSED) after 2 attempts");
  assert.ok(!(reading.ok === false ? reading.note : "").includes("sk-secret"));
});

test("a failure with no code is a bare request failure", async () => {
  const reading = await readOver(
    async () => ({ kind: "failed", failure: { kind: "network" } }),
    { backoffMs: 1 },
  ).claude("tok");
  assert.equal(reading.ok === false ? reading.note : "", "request failed after 2 attempts");
});

test("a well-formed answer with no windows is still an answer, and says so", async () => {
  const claude = await readOver(documentTransport({})).claude("tok");
  assert.equal(claude.ok === false ? claude.note : "", "no usage windows returned");
  assert.equal(claude.ok === false ? claude.readAt : undefined, NOW);

  const codex = await readOver(documentTransport({ rate_limit: {} })).codex({ access: "tok", accountId: "acct" });
  assert.equal(codex.ok === false ? codex.note : "", "no rate_limit windows returned");
});

test("a credential that was never acquired is one group-wide failure, not a request", async () => {
  const { transport, requests } = transportOf(() => ({ kind: "document", body: quotaBody() }));
  const group: AntigravityReadings = await readOver(transport).antigravity({
    error: "no pi auth file",
    reason: "unusable",
  });

  assert.equal(requests.length, 0);
  for (const rail of ["antigravity-argon", "antigravity-gemini", "antigravity-3p"] as const) {
    assert.equal(group[rail].ok === false ? group[rail].note : "", "no pi auth file");
  }
  assert.deepEqual(new Set(Object.values(group).map((r) => r.readAt)).size, 1, "one failure, one instant");
});

// ------------------------------------------------------------- the pacing

/**
 * `undefined` in an injected timing has to read as "not stated". It used to
 * replace the shipped value outright, and `AbortSignal.timeout(undefined)` then
 * threw — inside the attempt, so a configuration mistake was reported as a
 * network blip.
 *
 * `backoffMs` is the field this test can see: a leaked `undefined` retries with
 * no pause at all, where the shipped 250ms is unmissable.
 */
test("an unstated timing reads as the shipped one, not as undefined", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pqd-rail-read-pacing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeCredsPath = join(root, "claude.json");
  await writeFile(claudeCredsPath, JSON.stringify({
    claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 3_600_000 },
  }));

  const { transport } = transportOf(() => ({ kind: "status", status: 500 }));
  const dispatcher = createDispatcher(
    {
      ...DEFAULT_CONFIG,
      agentDir: root,
      claudeCredsPath,
      codexCredsPath: join(root, "none.json"),
      piAuthPath: join(root, "none.json"),
      readingsPath: join(root, "readings.json"),
      agents: {},
    },
    { transport, now: () => NOW, quotaRead: { backoffMs: undefined } },
  );

  const started = Date.now();
  const { latest } = await dispatcher.railReadings("claude", true);
  assert.equal(latest.ok === false ? latest.note : "", "HTTP 500 after 2 attempts");
  assert.ok(Date.now() - started >= 200, "the shipped backoff was used");
});

test("the backoff between attempts is real time, and is not a dispatcher clock", () => {
  // Compile-negative guard: `deps.sleep` moves the readings file's lock waiter,
  // and a read that honoured an injected clock would make "asked again and gave
  // up" unobservable in the tests that pin it. ADR 0021 records the reason.
  // @ts-expect-error a read takes no sleep seam
  createRailRead({ sleep: async () => {} });
});
