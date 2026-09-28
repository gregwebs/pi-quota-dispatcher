/**
 * Configuration loading for pi-quota-dispatcher.
 *
 * Three layers, later wins:
 *
 *   built-in  the shipped defaults in `defaultConfig()` (no agents at all)
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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- shape

export type Rail = "claude" | "codex" | "deepseek";

/**
 * A thinking level, spelled the way an agent file's `thinking:` line spells it.
 *
 * `off` is here because pi's own model-level type has it: an agent can be told
 * not to think at all, and that is a legitimate thing for a route to ask for.
 * Whether a given *model* can do a level is deliberately not this seam's
 * business — pi clamps a level to what the model supports when the agent is
 * spawned, so a level that is merely ambitious is not a configuration error.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The permitted levels, in pi's own order. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The levels as a rejection words them, e.g. `"off", "minimal", ...`. */
const THINKING_LEVEL_LIST = THINKING_LEVELS.map((level) => `"${level}"`).join(", ");

/**
 * Whether `value` is a level this seam accepts.
 *
 * The set is spelled out here rather than taken from pi so that the config seam
 * keeps its single job: rejecting a typo before it can be written into a file.
 * A level this list accepts but the running pi does not know is pi's to clamp.
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Why `id` cannot key the `models` table, or `undefined` when it can.
 *
 * A model is named here the way pi names it and the way a candidate names it —
 * `provider/modelId` — because that is what the entry is looked up by. An id
 * with no slash can never match a candidate, so it would be a default that
 * silently applies to nothing.
 */
export function modelIdRejection(id: string): string | undefined {
  if (id.includes("/")) return undefined;
  return `model "${id}" is not a provider/model id (needs "/")`;
}

export interface Candidate {
  model: string;
  rail: Rail;
  /**
   * The level this candidate asks for itself, which outranks both the route's
   * default and the model's.
   */
  thinking?: ThinkingLevel;
}

/**
 * What the `models` table holds for one model, wherever a route names it.
 *
 * Keyed by exact `provider/modelId`. An entry is a *default*: it applies to every
 * candidate whose model it names, and it is outranked by the route's `thinking`
 * and by the candidate's own. An entry for a model no route names is inert — a
 * table shared across machines and projects is a normal thing to have — except
 * that a `rail` contradicting the model's own prefix is a wrong registration
 * whether or not anything routes to it, and warns.
 */
export interface ModelDefault {
  /**
   * The rail this model draws on, wherever a route names it.
   *
   * The place to register a rail: a model belongs to one account, so stating it
   * here keeps every candidate that names the model from repeating it. A
   * candidate may still state its own rail, which outranks this one, and a
   * layer that moves a candidate to another model re-resolves the rail from
   * this table rather than gluing the old one to the new model.
   */
  rail?: Rail;
  thinking?: ThinkingLevel;
}

/**
 * One agent's destinations, in priority order.
 *
 * `primary` is where the agent belongs when nothing is tight. `alternates` is a
 * *priority* list, consulted in order: the first one that is usable and
 * meaningfully healthier than the primary wins. The order is the user's
 * statement of intent and is deliberately never re-sorted by headroom, which
 * would give the policy a second source of oscillation.
 *
 * The list is not deep-merged. A layer that mentions `alternates` replaces it
 * whole — merging element by element is not what a priority order means — and
 * it is accepted or rejected as a unit: one unusable element discards the whole
 * list and leaves the previous layer's list standing. Provenance follows: the
 * sources for `alternates[<index>]` are rewritten wholesale on replacement, so
 * an index the new list does not have carries no source at all.
 *
 * An empty list pins the agent to its primary: the primary is then assigned
 * with no readability check and is never held, because there is nothing else
 * the answer could be.
 */
export interface AgentRoute {
  /**
   * The level every candidate on this route falls back to when the candidate
   * itself names none. It outranks a model's own default, so a route can say
   * "planning work thinks hard" once instead of on every model it might use.
   */
  thinking?: ThinkingLevel;
  primary: Candidate;
  alternates: Candidate[];
}

/**
 * The entry-level skip instructions a layer may put on an agent. Both are
 * consumed while the layers are folded and are never part of the effective
 * config, because they say what to do with an entry rather than what the entry
 * is.
 *
 *   `disable`  the agent is off: remove it, whatever lower layers said, and
 *              record the removal once. A `disable` with nothing to remove
 *              removes nothing and records nothing.
 *   `ignore`   this copy of the entry does not govern: it contributes nothing,
 *              warns nothing and leaves a lower layer's route standing. Set as
 *              well as `disable`, `ignore` wins — there is no conflict to
 *              report, because a copy that governs nothing cannot also turn
 *              something off.
 *
 * `false` is legal and inert — it asserts nothing — so `disable: false` alone
 * leaves a lower layer's route exactly as it was. Any other non-boolean value
 * is not a skip instruction at all: it warns and is treated as absent, leaving
 * the rest of the entry to apply.
 *
 * An entry that carries skip flags and names no field of an agent route states
 * no route at all. On an agent no lower layer defines it therefore changes
 * nothing and gets no `has no primary` warning: the only warning such an entry
 * can produce is about a flag value that is not a boolean, and that one is the
 * flag's own. There is no half-built agent route to report, and the provenance
 * block already shows the agent as unmanaged. `has no primary` is for an entry
 * that named a route field — `primary`, `alternates` or `thinking` — and could
 * not complete one.
 */
export type SkipFlag = "disable" | "ignore";

