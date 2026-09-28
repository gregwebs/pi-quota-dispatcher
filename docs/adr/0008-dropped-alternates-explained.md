# A route with no alternates says which of the two ways it got there

`alternates: []` pins an agent to its primary — the meaning ADR 0002 gave it: the
primary is assigned with no readability check and is never held, because there is
nothing else the answer could be. Boot-time model checking reaches the same state
by the other road — each alternate this pi cannot spawn is dropped, and a route
whose alternates were all dropped arrives at the policy with an empty list.

The policy is right to treat those the same, and the report was wrong to. Both
printed

```
scribe -> openai-codex/gpt-6-sol  [unchanged]  (no alternate configured)
```

which tells a user who wrote two alternates that they wrote none. `/quota-dispatch`
is exactly where someone lands when asking why an agent is not switching, so the
one line they read there has to be about their config rather than about the shape
the policy happens to see.

## The dropped set travels beside the config, not inside it

`checkModels` already returns what it dropped, as the `held` record for unknown
primaries. Alternates get the same treatment: a `droppedAlternates` record, by
agent name, each entry the model id and the dotted key the warning named it by.

It is a decision-time input rather than a field on `AgentRoute`, for the reason
`held` is: it is a fact about the pi this extension is running inside, not about
the config the user wrote. The effective config stays the shape the config file
describes — `decide` is handed the route plus this record and stays a pure
function of the two — and there is exactly one place that could disagree about
what was dropped, which is the step that did the dropping.

The key rides along with the model because the reader's next action is to edit
that line. `unknownModelNote` is the single spelling of that wording — the boot
warning, the dropped-alternate note and `heldDecision`'s hold all go through it —
so no two of them can drift into saying one fact two ways.

## The report names them, one line each

```
scribe -> claude-bridge/claude-opus-5-5  [unchanged]  (every alternate was dropped — pinned to the primary)
  agents.scribe.alternates[0].model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may
  agents.scribe.alternates[1].model: this pi does not know model openai-codex/gpt-astra-6 — a newer pi may
```

The headline names no model and no mechanism: it says what happened and that the
route is now pinned, and the notes immediately below say who dropped what and why.
Those notes are one per dropped model rather than one line, which is the rule #13
settled for a route with several alternates — a headline carrying three model ids
and their reasons is one unreadably long line, and the notes are already the
mechanism for one fact per candidate.

## Considered options

**Leave `decide` alone and let the report explain.** The decision would keep
saying "no alternate configured" and the renderer would append the dropped models
underneath it. Rejected because the sentence itself is the lie: `why` is what the
report prints, what `/quota-dispatch apply` prints, and what any future renderer
prints, and a correction bolted on beside it leaves the wrong claim in the one
value every caller shares. It would also put the explanation in a layer that has
to be told what was dropped anyway.

**Keep the alternates in the config and mark them.** A dropped candidate could
have stayed in the route with a flag, which would give `decide` everything it
needs and let `describeConfig` show the provenance line a dropped alternate
currently lacks. Rejected because it puts a fact about the running pi into the
config shape, where every layer fold, the provenance listing, and every later
pass would have to know to ignore or re-derive it — and because a candidate the
dispatcher must never choose is better absent from the list it walks than present
with a trap attached.

## Consequences

A report names a dropped alternate twice: once as a note under the decision, and
once again in the provenance block, which replays the boot warnings with a
`warning:` prefix. That is deliberate, and it is not new — an unknown *primary*
has read that way since #14, named both in its hold's `why` and in the replayed
warning. The two are answering different questions. The decision is the
explanation: one line per dropped model, in the agent's own entry, where someone
asking "why is this agent not switching?" is looking. The provenance block is the
log: every warning in the order it was raised, whatever became of it. Dropping
the warning from the replay because a decision already mentioned the model would
stop that block being a replay — and the warning is still the only place a drop
appears when the route kept an alternate it can spawn and no decision ever
mentions it.

`describeConfig` still has no line for a dropped alternate, since it walks the
effective config and the candidate is gone from it. The decision note is where it
surfaces.

## Known and left alone

A route can reach the policy with no alternates by a third road: the config seam
rejects an alternates list that has one unusable element, discarding the whole
list so a lower layer's stands — and where no lower layer supplied one, the route
is left with `[]`. It then reads as `no alternate configured` for a user who
did write alternates, with the rejection reported as a load warning. Telling that
case apart needs the merge to record what it discarded, which is a change to the
config layer rather than to the policy, and it is not this decision's.
