# A model's rail is registered once, in the `models` table

Every candidate used to state its own `rail`, so a route that sent three agents
to the same model repeated `"rail": "claude"` three times, and moving a model
between two routes restated its account each time. The rail is a property of the
model, not of the route that names it, so it is now registered once:

```json
{
  "models": { "claude-bridge/claude-opus-5-5": { "rail": "claude" } },
  "agents": {
    "planner": { "primary": { "model": "claude-bridge/claude-opus-5-5" } }
  }
}
```

A candidate that states no rail takes the one registered for its model. It may
still state its own, which outranks the registration — the same shape `thinking`
already has, with the model's entry as one of the places a rail can be stated.

## Why the model, and not the prefix

The loader already knows which prefix belongs to which rail (`railFromModel`) and
uses it to propose the startup snippet, so the rail could have been derived from
the prefix and never configured at all. It is not. The prefix is a convention,
not a fact the dispatcher owns: a bridge can serve a vendor under a new prefix,
and the same vendor prefix can be reached through more than one account.
Requiring the rail to be stated, and checking the prefix against it, is what
turns a mis-pointed route into a warning instead of a silent route to the wrong
quota. A missing rail is therefore an error rather than a fallback to the prefix
— the guess that check exists to prevent.

## Why the `models` table is folded before any agent

A candidate can be in one file and the model it names in another. A single
ordered fold of the layers could only inherit a rail registered earlier in the
same pass, which fails for the ordinary case of a route added to a project file
that names a model the global file registered, and for a `models` key written
after `agents` in one file. The `models` table is therefore merged over every
layer first, and only then are the agents read, so a rail resolves against the
table the config actually ends up with.

A layer that moves a candidate to another model re-resolves the rail from that
model's entry, so the rail follows the model rather than being glued to the old
one. If the new model registers no rail, the move is rejected rather than
carried: the inherited rail belonged to the model being left, and pointing an
unregistered model at it routes work to an account the config never chose. A
rail the candidate stated itself is different — it is kept across a model
change, field-wise, like every other candidate field — and a layer that states
its own rail, or changes no model, keeps the rail beneath it.

## Considered options

**Deriving the rail from the prefix.** Removes the repetition entirely, but also
removes the check: a model routed to an account it does not belong to would be
invisible. The rail is the one thing about a destination the model id does not
prove.

**Forbidding a candidate-level rail and keeping the registration as the only
place a rail can be stated.** Cleaner on paper, but it makes the same model
unreachable on two accounts and breaks every existing config for no gain. The
candidate's `rail` is an override; the table is where it normally lives.

**Folding the layers once and resolving the rail lazily at decision time.**
Leaves the effective config without a definitive rail and pushes an inheritance
question into `decide`. Resolving during the fold keeps `Candidate.rail`
non-optional, so the decision code and the model check do not grow a second way
to be incomplete.
