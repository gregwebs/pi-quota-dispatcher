# An unknown model is surfaced at startup, not only logged

Boot already resolves every configured candidate against the running pi's
registry, and the miss is not harmless: a held agent is one the dispatcher will
not write, so it stays on whatever model the file happens to name and never
moves. The report at `/quota-dispatch` has said so since #14, but the reader had
to go and ask for it, and the only unprompted trace was a `console.error` line
that scrolls past at session start. A user who pasted a config with a transposed
`gpt-sol-6` therefore sees no symptom at all beyond an agent that never
switches — which is also what a healthy pinned agent looks like.

So the fact a person has to act on is now raised the way #13's unconfigured
state is raised: one warning-level notification on the reasons that ask for
setup, and a footer line that holds the state on the reasons that do not.

## The miss key is what names the file to edit

`checkModels` returns `misses` — one `{ key, model }` per unresolvable
candidate — beside the `warnings` it renders them into. The notification lists
those, once each, in the order the check found them, and closes by naming the
config file to edit. It is a shortcut to the log and the report rather than a
third telling of the same fact: the miss line is `unknownModelNote`'s sentence
verbatim, so the reader meets the same words in all three places.

The occurrences have to be data, and not only the rendered lines, for one
reason: the `key` is the provenance key a layer records against. `sources[key]`
is what turns a miss into the config file the reader has to open, so the notice
can name the layer the id was actually written in rather than whichever config
file happens to exist. A list of finished sentences cannot give that key back
without parsing its own wording. `held` and `droppedAlternates` cannot stand in:
they are keyed by agent, so a session-wide list rebuilt from them would
re-derive the dotted-key spelling, in order, for a third time.

## The footer holds the state on the reasons the notification cannot

`startup`, `new` and `reload` ask; `resume` and `fork` do not, because a setup
warning is noise in the middle of work already in progress. That leaves `resume`
as the gap: it is exactly the session that inherited yesterday's typo, no
notification ever fires in it, and without a footer the state would again be
visible only in the console line this change exists to stop relying on.

The footer therefore carries the notification's own headline sentence
(`quota-dispatcher: a configured model is unknown to this pi.`) on every reason,
the way the unconfigured status already does. The two states cannot collide:
an unknown model requires a route, and the unconfigured state is the absence of
one, so one status key is enough for both.

## Considered options

**The notification alone, with no footer.** Smaller, and enough on `startup`,
`new` and `reload`. Rejected because it re-creates the original problem on
`resume`: the state is real, it persists until a person edits a file, and nothing
in the session would say so.

**Deriving the miss list from `held` plus `droppedAlternates`.** No change to
`ModelCheckResult`. Rejected in the section above: it needs a second spelling of
the dotted-key scheme, and its ordering would be reconstructed rather than
recorded.

**Naming every config file rather than the layer the id came from.** Simpler, and
wrong in the direction that wastes a reader's time: a project-layer typo would be
reported with the global file, which does not contain it. `sources` already maps
a candidate's key to its layer, so the file named is the one to open.

**Calling the id invalid.** It is not. A model a newer pi knows is reported as
unknown by an older one, and the notification says so in the same words the log
does — "this pi does not know model X — a newer pi may".

## What did not change

`/quota-dispatch` is unchanged, including the `warning:` replay in its
provenance block. The notification adds a surface; it does not replace the
durable record, and a route whose alternate was dropped still appears in the
report whether or not any notification was seen.

A context with no `ctx.modelRegistry` is deliberately left as it was: the check
does not run, so there is no warning at all, and the footer clear is the one a
configured install already performed before this change rather than a new
render. The criterion is "nothing at all when there is no registry", and a check
that cannot answer must not guess.
