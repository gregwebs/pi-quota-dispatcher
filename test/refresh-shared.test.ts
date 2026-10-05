import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  CLAUDE_PING_COOLDOWN_MS, DEFAULT_CONFIG, claudeInstall, createDispatcher,
  type ClaudeIdentity, type ClaudeRefresh,
} from "../src/index.ts";
import { lockPathFor, withLockPath } from "../src/agent-file.ts";
import { createSharedReadings } from "../src/readings-file.ts";

const NOW = 1_730_123_456_789;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pqd-refresh-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agents"); await mkdir(agentDir);
  const claudeCredsPath = join(root, "claude.json");
  const piAuthPath = join(root, "auth.json");
  await writeFile(piAuthPath, JSON.stringify({ "openai-codex": { access: "test", accountId: "test" } }));
  const cfg = { ...DEFAULT_CONFIG, agentDir, claudeCredsPath, piAuthPath,
    readingsPath: join(root, "readings.json"), claudeRefresh: "offline-ping" as const };
  const probe: { clock: number; refreshes: number; identity: ClaudeIdentity | undefined; fetches: string[] } = {
    clock: NOW, refreshes: 0, identity: { path: join(root, "bin", "claude"), mtimeMs: 100 }, fetches: [],
  };
  const token = async (usable: boolean) => writeFile(claudeCredsPath, JSON.stringify({
    claudeAiOauth: { accessToken: usable ? "usable-token" : "expired-token",
      expiresAt: probe.clock + (usable ? 86_400_000 : -1_000) },
  }));
  await token(false);
  const make = (verdict: ClaudeRefresh, sleep?: (ms: number) => Promise<void>) => createDispatcher(cfg, {
    refreshClaude: async () => { probe.refreshes++; return verdict(); },
    now: () => probe.clock, claudeIdentity: async () => probe.identity,
    readKeychain: async () => ({ error: "no keychain" }),
    sleep: sleep ?? (async (ms) => { probe.clock += ms; }),
    readings: { fetchWaitMs: 100, writeWaitMs: 100, pollMs: 1, staleMs: 10_000 },
    fetchImpl: (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("chatgpt.com")) {
        return { ok: true, status: 200, json: async () => ({ rate_limit: {
          primary_window: { used_percent: 5 }, secondary_window: { used_percent: 10 },
        } }) };
      }
      assert.ok(String(url).includes("anthropic.com"), `unexpected request ${url}`);
      probe.fetches.push(init?.headers?.Authorization ?? "");
      return { ok: true, status: 200, json: async () => ({
        five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
      }) };
    }) as unknown as typeof fetch,
  });
  return { root, cfg, probe, make, token };
}
const failed: ClaudeRefresh = async () => ({ outcome: "failed", note: "offline deterministic failure" });
const pinged: ClaudeRefresh = async () => ({ outcome: "pinged" });
const undiverted: ClaudeRefresh = async () => ({ outcome: "undiverted", note: "diversion did not apply" });

// Defect: only the originating process sees its cooldown; TTL masks the missing gate.
test("two dispatchers share a failed offline ping cooldown and retry after it", async (t) => {
  const fx = await fixture(t); const a = fx.make(failed); const b = fx.make(failed);
  assert.equal((await a.railReadings("claude", true)).latest.ok, false);
  assert.equal(fx.probe.refreshes, 1);
  fx.probe.clock = NOW + CLAUDE_PING_COOLDOWN_MS - 1;
  assert.equal((await b.railReadings("claude", true)).latest.ok, false);
  assert.equal(fx.probe.refreshes, 1, "a forced peer read must honour the shared gate");
  fx.probe.clock = NOW + CLAUDE_PING_COOLDOWN_MS + 1;
  await b.railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 2);
  assert.deepEqual(fx.probe.fetches, [], "expired tokens never reach the vendor");
});

// Defect: a peer poll writes a fresh cooldown timestamp, indefinitely postponing retries.
test("shared cooldown hits never re-arm: retry exactly one window after the attempt", async (t) => {
  const fx = await fixture(t); const a = fx.make(failed); const b = fx.make(failed);
  await a.railReadings("claude", true);
  for (const offset of [60_000, 300_000, CLAUDE_PING_COOLDOWN_MS - 1]) {
    fx.probe.clock = NOW + offset;
    await b.railReadings("claude", true);
    assert.equal(fx.probe.refreshes, 1, `no retry at offset ${offset}`);
  }
  fx.probe.clock = NOW + CLAUDE_PING_COOLDOWN_MS;
  // Fresh instance proves the file, not just a local timestamp, was left alone.
  await fx.make(failed).railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 2, "window starts at attempt, not last gate hit");
});

