import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEFAULT_ANTIGRAVITY_USER_AGENT,
  DEFAULT_CONFIG,
  createDispatcher,
  httpTransport,
  parseAntigravityToken,
  providerTokenResolver,
} from "../src/index.ts";
import { parseAntigravityUsage, type RailReadings } from "../src/rail-reading.ts";
import { assertCleanExit, waitUntil } from "./fixtures/agent-write-child.ts";
import { spawnAntigravityChild } from "./fixtures/antigravity-child.ts";
import { agentTable } from "./helpers/identifiers.ts";

const NOW = 1_730_123_456_789;

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
        : [
            {
              displayName: "Gemini 4 Argon",
              buckets: [bucket("gemini-argon-wtu-weekly", "weekly", 1, weekly)],
            },
          ]),
    ],
  };
}

// ---------------------------------------------------------------- the credential

const usable = { token: "stored-access", projectId: "stored-project" };

test("a stored access token is usable, with its optional project", () => {
  assert.deepEqual(
    parseAntigravityToken(
      JSON.stringify({ antigravity: { access: "stored-access", expires: NOW + 1, projectId: "stored-project" } }),
      { now: NOW },
    ),
    usable,
  );
  // No expiry at all is not evidence of expiry.
  assert.deepEqual(parseAntigravityToken(JSON.stringify({ antigravity: { access: "stored-access" } }), { now: NOW }), {
    token: "stored-access",
  });
  // An empty or non-string project is absent rather than sent as a bad id.
  for (const projectId of ["", 5, null, {}]) {
    assert.deepEqual(
      parseAntigravityToken(JSON.stringify({ antigravity: { access: "stored-access", projectId } }), { now: NOW }),
      { token: "stored-access" },
    );
  }
});

test("an expiry at exactly this instant is already gone", () => {
  // `<=`, not `<`: a token whose expiry *is* now has no remaining life, and
  // spending a request on it is how a whole read becomes a 401.
  const expired = parseAntigravityToken(JSON.stringify({ antigravity: { access: "a", expires: NOW } }), { now: NOW });
  assert.deepEqual(expired, { error: "antigravity token expired", reason: "expired" });
  const alive = parseAntigravityToken(JSON.stringify({ antigravity: { access: "a", expires: NOW + 1 } }), { now: NOW });
  assert.deepEqual(alive, { token: "a" });
});

test("an expired entry with no access is still reported as expired", () => {
  // The expiry comes before the access check on purpose: pi may have cleared the
  // token, and the expiry is still the one failure a delegated refresh fixes.
  assert.deepEqual(
    parseAntigravityToken(JSON.stringify({ antigravity: { expires: NOW - 1 } }), { now: NOW }),
    { error: "antigravity token expired", reason: "expired" },
  );
});

test("a missing entry, an empty access, or a malformed expiry is unusable, not expired", () => {
  const cases: Array<[unknown, string]> = [
    [{}, "no antigravity.access"],
    [{ "openai-codex": { access: "a" } }, "no antigravity.access"],
    [{ antigravity: "a string" }, "no antigravity.access"],
    [{ antigravity: { access: "" } }, "no antigravity.access"],
    [{ antigravity: { access: 7 } }, "no antigravity.access"],
    [[1, 2, 3], "no antigravity.access"],
    [null, "no antigravity.access"],
    [{ antigravity: { access: "a", expires: "soon" } }, "antigravity credential has no usable expiry"],
    [{ antigravity: { access: "a", expires: null } }, "antigravity credential has no usable expiry"],
    [{ antigravity: { access: "a", expires: Number.NaN } }, "antigravity credential has no usable expiry"],
  ];
  for (const [body, error] of cases) {
    const parsed = parseAntigravityToken(JSON.stringify(body), { now: NOW });
    assert.deepEqual(parsed, { error, reason: "unusable" }, JSON.stringify(body));
  }
});

test("unreadable JSON is reported without quoting the credential file", () => {
  // A JSON syntax error's own message quotes the document, and this document is
  // a credential store: the note must be fixed text, not the parser's.
  const marker = "SECRET-ACCESS-MARKER";
  const parsed = parseAntigravityToken(`{ "antigravity": { "access": "${marker}",`, { now: NOW });
  assert.equal("error" in parsed, true);
  if (!("error" in parsed)) return;
  assert.equal(parsed.reason, "unusable");
  assert.ok(!parsed.error.includes(marker), parsed.error);
  assert.match(parsed.error, /unreadable pi auth/);
});

// ---------------------------------------------------------------- one request

