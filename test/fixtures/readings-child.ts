import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSharedReadings, type SharedReadingsPacing } from "../../src/index.ts";
import { waitUntil, type ChildResult } from "./agent-write-child.ts";

interface Job {
  readingsPath: string;
  credential: string;
  kind?: "read" | "hold-then-die";
  marker?: string;
  release?: string;
  waitingMarker?: string;
  delayMs?: number;
  pacing?: Partial<SharedReadingsPacing>;
}

export function spawnReadingsChild(job: Job): { done: Promise<ChildResult>; kill: () => void } {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(job)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`readings child hung: ${stderr}`)); }, 20_000);
    timer.unref();
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { done, kill: () => { child.kill("SIGKILL"); } };
}

async function run(job: Job) {
  let fetched = false;
  const store = createSharedReadings({
    path: job.readingsPath, now: Date.now,
    sleep: async (ms) => {
      if (job.waitingMarker) await writeFile(job.waitingMarker, "waiting");
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    pacing: { fetchWaitMs: 5_000, writeWaitMs: 1_000, pollMs: 2, staleMs: 10_000, ...job.pacing },
  });
  const result = await store.read("claude", job.credential, { ttlMs: 60_000, fetch: async () => {
    fetched = true;
    if (job.marker) await writeFile(job.marker, "fetching");
    if (job.kind === "hold-then-die") process.kill(process.pid, "SIGKILL");
    if (job.release) await waitUntil("release cue", () => existsSync(job.release!));
    if (job.delayMs) await new Promise((resolve) => setTimeout(resolve, job.delayMs));
    return { rail: "claude", ok: true, windows: [{ label: "5h", used: 17, budget: "session" }], readAt: Date.now(), raw: { child: true } };
  } });
  process.stdout.write(`${JSON.stringify({ fetched, result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(JSON.parse(process.argv[2] ?? "{}") as Job);
}
