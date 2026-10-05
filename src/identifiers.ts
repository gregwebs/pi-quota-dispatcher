/**
 * The three validated configuration identifiers, as compile-time newtypes.
 *
 * A configuration names an agent (`agents` key), a model
 * (`provider/modelId`) and a skill (`skills` key), and every one of them
 * arrives from JSON as a plain string. `src/config.ts` validates each at its
 * seam, and this module is where that validation lives and where a successful
 * check produces the branded value the rest of the code threads through fields,
 * tables and function arguments.
 *
 * The encoding is the standard TypeScript nominal-typing idiom: a value is
 * `string & OpaqueTag<tag>`, where the tag is a `unique symbol` declared but
 * never emitted and the tag class's field is `private`, so no value can be
 * produced by structural construction. There is no runtime class, symbol or
 * wrapper — the brands are erased, and the guarantee is compile-time only: a
 * `ModelId` cannot be passed where an `AgentName` is expected, and a raw
 * `string` cannot populate a branded field.
 *
 * A brand proves spelling and nothing else. `parseModelId` checks the id
 * contains a `/`; it does not check the registry knows the model, and the
 * runtime membership guard (`Object.hasOwn`) is still needed wherever a
 * branded key indexes a table. See docs/adr/0018-config-identifiers-use-newtypes.md.
 */

declare const opaqueTag: unique symbol;

declare class OpaqueTag<S extends symbol> {
  private [opaqueTag]: S;
}

type Opaque<T, S extends symbol> = T & OpaqueTag<S>;

declare const agentNameTag: unique symbol;
declare const modelIdTag: unique symbol;
declare const skillNameTag: unique symbol;

/** The name pi spawns an agent under, and the key a route is stored by. */
export type AgentName = Opaque<string, typeof agentNameTag>;

/** A qualified `provider/modelId` string, the way pi and a candidate name one. */
export type ModelId = Opaque<string, typeof modelIdTag>;

/** The name an explicit `/skill:<name>` invocation names. */
export type SkillName = Opaque<string, typeof skillNameTag>;

/**
 * The result of a checked parse: the branded value, or the sentence that
 * rejects the raw spelling. A rejection is a whole clause so a caller can
 * splice it into its own warning; the caller that wants different wording does
 * its own check and never sees this one.
 */
export type Parsed<T> = { value: T } | { rejection: string };

/**
 * Why `name` cannot be a route key, or `undefined` when it can.
 *
 * A route is keyed by the name pi spawns an agent under, and a name is a file:
 * the path for a route the agent dir does not define — the one `/agents` would
 * create — is `<agentDir>/<name>.md`. So the only guarantee the seam owes is
 * that a name is a single path segment. The charset and the case are pi's, not
 * ours, and a name pi can spawn is a name a route may key — `Plan`, `Explore`,
 * `9lives`, `v1.2`, `snake_case`, `Code Reviewer`, `a:b`.
 *
 * The name must also be usable as an object key, so one of `Object.prototype`'s
 * own names is refused: `constructor` is a valid filename, but a route table
 * keyed by it reads back a phantom value under any unguarded lookup, so it is
 * refused at the seam rather than each read having to remember `Object.hasOwn`.
 *
 * Two keys that differ only by case are distinct here and may name one file on
 * a case-insensitive filesystem. That is the OS's business, and the seam stays
 * filesystem-agnostic: resolution matches pi-visible names exactly, so such a
 * filesystem never sees a route written through a case-folded path.
 */
export function agentNameRejection(name: string): string | undefined {
  if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    return `agent ${JSON.stringify(name)} is not a valid agent name (a name is also a filename, so it must be a single path segment: not empty, not "." or "..", and with no "/", "\\" or NUL character)`;
  }
  if (name in Object.prototype) {
    return `agent "${name}" shadows Object.prototype and is not manageable`;
  }
  return undefined;
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

/**
 * Why `skill` names no invocable skill, or `undefined` when it does.
 *
 * The skill is named the way pi splits an explicit invocation — everything
 * after `/skill:` up to the first space — so a name that is empty or holds a
 * space can never be invoked, and a binding for it could never fire. That is
 * the only rule on the skill: pi loads a skill whose name breaks the Agent
 * Skills grammar (it warns and keeps it), so a stricter rule here would refuse
 * a skill the user can run. `__proto__` and `constructor` are deliberately
 * admitted; `bindSkill` inserts with `Object.defineProperty` and lookup uses
 * `Object.hasOwn`, so a prototype name is a usable own key here.
 */
export function skillNameRejection(skill: string): string | undefined {
  if (skill === "" || skill.includes(" ")) {
    return `skill ${JSON.stringify(skill)} names no skill (an explicit invocation names a skill up to the first space)`;
  }
  return undefined;
}

export function parseAgentName(value: string): Parsed<AgentName> {
  const rejection = agentNameRejection(value);
  return rejection === undefined ? { value: value as AgentName } : { rejection };
}

export function parseModelId(value: string): Parsed<ModelId> {
  const rejection = modelIdRejection(value);
  return rejection === undefined ? { value: value as ModelId } : { rejection };
}

export function parseSkillName(value: string): Parsed<SkillName> {
  const rejection = skillNameRejection(value);
  return rejection === undefined ? { value: value as SkillName } : { rejection };
}
