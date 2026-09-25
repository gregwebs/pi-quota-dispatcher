/**
 * Configuration loading for pi-quota-dispatcher.
 *
 * Three layers, later wins:
 *
 *   built-in  the shipped defaults in `defaultConfig()`
 *   global    `<agentDir>/quota-dispatch.json`   (`~/.pi/agent/quota-dispatch.json`)
 *   project   `<cwd>/<CONFIG_DIR_NAME>/quota-dispatch.json`   (`.pi/quota-dispatch.json`)
 *
 * The point of the file layers is that the installed package is read-only in
 * practice: `pi install` overwrites `node_modules/pi-quota-dispatcher`, so a
 * route edited in the source is reverted by the next update, silently.
 *
 * Loading never throws. A missing file is ordinary, an unparseable one is
 * reported and skipped, and an invalid value is reported and the previous
 * layer's value stands. The dispatcher must always start.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- shape

export type Rail = "claude" | "codex" | "deepseek";

export interface Candidate {
  model: string;
  rail: Rail;
}

export interface Route {
  primary: Candidate;
  alternate?: Candidate;
}

export interface DispatcherConfig {
  agentDir: string;
  claudeCredsPath: string;
  piAuthPath: string;
  /** Quota readings are cached this long. 5h/7d windows move slowly. */
  ttlMs: number;
  /** Re-evaluate on this cadence while a session is open. */
  pollMs: number;
  /**
   * Consider the alternate once the primary's *session* budget reaches this.
   * This is the acute cap: the one that blocks you mid-task, and the only one
   * that recovers within hours, so a switch made on it is reversible.
   */
  sessionSwitchAt: number;
  /**
   * ...or once its *weekly* budget reaches this.
   *
   * Deliberately higher than `sessionSwitchAt`. The weekly window does not
   * recover for days, so a switch made on it is close to one-way and should be
   * a last resort rather than the routine signal.
   */
  weeklySwitchAt: number;
  /** ...and only when the alternate is at least this many points healthier. */
  margin: number;
  /** Agents absent from this table are never touched. */
  routes: Record<string, Route>;
}

/** Name of the file, in both the global and the project directory. */
export const CONFIG_FILE_NAME = "quota-dispatch.json";