// Defect: pinged-without-refresh is not shared, or a usable credential never clears halt.
test("a pinged expired episode halts peers until a usable token ends the episode", async (t) => {
  const fx = await fixture(t); const a = fx.make(pinged); const b = fx.make(pinged);
  await a.railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 1);
  fx.probe.clock += CLAUDE_PING_COOLDOWN_MS * 10;
  await b.railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 1, "halt is not a cooldown");
  await fx.token(true);
  assert.equal((await b.railReadings("claude", true)).latest.ok, true);
  assert.deepEqual(fx.probe.fetches, ["Bearer usable-token"]);
  assert.equal(fx.probe.refreshes, 1);
  await fx.token(false);
  await fx.make(pinged).railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 2, "usable read must clear the halt in the shared file");
});

for (const changed of ["path", "mtime"] as const) {
  // Defect: sticky dies on process restart/usable token, or identity compares only one field.
  test(`sticky undiverted halt survives a new dispatcher and clears on changed ${changed}`, async (t) => {
    const fx = await fixture(t);
    const a = fx.make(async () => { await fx.token(true); return undiverted(); });
    assert.equal((await a.railReadings("claude", true)).latest.ok, true);
    assert.equal(fx.probe.refreshes, 1);
    const b = fx.make(failed);
    assert.equal((await b.railReadings("claude", true)).latest.ok, true);
    await fx.token(false);
    fx.probe.clock += CLAUDE_PING_COOLDOWN_MS * 10;
    assert.equal((await b.railReadings("claude", true)).latest.ok, false);
    assert.equal(fx.probe.refreshes, 1, "new process and usable token must not clear sticky");
    const identity = fx.probe.identity!;
    fx.probe.identity = changed === "path"
      ? { ...identity, path: join(fx.root, "new-bin", "claude") }
      : { ...identity, mtimeMs: identity.mtimeMs + 1 };
    await b.railReadings("claude", true);
    assert.equal(fx.probe.refreshes, 2, "changed resolved install ends sticky halt");
  });
}

// Defect: a forced report implicitly clears sticky.
test("force report retains the shared sticky halt", async (t) => {
  const fx = await fixture(t); await fx.make(undiverted).railReadings("claude", true);
  await fx.make(failed).report({ force: true });
  assert.equal(fx.probe.refreshes, 1, "force alone does not clear sticky");
});

// Defect: clearStickyHalt only clears local state, not the file a peer sees.
test("explicit clearStickyHalt permits a new dispatcher's later expiry", async (t) => {
  const fx = await fixture(t); await fx.make(undiverted).railReadings("claude", true);
  await fx.make(failed).clearStickyHalt();
  await fx.make(failed).railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 2, "explicit clear persists to a new process");
});

// Defect: failure to resolve the install is mistaken for proof it changed.
test("an unresolved identity retains an existing resolved sticky halt", async (t) => {
  const fx = await fixture(t); await fx.make(undiverted).railReadings("claude", true);
  fx.probe.identity = undefined;
  await fx.make(failed).railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 1);
});

// Defect: unknown-at-arm sticky is auto-cleared as soon as PATH starts resolving.
test("a sticky halt armed without an identity needs explicit clearing", async (t) => {
  const fx = await fixture(t); fx.probe.identity = undefined;
  await fx.make(undiverted).railReadings("claude", true);
  fx.probe.identity = { path: join(fx.root, "claude"), mtimeMs: 200 };
  const b = fx.make(failed); await b.railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 1);
  await b.clearStickyHalt(); await b.railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 2);
});

async function binFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pqd-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Defect: wrong PATH resolution/mtime, or spawning the binary instead of statting it.
test("claudeInstall resolves an executable on a temp PATH with its mtime", async (t) => {
  const root = await binFixture(t); const path = join(root, "claude");
  // If accidentally spawned, this deliberately cannot successfully run.
  await writeFile(path, "not an executable program\n"); await chmod(path, 0o755);
  const { mtimeMs } = await stat(path);
  assert.deepEqual(await claudeInstall({ PATH: root }), { path, mtimeMs });
});

// Defect: falls back to the real machine's PATH when the injected PATH has no claude.
test("claudeInstall returns undefined when the temp PATH has no claude", async (t) => {
  const root = await binFixture(t);
  assert.equal(await claudeInstall({ PATH: root }), undefined);
});

// Defect: stat/access alone accepts directories or fails to continue scanning PATH.
test("claudeInstall ignores a directory named claude and continues scanning PATH", async (t) => {
  const root = await binFixture(t); const first = join(root, "first"); const second = join(root, "second");
  await mkdir(first); await mkdir(second); await mkdir(join(first, "claude"));
  assert.equal(await claudeInstall({ PATH: first }), undefined);
  const path = join(second, "claude"); await writeFile(path, "not a program\n"); await chmod(path, 0o755);
  assert.deepEqual(await claudeInstall({ PATH: [first, second].join(delimiter) }), {
    path, mtimeMs: (await stat(path)).mtimeMs,
  });
});

