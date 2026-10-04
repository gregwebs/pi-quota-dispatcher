import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createDispatcher, DEFAULT_CONFIG, READINGS_FILE_VERSION } from "../src/index.ts";

const NOW = 1_730_123_456_789;
const PRIMARY = "claude-bridge/claude-opus-5-5";
const ALTERNATE = "openai-codex/gpt-6-sol";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pqd-shared-dispatcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agents"); await mkdir(agentDir);
  const agentFile = join(agentDir, "planner.md");
  await writeFile(agentFile, `---\nname: planner\nmodel: "${PRIMARY}"\n---\n\nBody.\n`);
  const claudeCredsPath = join(root, "claude.json");
  const piAuthPath = join(root, "auth.json");
  await writeFile(claudeCredsPath, JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: NOW + 86_400_000 } }));
  await writeFile(piAuthPath, JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct-test" } }));
  const cfg = {
    ...DEFAULT_CONFIG, agentDir, claudeCredsPath, piAuthPath, claudeRefresh: "off" as const,
    readingsPath: join(root, "quota-dispatch-readings.json"), ttlMs: 10_000,
    agents: { planner: { primary: { model: PRIMARY, rail: "claude" as const }, alternates: [{ model: ALTERNATE, rail: "codex" as const }] } },
  };
  const probe = { clock: NOW, failed: false };
  const make = (beforeRespond?: () => Promise<void>, sleep?: (ms: number) => Promise<void>) => {
    const calls = { claude: 0, codex: 0 };
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      const rail = u.includes("anthropic.com") ? "claude" : u.includes("chatgpt.com") ? "codex" : undefined;
      assert.ok(rail, `unexpected request ${u}`); calls[rail]++;
      if (beforeRespond) await beforeRespond();
      const failed = probe.failed && rail === "claude";
      return { ok: !failed, status: failed ? 429 : 200, json: async () => rail === "claude"
        ? { five_hour: { utilization: 93 }, seven_day: { utilization: 21 } }
        : { rate_limit: { primary_window: { used_percent: 3 }, secondary_window: { used_percent: 4 } } } };
    }) as unknown as typeof fetch;
    return { calls, dispatcher: createDispatcher(cfg, {
      fetchImpl, now: () => probe.clock, readKeychain: async () => ({ error: "no keychain" }),
      ...(sleep ? { sleep } : {}), readings: { fetchWaitMs: 1_000, writeWaitMs: 100, pollMs: 2, staleMs: 10_000 },
    }) };
  };
  return { cfg, probe, make, agentFile };
}

for (const rail of ["claude", "codex"] as const) {
  test(`two dispatchers share one ${rail} vendor request across concurrent and fresh reads`, async (t) => {
    const fx = await fixture(t);
    const started = gate(); const finish = gate(); const waiting = gate();
    const a = fx.make(async () => { started.release(); await finish.promise; });
    const b = fx.make(undefined, async (ms) => { waiting.release(); await new Promise((resolve) => setTimeout(resolve, ms)); });
    const first = a.dispatcher.railReadings(rail);
    await started.promise;
    const second = b.dispatcher.railReadings(rail);
    await waiting.promise; finish.release();
    assert.deepEqual(await second, await first);
    assert.equal(a.calls[rail] + b.calls[rail], 1);
    const c = fx.make();
    assert.deepEqual(await c.dispatcher.railReadings(rail), await first);
    assert.equal(c.calls[rail], 0);
  });
}

for (const [name, contents] of [
  ["corrupt", "not JSON"],
  ["unknown-version", JSON.stringify({ version: READINGS_FILE_VERSION + 1, entries: [] })],
] as const) {
  test(`${name} shared file does not block report, surfaces a warning line, and is repaired`, async (t) => {
    const fx = await fixture(t); await writeFile(fx.cfg.readingsPath, contents);
    const { dispatcher, calls } = fx.make();
    const lines = await dispatcher.report();
    const warnings = lines.filter((line) => /quota-dispatch-readings\.json.*unusable.*ignoring/i.test(line));
    assert.equal(warnings.length, 1, "report must surface the shared-file warning as its own line");
    assert.match(warnings[0]!, /^quota-dispatch-readings\.json/);
    assert.ok(lines.some((line) => line.startsWith("claude: 5h 93%")));
    assert.deepEqual(calls, { claude: 1, codex: 1 });
    const repaired = JSON.parse(await readFile(fx.cfg.readingsPath, "utf8"));
    assert.equal(repaired.version, READINGS_FILE_VERSION);
    const second = fx.make(); await second.dispatcher.report();
    assert.deepEqual(second.calls, { claude: 0, codex: 0 });
    assert.equal((await dispatcher.report()).filter((line) => line === warnings[0]).length, 1);
  });
}

test("shared failed latest holds decisions; its last good reading never routes or reports as live", async (t) => {
  const fx = await fixture(t); const a = fx.make();
  const [initial] = await a.dispatcher.evaluate({ force: true, dry: true });
  assert.equal(initial!.decision.kind, "assign");
  const earlier = (await a.dispatcher.railReadings("claude")).latest;
  fx.probe.clock++; fx.probe.failed = true;
  await a.dispatcher.railReadings("claude", true);
  const b = fx.make(); const before = await readFile(fx.agentFile, "utf8");
  const [held] = await b.dispatcher.evaluate();
  assert.equal(held!.decision.kind, "hold");
  assert.equal(held!.outcome, "held");
  assert.deepEqual(b.calls, { claude: 0, codex: 0 });
  const reading = await b.dispatcher.railReadings("claude");
  assert.equal(reading.latest.ok, false);
  assert.deepEqual(reading.lastGood, earlier);
  const lines = await b.dispatcher.report();
  assert.ok(lines.some((line) => line.startsWith("claude: unavailable")));
  assert.ok(!lines.some((line) => line.startsWith("claude: 5h")));
  assert.equal(await readFile(fx.agentFile, "utf8"), before);
});