/**
 * What the dispatcher may do about an expired Claude credential.
 *
 * Claude Code owns this credential and is the only thing that refreshes it, as
 * a side effect of being run. An install driven through a bridge rather than
 * through `claude` therefore leaves the token to expire overnight, and the rail
 * is unreadable exactly when a new session wants to read it — a missing reading,
 * which holds every route that depends on it (ADR 0006).
 *
 *   `off`           read the credential, report the expiry, change nothing.
 *                   What every install did before this key existed.
 *   `offline-ping`  run one throwaway Claude Code process whose model request
 *                   is diverted to a loopback listener this extension answers
 *                   itself, so Claude Code refreshes its own credential without
 *                   spending budget. See docs/adr/0007-refresh-pings.md.
 *   `ping`          the same run without the diversion. A real request, costing
 *                   a real answer's worth of tokens; the fallback for a machine
 *                   where the diversion stops working.
 *
 * `off` is the default because this is the one key that makes the extension
 * start a process and change state outside itself. `offline-ping` is the
 * setting to recommend, and the reason the key exists at all.
 */
export type ClaudeRefreshMode = "off" | "offline-ping" | "ping";

export const CLAUDE_REFRESH_MODES: readonly ClaudeRefreshMode[] = [
  "off",
  "offline-ping",
  "ping",
];

/** The modes as a rejection words them, e.g. `"off", "offline-ping", ...`. */
const CLAUDE_REFRESH_MODE_LIST = CLAUDE_REFRESH_MODES.map((mode) => `"${mode}"`).join(", ");

/**
 * Whether `value` is a mode this seam accepts.
 *
 * Spelled out here for the same reason the thinking levels are: the config
 * seam's job is to refuse a typo before it can govern anything, and a mode it
 * accepts is one the dispatcher knows how to carry out.
 */
export function isClaudeRefreshMode(value: unknown): value is ClaudeRefreshMode {
  return typeof value === "string" && (CLAUDE_REFRESH_MODES as readonly string[]).includes(value);
}

export interface DispatcherConfig {
  agentDir: string;
  claudeCredsPath: string;
  claudeRefresh: ClaudeRefreshMode;
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
  /**
   * Per-model defaults, keyed by `provider/modelId`.
   *
   * A model is named here so that every candidate using it inherits its rail
   * and its thinking level without each route restating them. The rail is the
   * recommended place to register the account a model draws on; the level is
   * the weakest of the three places one can be stated — route and candidate
   * both outrank it. The table ships empty, because a default for a model this
   * user does not use says nothing.
   */
  models: Record<string, ModelDefault>;
  /**
   * The agents this extension manages, keyed by agent name — a name is the
   * filename stem, `<agentDir>/<name>.md`.
   *
   * There are no shipped entries. This extension writes to agent files, so a
   * table of default names means editing files the user never named; an agent is
   * managed only once the user has listed it here. An agent absent from this
   * table is never touched.
   */
  agents: Record<string, AgentRoute>;
}

/** Name of the file, in both the global and the project directory. */
export const CONFIG_FILE_NAME = "quota-dispatch.json";