/** The scalar keys, in the fixed order they are reported by `describeConfig`. */
const SCALAR_KEYS = [
  "agentDir",
  "claudeCredsPath",
  "piAuthPath",
  "ttlMs",
  "pollMs",
  "sessionSwitchAt",
  "weeklySwitchAt",
  "margin",
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

/**
 * The numeric scalars and the closed range each must fall in.
 *
 * `Number.isFinite` alone let `{"pollMs": 2147483648}` through, and Node runs
 * an interval past its supported range as 1 ms — a runaway polling cadence,
 * not an error. Timers therefore need whole milliseconds inside Node's range;
 * the rest are used-percentages.
 */
interface NumberRange {
  min: number;
  max: number;
  /** Timers need whole milliseconds; Node runs a fractional interval as 1 ms. */
  integer?: boolean;
}

const NUMBER_RANGES: ReadonlyMap<ScalarKey, NumberRange> = new Map([
  ["ttlMs", { min: 1, max: 2_147_483_647, integer: true }],
  ["pollMs", { min: 1, max: 2_147_483_647, integer: true }],
  ["sessionSwitchAt", { min: 0, max: 100 }],
  ["weeklySwitchAt", { min: 0, max: 100 }],
  ["margin", { min: 0, max: 100 }],
]);

/**
 * Path scalars that are pi's to own, and therefore not settable from a config
 * file. `agentDir` and `piAuthPath` both derive from `getAgentDir()`, which
 * already honours `PI_CODING_AGENT_DIR` and a rebranded distribution's config
 * directory; a JSON file pointing them elsewhere would only make the dispatcher
 * edit files nothing reads. The warning names that mechanism rather than
 * rejecting the key flatly — the reader wants the supported way, not a refusal.
 */
const OWNED_PATH_SCALARS: ReadonlyMap<string, string> = new Map([
  ["agentDir", "relocate the agent dir with PI_CODING_AGENT_DIR"],
  ["piAuthPath", "relocate the agent dir with PI_CODING_AGENT_DIR"],
]);

/**
 * Agent names are filenames: `<agentDir>/<agent>.md`. A key like `../outside`
 * would write outside the agents directory, so a route is only accepted when
 * its key matches the convention the shipped agents use.
 */
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Why `name` cannot be a route key, or `undefined` when it can.
 *
 * A name has to be a safe filename — `../outside` would write outside the
 * agents directory — and it must not be one of `Object.prototype`'s own names.
 * `constructor` is a valid filename, but a route table keyed by it reads back a
 * phantom value under any unguarded lookup, so it is refused at the seam rather
 * than each read having to remember `Object.hasOwn`.
 *
 * The rejection is a whole sentence so the layer loop and the base clone can
 * report the same thing; the caller supplies the prefix (`built-in:` for the
 * base).
 */
function agentNameRejection(name: string): string | undefined {
  if (!AGENT_NAME.test(name)) {
    return `route "${name}" is not a valid agent name (lowercase letters, digits and dashes, starting with a letter)`;
  }
  if (name in Object.prototype) {
    return `route "${name}" shadows Object.prototype and is not manageable`;
  }
  return undefined;
}

/** JSON objects only; arrays, `null` and primitives are not layers or routes. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRail(value: unknown): value is Rail {
  return value === "claude" || value === "codex" || value === "deepseek";
}

/**
 * The rail a model's prefix implies, or `undefined` for a prefix we do not
 * recognise. An unknown prefix is not evidence of a mistake, so it never warns.
 */
function railFromModel(model: string): Rail | undefined {
  if (model.startsWith("claude-bridge/") || model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("openai-codex/")) return "codex";
  if (model.startsWith("deepseek/")) return "deepseek";
  return undefined;
}

/**
 * The shipped defaults, for a given agent directory.
 *
 * Everything that used to hardcode `~/.pi/agent` now derives from
 * `getAgentDir()`, which honours `PI_CODING_AGENT_DIR` and a rebranded
 * distribution's `CONFIG_DIR_NAME`. Hardcoding those paths made the extension
 * edit files nothing reads and report the Codex rail permanently unreadable
 * whenever the agent dir was relocated.
 *
 * The values, which the README documents as the defaults:
 *
 *   agentDir         `<agentDir>/agents`
 *   piAuthPath       `<agentDir>/auth.json`
 *   claudeCredsPath  `~/.claude/.credentials.json`
 *   ttlMs            180_000
 *   pollMs           300_000
 *   sessionSwitchAt  75
 *   weeklySwitchAt   90
 *   margin           10
 *   routes           planner     claude-bridge/claude-opus-5-5  -> openai-codex/gpt-6-sol
 *                    reviewer    openai-codex/gpt-6-astra       -> claude-bridge/claude-opus-5-5
 *                    implementer deepseek/deepseek-flash        -> openai-codex/gpt-6-luna
 *
 * (Each route's first model is its primary on the rail its prefix implies; the
 * implementer rests on DeepSeek because it is metered, and uses codex as the
 * pressure valve rather than the default.)
 */
export function defaultConfig(agentDir: string = getAgentDir()): DispatcherConfig {
  return {
    agentDir: join(agentDir, "agents"),
    claudeCredsPath: join(homedir(), ".claude", ".credentials.json"),
    piAuthPath: join(agentDir, "auth.json"),
    ttlMs: 180_000,
    pollMs: 300_000,
    sessionSwitchAt: 75,
    weeklySwitchAt: 90,
    margin: 10,
    routes: {
      planner: {
        primary: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
        alternate: { model: "openai-codex/gpt-6-sol", rail: "codex" },
      },
      reviewer: {
        primary: { model: "openai-codex/gpt-6-astra", rail: "codex" },
        alternate: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
      },
      implementer: {
        primary: { model: "deepseek/deepseek-flash", rail: "deepseek" },
        alternate: { model: "openai-codex/gpt-6-luna", rail: "codex" },
      },
    },
  };
}

/** `defaultConfig()` snapshotted at import, for callers that want no surprise. */
export const DEFAULT_CONFIG: DispatcherConfig = defaultConfig();

/** `<agentDir>/quota-dispatch.json`. */
export function globalConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

/** `<cwd>/<CONFIG_DIR_NAME>/quota-dispatch.json`. */
export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

// ---------------------------------------------------------------- loading

/** Which layer a resolved value came from. */
export type ConfigSource = "built-in" | "global" | "project";

export interface ConfigFile {
  source: "global" | "project";
  path: string;
  /**
   * Whether the file was there. A file that exists but does not parse is still
   * `present` — it is the reason the run warned, and reporting it as "absent"
   * would send someone looking for a file that is right where they left it.
   */
  present: boolean;
}

export interface LoadedConfig {
  config: DispatcherConfig;
  /** The layers consulted, in precedence order. Always both entries. */
  files: ConfigFile[];
  /**
   * Dotted key -> the layer that supplied the effective value. Covers the
   * scalar keys and each route candidate field, e.g.
   * `sessionSwitchAt` and `routes.planner.primary.model`. A key no layer set
   * is `"built-in"`.
   *
   * It describes the config that actually resulted, so a route or candidate a
   * layer proposes but validation rejects leaves no entry: `sources` never
   * names a layer that supplied a value `config` does not hold.
   */
  sources: Record<string, ConfigSource>;
  /** Everything reported while loading, each prefixed with its file path. */
  warnings: string[];
}

export interface LoadConfigDeps {
  /** Defaults to `getAgentDir()`. */
  agentDir?: string;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Reads a file's text. Rejects with `code: "ENOENT"` when it is missing. */
  readFile?: (path: string) => Promise<string>;
  /** Where warnings go. Defaults to `console.error`. */
  warn?: (message: string) => void;
}

/**
 * Resolve the effective config from the three layers.
 *
 * Absent files are skipped silently. An unparseable file warns and is skipped
 * whole — a half-applied config is harder to reason about than the defaults.
 * An invalid value warns and the previous layer's value stands, so a typo in a
 * project file cannot undo a correct global one.
 *
 * Warnings are returned *and* passed to `warn` (default `console.error`), so
 * the extension logs on load and tests can collect instead of printing.
 */
export async function loadConfig(deps: LoadConfigDeps = {}): Promise<LoadedConfig> {
  const agentDir = deps.agentDir ?? getAgentDir();
  const cwd = deps.cwd ?? process.cwd();
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const warn = deps.warn ?? console.error;

  const globalPath = globalConfigPath(agentDir);
  const projectPath = projectConfigPath(cwd);
  const entries: Array<{ source: "global" | "project"; path: string }> = [
    { source: "global", path: globalPath },
    { source: "project", path: projectPath },
  ];

  const warnings: string[] = [];
  const files: ConfigFile[] = [];
  const layers: MergeLayer[] = [];

  for (const entry of entries) {
    let text: string;
    try {
      text = await read(entry.path);
    } catch (err) {
      // An absent file is ordinary; anything else is worth reporting but must
      // not stop the other layer from applying.
      if ((err as { code?: unknown }).code === "ENOENT") {
        files.push({ source: entry.source, path: entry.path, present: false });
        continue;
      }
      warnings.push(`${entry.path}: ${(err as Error).message}`);
      files.push({ source: entry.source, path: entry.path, present: true });
      continue;
    }

    // The file was there, whether or not its contents are usable. Reporting it
    // as absent would send someone looking for a file that is right there.
    files.push({ source: entry.source, path: entry.path, present: true });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      warnings.push(`${entry.path}: ${(err as Error).message}`);
      continue;
    }
    if (!isPlainObject(parsed)) {
      warnings.push(`${entry.path}: config must be a JSON object`);
      continue;
    }
    // Each layer labels its warnings with the file path, so `mergeConfig`
    // outputs them in the shape a reader needs to act on directly.
    layers.push({ source: entry.source, label: entry.path, data: parsed });
  }

  const merged = mergeConfig(defaultConfig(agentDir), layers);
  warnings.push(...merged.warnings);

  for (const warning of warnings) {
    try {
      warn(warning);
    } catch {
      // Warning sinks are callers' code; a throwing one must not sink a load.
    }
  }

  return { config: merged.config, files, sources: merged.sources, warnings };
}

