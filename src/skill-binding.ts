/**
 * Skill bindings: an explicit `/skill:<name> [args]` selects, for the session,
 * the model and thinking level its bound agent route's *file* states right now.
 *
 * The file is the authority, not the route. It is what a spawn of that agent
 * would run on, so the session and the agent share one preference — and it may
 * be stale after a hold or a hand edit, which is still the answer. Re-deciding
 * from quota instead would put a vendor round trip in front of every skill, and
 * keeping the file current is the dispatcher poll's job. So this path reads no
 * quota, refreshes no credential, evaluates no route and writes no file. See
 * docs/adr/0014-skill-bindings-read-the-agent-file.md.
 *
 * The pi runtime and the agent dir arrive in `SkillBindingDeps`, so the whole
 * decision runs against fakes, and the frontmatter reader stays in `index.ts`,
 * which imports this module rather than the other way round.
 */
import {
  type DispatcherConfig,
  type SkillBinding,
  type ThinkingLevel,
  THINKING_LEVEL_LIST,
  errorText,
  isThinkingLevel,
} from "./config.ts";
import { splitModelId, unknownModelClause } from "./models.ts";

/** pi's own prefix for an explicit skill command (`AgentSession._expandSkillCommand`). */
const SKILL_COMMAND = "/skill:";

/**
 * The skill an explicit `/skill:<name> [args]` command names, or `undefined`.
 *
 * Split exactly as pi splits it before expanding — the text starts with
 * `/skill:` and the name runs to the first space — so a binding fires for
 * precisely the skill pi is about to run. A prompt that only mentions a skill,
 * and a skill the model loads by itself, never arrive here as one.
 */
export function explicitSkill(text: string): string | undefined {
  if (!text.startsWith(SKILL_COMMAND)) return undefined;
  const space = text.indexOf(" ");
  const skill = space === -1 ? text.slice(SKILL_COMMAND.length) : text.slice(SKILL_COMMAND.length, space);
  return skill === "" ? undefined : skill;
}

/** What the bound agent's file currently selects, or why it could not be read. */
export type AgentFileSelection =
  /** Raw decoded frontmatter values; an absent key is an absent field. */
  | { kind: "file"; model?: string; thinking?: string }
  /** `why` is a finished clause, spliced after "but". */
  | { kind: "unavailable"; why: string };

/**
 * The session selection this feature drives. Structural, never pi's own types,
 * so the decision runs against a fake; `Model` is whatever the registry hands
 * back and `setModel` takes.
 */