/** The scalar keys, in the fixed order they are reported by `describeConfig`. */
const SCALAR_KEYS = [
  "agentDir",
  "claudeCredsPath",
  "claudeRefresh",
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
 * The string scalars that accept one of a closed set, and that set as a
 * rejection words it.
 *
 * A key here is validated by its own predicate instead of by the blanket "must
 * be a string" check, so `{"claudeRefresh": "ocasionally"}` is refused where it
 * is written rather than at the moment the dispatcher would have acted on it.
 */
const ENUM_SCALARS: ReadonlyMap<
  ScalarKey,
  { is: (value: unknown) => value is string; list: string }
> = new Map([["claudeRefresh", { is: isClaudeRefreshMode, list: CLAUDE_REFRESH_MODE_LIST }]]);

/**
 * Agent names are filenames: `<agentDir>/<agent>.md`. A key like `../outside`
 * would write outside the agents directory, so an agent is only accepted when
 * its key matches the convention agent files use.
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
 *
 * Exported because the startup snippet proposes agent names, and a name it
 * proposes has to be one the loader would accept — otherwise the "paste-ready"
 * table warns the moment it is pasted.
 */
export function agentNameRejection(name: string): string | undefined {
  if (!AGENT_NAME.test(name)) {
    return `agent "${name}" is not a valid agent name (lowercase letters, digits and dashes, starting with a letter)`;
  }
  if (name in Object.prototype) {
    return `agent "${name}" shadows Object.prototype and is not manageable`;
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
 *
 * Exported because the startup snippet derives each candidate's `rail` from the
 * model an agent file already declares, and a second copy of these prefixes
 * would be free to drift from the one the loader validates against.
 */
export function railFromModel(model: string): Rail | undefined {
  if (model.startsWith("claude-bridge/") || model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("openai-codex/")) return "codex";
  if (model.startsWith("deepseek/")) return "deepseek";
  return undefined;
}

/**
 * The rail `model`'s prefix implies when that disagrees with `rail`, or
 * `undefined` when the prefix names no rail we know or agrees with `rail`.
 *
 * A prefix that names no rail is not evidence of a mistake, so it never warns;
 * this only answers "does this stated rail contradict the model id?", which is
 * asked wherever a rail is stated — on a candidate and in the `models` table.
 */
function mismatchedRail(model: string, rail: Rail): Rail | undefined {
  const implied = railFromModel(model);
  return implied !== undefined && implied !== rail ? implied : undefined;
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
 *   claudeRefresh    `off`
 *   ttlMs            180_000
 *   pollMs           300_000
 *   sessionSwitchAt  75
 *   weeklySwitchAt   90
 *   margin           10
 *   models           {}
 *
 * `models` and `agents` are both empty, and that is the point. There is no
 * opinion here about which agents exist, where their work should go, or which
 * model thinks how hard: a shipped table names files the user never named and
 * routes work to rails they never chose. The README shows the snippet to paste
 * instead.
 */
export function defaultConfig(agentDir: string = getAgentDir()): DispatcherConfig {
  return {
    agentDir: join(agentDir, "agents"),
    claudeCredsPath: join(homedir(), ".claude", ".credentials.json"),
    claudeRefresh: "off",
    piAuthPath: join(agentDir, "auth.json"),
    ttlMs: 180_000,
    pollMs: 300_000,
    sessionSwitchAt: 75,
    weeklySwitchAt: 90,
    margin: 10,
    models: {},
    agents: {},
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
   * scalar keys and each candidate field of each agent, e.g. `sessionSwitchAt`,
   * `agents.planner.primary.model` and `agents.planner.alternates[0].model`. A
   * key no layer set is `"built-in"`.
   *
   * It describes the config that actually resulted, so an agent or candidate a
   * layer proposes but validation rejects leaves no entry: `sources` never
   * names a layer that supplied a value `config` does not hold.
   *
   * The one key that is not a value is `agents.<name>`, with no `.primary` or
   * `.alternates` suffix. It records that this layer removed that agent with
   * `disable`, which is the only way an agent that a lower layer configured can
   * be absent from `config` — and therefore the answer to "why is this agent not
   * managed?".
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
  /**
   * Whether a file is there, for the "configured but absent" check on the
   * agent files the effective table names. Defaults to `existsSync`.
   * Deliberately not `readFile`: the check is about the file existing, not about
   * being able to read it.
   */
  fileExists?: (path: string) => boolean;
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
  const exists = deps.fileExists ?? existsSync;
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

  // An agent the effective table names, whose file is not there, is a config
  // that quietly does nothing for that agent: `decide` reports "skipped (no
  // file)" at every evaluation and the reason is never surfaced. The warning is
  // prefixed with the path it is about, like every other one, because that path
  // is what has to exist. The path alone assumes hand-writing the file, so the
  // remedy the user actually has in the terminal — `/agents` — is named too.
  for (const agent of Object.keys(merged.config.agents).sort()) {
    const file = join(merged.config.agentDir, `${agent}.md`);
    if (!exists(file)) {
      warnings.push(
        `${file}: configured agent "${agent}" has no file — run the /agents command to create a new agent`,
      );
    }
  }

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
 * Deep per agent: a layer that names one agent only touches that agent. The
 * `models` table is folded first, over every layer, before any agent is read: a
 * candidate that states no rail of its own resolves the rail against the fully
 * merged table, so the model and the route that names it can live in different
 * layers. A layer that moves a candidate to another model re-resolves that
 * model's registered rail; a layer that states a rail, or changes no model,
 * keeps the rail beneath it, field-wise. Two things about agents are not deep,
 * and both are deliberate. `alternates` is replaced as a whole whenever a layer
 * mentions it (see `AgentRoute`), and the skip flags act on the entry as a unit
 * (see `SkipFlag`).
 *
 * There is no `null`. It used to mean "remove this", which made one mistyped
 * value silently delete a route. Removal is now `disable: true`, which says what
 * it is doing; `null` anywhere — an agent, a candidate, an element of
 * `alternates` — warns and leaves the previous layer's value standing.
 *
 * Warnings. A layer warning is prefixed with the layer's `label`, which
 * defaults to its `source`, e.g. `global: ...`; `loadConfig` passes the file
 * path as the label, which is what a reader needs in order to go and fix it. An
 * agent rejected while cloning `base` is prefixed `built-in:`, because that is
 * the layer the base stands for. The kinds are:
 *
 *   - an unrecognised key, at the top level or inside an agent, candidate or
 *     skip flag
 *   - a value of the wrong type, including a skip flag that is not a boolean
 *   - a scalar outside its permitted range: the timers are whole milliseconds
 *     in Node's timer range, the rest are 0–100 percentages
 *   - an agent name that is not a safe filename, on a layer key or on a base
 *     entry (see `AGENT_NAME` and `agentNameRejection`)
 *   - a `model` that is not a string containing `/`
 *   - a `rail` that is not one of the three known rails
 *   - a `thinking` that is not one of the levels pi accepts
 *   - a `models` key that is not a `provider/modelId`, or an entry that is not
 *     an object, or an unrecognised key inside one, or a `rail` that is not one
 *     of the three known rails, or a registered rail that reads like a
 *     different account's model than its key
 *   - a candidate left with no rail: one that states none and whose model has
 *     no registered rail cannot name an account to route to
 *   - a `model` whose prefix reads like a different rail's model than the one
 *     declared, which is what a partial override leaves behind
 *   - an `alternates` that is not an array, or that holds an element which is
 *     not a usable candidate: the list is accepted or rejected as a unit
 *   - an agent left without a `primary`, which leaves the previous entry for
 *     that agent intact rather than erasing it
 *   - the obsolete `routes` key, which is reported with the name that replaced
 *     it
 *
 * `sources` describes the config that survives: an agent or candidate a layer
 * proposes but validation rejects contributes nothing, so provenance can never
 * point at a value the merge did not accept. A committed entry commits its
 * values and its sources together.
 */
/**
 * Validate one candidate at `dotted`, merging over `current` when there is one.
 *
 * Returns `undefined` when the value cannot complete a candidate, having already
 * warned; the caller then leaves the value it already holds standing. The staged
 * sources are returned rather than written, so a candidate that is rejected
 * after being partly read leaves provenance untouched.
 *
 * A candidate may state a `rail`, or leave it to the `models` table. The table
 * is the recommended single place for it, so a layer that *moves* the candidate
 * to another model re-resolves the rail from that model's entry rather than
 * keeping the rail the old model carried; if the new model registers none, an
 * inherited rail is dropped and the candidate rejected, because that rail
 * belonged to the model being left. A rail a candidate stated itself is kept
 * across a model change, field-wise, like every other candidate field. A layer
 * that states a rail, or restates the same model, leaves the lower value
 * standing. A candidate with neither a rail of its own nor a registered one is
 * rejected.
 *
 * `registeredRail` is the *fully merged* table (see `mergeConfig`), so a rail
 * registered in any layer can complete a candidate in any other. `inheritedRail`
 * records which candidates already carry a table rail, so the distinction
 * survives the field-wise clone of a lower layer's candidate.
 */
function parseCandidate(
  value: unknown,
  dotted: string,
  current: Candidate | undefined,
  source: ConfigSource,
  warn: (message: string) => void,
  registeredRail: (model: string) => { rail: Rail; source: ConfigSource } | undefined,
  inheritedRail: WeakSet<Candidate>,
): { candidate: Candidate; sources: Map<string, ConfigSource> } | undefined {
  if (!isPlainObject(value)) {
    warn(`"${dotted}" must be an object`);
    return undefined;
  }

  const candidate: Partial<Candidate> = current ? { ...current } : {};
  const sources = new Map<string, ConfigSource>();
  // Whether the rail we start from came from the models table rather than a
  // statement on a candidate. It decides two things: a table rail is checked
  // where it is registered rather than here, and a layer that moves the
  // candidate to an unregistered model must not drag it along.
  const currentFromTable = current !== undefined && inheritedRail.has(current);
  // Whether this layer states the field itself. A stated rail outranks the
  // model's; a stated model moves the candidate and re-resolves its rail.
  let statedModel = false;
  let statedRail = false;
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === "model") {
      if (typeof fieldValue === "string" && fieldValue.includes("/")) {
        candidate.model = fieldValue;
        statedModel = true;
        sources.set(`${dotted}.model`, source);
      } else {
        warn(`"${dotted}.model" must be a string containing "/"`);
      }
    } else if (key === "rail") {
      if (isRail(fieldValue)) {
        candidate.rail = fieldValue;
        statedRail = true;
        sources.set(`${dotted}.rail`, source);
      } else {
        warn(`"${dotted}.rail" must be one of "claude", "codex", "deepseek"`);
      }
    } else if (key === "thinking") {
      // A level is validated for its *spelling* here and for nothing else. Pi
      // clamps to what the model supports at spawn time, so an ambitious level
      // is not an error and this seam has no business guessing at capability.
      if (isThinkingLevel(fieldValue)) {
        candidate.thinking = fieldValue;
        sources.set(`${dotted}.thinking`, source);
      } else {
        warn(`"${dotted}.thinking" must be one of ${THINKING_LEVEL_LIST}`);
      }
    } else {
      warn(`unknown key "${dotted}.${key}"`);
    }
  }

  // The rail follows the model it names, but only when the model actually
  // changes: restating the same model must not throw away a rail the candidate
  // itself stated.
  let fromTable = false;
  if (statedRail) {
    // The candidate states its own rail, which outranks the table's.
  } else if (statedModel && candidate.model !== current?.model) {
    const registered = candidate.model === undefined ? undefined : registeredRail(candidate.model);
    if (registered) {
      candidate.rail = registered.rail;
      sources.set(`${dotted}.rail`, registered.source);
      fromTable = true;
    } else if (currentFromTable) {
      // The rail belonged to the model being left, and the new model registers
      // none, so there is nothing to carry: dropping it makes the candidate
      // incomplete and the layer is rejected rather than pointing an
      // unregistered model at another model's account.
      delete candidate.rail;
    }
  } else {
    // No model change, so the rail beneath it — stated by a lower layer, or
    // registered for this same model — stands.
    fromTable = currentFromTable;
  }

  if (candidate.model !== undefined && candidate.rail !== undefined) {
    const resolved = candidate as Candidate;
    // A rail the models table supplied is checked once, at the entry that stated
    // it, so it does not warn again on every candidate that names the model —
    // or on a layer that only changes the level beside it.
    if (!fromTable) {
      const implied = mismatchedRail(resolved.model, resolved.rail);
      if (implied !== undefined) {
        warn(
          `"${dotted}.model" "${resolved.model}" reads as the ${implied} rail but rail is "${resolved.rail}"`,
        );
      }
    }
    if (fromTable) inheritedRail.add(resolved);
    return { candidate: resolved, sources };
  }

  if (candidate.model !== undefined) {
    // The model is named but no rail is stated anywhere, so this candidate
    // cannot name an account to route to.
    warn(
      `"${dotted}" needs a rail (state one here or register one for "${candidate.model}" under "models")`,
    );
  } else if (candidate.rail !== undefined) {
    // Only ever reached for a candidate a layer introduces: an existing one
    // already carries both fields, so a partial override completes it.
    warn(`"${dotted}" needs a "model"`);
  }
  return undefined;
}

export function mergeConfig(base: DispatcherConfig, layers: MergeLayer[]): MergeResult {
  const warnings: string[] = [];
  const agents: Record<string, AgentRoute> = {};
  for (const [agent, route] of Object.entries(base.agents)) {
    // Normally the base is `defaultConfig()`, which ships no agents at all, so
    // this only fires for a config a caller built programmatically. A bad key is
    // the same defect class as a bad layer key — it names a file — so it gets
    // the same warning and is dropped rather than cloned into the effective
    // config.
    const rejection = agentNameRejection(agent);
    if (rejection) {
      warnings.push(`built-in: ${rejection}`);
      continue;
    }
    agents[agent] = {
      ...(route.thinking !== undefined ? { thinking: route.thinking } : {}),
      primary: { ...route.primary },
      alternates: route.alternates.map((candidate) => ({ ...candidate })),
    };
  }
  // The `models` table is a base value like `agents`: entries a caller built
  // programmatically are cloned so a merge cannot mutate the caller's object,
  // and a key that cannot name a pi model is dropped with the warning a bad key
  // on a layer would get. A key with a `/` in it can never be `__proto__` or
  // `constructor`, which is what keeps an unguarded write onto `models` from
  // reaching an inherited value.
  const models: Record<string, ModelDefault> = {};
  for (const [id, entry] of Object.entries(base.models)) {
    const rejection = modelIdRejection(id);
    if (rejection) {
      warnings.push(`built-in: ${rejection}`);
      continue;
    }
    if (entry.rail !== undefined) {
      const implied = mismatchedRail(id, entry.rail);
      if (implied !== undefined) {
        warnings.push(
          `built-in: model "${id}" reads as the ${implied} rail but its registered rail is "${entry.rail}"`,
        );
      }
    }
    models[id] = { ...entry };
  }
  const config: DispatcherConfig = { ...base, models, agents };
  const scalarTarget = config as unknown as Record<ScalarKey, string | number>;

  const sources: Record<string, ConfigSource> = {};
  const setSource = (key: string, source: ConfigSource) => {
    sources[key] = source;
  };
  const clearSource = (key: string) => {
    delete sources[key];
  };

  for (const key of SCALAR_KEYS) setSource(key, "built-in");
  for (const [id, entry] of Object.entries(config.models)) {
    if (entry.rail !== undefined) setSource(`models.${id}.rail`, "built-in");
    if (entry.thinking !== undefined) setSource(`models.${id}.thinking`, "built-in");
  }
  for (const [agent, route] of Object.entries(config.agents)) {
    setSource(`agents.${agent}.primary.model`, "built-in");
    setSource(`agents.${agent}.primary.rail`, "built-in");
    // A level is only a value where one is actually stated, so only then does it
    // get a source; there is no `undefined` for provenance to describe.
    if (route.thinking !== undefined) setSource(`agents.${agent}.thinking`, "built-in");
    if (route.primary.thinking !== undefined) {
      setSource(`agents.${agent}.primary.thinking`, "built-in");
    }
    route.alternates.forEach((candidate, index) => {
      setSource(`agents.${agent}.alternates[${index}].model`, "built-in");
      setSource(`agents.${agent}.alternates[${index}].rail`, "built-in");
      if (candidate.thinking !== undefined) {
        setSource(`agents.${agent}.alternates[${index}].thinking`, "built-in");
      }
    });
  }

  /**
   * The rail registered for `model`, with the layer that supplied it, or
   * `undefined` when the table does not register one.
   *
   * Read through `Object.hasOwn`, so a candidate naming a model the table does
   * not have cannot resolve to an inherited value. A model id always contains a
   * `/` (the seam rejects the rest), which already rules out the
   * `Object.prototype` names.
   */
  const registeredRail = (model: string): { rail: Rail; source: ConfigSource } | undefined => {
    if (!Object.hasOwn(config.models, model)) return undefined;
    const rail = config.models[model].rail;
    if (rail === undefined) return undefined;
    return { rail, source: sources[`models.${model}.rail`] ?? "built-in" };
  };

  /**
   * Candidates whose rail came from the `models` table rather than from a
   * statement on the candidate itself.
   *
   * The distinction is invisible in the effective config — a rail is a rail —
   * but it decides what a later layer may do with it: a layer that moves the
   * candidate to an unregistered model must drop an inherited rail rather than
   * point the new model at the old model's account, while a rail the candidate
   * stated itself is kept field-wise. Tracked by identity, because the merge
   * hands each layer a fresh clone of the candidate it is editing.
   */
  const inheritedRail = new WeakSet<Candidate>();

  /** Forget every value `agent` contributed, including every list index. */
  const clearAgentSources = (agent: string): void => {
    for (const key of Object.keys(sources)) {
      if (key === `agents.${agent}` || key.startsWith(`agents.${agent}.`)) clearSource(key);
    }
  };

  /**
   * Remove `agent` from the effective table, and record who removed it.
   *
   * The record is the bare `agents.<agent>` key, which is not a value: it is how
   * `/quota-dispatch` answers "why is this agent not managed?". A disable that
   * had nothing to remove records nothing, because nothing changed.
   */
  const disableAgent = (agent: string, source: ConfigSource): void => {
    // Own property only: a key like `constructor` would otherwise reach an
    // inherited value that is not an agent at all.
    if (!Object.hasOwn(config.agents, agent)) return;
    delete config.agents[agent];
    clearAgentSources(agent);
    setSource(`agents.${agent}`, source);
  };

  const applyAgent = (
    agent: string,
    data: Record<string, unknown>,
    source: ConfigSource,
    warn: (message: string) => void,
  ): void => {
    // Own property only, so `{"agents":{"constructor":{}}}` does not resolve
    // to `Object.prototype.constructor` and commit a phantom agent.
    const existing = Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;

    // The entry-level skip instructions act on the entry as a unit, so they are
    // settled before anything inside it is looked at. `ignore` wins over
    // `disable`: a copy that governs nothing cannot also turn something off, and
    // there is no conflict to report. Either `true` is a complete answer, and
    // `false` is inert, so the rest of the entry applies. A non-boolean is not
    // a skip instruction at all — it warns and is treated as absent.
    const skipFlag = (flag: SkipFlag): boolean => {
      const value = data[flag];
      if (value === undefined) return false;
      if (typeof value === "boolean") return value;
      warn(`"agents.${agent}.${flag}" must be true or false`);
      return false;
    };
    if (skipFlag("ignore")) return;
    if (skipFlag("disable")) {
      disableAgent(agent, source);
      return;
    }

    // `primary` is aliased rather than copied so that a candidate whose rail
    // came from the `models` table keeps its identity in `inheritedRail`; the
    // candidate a layer builds is a fresh object either way, so nothing here
    // mutates the lower layer's entry.
    const holders: { thinking?: ThinkingLevel; primary?: Candidate; alternates?: Candidate[] } = {
      ...(existing?.thinking !== undefined ? { thinking: existing.thinking } : {}),
      ...(existing ? { primary: existing.primary } : {}),
      ...(existing ? { alternates: existing.alternates.map((c) => ({ ...c })) } : {}),
    };

    // Provenance is staged here, not written as candidates are validated: an
    // agent or candidate that is later rejected must leave `sources` byte-for-
    // byte as it was, so it can only describe the effective config. Because the
    // commit below writes `config.agents[agent]` and then drains `pending`, a
    // value and its source are never out of step.
    const pending = new Map<string, ConfigSource | null>();

    // Whether this entry named a field of an agent route — one of `AgentRoute`'s
    // fields rather than a skip flag, which says what to do with an entry
    // instead of what the entry is. An entry that named none of them is not an
    // agent route that failed to complete, so it must not be reported as one
    // below.
    let namedRouteField = false;

    for (const [field, value] of Object.entries(data)) {
      if (field === "disable" || field === "ignore") {
        // Already consumed as a skip instruction; a `false` one is valid and
        // inert, so it is not an unknown key.
        continue;
      }
      if (field !== "thinking" && field !== "primary" && field !== "alternates") {
        warn(`unknown key "agents.${agent}.${field}"`);
        continue;
      }
      // A field of an agent route, whatever its value turns out to be worth: the
      // entry is an attempt at one, so ending up with no primary is reportable
      // below. A key this schema does not have is not — it warned for itself, and
      // a misspelling is not a half-built agent route.
      namedRouteField = true;

      if (field === "thinking") {
        // The route's own default, which outranks a model's and is outranked by
        // a candidate's. Rejecting it leaves the lower layer's level standing,
        // like every other invalid value.
        if (!isThinkingLevel(value)) {
          warn(`"agents.${agent}.thinking" must be one of ${THINKING_LEVEL_LIST}`);
          continue;
        }
        holders.thinking = value;
        pending.set(`agents.${agent}.thinking`, source);
        continue;
      }

      if (field === "primary") {
        const dotted = `agents.${agent}.primary`;
        if (value === null) {
          // `null` is no longer an eraser. A route needs a primary, so the only
          // way to name a removal is the explicit flag; a `null` here changes
          // nothing and the previous primary stands.
          warn(`"${dotted}" is null; a route needs a primary (to remove the agent use disable: true)`);
          continue;
        }
        const parsed = parseCandidate(
          value,
          dotted,
          holders.primary,
          source,
          warn,
          registeredRail,
          inheritedRail,
        );
        if (!parsed) continue;
        holders.primary = parsed.candidate;
        for (const [key, from] of parsed.sources) pending.set(key, from);
        continue;
      }

      const dotted = `agents.${agent}.alternates`;
      if (!Array.isArray(value)) {
        warn(`"${dotted}" must be an array`);
        continue;
      }
      // A layer that mentions the list replaces it whole, never element by
      // element: `alternates` is a priority order, and the order is not
      // something element-wise merging can express. Each element is a candidate
      // in its own right — it inherits nothing from whatever used to sit at the
      // same index — and the list is accepted or rejected as a unit, so a single
      // unusable element leaves the previous list, and its provenance, exactly
      // as they were.
      const nextAlternates: Candidate[] = [];
      const nextStages: Array<Map<string, ConfigSource>> = [];
      let usable = true;
      for (let index = 0; index < value.length; index++) {
        const parsed = parseCandidate(
          value[index],
          `${dotted}[${index}]`,
          undefined,
          source,
          warn,
          registeredRail,
          inheritedRail,
        );
        if (!parsed) {
          usable = false;
          continue;
        }
        nextAlternates.push(parsed.candidate);
        nextStages.push(parsed.sources);
      }
      if (!usable) continue;

      // A list replacement replaces every element, so every source the old
      // list carried is staged for clearing *before* the new list's sources are
      // staged over it. Clearing only the indices the new list does not reach
      // left an element it does reach — which inherits nothing, being parsed
      // fresh — still carrying the old element's `thinking` source, so
      // provenance named a level the effective config did not hold.
      const previousLength = holders.alternates?.length ?? 0;
      holders.alternates = nextAlternates;
      for (let index = 0; index < previousLength; index++) {
        pending.set(`${dotted}[${index}].model`, null);
        pending.set(`${dotted}[${index}].rail`, null);
        pending.set(`${dotted}[${index}].thinking`, null);
      }
      for (const stage of nextStages) {
        for (const [key, from] of stage) pending.set(key, from);
      }
    }

    if (!holders.primary) {
      // Never remove an agent a lower layer set: an invalid value leaves the
      // previous value standing. Removal stays explicit (`disable: true`).
      // Returning here discards `pending`, so neither value nor source moves.
      //
      // The warning is about an agent route that could not be finished, so it is
      // owed only to an entry that named a route field: `{"disable": false}`
      // asks for no agent route, and one it does not get is not a failure to
      // report.
      if (namedRouteField) warn(`agent "${agent}" has no primary`);
      return;
    }
    config.agents[agent] = {
      ...(holders.thinking !== undefined ? { thinking: holders.thinking } : {}),
      primary: holders.primary,
      alternates: holders.alternates ?? [],
    };
    // An entry that lands here is managed, so a removal a lower layer recorded
    // for this agent no longer describes the effective config.
    clearSource(`agents.${agent}`);
    for (const [key, from] of pending) {
      if (from === null) clearSource(key);
      else setSource(key, from);
    }
  };

  const labelWarn = (layer: MergeLayer): ((message: string) => void) => {
    const label = layer.label ?? layer.source;
    return (message: string) => {
      warnings.push(`${label}: ${message}`);
    };
  };

  // The `models` table is merged first, over every layer, so a candidate in any
  // layer can inherit a rail registered in any layer — a route and the model it
  // names need not live in the same file. It is also what lets a layer that
  // changes only a model re-resolve the rail that model registers, which a
  // single ordered pass could not do when the `models` key came after `agents`
  // or in a higher layer.
  for (const layer of layers) {
    if (!isPlainObject(layer.data)) continue;
    const modelsValue = layer.data.models;
    if (modelsValue === undefined) continue;
    const { source } = layer;
    const warn = labelWarn(layer);
    if (!isPlainObject(modelsValue)) {
      warn(`"models" must be an object`);
      continue;
    }
    // Deep-merged per model, like `agents` is per agent, and validated per
    // entry: an entry is a default several routes may inherit, so a typo in one
    // model must not take the rest of the table down with it.
    for (const [id, entryValue] of Object.entries(modelsValue)) {
      const rejection = modelIdRejection(id);
      if (rejection) {
        warn(rejection);
        continue;
      }
      if (!isPlainObject(entryValue)) {
        warn(`model "${id}" must be an object`);
        continue;
      }
      for (const [field, fieldValue] of Object.entries(entryValue)) {
        if (field === "rail") {
          if (!isRail(fieldValue)) {
            warn(`"models.${id}.rail" must be one of "claude", "codex", "deepseek"`);
            continue;
          }
          config.models[id] = { ...config.models[id], rail: fieldValue };
          setSource(`models.${id}.rail`, source);
          // A rail that reads like a different account's model is the same
          // partial-override mistake a candidate-level rail can make, so it
          // gets the same warning here, once, where the rail is stated.
          const implied = mismatchedRail(id, fieldValue);
          if (implied !== undefined) {
            warn(`model "${id}" reads as the ${implied} rail but its registered rail is "${fieldValue}"`);
          }
          continue;
        }
        if (field !== "thinking") {
          warn(`unknown key "models.${id}.${field}"`);
          continue;
        }
        if (!isThinkingLevel(fieldValue)) {
          warn(`"models.${id}.thinking" must be one of ${THINKING_LEVEL_LIST}`);
          continue;
        }
        config.models[id] = { ...config.models[id], thinking: fieldValue };
        setSource(`models.${id}.thinking`, source);
      }
    }
  }

  for (const layer of layers) {
    const { source } = layer;
    const warn = labelWarn(layer);

    if (!isPlainObject(layer.data)) {
      warn("config must be a JSON object");
      continue;
    }

    for (const [key, value] of Object.entries(layer.data)) {
      if (key === "agents") {
        if (!isPlainObject(value)) {
          warn(`"agents" must be an object`);
          continue;
        }
        for (const [agent, agentValue] of Object.entries(value)) {
          const rejection = agentNameRejection(agent);
          if (rejection) {
            warn(rejection);
            continue;
          }
          if (agentValue === null) {
            // `null` no longer removes an agent. Removal is the explicit flag,
            // and an invalid value leaves the previous entry standing rather
            // than erasing it.
            warn(`agent "${agent}" is null; to remove an agent use disable: true`);
          } else if (!isPlainObject(agentValue)) {
            warn(`agent "${agent}" must be an object`);
          } else {
            applyAgent(agent, agentValue, source, warn);
          }
        }
        continue;
      }

      if (key === "models") {
        // Merged in the pass above, before any agent, so a candidate in any
        // layer can inherit a rail registered in any layer.
        continue;
      }

      if (key === "routes") {
        // A hint, not an alias: the old spelling is never read.
        warn(`unknown key "routes" (renamed to "agents")`);
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
      const accepted = ENUM_SCALARS.get(scalar);
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
      } else if (accepted) {
        if (!accepted.is(value)) {
          warn(`"${key}" must be one of ${accepted.list}`);
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
 * The thinking level a candidate resolves to, or `undefined` when nothing names
 * one.
 *
 * Three places can state a level, and the most specific wins:
 *
 *   candidate  the entry's own `thinking`, so one destination can differ from
 *              its route without the route losing its default
 *   route      `agents.<name>.thinking`, which says something about the *work*
 *              — "planning thinks hard" — rather than about a model
 *   model      `models.<provider/modelId>.thinking`, the weakest, because it
 *              knows nothing about what the model is being asked to do
 *
 * `undefined` is a real answer, not a missing one: it means no layer had an
 * opinion, and the agent file's own `thinking:` line is then left alone. Only a
 * level that actually resolved is written, and the dispatcher keeps no record of
 * what it wrote — see `upsertThinking` in `index.ts` for why there is no
 * restore.
 *
 * A model entry is looked up with `Object.hasOwn`, so a candidate naming a model
 * the table does not have cannot read an inherited value as a default. Model ids
 * always contain a `/` (the seam rejects the rest), which already rules out the
 * `Object.prototype` names.
 */
export function thinkingFor(
  cfg: DispatcherConfig,
  route: AgentRoute,
  candidate: Candidate,
): ThinkingLevel | undefined {
  if (candidate.thinking !== undefined) return candidate.thinking;
  if (route.thinking !== undefined) return route.thinking;
  return Object.hasOwn(cfg.models, candidate.model)
    ? cfg.models[candidate.model].thinking
    : undefined;
}

/**
 * Provenance block for `/quota-dispatch`, so "where did this value come from?"
 * is answerable without opening three files.
 *
 * First line names the layers and whether each file was found:
 *
 *   `config: built-in < global <path> (present|absent) < project <path> (present|absent)`
 *
 * Then one line per effective value, scalars in a fixed order, then the
 * `models` table sorted by model id — each entry's `rail` before its `thinking`
 * — then the agents sorted by name, each
 * rendered `<dotted-key> = <value>  [<source>]`:
 *
 *   `  sessionSwitchAt = 75  [built-in]`
 *
 * An agent renders one `.model`/`.rail` pair per candidate, `primary` first and
 * then each `alternates[<index>]` in priority order, so the list reads the way
 * it is consulted. A level is rendered only where something actually states one
 * — a route's `thinking`, a candidate's, and a model's — because "no level" is
 * the absence of a value rather than a value of `undefined`, and a line for
 * every model a route happens to use would be noise. An agent a layer disabled
 * is not in the effective config and has no candidates to render; it appears as
 * the single line `  agents.<name> = disabled  [<source>]`, which is what makes
 * "why is this agent not managed?" answerable from the same block.
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

  // The `models` table is the user's own, and an entry no route names is inert
  // rather than wrong, so every stated default is listed — including one
  // nothing currently reads.
  for (const id of Object.keys(loaded.config.models).sort()) {
    const entry = loaded.config.models[id];
    // The rail first: it is what makes the model a destination at all, and the
    // level beside it is a property of the work that draws on the account.
    if (entry.rail !== undefined) {
      lines.push(`  models.${id}.rail = ${entry.rail}  [${sourceOf(`models.${id}.rail`)}]`);
    }
    if (entry.thinking !== undefined) {
      lines.push(`  models.${id}.thinking = ${entry.thinking}  [${sourceOf(`models.${id}.thinking`)}]`);
    }
  }

  // A disabled agent is absent from `loaded.config.agents` by construction, so
  // the block has to read the removal markers out of `sources` as well; without
  // that, the one agent you most want to ask about — the one that is not
  // managed — would not appear at all. The bare `agents.<name>` key is the
  // marker; a value key always has a `.primary` or `.alternates[...]` suffix.
  const disabled = new Map<string, ConfigSource>();
  for (const [key, source] of Object.entries(loaded.sources)) {
    const removed = /^agents\.([a-z][a-z0-9-]*)$/.exec(key);
    if (removed) disabled.set(removed[1], source);
  }
  const names = new Set<string>([...Object.keys(loaded.config.agents), ...disabled.keys()]);

  for (const agent of [...names].sort()) {
    const route = loaded.config.agents[agent];
    if (!route) {
      lines.push(`  agents.${agent} = disabled  [${disabled.get(agent) ?? "built-in"}]`);
      continue;
    }
    const slots: Array<[string, Candidate]> = [
      ["primary", route.primary],
      ...route.alternates.map(
        (candidate, index): [string, Candidate] => [`alternates[${index}]`, candidate],
      ),
    ];
    // The route's default first, so the block reads weakest-to-strongest down
    // to the candidates that may override it.
    if (route.thinking !== undefined) {
      lines.push(`  agents.${agent}.thinking = ${route.thinking}  [${sourceOf(`agents.${agent}.thinking`)}]`);
    }
    for (const [slot, candidate] of slots) {
      const dotted = `agents.${agent}.${slot}`;
      lines.push(`  ${dotted}.model = ${candidate.model}  [${sourceOf(`${dotted}.model`)}]`);
      lines.push(`  ${dotted}.rail = ${candidate.rail}  [${sourceOf(`${dotted}.rail`)}]`);
      if (candidate.thinking !== undefined) {
        lines.push(`  ${dotted}.thinking = ${candidate.thinking}  [${sourceOf(`${dotted}.thinking`)}]`);
      }
    }
  }

  for (const warning of loaded.warnings) lines.push(`  warning: ${warning}`);
  return lines;
}

/**
 * The config files that supplied these keys, deduped and in layer order, so a
 * caller can name the file the reader has to edit rather than whichever config
 * file happens to exist. A key no layer set (`built-in`) names no file.
 */
export function configFilesFor(loaded: LoadedConfig, keys: Iterable<string>): string[] {
  const layers = new Set([...keys].map((key) => loaded.sources[key]));
  return loaded.files.filter((file) => layers.has(file.source)).map((file) => file.path);
}
