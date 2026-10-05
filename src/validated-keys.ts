/**
 * Recovering branded keys from a table that was built through the checked
 * producers.
 *
 * The effective `agents`, `models` and `skills` tables are plain objects, so
 * `Object.keys` and `Object.entries` hand back `string` keys and throw the key
 * brand away. Branding the key at the parse seam and then losing it in every
 * consumer would leave the vocabulary half-branded; these two helpers are the
 * one place the brand is recovered, so the assertions do not scatter.
 *
 * Trust contract: every own enumerable key was installed using the
 * corresponding checked identifier producer (`parseAgentName`, `parseModelId`,
 * `parseSkillName`). These helpers do not validate anything, and a structural
 * TypeScript type is not an exact-object proof. They are deliberately not a
 * general-purpose "type-safe `Object.keys`": they cover the three identifier
 * brands and nothing else.
 *
 * Recovery is not membership. A branded key does not prove the table holds an
 * entry — this repo does not enable `noUncheckedIndexedAccess` — so an
 * `Object.hasOwn` guard is still required wherever absence is possible.
 */
import type { AgentName, ModelId, SkillName } from "./identifiers.ts";

/** A key brand one of the three validated tables can carry. */
export type BrandedKey = AgentName | ModelId | SkillName;

/** The own enumerable keys of a validated table, with their brand recovered. */
export function validatedKeys<K extends BrandedKey, V>(table: Record<K, V>): K[] {
  return Object.keys(table) as K[];
}

/** The own enumerable entries of a validated table, with their key brand recovered. */
export function validatedEntries<K extends BrandedKey, V>(table: Record<K, V>): Array<[K, V]> {
  return Object.entries(table) as Array<[K, V]>;
}