export interface MergeLayer {
  source: ConfigSource;
  /**
   * Prefix for every warning this layer produces, verbatim. Defaults to
   * `source`; `loadConfig` passes the file path, which is what a reader needs
   * in order to go and fix it. An explicit label is why the path no longer has
   * to be recovered by splitting the warning text back apart.
   */
  label?: string;
  /** Parsed JSON, of unknown shape until validated. */
  data: unknown;
}

export interface MergeResult {
  config: DispatcherConfig;
  sources: Record<string, ConfigSource>;
  warnings: string[];
}

/**
 * Fold parsed layers over `base`, validating as it goes.
 *
 * Deep per route: a layer that names one agent only touches that agent, and a
 * candidate that names only `model` keeps the base `rail`. `null` is the
 * explicit eraser — `{"routes": {"implementer": null}}` drops a route, and
 * `{"alternate": null}` drops a candidate — so a project can say "I only use
 * two of these agents" without restating the table.
 *
 * Warnings. A layer warning is prefixed with the layer's `label`, which
 * defaults to its `source`, e.g. `global: ...`; `loadConfig` passes the file
 * path as the label, which is what a reader needs in order to go and fix it. A
 * route rejected while cloning `base` is prefixed `built-in:`, because that is
 * the layer the base stands for. The kinds are:
 *
 *   - an unrecognised key, at the top level or inside a route or candidate
 *   - a value of the wrong type
 *   - a scalar outside its permitted range: the timers are whole milliseconds
 *     in Node's timer range, the rest are 0–100 percentages
 *   - an agent name that is not a safe filename, on a layer key or on a base
 *     route (see `AGENT_NAME` and `agentNameRejection`)
 *   - a `model` that is not a string containing `/`
 *   - a `rail` that is not one of the three known rails
 *   - a `model` whose prefix reads like a different rail's model than the one
 *     declared, which is what a partial override leaves behind
 *   - a route left without a `primary`, which leaves the previous route for
 *     that agent intact rather than erasing it
 *
 * `sources` describes the config that survives: a route or candidate a layer
 * proposes but validation rejects contributes nothing, so provenance can never
 * point at a value the merge did not accept. A committed route commits its
 * values and its sources together.
 */
