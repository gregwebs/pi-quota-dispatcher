# Removal is spelled `disable`, `ignore` and `[]` — never `null`

No key anywhere in the configuration accepts `null`. An agent is switched off
with `disable: true`, which is read at load as a skip instruction and never
survives into the effective config: it removes the agent whatever lower layers
said, and appears in the provenance listing only as a single
`agents.<name> = disabled` line. An entry that should contribute nothing while a
lower layer's route stands is `ignore: true`, which is silent by construction.
`alternates` is a priority list and any layer that mentions it replaces the whole
list, so `[]` — not `null` — is how a higher layer says "no alternates".

## Considered options

`null` was the previous eraser, at two granularities: route-level `null` removed
an agent, candidate-level `null` removed one slot. Once `alternates` became a
list, `[]` expressed slot removal more directly and `disable` expressed agent
removal, so `null` was left as a second spelling of both. Folding `disable` and
`ignore` into one flag was also considered: they stayed separate because they
answer different questions — "this agent is off" versus "this copy of the route
is not the one that governs" — and the parked-copy case must not clobber a live
lower layer.

Taking the alternate with the most headroom, rather than the first usable one in
order, was the other rejected option. Order is the only intent a user can express
that the numbers cannot, and a "best available" rule would add a second source of
oscillation to a policy that already swaps models when a budget hovers near a
threshold.

## Consequences

Any layer that mentions `alternates` must restate the whole list, even to change
one candidate's model: objects merge field-wise, arrays replace. `disable` and
`ignore` are entry-level only, so a candidate has exactly `model` and `rail`, and
a lone candidate object is not accepted as shorthand for a one-element list.
