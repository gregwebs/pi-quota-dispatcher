/**
 * Boot-time resolution of the models a config names against the pi that is
 * running.
 *
 * The dispatcher writes a `model:` line into an agent file, and pi then has to
 * spawn that model. A config outlives the pi that validated it — an id renamed
 * upstream, a typo such as a transposed `gpt-sol-6`, a config copied from
 * another machine — and the failure mode is the worst one available here: an
 * agent file is silently rewritten to a model no spawn can use. So every
 * configured candidate is resolved at boot, before any decision is made,
 * through the running pi's own registry.
 *
 * The asymmetry is the design, not an oversight. A registry miss is *known
 * bad*, so the model is dropped from consideration: an agent whose **primary**
 * was dropped is held — its file is left exactly as the user left it — and a
 * dropped **alternate** leaves the alternates behind it eligible. An unreadable
 * rail is *unknown* instead, and unknown holds (see `decide` in `index.ts`);
 * conflating the two would either guess past a model that cannot be spawned or
 * hold an agent over a quota reading that merely failed.
 *
 * This module is deliberately free of the pi runtime. The lookup is a parameter
 * and the registry is a structural type, so the check is exercised without a
 * registry, a session or a terminal.
 */
import type { AgentRoute, Candidate, DispatcherConfig } from "./config.ts";

/**
 * The one thing this extension needs from the running pi's model registry:
 * whether a provider/model pair resolves to a model this pi can spawn.
 *
 * Structural rather than pi's own `ModelRegistry` so the check can be driven
 * from a test without one, and so a pi that grew the field late still
 * type-checks. `find` answers with the model or `undefined`, which is why the
 * return is `unknown` here: the check only asks whether an answer came back.
 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
}

/**
 * Whether the pi that is running can spawn `provider/modelId`.
 *
 * A parameter everywhere it is used, so that "the model is not known" and "this
 * config is wrong" stay separable and neither decision needs a registry.
 */
export type ModelLookup = (provider: string, modelId: string) => boolean;

/**
 * One configured candidate this pi cannot spawn, with the config key the warning
 * named it by.
 *
 * The pair is the whole of a miss: the id that has to resolve somewhere else,
 * and the line the reader has to go and edit. `ModelCheckResult` keeps every one
 * of them in the order they were found, because the startup warning lists each
 * occurrence whether or not a decision ever mentions it.
 */
export interface ModelMiss {
  key: string;
  model: string;
}

/**
 * One alternate dropped because this pi cannot spawn it: the same two strings a
 * `ModelMiss` is, under the name the decision knows them by.
 *
 * Carried out of the check rather than only reported, because a route whose
 * alternates were all dropped reaches `decide` looking exactly like one the user
 * pinned with `[]` — and those two need opposite explanations. The key rides
 * along so the decision can say it in the warning's own words, which name the
 * line the reader has to go and fix; it is a provenance key,
 * `agents.<name>.alternates[<n>].model`, indexed in the alternates list as the
 * user wrote it — before any dropping, so the key still names the right element
 * of a route that kept some of its list.
 */
export type DroppedAlternate = ModelMiss;

/**
 * The one wording for a model this pi does not know, shared by the boot warning
 * and by the decision note that explains a route left with no alternates.
 *
 * Two spellings of one fact drift, and the reader is meant to recognise the
 * warning's line in the report: naming the dotted config key is what makes it an
 * instruction rather than a diagnosis.
 */
export function unknownModelNote(key: string, model: string): string {
  return `${key}: this pi does not know model ${model} — a newer pi may`;
}

/**
 * Where a candidate resolved, how it did not, and what that costs.
 *
 * `config` is a value, not a mutation: the routes the caller passed are left
 * untouched, so a config that has been checked and a config that has not are
 * distinguishable by identity rather than by a flag on the route.
 */
export interface ModelCheckResult {
  /**
   * The same config with every candidate this pi cannot spawn dropped from
   * consideration: an unknown alternate is removed from its route's list in the
   * returned config (the caller's is untouched), and an unknown primary leaves
   * its agent in the table — held, not removed. Removing the agent would make a
   * configured install look unconfigured and would lose the only thing worth
   * reporting, which is that this agent was deliberately left alone and why.
   *
   * A route whose alternates are all dropped therefore ends up with `[]`, and
   * the policy already treats an empty list as pinned to the primary, so such an
   * agent is assigned its primary with no readability check. Which is why
   * `droppedAlternates` travels with this: an empty list arrived at from the
   * config and an empty list arrived at by dropping call for opposite
   * explanations, and only the check knows which one this is.
   */
  config: DispatcherConfig;
  /**
   * The alternates that were dropped, by agent name, each carrying the key the
   * warning named it by. An agent absent from this record had every candidate it
   * wrote kept; an agent whose route is absent from `config` altogether was
   * never in the table to begin with.
   *
   * The whole set is kept, not only the routes left with `[]`: the decision is
   * free to ignore it, and "what did boot drop from this route?" is a question
   * only this step can answer.
   */
  droppedAlternates: Record<string, DroppedAlternate[]>;
  /**
   * The agents to hold, by agent name, each carrying the primary model id this
   * pi does not know.
   *
   * A primary that cannot be spawned is *known bad*, so the agent is held
   * rather than resolved: no quota reading could change the answer, and the
   * file must stay as the user left it. An agent absent from this record is
   * decided the ordinary way.
   */
  held: Record<string, string>;
  /**
   * Every candidate this pi cannot spawn, one per occurrence, never deduped by
   * model id, because the reader has to fix every place the id is written. In a
   * fixed order: agents by name, and within an agent the primary before its
   * alternates in priority order.
   *
   * The occurrences `warnings` renders, kept as data as well because the `key`
   * is the provenance key a layer records against: it is what resolves the miss
   * to the config file to edit, `loaded.sources[miss.key]`. A list of already
   * rendered sentences cannot give that key back without parsing its own
   * wording.
   */
  misses: ModelMiss[];
  /**
   * One line per unresolvable candidate, each `misses` entry through
   * `unknownModelNote`, in the same order.
   */
  warnings: string[];
}