// Defect: file existence accepted without checking execute permission.
test("claudeInstall ignores a non-executable claude file", async (t) => {
  const root = await binFixture(t); const path = join(root, "claude");
  await writeFile(path, "not a program\n"); await chmod(path, 0o644);
  assert.equal(await claudeInstall({ PATH: root }), undefined);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("concurrent forced fresh reads across dispatchers make exactly one offline ping", async (t) => {
  const fx = await fixture(t);
  const started = gate(); const finish = gate(); const waiting = gate(); const published = gate();
  const a = fx.make(async () => {
    started.release(); await finish.promise;
    await fx.token(true);
    return pinged();
  });
  const b = fx.make(pinged, async () => {
    waiting.release(); await published.promise;
  });
  const first = a.railReadings("claude", true);
  await started.promise;
  const second = b.railReadings("claude", true);
  await waiting.promise;
  finish.release();
  let reading;
  try { reading = await first; } finally { published.release(); }
  assert.deepEqual(await second, reading);
  assert.equal(reading.latest.ok, true);
  assert.equal(fx.probe.refreshes, 1);
  assert.deepEqual(fx.probe.fetches, ["Bearer usable-token"]);
});

test("sticky identity is captured before a ping that changes the install", async (t) => {
  const fx = await fixture(t);
  const oldIdentity = fx.probe.identity!;
  const newIdentity = { ...oldIdentity, mtimeMs: oldIdentity.mtimeMs + 1 };
  const dispatcher = fx.make(async () => {
    fx.probe.identity = newIdentity;
    return undiverted();
  });
  assert.equal((await dispatcher.railReadings("claude", true)).latest.ok, false);
  assert.equal(fx.probe.refreshes, 1);
  assert.equal((await dispatcher.railReadings("claude", true)).latest.ok, false);
  assert.equal(fx.probe.refreshes, 2, "changed install must retry instead of inheriting the old install's sticky halt");
  await dispatcher.railReadings("claude", true);
  assert.equal(fx.probe.refreshes, 2, "unchanged new install remains sticky after its own attempt");
  assert.deepEqual(fx.probe.fetches, [], "no ping refreshed the expired token");
});

test("claudeInstall resolves an empty leading PATH segment to the working directory", async (t) => {
  const root = await binFixture(t); const cwd = join(root, "cwd"); const bin = join(root, "bin");
  await mkdir(cwd); await mkdir(bin);
  for (const dir of [cwd, bin]) {
    await writeFile(join(dir, "claude"), "not an executable program\n");
    await chmod(join(dir, "claude"), 0o755);
  }
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    const path = resolve(process.cwd(), "claude");
    assert.deepEqual(await claudeInstall({ PATH: delimiter + bin }), {
      path, mtimeMs: (await stat(path)).mtimeMs,
    });
  } finally {
    process.chdir(originalCwd);
  }
});

for (const intervenes of [false, true]) {
  test(intervenes
    ? "dispatcher honours a current-install sticky replacement published while stale clear waits"
    : "dispatcher clears a stale-install sticky halt and pings when no peer intervenes", async (t) => {
    const fx = await fixture(t);
    const oldIdentity = fx.probe.identity!;
    const identity = { ...oldIdentity, mtimeMs: oldIdentity.mtimeMs + 1 };
    fx.probe.identity = identity;
    const stale = { note: "old install", claudePath: oldIdentity.path, claudeMtimeMs: oldIdentity.mtimeMs };
    const replacement = { note: "current install", claudePath: identity.path, claudeMtimeMs: identity.mtimeMs };
    const makeStore = () => createSharedReadings({
      path: fx.cfg.readingsPath, now: () => fx.probe.clock,
      sleep: async () => { assert.fail("peer write should be uncontended"); },
      pacing: { fetchWaitMs: 100, writeWaitMs: 100, pollMs: 1, staleMs: 10_000 },
    });
    const peer = makeStore();
    await peer.setStickyHalt(stale);
    const lock = lockPathFor(fx.cfg.readingsPath);
    let waits = 0;
    const dispatcher = fx.make(failed, async () => {
      waits++;
      assert.equal(waits, 1, "clear must wait exactly once");
      await rm(lock);
      await peer.setStickyHalt(replacement);
    });
    if (intervenes) {
      const held = await withLockPath(lock, {}, () => NOW, async () => {
        assert.fail("external lock should be uncontended");
      }, async () => {
        assert.equal((await dispatcher.railReadings("claude", true)).latest.ok, false);
      });
      assert.equal(held.ok, true);
      assert.equal(waits, 1);
      assert.equal(fx.probe.refreshes, 0, "surviving halt must prevent the ping");
      assert.deepEqual((await makeStore().gates(fx.cfg.claudeCredsPath)).sticky, replacement);
    } else {
      assert.equal((await dispatcher.railReadings("claude", true)).latest.ok, false);
      assert.equal(waits, 0);
      assert.equal(fx.probe.refreshes, 1, "stale halt alone must not prevent the ping");
      assert.equal((await makeStore().gates(fx.cfg.claudeCredsPath)).sticky, undefined);
    }
    assert.deepEqual(fx.probe.fetches, [], "expired credentials must not reach the vendor");
  });
}
