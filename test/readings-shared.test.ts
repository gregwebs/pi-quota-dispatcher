import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createDispatcher,
} from "../src/index.ts";
import {
  DEFAULT_CONFIG,
} from "../src/config.ts";
import {
  READINGS_FILE_VERSION,
} from "../src/readings-file.ts";
import { failureOf, fakeReads, readingOf } from "./helpers/rails.ts";

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
    ...DEFAULT_CONFIG, agentDir, claudeCredsPath, piAuthPath, codexCredsPath: piAuthPath, claudeRefresh: "off" as const,
    readingsPath: join(root, "quota-dispatch-readings.json"), ttlMs: 10_000,
    agents: { planner: { primary: { model: PRIMARY, rail: "claude" as const }, alternates: [{ model: ALTERNATE, rail: "codex" as const }] } },
  };
  const probe = { clock: NOW, failed: false };
  const make = (
    beforeRespond?: () => Promise<void>,
    sleep?: (ms: number) => Promise<void>,
    overrides: Partial<typeof cfg> = {},
  ) => {
    const calls = { claude: 0, codex: 0 };
    // The reads are the seam, so a test counts reads here rather than requests:
    // what it pins is how many times a dispatcher went to a rail, which is what
    // the shared entry is supposed to answer for it.
    const read = fakeReads({
      claude: async () => {
        calls.claude++;
        if (beforeRespond) await beforeRespond();
        return probe.failed
          ? failureOf("claude", "HTTP 429")
          : readingOf("claude", { session: 93, weekly: 21 });
      },
      codex: async () => {
        calls.codex++;
        if (beforeRespond) await beforeRespond();
        return readingOf("codex", { session: 3, weekly: 4 });
      },
    });
    return { calls, dispatcher: createDispatcher({ ...cfg, ...overrides }, {
      read, now: () => probe.clock, readKeychain: async () => ({ error: "no keychain" }),
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

// ADR 0016 keys a shared entry by the credential, so a settable Codex path is
// only safe if a second source is a second entry. Sharing one would report one
// account's headroom while the other's work draws on it — the one thing the
// shared cache must not do (issue #89).
test("two codex credential paths are two shared entries, not one", async (t) => {
  const fx = await fixture(t);
  const other = join(dirname(fx.cfg.codexCredsPath), "codex-other.json");
  await writeFile(other, JSON.stringify({
    tokens: { access_token: "other-token", account_id: "other-acct" },
  }));

  const first = fx.make();
  await first.dispatcher.railReadings("codex", true);
  const second = fx.make(undefined, undefined, { codexCredsPath: other });
  // Unforced: if the two paths shared one key, the entry the first dispatcher
  // just published would answer and this fetch would not happen at all.
  const reading = await second.dispatcher.railReadings("codex");

  assert.equal(reading.latest.ok, true);
  assert.equal(first.calls.codex, 1);
  assert.equal(second.calls.codex, 1, "the second credential must be fetched, not served from the first's entry");
  const stored = JSON.parse(await readFile(fx.cfg.readingsPath, "utf8"));
  const codex = stored.entries
    .filter((entry: { rail: string }) => entry.rail === "codex")
    .map((entry: { credential: string }) => entry.credential);
  assert.deepEqual(codex.sort(), [resolve(fx.cfg.codexCredsPath), resolve(other)].sort());
});

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
