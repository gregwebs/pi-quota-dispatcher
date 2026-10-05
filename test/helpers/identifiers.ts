/**
 * Checked fixture helpers for the configuration identifier newtypes.
 *
 * After issue #74's migration, the effective `agents`, `models` and `skills`
 * tables and every `Candidate.model` carry a brand. A test fixture is still
 * written from readable literals, so these helpers run each literal through the
 * same checked producer the loader uses and throw — loudly and by name — when a
 * fixture that claims to be valid is not. They are the one place a test may
 * recover a brand, and the plan for this migration forbids blanket
 * `as AgentName` / `as ModelId` / `as DispatcherConfig` casts in the tests
 * themselves.
 *
 * A fixture that is *deliberately* invalid does not come through here: it is a
 * local, explicitly named bypass at the one test that exercises a violated
 * invariant.
 */
import type { AgentRoute, Candidate, ModelDefault, Rail, ThinkingLevel } from "../../src/config.ts";
import type { AgentName, ModelId, Parsed, SkillName } from "../../src/identifiers.ts";
import { parseAgentName, parseModelId, parseSkillName } from "../../src/identifiers.ts";

function checked<T>(what: string, parsed: Parsed<T>): T {
  if ("rejection" in parsed) throw new Error(`invalid test fixture ${what}: ${parsed.rejection}`);
  return parsed.value;
}

export function agentName(value: string): AgentName {
  return checked(`agent name ${JSON.stringify(value)}`, parseAgentName(value));
}

export function modelId(value: string): ModelId {
  return checked(`model id ${JSON.stringify(value)}`, parseModelId(value));
}

export function skillName(value: string): SkillName {
  return checked(`skill name ${JSON.stringify(value)}`, parseSkillName(value));
}

/** One model on one rail, from a readable literal. */
export function candidateOf(input: { model: string; rail: Rail; thinking?: ThinkingLevel }): Candidate {
  return {
    model: modelId(input.model),
    rail: input.rail,
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
  };
}

/** An agent route, from a readable literal. */
export function routeOf(input: {
  thinking?: ThinkingLevel;
  primary: { model: string; rail: Rail; thinking?: ThinkingLevel };
  alternates?: Array<{ model: string; rail: Rail; thinking?: ThinkingLevel }>;
}): AgentRoute {
  return {
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    primary: candidateOf(input.primary),
    alternates: (input.alternates ?? []).map(candidateOf),
  };
}

/**
 * Brand the keys of an agent table. The routes are already validated values
 * (built with `routeOf` or a local candidate helper); only the keys need
 * recovering, and every one is checked so a bad fixture fails by name.
 */
export function agentTable(routes: Record<string, AgentRoute>): Record<AgentName, AgentRoute> {
  return Object.fromEntries(
    Object.entries(routes).map(([name, route]) => [agentName(name), route]),
  ) as Record<AgentName, AgentRoute>;
}

export function modelTable(entries: Record<string, ModelDefault>): Record<ModelId, ModelDefault> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [modelId(id), entry]),
  ) as Record<ModelId, ModelDefault>;
}

/** Brand both halves of a `skills` table, from readable literals. */
export function skillTable(bindings: Record<string, string>): Record<SkillName, AgentName> {
  return Object.fromEntries(
    Object.entries(bindings).map(([skill, route]) => [skillName(skill), agentName(route)]),
  ) as Record<SkillName, AgentName>;
}