export function mergeConfig(base: DispatcherConfig, layers: MergeLayer[]): MergeResult {
  const warnings: string[] = [];
  const routes: Record<string, Route> = {};
  for (const [agent, route] of Object.entries(base.routes)) {
    // Normally the base is `defaultConfig()`, whose keys are the shipped agent
    // names and always valid, so this only fires for a config a caller built
    // programmatically. A bad key is the same defect class as a bad layer key —
    // it names a file — so it gets the same warning and is dropped rather than
    // cloned into the effective config.
    const rejection = agentNameRejection(agent);
    if (rejection) {
      warnings.push(`built-in: ${rejection}`);
      continue;
    }
    routes[agent] = {
      primary: { ...route.primary },
      ...(route.alternate ? { alternate: { ...route.alternate } } : {}),
    };
  }
  const config: DispatcherConfig = { ...base, routes };
  const scalarTarget = config as unknown as Record<ScalarKey, string | number>;

  const sources: Record<string, ConfigSource> = {};
  const setSource = (key: string, source: ConfigSource) => {
    sources[key] = source;
  };
  const clearSource = (key: string) => {
    delete sources[key];
  };

  for (const key of SCALAR_KEYS) setSource(key, "built-in");
  for (const [agent, route] of Object.entries(config.routes)) {
    setSource(`routes.${agent}.primary.model`, "built-in");
    setSource(`routes.${agent}.primary.rail`, "built-in");
    if (route.alternate) {
      setSource(`routes.${agent}.alternate.model`, "built-in");
      setSource(`routes.${agent}.alternate.rail`, "built-in");
    }
  }

  const dropRoute = (agent: string): void => {
    // Own property only: a key like `constructor` would otherwise reach an
    // inherited value that is not a route at all.
    if (!Object.hasOwn(config.routes, agent)) return;
    delete config.routes[agent];
    clearSource(`routes.${agent}.primary.model`);
    clearSource(`routes.${agent}.primary.rail`);
    clearSource(`routes.${agent}.alternate.model`);
    clearSource(`routes.${agent}.alternate.rail`);
  };

  const applyRoute = (
    agent: string,
    data: Record<string, unknown>,
    source: ConfigSource,
    warn: (message: string) => void,
  ): void => {
    // Own property only, so `{"routes":{"constructor":{}}}` does not resolve
    // to `Object.prototype.constructor` and commit a phantom route.
    const existing = Object.hasOwn(config.routes, agent) ? config.routes[agent] : undefined;
    const holders: { primary?: Candidate; alternate?: Candidate } = {
      ...(existing ? { primary: { ...existing.primary } } : {}),
      ...(existing?.alternate ? { alternate: { ...existing.alternate } } : {}),
    };

    // Provenance is staged here, not written as candidates are validated: a
    // route or candidate that is later rejected must leave `sources` byte-for-
    // byte as it was, so it can only describe the effective config. `null` is a
    // staged erasure, applied together with the commit. Because the commit
    // below writes `config.routes[agent]` and then drains `pending`, a value
    // and its source are never out of step.
    const pending = new Map<string, ConfigSource | null>();

    for (const [field, value] of Object.entries(data)) {
      if (field !== "primary" && field !== "alternate") {
        warn(`unknown key "routes.${agent}.${field}"`);
        continue;
      }
      const slot = field;
      const dotted = `routes.${agent}.${slot}`;
      const current = holders[slot];

      if (value === null) {
        delete holders[slot];
        pending.set(`${dotted}.model`, null);
        pending.set(`${dotted}.rail`, null);
        continue;
      }
      if (!isPlainObject(value)) {
        warn(`"${dotted}" must be an object or null`);
        continue;
      }

      const candidate: Partial<Candidate> = current ? { ...current } : {};
      // A candidate's sources are collected locally and only folded into
      // `pending` once the candidate is accepted, so a candidate rejected for
      // lacking `model` or `rail` leaves its half-set provenance behind.
      const candidateSources = new Map<string, ConfigSource>();
      for (const [key, fieldValue] of Object.entries(value)) {
        if (key === "model") {
          if (typeof fieldValue === "string" && fieldValue.includes("/")) {
            candidate.model = fieldValue;
            candidateSources.set(`${dotted}.model`, source);
          } else {
            warn(`"${dotted}.model" must be a string containing "/"`);
          }
        } else if (key === "rail") {
          if (isRail(fieldValue)) {
            candidate.rail = fieldValue;
            candidateSources.set(`${dotted}.rail`, source);
          } else {
            warn(`"${dotted}.rail" must be one of "claude", "codex", "deepseek"`);
          }
        } else {
          warn(`unknown key "${dotted}.${key}"`);
        }
      }

      if (candidate.model !== undefined && candidate.rail !== undefined) {
        const resolved = candidate as Candidate;
        const implied = railFromModel(resolved.model);
        if (implied !== undefined && implied !== resolved.rail) {
          warn(
            `"${dotted}.model" "${resolved.model}" reads as the ${implied} rail but rail is "${resolved.rail}"`,
          );
        }
        holders[slot] = resolved;
        for (const [key, from] of candidateSources) pending.set(key, from);
      } else if (candidate.model !== undefined || candidate.rail !== undefined) {
        // Only ever reached for a candidate a layer introduces: an existing one
        // already carries both fields, so a partial override completes it.
        warn(`"${dotted}" needs both "model" and "rail"`);
      }
    }

    if (!holders.primary) {
      // Never remove a route a lower layer set: an invalid value leaves the
      // previous value standing. Deletion stays explicit (route-level `null`).
      // Returning here discards `pending`, so neither value nor source moves.
      warn(`route "${agent}" has no primary`);
      return;
    }
    config.routes[agent] = {
      primary: holders.primary,
      ...(holders.alternate ? { alternate: holders.alternate } : {}),
    };
    for (const [key, from] of pending) {
      if (from === null) clearSource(key);
      else setSource(key, from);
    }
  };

  for (const layer of layers) {
    const { source } = layer;
    const label = layer.label ?? source;
    const warn = (message: string) => {
      warnings.push(`${label}: ${message}`);
    };

    if (!isPlainObject(layer.data)) {
      warn("config must be a JSON object");
      continue;
    }

    for (const [key, value] of Object.entries(layer.data)) {
      if (key === "routes") {
        if (!isPlainObject(value)) {
          warn(`"routes" must be an object`);
          continue;
        }
        for (const [agent, routeValue] of Object.entries(value)) {
          const rejection = agentNameRejection(agent);
          if (rejection) {
            warn(rejection);
            continue;
          }
          if (routeValue === null) {
            dropRoute(agent);
          } else if (!isPlainObject(routeValue)) {
            warn(`route "${agent}" must be an object or null`);
          } else {
            applyRoute(agent, routeValue, source, warn);
          }
        }
        continue;
      }

      if (!(SCALAR_KEYS as readonly string[]).includes(key)) {
        warn(`unknown key "${key}"`);
        continue;
      }
      const scalar = key as ScalarKey;
      const owned = OWNED_PATH_SCALARS.get(scalar);
      if (owned !== undefined) {
        warn(`unknown key "${key}" (${owned})`);
        continue;
      }
      const range = NUMBER_RANGES.get(scalar);
      if (range) {
        const requirement = `${range.integer ? "an integer" : "a number"} in [${range.min}, ${range.max}]`;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          warn(`"${key}" must be ${requirement}`);
          continue;
        }
        if ((range.integer && !Number.isInteger(value)) || value < range.min || value > range.max) {
          warn(`"${key}" must be ${requirement}`);
          continue;
        }
      } else if (typeof value !== "string") {
        warn(`"${key}" must be a string`);
        continue;
      }
      scalarTarget[scalar] = value as string | number;
      setSource(scalar, source);
    }
  }

  return { config, sources, warnings };
}

