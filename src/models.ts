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
 * dropped **alternate** is skipped, leaving the alternates behind it eligible.
 * An unreadable rail is *unknown* instead, and unknown holds (see `decide` in
 * `index.ts`); conflating the two would either guess past a model that cannot
 * be spawned or hold an agent over a quota reading that merely failed.
 *
 * This module is deliberately free of the pi runtime. The lookup is a parameter
 * and the registry is a structural type, so the check is exercised without a
 * registry, a session or a terminal.
 */
import type { AgentRoute, DispatcherConfig } from "./config.ts";

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
   * agent is assigned its primary with no readability check.
   */
  config: DispatcherConfig;
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
   * One line per unresolvable candidate — one per occurrence, never deduped by
   * model id, because the reader has to fix every place the id is written. In a
   * fixed order: agents by name, and within an agent the primary before its
   * alternates in priority order.
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
 * value is for `/quota-dispatch`, which prints them in its provenance block.
 *
 * Without a lookup the check is skipped silently and `config` comes back
 * unchanged, which is how a pi with no registry is handled.
 */
export function checkModels(
  config: DispatcherConfig,
  lookup: ModelLookup | undefined,
  warn: (message: string) => void = console.error,
): ModelCheckResult {
  if (!lookup) return { config, held: {}, warnings: [] };

  const held: Record<string, string> = {};
  const warnings: string[] = [];

  /**
   * Whether `model` resolves, warning once and recording the line when it does
   * not. A model with no `/` cannot name a pi model at all, so it is a miss
   * without being put to the lookup; the config seam already rejects those, so
   * this is the belt-and-braces path rather than a second wording.
   */
  const resolves = (dotted: string, model: string): boolean => {
    const slash = model.indexOf("/");
    if (slash !== -1 && lookup(model.slice(0, slash), model.slice(slash + 1))) return true;

    const line = `${dotted}: this pi does not know model ${model} — a newer pi may`;
    try {
      warn(line);
    } catch {
      // Warning sinks are callers' code; a throwing one must not sink the
      // check. The line is still returned for `/quota-dispatch` to print.
    }
    warnings.push(line);
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
    // warning is the one in the config the user wrote, before any dropping.
    const alternates = route.alternates.filter((candidate, index) =>
      resolves(`agents.${agent}.alternates[${index}].model`, candidate.model),
    );
    agents[agent] = {
      primary: { ...route.primary },
      alternates: alternates.map((candidate) => ({ ...candidate })),
    };
  }

  return { config: { ...config, agents }, held, warnings };
}