interface Probe {
  requests: Array<{ url: string; method: string | undefined; headers: Record<string, string>; body: unknown }>;
  clock: number;
}

interface Fixture {
  piAuthPath: string;
  root: string;
  probe: Probe;
  dispatcher: (overrides?: {
    piAuthPath?: string;
    resolveProviderToken?: (provider: "antigravity") => Promise<string | undefined>;
    providerTokenTimeoutMs?: number;
    failing?: number;
    body?: unknown;
  }) => ReturnType<typeof createDispatcher>;
}

/** The credential an ordinary fixture's `auth.json` holds. */
const STORED_AUTH = JSON.stringify({
  // Real time, not the probe clock: a dispatcher built without an injected `now`
  // reads `Date.now()`, and an expiry in the past would skip the whole request.
  antigravity: { access: "stored-access", expires: Date.now() + 3_600_000, projectId: "stored-project" },
});

/** `auth` is the file's bytes, or `null` for no file at all. */
async function fixture(t: TestContext, auth: string | null = STORED_AUTH): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pqd-antigravity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const piAuthPath = join(root, "pi-auth.json");
  if (auth !== null) await writeFile(piAuthPath, auth, "utf8");
  const probe: Probe = { requests: [], clock: NOW };
  const dispatcher = (overrides: {
    piAuthPath?: string;
    resolveProviderToken?: (provider: "antigravity") => Promise<string | undefined>;
    providerTokenTimeoutMs?: number;
    failing?: number;
    body?: unknown;
  } = {}) => {
    let failures = overrides.failing ?? 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      probe.requests.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (failures > 0) {
        failures--;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => overrides.body ?? quotaBody() };
    }) as unknown as typeof fetch;
    return createDispatcher(
      {
        ...DEFAULT_CONFIG,
        agentDir: join(root, "agents"),
        claudeCredsPath: join(root, "no-claude-credentials.json"),
        piAuthPath: overrides.piAuthPath ?? piAuthPath,
        // This fixture's file is pi's auth file, which carries no Codex entry:
        // named here so no read can fall through to the developer's own.
        codexCredsPath: overrides.piAuthPath ?? piAuthPath,
        readingsPath: join(root, "quota-dispatch-readings.json"),
        claudeRefresh: "off",
        ttlMs: 10_000,
        agents: agentTable({}),
      },
      {
        // These tests are about credentials and the delegated refresh, so the
        // one wire fact they observe — which Authorization header a request
        // carried — is read at the transport. The document shapes themselves
        // are `rail-read.test.ts`'s.
        transport: httpTransport(fetchImpl),
        now: () => probe.clock++,
        // A definite answer, so the retry path is only entered where a test asks
        // for a 5xx; tiny timings keep a stalled body from spending real time.
        quotaRead: { timeoutMs: 200, backoffMs: 1 },
        ...(overrides.resolveProviderToken === undefined
          ? {}
          : { resolveProviderToken: overrides.resolveProviderToken }),
        ...(overrides.providerTokenTimeoutMs === undefined
          ? {}
          : { providerTokenTimeoutMs: overrides.providerTokenTimeoutMs }),
      },
    );
  };
  return { piAuthPath, root, probe, dispatcher };
}

/** The requests this fixture made, in order. */
function quotaCalls(probe: Probe) {
  return probe.requests;
}

/** One pool's readings, asserting the arm so a test reads a vendor reading. */
function pool(readings: RailReadings) {
  assert.ok(!readings.latest.metered, "a pool is quota-capped, never metered");
  return readings.latest;
}

test("a missing or unreadable auth file is unavailable without a request", async (t) => {
  const missing = await fixture(t, null);
  const missingReading = pool(await missing.dispatcher().railReadings("antigravity-argon", true));
  assert.equal(missingReading.ok === false ? missingReading.note : "", "no pi auth file");
  assert.equal(quotaCalls(missing.probe).length, 0);

  const marker = "SECRET-ACCESS-MARKER";
  const unreadable = await fixture(t, `{ "antigravity": { "access": "${marker}",`);
  const unreadableReading = pool(await unreadable.dispatcher().railReadings("antigravity-3p", true));
  assert.equal(unreadableReading.ok, false);
  const note = unreadableReading.ok === false ? unreadableReading.note : "";
  assert.match(note, /unreadable pi auth/);
  assert.ok(!note.includes(marker), note);
  assert.equal(quotaCalls(unreadable.probe).length, 0);
});

