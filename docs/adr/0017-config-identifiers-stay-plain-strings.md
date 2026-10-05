# Config identifiers stay plain strings

## Context

A configuration names an agent (`agents` key), a model (`provider/modelId`) and
a skill (`skills` key), and every one of them arrives from JSON as a string.
`src/config.ts` validates each at the seam: `agentNameRejection` refuses a name
that is not a single path segment or that shadows `Object.prototype`,
`modelIdRejection` refuses an id with no `/`, and `parseSkillBinding` refuses a
skill an explicit `/skill:` invocation could never name. After validation the
values are carried as `string` through the merged config, the decision, the
agent-file reader and the report.

`CODING_STANDARDS.md` asks for a new type after data is validated, even when the
underlying type is still a string, and separately warns against two same-typed
arguments in a row. Issue #57 asked whether a small set of newtypes
(`AgentName`, `ModelId`, `AgentDir`, `SkillName`) should pay for themselves
across this seam.

## Decision

The identifiers stay `string`. The validated-newtype rule is not applied here;
the two-same-typed-arguments rule is satisfied with named-argument records and
factories instead.

```
  config path
  ───────────
  JSON layer       ── parse ──▶  mergeConfig: agentNameRejection,  ──▶  agents: Record<string, AgentRoute>
   (string)                        modelIdRejection, parseSkillBinding     models: Record<string, ModelDefault>
                                                                          skills: Record<string, string>
                                                                               │
                                                   Object.keys/entries on a table ──▶ key: string
                                                   (a branded key would be lost here)

  agent-file path
  ───────────────
  frontmatter      ── parse ──▶  readAgentFiles: discovery only,   ──▶  AgentFile.model, .thinking: string
   (string)                        no name/model validation                    │
                                                         agentSelectionReader ──▶ skill binding validates the
                                                         selection (model lookup, isThinkingLevel) then selects
```

A TypeScript brand is erased at run time, but its compile-time check is real
where a value flows through a typed field or a typed table value: a
`Candidate.model: ModelId`, or the `AgentName` values of a
`Record<..., AgentName>`, fail to compile when a route name is passed where a
model id is expected. `agentKey(modelId)` would not compile. That benefit is
genuine, and it is the benefit issue #57 asked about.

The cost is concentrated where these values are *keys* and where they arrive
*raw*. `Object.keys` and `Object.entries` — how the `agents`, `models` and
`skills` tables are folded — return `string` keys, so the merge loop and the
provenance loop each need a predicate or an assertion to recover the key brand;
the spike left `TS7053` on every `Record<AgentName, …>` indexed by a `string`
and `TS2339` on `config.agents.planner`. Raw input is the cheap direction:
`JSON.parse` yields `any` and the frontmatter reader yields `string`, and
validation would *produce* a brand through a type predicate rather than assert
one. The awkward case is the tables themselves: a table key cannot be branded
without paying the key-enumeration cost above, so branding the fields while the
tables stay `Record<string, …>` leaves the key role unprotected and the
vocabulary half-branded — a branded `AgentName` in a struct, a plain string
wherever that same name is a table key.

Branding a key also proves no more than the spelling it carries. It is the same
`string` at run time, and membership is still the separate `Object.hasOwn`
check; `Record<AgentName, T>` does not make an absent entry present. Indexing it
without `noUncheckedIndexedAccess`, which this repo does not enable, yields `T`
rather than `T | undefined`, so the runtime guard remains necessary on its own
terms.

The seam is a deep parser module, not a scattering of ad-hoc checks.
`mergeConfig` and `loadConfig` are the single point where untrusted JSON becomes
an effective config, and identifier values parsed from a layer are validated
there: a name is refused unless it is a single path segment that does not shadow
`Object.prototype`, a model id unless it contains `/`, a skill unless an explicit
`/skill:` invocation could name it, and every rejection is reported in the user's
own dotted key. A programmatic `base` is a different contract: `mergeConfig`
validates its agent and model-table *keys*, then clones its candidates without
re-checking `model` spelling, so a caller-built base is trusted the way its type
suggests rather than re-parsed. The guarantee this decision leans on is about
identifier values parsed from JSON, which is where the untrusted input arrives.

