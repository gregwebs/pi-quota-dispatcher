# Configuration identifiers are validated newtypes

## Context

A configuration names an agent (`agents` key), a model (`provider/modelId`) and
a skill (`skills` key), and every one of them arrives from JSON as a string.
`src/config.ts` validates each at the seam, and the three validations are
genuinely different: an agent name must be a single path segment that does not
shadow `Object.prototype`, a model id must contain `/`, and a skill name must be
one an explicit `/skill:` invocation could produce.

[ADR 0017](0017-config-identifiers-stay-plain-strings.md) asked whether those
validated identifiers should carry distinct types, and declined. The benefit was
real — `agentKey(modelId)` would fail to compile — but the spike measured the
cost as 257 compiler diagnostics across twelve test and fixture files, and the
decision was that the tests would pay for a compile-time-only guarantee every
time someone read them. It adopted named-argument records and factories instead.

Issue #74 revisits that trade: it accepts the migration cost deliberately, to
establish the newtype pattern for future code rather than to answer a defect.
This ADR is the decision in force, and it supersedes 0017. The old spike
measurements remain in 0017 as the historical record.

The two rules from `CODING_STANDARDS.md` that meet here are "after data is
validated it should be given a new type, even if the underlying type is still
string" and "avoid using the same type multiple times in a row for function
arguments". Records and factories answered the second rule at the call site;
this decision answers the first, and it catches the transposition *inside* a
record that a named-argument call cannot see:

```ts
const agent: AgentName = /* checked producer */;
const model: ModelId = /* checked producer */;

agentKey(agent); // accepted
agentKey(model); // compile error
```

The strings themselves are unchanged; only what the compiler will accept for
them changes.

## Decision

Agent names, qualified model ids and skill names are opaque types, produced only
by checked parsers. `AgentDir` is not among them — see below.

```ts
declare const opaqueTag: unique symbol;

declare class OpaqueTag<S extends symbol> {
  private [opaqueTag]: S;
}

type Opaque<T, S extends symbol> = T & OpaqueTag<S>;

declare const agentNameTag: unique symbol;
declare const modelIdTag: unique symbol;
declare const skillNameTag: unique symbol;

export type AgentName = Opaque<string, typeof agentNameTag>;
export type ModelId = Opaque<string, typeof modelIdTag>;
export type SkillName = Opaque<string, typeof skillNameTag>;
```