test("an expired token on another profile's auth file is unavailable and is not refreshed", async (t) => {
  const fx = await fixture(t, JSON.stringify({ antigravity: { access: "stored-access", expires: NOW - 1 } }));
  let resolverCalls = 0;
  const readings = await fx
    .dispatcher({
      resolveProviderToken: async () => {
        resolverCalls++;
        return "{}";
      },
    })
    .railReadings("antigravity-argon", true);
  const latest = pool(readings);
  assert.equal(latest.ok, false);
  const note = latest.ok === false ? latest.note : "";
  assert.match(note, /antigravity token expired/);
  assert.match(note, /not the default one/, "the refusal says why no refresh was attempted");
  assert.equal(resolverCalls, 0, "another profile's credential says nothing about this machine's provider");
  assert.equal(quotaCalls(fx.probe).length, 0, "an expired token is never sent");
});

test("an expired token with no resolver wired is unavailable, not sent", async (t) => {
  const fx = await fixture(t, JSON.stringify({ antigravity: { access: "stored-access", expires: NOW - 1 } }));
  const readings = await fx.dispatcher().railReadings("antigravity-gemini", true);
  const latest = pool(readings);
  assert.equal(latest.ok, false);
  const note = latest.ok === false ? latest.note : "";
  assert.match(note, /antigravity token expired/);
  assert.match(note, /no provider token resolver/);
  assert.equal(quotaCalls(fx.probe).length, 0);
});

test("a usable token never invokes the resolver, even where one is wired", async (t) => {
  const fx = await fixture(t);
  let resolverCalls = 0;
  await fx
    .dispatcher({
      resolveProviderToken: async () => {
        resolverCalls++;
        return "{}";
      },
    })
    .railReadings("antigravity-argon", true);
  assert.equal(resolverCalls, 0);
  assert.equal(quotaCalls(fx.probe).length, 1);
});

/**
 * The credential file is pi's, not this extension's.
 *
 * The two branches a read reaches here are both read-only: the token that was
 * used, and the token that needed a refresh this profile may not attempt. Both
 * leave the bytes exactly as they were — a dispatcher that normalized the file
 * on its way past (rewriting it compact, dropping a key) would be the second
 * writer ADR 0007 forbids. The failed-refresh branch is covered by the
 * default-path tests below, which read the file through a relocated agent
 * directory.
 */
test("reading a credential leaves auth.json byte-for-byte unchanged", async (t) => {
  const unexpired = await fixture(t);
  const before = await readFile(unexpired.piAuthPath, "utf8");
  assert.equal(pool(await unexpired.dispatcher().railReadings("antigravity-argon", true)).ok, true);
  assert.equal(await readFile(unexpired.piAuthPath, "utf8"), before, "a usable token is read, not rewritten");

  // An expired token on another profile's file: the refresh this dispatcher may
  // not attempt is not a write either.
  const expired = JSON.stringify({ antigravity: { access: "stored-access", expires: NOW - 1 } });
  const other = await fixture(t, expired);
  let resolverCalls = 0;
  const readings = await other
    .dispatcher({
      resolveProviderToken: async () => {
        resolverCalls++;
        return "{}";
      },
    })
    .railReadings("antigravity-gemini", true);
  assert.equal(pool(readings).ok, false);
  assert.equal(resolverCalls, 0);
  assert.equal(await readFile(other.piAuthPath, "utf8"), expired, "the dispatcher is not a second writer");
});

test("a pool the vendor omitted keeps its own last good reading", async (t) => {
  const fx = await fixture(t);
  const first = await fx.dispatcher().railReadings("antigravity-argon", true);
  assert.equal(pool(first).ok, true);
  // A second, forced read whose body carries only the other two pools: Argon's
  // failure must not borrow a neighbour's numbers, and the neighbours must not
  // lose theirs.
  const second = await fx.dispatcher({ body: quotaBody({ argon: false }) }).railReadings("antigravity-argon", true);
  assert.equal(pool(second).ok, false);
  assert.equal(second.lastGood?.ok, true);
  assert.deepEqual(second.lastGood?.raw, quotaBody());
  const gemini = await fx.dispatcher({ body: quotaBody({ argon: false }) }).railReadings("antigravity-gemini", true);
  assert.equal(pool(gemini).ok, true);
  assert.equal(gemini.lastGood?.rail, "antigravity-gemini");
});

// ---------------------------------------------------------------- default path