The migration cost is measurable and one-sided. Threading the three identifier
brands through the seam and its consumers changes four source files (92
insertions, 63 deletions) and leaves 257 compiler diagnostics across twelve
test and fixture files — 236 distinct sites. Branding only `ModelId` still
leaves 142. The failures are mechanical (key-brand erasure, hand-built fixtures,
raw-versus-validated interfaces), not a hard design problem, but they are paid
by every future reader of the tests, and all 780 runtime tests pass unchanged
under the branded build — the guarantee is compile-time only, and it is bought
with a large diff to the tests.

The rule for same-typed arguments is a different rule, and it is addressed
directly. `SkillBinding` and `Candidate` are named records; `heldDecision` takes
a `{ agent, model }` record; `agentSelectionReader(agentDir)` is a factory whose
returned closure takes the name, so no signature carries two adjacent strings.
Where two same-typed arguments remained, the remedy was a record:
`unknownModelNote` and `checkModels`' local `resolves` now take a `ModelMiss`
(`{ key, model }`) instead of two strings, and `isInside` takes `{ dir, file }`
instead of two paths.

`AgentDir` is declined on different grounds. A brand on a filesystem path can
keep two path *roles* apart, and that is real, but it cannot establish
existence, containment or canonical identity: `join`, `resolve` and `realpath`
return ordinary strings, existence changes over time, and a symlink's target is
only known at read time. Containment is already a runtime check (`isInside`,
which resolves both sides and requires the separator), and the file a write
lands on is pinned at lock time. Pi's root data directory and the `agents` child
this extension writes to are two different roles that one brand would conflate.

## Considered options

**Brand all four identifiers.** Rejected: the benefit is real but narrow, and
the cost is the largest of the probes — the three identifier brands alone leave
257 diagnostics across twelve test and fixture files, and adding `AgentDir` on
top leaves 294 across fourteen (a lower bound, since `AgentDir` was not threaded
to the filesystem interfaces).

**Brand only `ModelId`.** Measured at 142 diagnostics across twelve test and
fixture files, with the threaded consumer interfaces retained. Rejected as a
sensitivity probe rather than a smaller design: it removes one role distinction
while leaving the model-table key conversion and the raw-input validation where
they already are, and the other two roles interchangeable.

**Brand the identifiers at the config seam only.** Measured at 60 insertions and
32 deletions in `src/config.ts` alone, and 174 diagnostics across twelve files —
170 of them in tests. Rejected because the seam-only brand is exactly what the
consumers then cannot name, so the churn does not shrink; it moves.

**Do nothing.** Rejected. It leaves the same-typed-argument hazard in place
without a record of why, so the question gets re-opened by the next review.

**Named-argument records and factories (adopted).** The remedy the standards
name, already the house style, and the one that removes the hazard where it can
actually be removed: at the call site, where both arguments are in front of the
reader.

## Consequences

An agent name, a model id and a skill name remain interchangeable to the
compiler. A swap is caught only where the two are validated differently at
run time or where a test exercises the wrong path. `agentKey(modelId)` still
type-checks and produces a plausible-but-wrong provenance key; so does
`upsertModel(model, src)` (though that one fails safe, writing nothing).

New same-typed seams should reach for a record or a factory before reaching for
a brand, and this ADR is the record that the question was asked. A future
same-typed seam that a record cannot make safe — where two validated identifiers
of the same shape are genuinely easy to transpose across a module boundary — is
the trigger to revisit, as is a language or library feature that keeps a branded
key through `Object.keys`/`Object.entries` without an assertion — raw input is
not the obstacle, since a checked producer can brand it.