/**
 * The running pi's registry as a `ModelLookup`, or `undefined` when this pi has
 * none.
 *
 * Feature-detected rather than required. The check is a courtesy to a user whose
 * config names something the running pi cannot spawn; a pi that cannot answer —
 * an older build, or a context assembled without a registry — must not be the
 * reason dispatch stops working, and it must not be asked to answer. Silence is
 * the whole contract of the `undefined` return: no warning, no hold, every other
 * behaviour unchanged.
 */
export function modelLookup(ctx: { modelRegistry?: ModelRegistryLike }): ModelLookup | undefined {
  const registry = ctx?.modelRegistry;
  // Feature-detected rather than assumed: an older pi, or a context assembled
  // without a registry, must be left alone rather than made to answer. `find`
  // is checked too, so a registry that does not carry it (`undefined`, or a
  // shape from another pi version) is "no registry" as well.
  if (!registry || typeof registry.find !== "function") return undefined;
  return (provider, modelId) => registry.find(provider, modelId) !== undefined;
}

/**
 * Resolve every candidate in `config` against `lookup`, and report each one it
 * does not know.
 *
 * The provider is the text before the first `/` and the model id is the text
 * after it, which is the split pi's own registry is keyed by: `find(provider,
 * modelId)`. A model with no `/` cannot name a pi model at all — the config seam
 * already rejects those — so it is unresolvable without being put to the lookup.
 *
 * A miss warns once per occurrence, in the wording the reader can act on: the
 * id is not *invalid*, it is unknown *to this pi*, and the pi a user upgrades to
 * may well know it.
 *
 *   `agents.planner.primary.model: this pi does not know model X — a newer pi may`
 *
 * `warn` is called as each miss is found and the same lines come back in
 * `warnings`, the way `loadConfig` reports: the sink is for the log, the return
 * value is for `/quota-dispatch`, which prints them in its provenance block. The
 * occurrences come back as `misses` too, because each miss's key is what
 * resolves to the config file to edit — data a list of finished sentences no
 * longer carries.
 *
 * Without a lookup the check is skipped silently and `config` comes back
 * unchanged, which is how a pi with no registry is handled.
 */
export function checkModels(
  config: DispatcherConfig,
  lookup: ModelLookup | undefined,
  warn: (message: string) => void = console.error,
): ModelCheckResult {
  if (!lookup) return { config, held: {}, droppedAlternates: {}, misses: [], warnings: [] };

  const held: Record<string, string> = {};
  const droppedAlternates: Record<string, DroppedAlternate[]> = {};
  const misses: ModelMiss[] = [];

  /**
   * Whether `model` resolves, warning once and recording the miss when it does
   * not. A model with no `/` cannot name a pi model at all, so it is a miss
   * without being put to the lookup; the config seam already rejects those, so
   * this is the belt-and-braces path rather than a second wording.
   */
  const resolves = (dotted: string, model: string): boolean => {
    const slash = model.indexOf("/");
    if (slash !== -1 && lookup(model.slice(0, slash), model.slice(slash + 1))) return true;

    const line = unknownModelNote(dotted, model);
    try {
      warn(line);
    } catch {
      // Warning sinks are callers' code; a throwing one must not sink the
      // check. The line is still returned for `/quota-dispatch` to print.
    }
    misses.push({ key: dotted, model });
    return false;
  };

  // Agents by name, so the warnings and the rebuilt table share one fixed
  // order. Every configured candidate is checked, including the alternates of
  // an agent whose primary is unknown — the user has to fix every occurrence.
  const agents: Record<string, AgentRoute> = {};
  for (const agent of Object.keys(config.agents).sort()) {
    const route = config.agents[agent];
    if (!resolves(`agents.${agent}.primary.model`, route.primary.model)) {
      held[agent] = route.primary.model;
    }
    // The alternates after a dropped one keep their order; the index in the
    // warning is the one in the config the user wrote, before any dropping, and
    // it is kept so the decision can name the same key the warning did.
    const alternates: Candidate[] = [];
    const dropped: DroppedAlternate[] = [];
    for (const [index, candidate] of route.alternates.entries()) {
      const key = `agents.${agent}.alternates[${index}].model`;
      if (resolves(key, candidate.model)) alternates.push({ ...candidate });
      else dropped.push({ key, model: candidate.model });
    }
    if (dropped.length) droppedAlternates[agent] = dropped;
    agents[agent] = {
      // The route's own fields ride through untouched: the check is about
      // candidate model ids, and a route default that fell off here would stop
      // being written for every agent of the session, leaving each file on
      // whatever level a past pass happened to leave there.
      ...(route.thinking !== undefined ? { thinking: route.thinking } : {}),
      primary: { ...route.primary },
      alternates,
    };
  }

  return {
    config: { ...config, agents },
    held,
    droppedAlternates,
    misses,
    warnings: misses.map((miss) => unknownModelNote(miss.key, miss.model)),
  };
}