test("the resolver adapter calls pi's registry through the registry, for one provider", async () => {
  const seen: Array<{ self: unknown; provider: string }> = [];
  const registry = {
    tokens: "kept",
    async getApiKeyForProvider(this: { tokens: string }, provider: string) {
      seen.push({ self: this, provider });
      return `${this.tokens}:${provider}`;
    },
  };
  const resolve = providerTokenResolver({ modelRegistry: registry });
  assert.ok(resolve, "a registry with the method yields a resolver");
  assert.equal(await resolve("antigravity"), "kept:antigravity");
  assert.equal(seen[0]!.self, registry, "the method must keep its receiver");
  assert.deepEqual(seen.map((s) => s.provider), ["antigravity"]);

  // A pi that has no such method leaves an expired credential unavailable, which
  // is a smaller problem than calling into nothing.
  assert.equal(providerTokenResolver({}), undefined);
  assert.equal(providerTokenResolver({ modelRegistry: {} as never }), undefined);
});

test("on the default auth path, an expired token is refreshed by delegating to pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pqd-antigravity-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const marker = join(root, "refresh-started");
  const child = spawnAntigravityChild({
    agentDir,
    auth: JSON.stringify({ antigravity: { access: "expired-access", expires: Date.now() - 1_000, projectId: "old" } }),
    resolver: {
      kind: "persist",
      refreshed: JSON.stringify({
        antigravity: { access: "fresh-access", expires: Date.now() + 3_600_000, projectId: "fresh-project" },
      }),
      // What pi's registry answers: a JSON credential document, not a token this
      // dispatcher may put in an Authorization header.
      returns: JSON.stringify({ token: "fresh-access", projectId: "fresh-project" }),
      startedMarker: marker,
    },
    reads: 1,
    quota: { status: 200, body: quotaBody() },
  });
  t.after(child.kill);
  const result = await child.done;
  assertCleanExit(result);
  const output = JSON.parse(result.stdout) as {
    requests: Array<{ method: string; authorization: string | undefined; body: string | undefined }>;
    resolverCalls: number;
    reads: Array<{ latest: { ok: boolean } }>;
  };
  assert.equal(output.resolverCalls, 1);
  assert.equal(output.requests.length, 1);
  assert.equal(output.requests[0]!.method, "POST");
  // The refreshed credential that was *persisted*, never the resolver's own
  // return value — that is a JSON document, and sending it would be a 401.
  assert.equal(output.requests[0]!.authorization, "Bearer fresh-access");
  assert.deepEqual(JSON.parse(output.requests[0]!.body!), { project: "fresh-project" });
  assert.equal(output.reads[0]!.latest.ok, true);
});

test("a resolver that throws reports an expiry without echoing its message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pqd-antigravity-throw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawnAntigravityChild({
    agentDir: join(root, "agent"),
    auth: JSON.stringify({ antigravity: { access: "expired-access", expires: Date.now() - 1_000 } }),
    resolver: { kind: "throw", message: "api error: SECRET-RESOLVER-MARKER leaked" },
    reads: 1,
    quota: { status: 200, body: quotaBody() },
  });
  t.after(child.kill);
  const result = await child.done;
  assertCleanExit(result);
  const output = JSON.parse(result.stdout) as {
    requests: unknown[];
    resolverCalls: number;
    reads: Array<{ latest: { ok: boolean; note?: string } }>;
  };
  assert.equal(output.resolverCalls, 1);
  assert.equal(output.requests.length, 0, "an expired token is not sent while the refresh fails");
  const latest = output.reads[0]!.latest;
  assert.equal(latest.ok, false);
  assert.match(latest.note ?? "", /antigravity token expired/);
  assert.match(latest.note ?? "", /delegated refresh failed/);
  assert.ok(!(latest.note ?? "").includes("SECRET-RESOLVER-MARKER"), latest.note);
});

/**
 * A refresh that succeeds as a call but leaves nothing usable behind.
 *
 * pi's registry answers with a credential document whether or not it managed to
 * persist anything, so the read has to judge the file rather than the return
 * value: an expiry that is still there after the refresh is what the user needs
 * to see, and it is a different failure from the refresh itself failing.
 */
test("a refresh that persists nothing usable says so instead of repeating the expiry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pqd-antigravity-still-expired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expired = JSON.stringify({ antigravity: { access: "expired-access", expires: Date.now() - 1_000 } });
  const child = spawnAntigravityChild({
    agentDir: join(root, "agent"),
    auth: expired,
    // Resolves — `done`, not `failed` — while the file it was supposed to refresh
    // is left exactly as it was.
    resolver: { kind: "persist", returns: JSON.stringify({ token: "never-persisted" }) },
    reads: 1,
    quota: { status: 200, body: quotaBody() },
  });
  t.after(child.kill);
  const result = await child.done;
  assertCleanExit(result);
  const output = JSON.parse(result.stdout) as {
    requests: unknown[];
    resolverCalls: number;
    reads: Array<{ latest: { ok: boolean; note?: string } }>;
  };
  assert.equal(output.resolverCalls, 1);
  assert.equal(output.requests.length, 0, "a token that is still expired is never sent");
  const latest = output.reads[0]!.latest;
  assert.equal(latest.ok, false);
  assert.match(latest.note ?? "", /antigravity token expired/);
  assert.match(latest.note ?? "", /the delegated refresh produced no usable token/);
});