The tag class's field is `private`, so the opaque type cannot be produced by
structural construction, and the tags are erased — there is no runtime class,
symbol or wrapper. This is the idiom from
[microsoft/TypeScript#4895](https://github.com/microsoft/TypeScript/issues/4895#issuecomment-401067935),
and it is the same strength as 0017's spike encoding; the spike's shared symbol
with a per-role literal tag was a marginally weaker spelling of one idea.

The encoding, the tags and the raw validation rules live in `src/identifiers.ts`
and nothing else constructs a brand. Each role has one checked producer:

```ts
type Parsed<T> = { value: T } | { rejection: string };

export function parseAgentName(value: string): Parsed<AgentName>;
export function parseModelId(value: string): Parsed<ModelId>;
export function parseSkillName(value: string): Parsed<SkillName>;
```

The producers take a `string`, so raw input is their natural argument rather than
something asserted into a brand first, and a successful check is the only place
a `value as AgentName`-style assertion appears. `src/config.ts` keeps exporting
`agentNameRejection` and `modelIdRejection` as the compatibility surface the
startup snippet and warnings already use; they are the rejection half of the
same producers.

### Raw input versus validated domain values

The brands mark validated configuration, not everything spelled the same way:

```text
JSON / programmatic base keys
          │ raw strings
          ▼
    checked producers
          │ branded identifiers
          ▼
 effective configuration
          │ brands retained in fields and table keys
          ▼
 decisions / skill selection / writes

agent-file frontmatter ──▶ raw discovery / diagnostic evidence
                                  │
                                  └─ checked conversion when used
                                     as a validated identifier
```

Configuration parsing validates and brands. Discovery and reporting stay raw: a
discovered pi name can be valid for discovery but invalid as a configuration
agent name, and a malformed model must remain representable in a warning or a
conflict comparison. `NamedAgentFile.name`/`.model`/`.thinking`,
`AgentFileSelection.model`, `ModelMiss.model`, `DroppedAlternate.model`, a held
model's evidence and `AgentWrite.base` are all still `string`. Where a raw value
is later used as a validated identifier — a frontmatter model on its way to a
registry lookup, a discovered name on its way into a startup snippet — it goes
through the checked producer first.

The effective `DispatcherConfig` tables are branded
(`Record<AgentName, AgentRoute>`, `Record<ModelId, ModelDefault>`,
`Record<SkillName, AgentName>`), and so is `Candidate.model`.

### The programmatic base is a separate contract

`mergeConfig` used to take a `DispatcherConfig`, which pretended a caller-built
base was already validated while the implementation re-checked its table keys
but trusted its candidate fields. Those are two different contracts, so the base
is now typed as one:

```ts
export type ConfigBase = Omit<DispatcherConfig, "agents" | "models" | "skills"> & {
  agents: Record<string, AgentRoute>;
  models: Record<string, ModelDefault>;
  skills: Record<string, string>;
};
```

A raw key and a brand are both accepted as parser *input*, which is honest about
what `mergeConfig` does with a base: it validates the keys through the checked
producers and then clones the candidates. The alternative — re-parsing every base
candidate, or widening the whole base to `unknown` — would change the programmatic
contract beyond this migration. `defaultConfig()` still returns a
`DispatcherConfig` and is assignable to `ConfigBase`.

### Recovering a key brand from a validated table

Branding a table key means `Object.keys`/`Object.entries` hand the brand back as
`string`, so the effective tables need the brand recovered where they are
iterated. That recovery is localized in `src/validated-keys.ts`:

```ts
validatedKeys(table);    // branded key[]
validatedEntries(table); // [branded key, value][]
```

Trust contract: every own enumerable key was installed using the corresponding
checked identifier producer. The helpers do not validate, and a structural type
is not an exact-object proof; they are deliberately not a general-purpose
"type-safe `Object.keys`". They cover the three identifier brands and are used in
provenance initialization, the configuration description, model checking,
agent-file checking and dispatch iteration. Raw base tables and JSON layers keep
plain `Object.entries` and validate each key there.

Recovery is not membership. A branded key does not prove the table holds an
entry — this repo does not enable `noUncheckedIndexedAccess` — so the
`Object.hasOwn` guards stay, exactly where 0017 argued they must.

Prototype-named skills are preserved deliberately. `SkillName` admits
`__proto__` and `constructor`, because pi may load such a skill and this seam
refuses no name pi can invoke; `bindSkill` installs with `Object.defineProperty`
and lookup uses `Object.hasOwn`.

## Guarantees and non-guarantees

A brand guarantees spelling and role. It makes a raw string invalid for a
branded field, and it makes `AgentName`, `ModelId` and `SkillName`
interchangeable with nothing but themselves, so `agentKey(modelId)` and
`skillKey(agentName)` are compile errors and a wrong-role table index will not
compile.

A brand proves nothing else. It is erased at run time and is the same string, so
it does not establish that a file exists, that a route is configured, that a
registry knows the model, or that a table holds an entry. Those remain runtime
checks. The guarantee is compile-time only, and `test/identifiers.typecheck.ts`
is the regression fixture that fails `npm run typecheck` if any of it stops
holding.

## Considered options

**Stay plain strings (ADR 0017).** Superseded. The cost it declined is now
accepted, and the narrow benefit — role separation that survives inside a
record — is the point of the migration rather than a side effect.

**Brand only `ModelId`, or brand at the config seam only.** Both were measured
in 0017's spike (142 and 174 diagnostics) and both were rejected then and now:
branding one role leaves the others interchangeable, and a seam-only brand is
exactly what the consumers cannot name, so the churn does not shrink, it moves.

**Re-key the tables as `Map<AgentName, …>`.** A `Map` keeps the key brand
through iteration and demands one from `get`/`has`; it would remove the
key-recovery half of the cost. It is declined here for two reasons. It is not a
newtype and does not answer this issue, and it is a runtime-representation
change — serialization, merge and every `.get`/`.has` call site — that this
migration is explicitly scoped to avoid. The object representation and the
localized recovery are what the decision accepts.

**Brand `AgentDir` (and other filesystem paths).** Declined on different
grounds, still. A path brand can keep two path *roles* apart, but it cannot
establish existence, containment or canonical identity: `join`, `resolve` and
`realpath` return ordinary strings, existence changes over time, and a symlink's
target is only known at read time. Containment is already the runtime `isInside`
check. Pi's root data directory and the `agents` child are two roles one brand
would conflate.

**Brand raw discovery and diagnostic evidence.** Declined. Discovery is
deliberately permissive — a discovered name can be config-invalid, and a
malformed model must be reportable — so branding it would either force a
permissive escape hatch or make the evidence unrepresentable.

## Consequences

The identifier vocabulary is now half compile-checked and half raw, by design:
the boundary is "validated configuration" on one side and "untrusted evidence"
on the other. New same-typed seams should still reach for a record or a factory
first, as 0017 adopted, and reach for a brand when the value is a validated
domain identifier that flows across a module boundary.

The pattern is established for future code: a new validated identifier is a new
opaque type plus a checked producer in `identifiers.ts`, and a new validated
table recovers its key brand through `validated-keys.ts`. The migration cost is
paid once, in the test fixtures; the runtime behaviour, JSON formats,
identifier validation, warning text and ordering are unchanged.