/**
 * Provenance block for `/quota-dispatch`, so "where did this value come from?"
 * is answerable without opening three files.
 *
 * First line names the layers and whether each file was found:
 *
 *   `config: built-in < global <path> (present|absent) < project <path> (present|absent)`
 *
 * Then one line per effective value, scalars in a fixed order followed by
 * routes sorted by agent, each rendered `<dotted-key> = <value>  [<source>]`:
 *
 *   `  sessionSwitchAt = 75  [built-in]`
 *
 * Finally one `  warning: <text>` line per warning, if any.
 */
export function describeConfig(loaded: LoadedConfig): string[] {
  const [globalFile, projectFile] = loaded.files;
  const found = (file: ConfigFile | undefined): string => (file?.present ? "present" : "absent");
  const lines: string[] = [
    `config: built-in < global ${globalFile?.path ?? globalConfigPath()} (${found(globalFile)})` +
      ` < project ${projectFile?.path ?? projectConfigPath()} (${found(projectFile)})`,
  ];

  const sourceOf = (key: string): ConfigSource => loaded.sources[key] ?? "built-in";

  for (const key of SCALAR_KEYS) {
    lines.push(`  ${key} = ${String(loaded.config[key])}  [${sourceOf(key)}]`);
  }

  for (const agent of Object.keys(loaded.config.routes).sort()) {
    const route = loaded.config.routes[agent];
    for (const [slot, candidate] of [
      ["primary", route.primary],
      ["alternate", route.alternate],
    ] as const) {
      if (!candidate) continue;
      const dotted = `routes.${agent}.${slot}`;
      lines.push(`  ${dotted}.model = ${candidate.model}  [${sourceOf(`${dotted}.model`)}]`);
      lines.push(`  ${dotted}.rail = ${candidate.rail}  [${sourceOf(`${dotted}.rail`)}]`);
    }
  }

  for (const warning of loaded.warnings) lines.push(`  warning: ${warning}`);
  return lines;
}