/**
 * The re-read after a refresh is the one that decides, so it is its reason that
 * is reported.
 *
 * A refresh that replaces the credential with something this reader cannot use —
 * a document with no `antigravity` entry, or one that no longer parses — is a
 * different failure from an expiry, and telling the user "expired" would send
 * them looking for the wrong problem.
 */
test("a re-read that fails for a new reason reports that reason, not the first read's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pqd-antigravity-reread-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawnAntigravityChild({
    agentDir: join(root, "agent"),
    auth: JSON.stringify({ antigravity: { access: "expired-access", expires: Date.now() - 1_000 } }),
    // What pi persisted is a document with no Antigravity entry at all.
    resolver: {
      kind: "persist",
      refreshed: JSON.stringify({ "openai-codex": { access: "other", accountId: "acct" } }),
      returns: JSON.stringify({ token: "gone" }),
    },
    reads: 1,
    quota: { status: 200, body: quotaBody() },
  });
  t.after(child.kill);
  const result = await child.done;
  assertCleanExit(result);
  const output = JSON.parse(result.stdout) as {
    requests: unknown[];
    resolverCalls: number;
    reads: Array<{ latest: { ok: boolean; note?: string } }>;
  };
  assert.equal(output.resolverCalls, 1);
  assert.equal(output.requests.length, 0);
  const note = output.reads[0]!.latest.note ?? "";
  assert.match(note, /no antigravity\.access/, note);
  assert.match(note, /the delegated refresh produced no usable token/, note);
  assert.ok(!note.includes("antigravity token expired"), `the re-read is what failed: ${note}`);
});

test("a refresh that times out is waited for once, and the next read recovers without a second", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pqd-antigravity-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const started = join(root, "resolver-started");
  const release = join(root, "resolver-release");
  const persisted = join(root, "resolver-persisted");
  const batchDone = join(root, "batch-done");
  const proceed = join(root, "proceed");
  const child = spawnAntigravityChild({
    agentDir,
    auth: JSON.stringify({ antigravity: { access: "expired-access", expires: Date.now() - 1_000 } }),
    resolver: {
      kind: "pending",
      refreshed: JSON.stringify({
        antigravity: { access: "fresh-access", expires: Date.now() + 3_600_000 },
      }),
      returns: JSON.stringify({ token: "fresh-access" }),
      startedMarker: started,
      release,
      persistedMarker: persisted,
    },
    // Small enough to be observed many times over, long enough that a loaded
    // machine does not turn the first wait into a flake.
    timeoutMs: 25,
    // Three forced reads while the refresh is still pending: each waits out its
    // bound, and none of them may start a second refresh or send the expired
    // token.
    reads: 3,
    batchDone,
    proceed,
    secondReads: 1,
    quota: { status: 200, body: quotaBody() },
  });
  t.after(child.kill);

  await waitUntil("the resolver to be entered", () => existsSync(started));
  // Only once all three timed-out reads are behind us may the refresh finish, so
  // "no expired token was sent while pending" is a fact about those reads and
  // not a race with the parent's cues.
  await waitUntil("the pending reads to finish", () => existsSync(batchDone));
  assert.ok(!existsSync(persisted), "the refresh has not finished yet");
  await writeFile(release, "go");
  await waitUntil("the refreshed bytes", () => existsSync(persisted));
  await writeFile(proceed, "go");

  const result = await child.done;
  assertCleanExit(result);
  const output = JSON.parse(result.stdout) as {
    requests: Array<{ authorization: string | undefined }>;
    resolverCalls: number;
    reads: Array<{ latest: { ok: boolean; note?: string } }>;
  };
  assert.equal(output.resolverCalls, 1, "a wait that timed out must not start a second refresh");
  assert.equal(output.reads.length, 4);
  for (const read of output.reads.slice(0, 3)) {
    assert.equal(read.latest.ok, false, "no expired token was sent while the refresh was pending");
    assert.match(read.latest.note ?? "", /did not finish in time/);
  }
  assert.equal(output.requests.length, 1, "only the read after the refresh succeeded asked the vendor");
  assert.equal(output.requests[0]!.authorization, "Bearer fresh-access");
  assert.equal(output.reads[3]!.latest.ok, true);
});
