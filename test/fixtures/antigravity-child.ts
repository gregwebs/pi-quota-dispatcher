import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Nothing from `src` may be imported statically here: this file's whole point is
 * that `src/index.ts` is first evaluated *after* `PI_CODING_AGENT_DIR` is set.
 * `agent-write-child.ts` imports it at module scope, so even its `waitUntil` is
 * re-stated rather than shared.
 */
type ChildResult = Parameters<typeof import("./agent-write-child.ts").assertCleanExit>[0];

async function waitUntil(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * The parts of an Antigravity credential read that only exist on the **default**
 * auth path.
 *
 * The dispatcher delegates a refresh to pi only when `cfg.piAuthPath` is
 * `DEFAULT_CONFIG.piAuthPath`, and that constant is snapshotted from
 * `PI_CODING_AGENT_DIR` when the module is imported. A test therefore cannot
 * reach the branch by pointing the config somewhere else — it has to be a
 * process whose environment named the relocated agent dir *before* the import,
 * which is what this child is for. It never touches the developer's own
 * `~/.pi/agent/auth.json`.
 */
interface Job {
  /** The relocated agent dir `PI_CODING_AGENT_DIR` names; `auth.json` lives here. */
  agentDir: string;
  /** Bytes to write as `auth.json`; absent leaves the file missing. */
  auth?: string;
  resolver?: {
    /** `persist` rewrites the file then resolves; `pending` waits for a cue first. */
    kind: "persist" | "pending" | "throw";
    /** The bytes the refresh leaves on disk (the "provider persisted a token"). */
    refreshed?: string;
    /** What the resolver resolves with — opaque provider output, not a bearer token. */
    returns?: string;
    /** The message a throwing resolver fails with, so a test can plant a marker. */
    message?: string;
    /** Written when the resolver is entered, so the parent knows it is pending. */
    startedMarker?: string;
    /** The cue a `pending` resolver waits for before persisting and resolving. */
    release?: string;
    /** Written after `refreshed` is on disk, so the parent knows the write landed. */
    persistedMarker?: string;
  };
  /** How long a delegated refresh is waited for, in milliseconds. */
  timeoutMs?: number;
  /** How many forced reads to make before any `proceed` cue. */
  reads: number;
  /**
   * Written after those reads finish, so the parent can tell that the batch ran
   * while the refresh was still pending — and only then let the refresh finish.
   */
  batchDone?: string;
  /** A cue to wait for between those reads and a second batch. */
  proceed?: string;
  /** How many further forced reads to make after `proceed`. */
  secondReads?: number;
  /** What the vendor answers; `status: 401` is the definitive refusal. */
  quota?: { status: number; body?: unknown };
}

export function spawnAntigravityChild(job: Job): { done: Promise<ChildResult>; kill: () => void } {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(job)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`antigravity child hung: ${stderr}`));
    }, 20_000);
    timer.unref();
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { done, kill: () => { child.kill("SIGKILL"); } };
}

interface Request {
  method: string;
  authorization: string | undefined;
  body: string | undefined;
}

async function run(job: Job) {
  // Before the import, deliberately: `DEFAULT_CONFIG.piAuthPath` is snapshotted
  // when `src/index.ts` evaluates, so a later assignment could not reach the
  // default-path branch this fixture exists to exercise.
  process.env.PI_CODING_AGENT_DIR = job.agentDir;
  await mkdir(job.agentDir, { recursive: true });
  const authPath = join(job.agentDir, "auth.json");
  if (job.auth !== undefined) await writeFile(authPath, job.auth, "utf8");

  const index = await import("../../src/index.ts");
  const { agentTable } = await import("../helpers/identifiers.ts");
  if (index.DEFAULT_CONFIG.piAuthPath !== authPath) {
    throw new Error(`the fixture is not on the default path: ${index.DEFAULT_CONFIG.piAuthPath} !== ${authPath}`);
  }

  const requests: Request[] = [];
  let resolverCalls = 0;
  const resolver = job.resolver;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== index.ANTIGRAVITY_QUOTA_URL) {
      throw new Error(`the fixture only answers the Antigravity endpoint, not ${String(url)}`);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      method: init?.method ?? "GET",
      authorization: headers.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const status = job.quota?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => job.quota?.body ?? { groups: [] },
    };
  }) as unknown as typeof fetch;

  const dispatcher = index.createDispatcher(
    {
      ...index.defaultConfig(job.agentDir),
      claudeRefresh: "off",
      ttlMs: 1,
      readingsPath: join(job.agentDir, "quota-dispatch-readings.json"),
      agents: agentTable({}),
    },
    {
      fetchImpl,
      ...(job.timeoutMs === undefined ? {} : { providerTokenTimeoutMs: job.timeoutMs }),
      ...(resolver === undefined
        ? {}
        : {
            resolveProviderToken: async () => {
              resolverCalls++;
              if (resolver.startedMarker !== undefined) await writeFile(resolver.startedMarker, "started");
              if (resolver.kind === "throw") throw new Error(resolver.message ?? "provider refused");
              if (resolver.kind === "pending") {
                await waitUntil("refresh release", () => existsSync(resolver.release!));
              }
              if (resolver.refreshed !== undefined) await writeFile(authPath, resolver.refreshed, "utf8");
              if (resolver.persistedMarker !== undefined) await writeFile(resolver.persistedMarker, "persisted");
              return resolver.returns;
            },
          }),
    },
  );

  const read = async () => {
    const readings = await dispatcher.railReadings("antigravity-gemini", true);
    return { latest: readings.latest, ...(readings.lastGood === undefined ? {} : { lastGood: readings.lastGood }) };
  };

  const reads: unknown[] = [];
  for (let i = 0; i < job.reads; i++) reads.push(await read());
  if (job.batchDone !== undefined) await writeFile(job.batchDone, "done");
  if (job.proceed !== undefined) await waitUntil("proceed cue", () => existsSync(job.proceed!));
  for (let i = 0; i < (job.secondReads ?? 0); i++) reads.push(await read());

  process.stdout.write(`${JSON.stringify({ requests, resolverCalls, reads })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(JSON.parse(process.argv[2] ?? "{}") as Job);
}
