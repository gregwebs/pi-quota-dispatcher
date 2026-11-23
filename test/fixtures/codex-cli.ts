/**
 * A stand-in Codex CLI, driven by a control directory.
 *
 * The command under test spawns whatever `codex` is on `PATH` and never looks at
 * what it prints, so this file's whole job is to behave like the CLI at the one
 * place that matters — the credential file — and to be able to misbehave in ways
 * a real one does: hang, ignore a signal, exit zero without reaching the
 * listener, write a token that is already expired.
 *
 * It is driven by `<control>/mode.json` rather than by argv, because the argv is
 * one of the things the tests assert against. `QD_CODEX_FIXTURE` is set by the
 * wrapper script, not inherited from the run's environment, so the environment
 * the run builds stays exactly what a real run would have.
 *
 * Every output path carries a sentinel: stdout, stderr, and the token payload.
 * A line that leaks vendor text is then caught by name instead of by a reader
 * happening to notice, and a leaked token is caught by its `eyJ` prefix.
 */
import { writeFileSync } from "node:fs";
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SENTINEL = "SENTINEL-codex-cli-output";

/** The knobs one run is given. */
interface Control {
  readonly mode: string;
  /** `hang`: write a fresh token before hanging. */
  readonly writeFirst?: boolean;
  readonly accountId?: string;
  /** As a token's `exp` claim states it: seconds, not milliseconds. */
  readonly expiresAt?: number;
}

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** A JWT-shaped token that states `exp`, and states the sentinel too. */
const token = (exp: number | undefined): string =>
  `${segment({ alg: "none", typ: "JWT", SENTINEL })}.${segment(
    exp === undefined ? { SENTINEL } : { exp, SENTINEL, iat: Date.now() },
  )}.${segment(SENTINEL)}`;

function sleepForever(): Promise<never> {
  setInterval(() => {}, 1_000);
  return new Promise<never>(() => {});
}

async function main(): Promise<number> {
  const control = process.env.QD_CODEX_FIXTURE;
  if (control === undefined) {
    process.stderr.write("QD_CODEX_FIXTURE is not set\n");
    return 97;
  }
  const argv = process.argv.slice(2);
  const mode = JSON.parse(await readFile(join(control, "mode.json"), "utf8")) as Control;
  const home = process.env.CODEX_HOME ?? "";
  const authPath = join(home, "auth.json");

  await appendFile(
    join(control, "invocations.jsonl"),
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      env: {
        CODEX_HOME: process.env.CODEX_HOME,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        NO_PROXY: process.env.NO_PROXY,
        no_proxy: process.env.no_proxy,
      },
      envKeys: Object.keys(process.env).sort(),
      stdinIsTTY: process.stdin.isTTY === true,
      cwdEntries: await readdir(process.cwd()),
    })}\n`,
    "utf8",
  );

  if (mode.mode === "silent") return 1;
  process.stdout.write(`${SENTINEL} on stdout\n`);
  process.stderr.write(`${SENTINEL} on stderr\n`);

  /** The base URL the run was told to use, as `-c chatgpt_base_url="..."` spells it. */
  const divert = async (): Promise<void> => {
    const setting = argv.find((arg) => arg.startsWith("chatgpt_base_url="));
    if (setting === undefined) return;
    const url = setting.slice("chatgpt_base_url=".length).replace(/^"|"$/g, "");
    // The listener answers 400 at once; the answer is not the point, the arrival is.
    await fetch(url).catch(() => undefined);
  };

  /** Writes a new login, keeping the account unless one is stated. */
  const rewrite = async (exp: number | undefined, accountId?: string): Promise<void> => {
    let existing: { tokens?: { account_id?: unknown } } = {};
    try {
      existing = JSON.parse(await readFile(authPath, "utf8")) as typeof existing;
    } catch {
      existing = {};
    }
    const account =
      accountId ?? (typeof existing.tokens?.account_id === "string" ? existing.tokens.account_id : "acct-fixture");
    await writeFile(
      authPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: token(exp),
          account_id: account,
          refresh_token: `refresh-${Date.now()}`,
        },
        last_refresh: new Date().toISOString(),
      }),
      "utf8",
    );
  };

  const future = Math.floor(Date.now() / 1_000) + 3_600;
  const past = Math.floor(Date.now() / 1_000) - 3_600;

  switch (mode.mode) {
    case "refresh":
      await divert();
      await rewrite(mode.expiresAt ?? future, mode.accountId);
      return 0;
    case "no-refresh":
      await divert();
      return 1;
    case "exit-zero":
      // The answer came from somewhere else: nothing reaches the listener.
      return 0;
    case "switch-account":
      await divert();
      await rewrite(future, mode.accountId ?? "acct-other");
      return 0;
    case "remove":
      await divert();
      await rm(authPath);
      return 0;
    case "write-expired":
      await divert();
      await rewrite(past);
      return 0;
    case "write-no-exp":
      await divert();
      await rewrite(undefined);
      return 0;
    case "write-api-key":
      await divert();
      await writeFile(
        authPath,
        JSON.stringify({
          OPENAI_API_KEY: `sk-${SENTINEL}`,
          tokens: { access_token: token(future), account_id: "acct-fixture", refresh_token: "r" },
        }),
        "utf8",
      );
      return 0;
    case "hang":
      if (mode.writeFirst === true) await rewrite(future);
      await writeFile(join(control, "ready"), "1", "utf8");
      return sleepForever();
    case "hang-ignore-term":
      // Installed before the ready marker, so a SIGTERM sent after it cannot be
      // missed by a child that is still starting up. The handler records that it
      // ran, which is what makes "TERM first, then KILL" a fact a test can see
      // rather than an assumption about the runner.
      process.on("SIGTERM", () => {
        // Synchronously, so the marker cannot be lost to the KILL that follows.
        writeFileSync(join(control, "term-seen"), "1", "utf8");
      });
      await writeFile(join(control, "ready"), "1", "utf8");
      return sleepForever();
    default:
      process.stderr.write(`${SENTINEL} unknown mode ${mode.mode}\n`);
      return 96;
  }
}

process.exitCode = await main();