export interface SessionSelection<Model> {
  /**
   * The model the session is on now — what a failed application restores.
   *
   * pi returns the *same* model object while the session stays on the same
   * model, which is what lets a caller compare this value against one read
   * before a switch to tell whether the session actually moved.
   */
  getModel(): Model | undefined;
  findModel(provider: string, modelId: string): Model | undefined;
  /** `false` when the model's provider has no authentication configured. */
  setModel(model: Model): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface SkillBindingDeps<Model> {
  config: DispatcherConfig;
  /** Reads the bound agent's definition file as it stands right now. */
  readSelection: (agent: string) => Promise<AgentFileSelection>;
  selection: SessionSelection<Model>;
  notify: (message: string, type: "info" | "warning") => void;
}

/**
 * Where the session's thinking level ended up after a successful switch.
 *
 * `effective` is read back from the session, never assumed: pi clamps a level to
 * what the model supports, so the level asked for and the level running can
 * differ, and a notice that named only the request would be false about the
 * session. `asked`/`previous` are what was requested, kept so a clamp can be
 * said out loud rather than hidden.
 */
type ThinkingResult =
  | { kind: "stated"; asked: ThinkingLevel; effective: ThinkingLevel }
  | { kind: "retained"; previous: ThinkingLevel; effective: ThinkingLevel };

/** What one bound invocation came to: the facts each message is rendered from. */
type SelectionOutcome =
  | { kind: "selected"; model: string; thinking: ThinkingResult }
  | { kind: "unconfigured" }
  | { kind: "unavailable"; why: string }
  | { kind: "no-model" }
  | { kind: "malformed-thinking"; stated: string }
  | { kind: "unknown-model"; model: string }
  /**
   * `restored` says the session holds its previous selection — either because it
   * never moved, or because the put-back succeeded.
   */
  | { kind: "not-selected"; model: string; detail: string; restored: boolean }
  | { kind: "failed"; detail: string };

/** What `setModel` answering `false` means, per pi's own contract for it. */
const NO_AUTH = "no authentication is configured for the provider";

/**
 * The whole feature at its one entry point: raw input text in, the session's
 * selection — and one notice — out. Resolves `undefined` whatever happens, so
 * the input always continues to pi unchanged and the skill runs.
 *
 * Unbound input returns before anything is read or said: only a configured
 * binding may touch the session or the screen.
 */
export async function applySkillBinding<Model>(deps: SkillBindingDeps<Model>, text: string): Promise<void> {
  const skill = explicitSkill(text);
  // Own property only, so a skill named `constructor` cannot read an inherited
  // value as its binding.
  if (skill === undefined || !Object.hasOwn(deps.config.skills, skill)) return;
  const binding: SkillBinding = { skill, route: deps.config.skills[skill] };

  let outcome: SelectionOutcome;
  try {
    outcome = await selectFromFile(deps, binding.route);
  } catch (err) {
    // The input path's one catch-all: a registry or a setter that throws must
    // not stop the skill, and the reader is owed the reason rather than silence.
    outcome = { kind: "failed", detail: errorText(err) };
  }

  const { message, type } = bindingNote(binding, outcome);
  try {
    deps.notify(message, type);
  } catch {
    // Notification sinks are callers' code; a throwing one must not stop the
    // skill, and the selection already stands or was never made.
  }
}

async function selectFromFile<Model>(deps: SkillBindingDeps<Model>, route: string): Promise<SelectionOutcome> {
  if (!Object.hasOwn(deps.config.agents, route)) return { kind: "unconfigured" };

  const read = await deps.readSelection(route);
  if (read.kind === "unavailable") return read;

  // The whole selection is validated before the session is touched: a file that
  // cannot be applied in full is applied not at all, because a model with some
  // other level is a selection nobody stated.
  if (read.model === undefined) return { kind: "no-model" };
  let stated: ThinkingLevel | undefined;
  if (read.thinking !== undefined) {
    if (!isThinkingLevel(read.thinking)) return { kind: "malformed-thinking", stated: read.thinking };
    stated = read.thinking;
  }
  const model = findModel(deps.selection, read.model);
  if (model === undefined) return { kind: "unknown-model", model: read.model };

  // Read before the switch, for two reasons. pi's `setModel` re-derives the
  // level for the new model from its own settings, so a file that states no
  // level asks for the session's level to survive the switch rather than for
  // pi's default; and these two values are what a failed application puts back.
  const previousModel = deps.selection.getModel();
  const previousLevel = deps.selection.getThinkingLevel();

  /**
   * Which halves of the selection the session actually moved, read live.
   *
   * A fault is not proof the session stayed put: pi assigns the model and the
   * level before its later steps can fail, and it does not short-circuit a
   * re-selection of the model already in place. So each catch asks the session
   * rather than assuming, and `restore` writes only the halves that moved.
   */
  const movement = (): { model: boolean; level: boolean } => ({
    model: deps.selection.getModel() !== previousModel,
    level: deps.selection.getThinkingLevel() !== previousLevel,
  });

  let selected: boolean;
  try {
    selected = await deps.selection.setModel(model);
  } catch (err) {
    // A rejection is not proof the session did not move: pi assigns the model and
    // resets the level before its later steps can fail, and it does not
    // short-circuit a re-selection of the model already in place. So the session
    // counts as untouched only when *both* halves are where they were, and a
    // fault that moved the level alone is not answered by selecting the model the
    // session is already on — pi would reset the level again on the way.
    const restored = await restore(deps.selection, previousModel, previousLevel, movement());
    return { kind: "not-selected", model: read.model, detail: errorText(err), restored };
  }
  // `false` is pi's own answer that the provider has no authentication
  // configured, decided before any session state moves: nothing to restore.
  if (!selected) return { kind: "not-selected", model: read.model, detail: NO_AUTH, restored: true };

  // Only once the model is in place: a failed switch never applies a level meant
  // for another model, and pi clamps the level against the model it will run on.
  const asked = stated ?? previousLevel;
  try {
    deps.selection.setThinkingLevel(asked);
  } catch (err) {
    // The probe answers what moved; the model need not have.
    const restored = await restore(deps.selection, previousModel, previousLevel, movement());
    return { kind: "not-selected", model: read.model, detail: errorText(err), restored };
  }

  // Read the level back rather than assuming the request landed: pi clamps, so
  // the running level is not always the one asked for.
  const effective = deps.selection.getThinkingLevel();
  const thinking: ThinkingResult =
    stated === undefined
      ? { kind: "retained", previous: previousLevel, effective }
      : { kind: "stated", asked: stated, effective };
  return { kind: "selected", model: read.model, thinking };
}

/**
 * Put the session back where it was, as far as the API allows.
 *
 * `moved` says which halves the fault actually changed, so only those are
 * written: a level-only change is not answered by re-selecting the model the
 * session already holds, which would make pi reset the level again on the way.
 * The model goes first when it did move, because re-selecting it re-applies pi's
 * own level rule, and the level is then re-applied for that reason as well.
 *
 * A call with neither half moved writes nothing and answers `true`: the session
 * is already where it was asked to be.
 *
 * `true` means the session holds its previous selection again — never that the
 * session persisted it. Every way this can fail returns `false`: no previous
 * model to put back (an application that selected one cannot be undone, because
 * this API has no way to unset a model), a `setModel` that answers `false`
 * (pi's own "no authentication" answer), a `setModel` that throws, and a
 * `setThinkingLevel` that throws.
 */
async function restore<Model>(
  selection: SessionSelection<Model>,
  previousModel: Model | undefined,
  previousLevel: ThinkingLevel,
  moved: { model: boolean; level: boolean },
): Promise<boolean> {
  if (moved.model) {
    if (previousModel === undefined) return false;
    try {
      if (!(await selection.setModel(previousModel))) return false;
    } catch {
      return false;
    }
  }
  try {
    if (moved.model || moved.level) selection.setThinkingLevel(previousLevel);
    return true;
  } catch {
    return false;
  }
}

/**
 * The thinking half of the success notice.
 *
 * A clamped level is named, not hidden: the request came from the file or the
 * session and the answer came from pi, and reporting only one of them would make
 * the notice untrue about whichever it left out.
 */
function thinkingText(thinking: ThinkingResult): string {
  if (thinking.kind === "stated") {
    return thinking.effective === thinking.asked
      ? `thinking ${thinking.asked}`
      : `thinking ${thinking.asked}, clamped to ${thinking.effective} by pi`;
  }
  return thinking.effective === thinking.previous
    ? `thinking retained (${thinking.effective})`
    : `thinking retained (${thinking.effective}, clamped from ${thinking.previous})`;
}

/**
 * `provider/modelId` through the registry. Split the way `checkModels` splits a
 * configured id (`splitModelId`); an id with no `/` names no pi model.
 */
function findModel<Model>(selection: SessionSelection<Model>, model: string): Model | undefined {
  const split = splitModelId(model);
  return split === undefined ? undefined : selection.findModel(split.provider, split.modelId);
}

/**
 * The one rendering of every outcome. Each warning shares one opening, so the
 * reader always learns which skill and which route before the reason, and the
 * reasons cannot drift into different shapes.
 */
function bindingNote(binding: SkillBinding, outcome: SelectionOutcome): { message: string; type: "info" | "warning" } {
  const { skill, route } = binding;
  const bound = `Skill "${skill}" is bound to agent route "${route}"`;
  const but = (reason: string) => ({ message: `${bound}, but ${reason}`, type: "warning" as const });
  switch (outcome.kind) {
    case "selected":
      // "retained" says the level is the session's own, so a level the file never
      // stated is not reported as if it had.
      return {
        message: `Skill ${skill} → ${route}: ${outcome.model}, ${thinkingText(outcome.thinking)}`,
        type: "info",
      };
    case "unconfigured":
      return { message: `${bound}, which is not configured`, type: "warning" };
    case "unavailable":
      return but(outcome.why);
    case "no-model":
      return but("its file states no model");
    case "malformed-thinking":
      return but(`its file states thinking ${JSON.stringify(outcome.stated)}, which is not one of ${THINKING_LEVEL_LIST}`);
    case "unknown-model":
      return but(unknownModelClause(outcome.model));
    case "not-selected": {
      const reason = `its model ${outcome.model} could not be selected (${outcome.detail})`;
      return but(outcome.restored ? reason : `${reason} and the previous session selection could not be restored`);
    }
    case "failed":
      return but(`applying it failed (${outcome.detail})`);
  }
}
