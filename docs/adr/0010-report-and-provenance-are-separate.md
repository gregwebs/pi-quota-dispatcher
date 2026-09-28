# The report answers the state; provenance is asked for by name

`/quota-dispatch` serves two readers at once: someone diagnosing why an agent is
not switching, and someone who just wants to see where their agents are. Every
form ended with `describeConfig`'s provenance block — one line per scalar, per
`models` entry, and per candidate slot — so "what is my state?" was answered
underneath a listing of where each value came from. On a real config that listing
is most of the output, and it is the part a reader scans past rather than reads.

Where a value came from is a question asked deliberately. It now has a form that
is asked by name.

## Four forms, and what each owes the reader

```
/quota-dispatch          rails, one decision line per agent, unmanaged files, warnings
/quota-dispatch refresh  the same, with the readings re-fetched
/quota-dispatch config   the provenance block
/quota-dispatch apply    the decisions it wrote
```

Only `apply` writes. Only `config` is answered without a quota read: the question
is "which file did this value come from?", and the config files on this machine
answer it — so it works when a vendor is unreachable and costs no request.

## The layers line and the warnings stay in the report

`describeConfig` was split so both surfaces can share a renderer rather than
grow a second one:

- `describeConfigLayers` — the layers consulted and whether each file was found.
  "Which files am I actually reading?" is a question about the install rather
  than about a value, and it is one line.
- `describeConfigWarnings` — one `warning: ` line per warning.

Neither is provenance. A config that is not doing what the user meant has to say
so on the run that read it, whichever form that was; the report answers "which of
my files is this ignoring?" from its first line and its last.

`describeConfig` composes both with the per-value lines, so
`/quota-dispatch config` prints the block unchanged.

## Considered options

**A flag on one form** (`/quota-dispatch --config`). Rejected as a different
spelling of the same capability. The existing forms already parse by substring —
`apply`, `refresh` — and `config` reads as the question it answers, so a flag
would buy a second syntax and no new behaviour.

**Condensing the block instead of moving it.** A report that printed provenance
only where a value was overridden would still be answering two questions on one
screen, and it would need a rule for what counts as worth printing — a new thing
to get wrong, in the one function whose value is that it never rewrites anything.

**Dropping the warnings along with the values.** Rejected: a warning is not
provenance, and ADR 0008's duplication argument needs it in the report. A dropped
alternate on a route that kept a usable alternate is named nowhere else, and the
load warnings — a rejected value, a bad flag — have no decision line at all.

**Leaving the block on `apply`.** `apply` is not a report: it answers "what did
that just write?", and a provenance listing underneath turns the answer into a
second question. The durable record is one command away and does not depend on a
pass having run, which is the property that made it valuable in the first place.

## Consequences

ADR 0009's "what did not change" note holds where it mattered — the warning
replay is still in `/quota-dispatch` — but the per-value listing moves. What the
README offered as "every form also prints where each configured value came from"
is now `/quota-dispatch config`'s, and the record a user reaches for is one word
further away. Nothing about the block's content changed.

`describeConfig`'s parts are exported rather than reached through the block, so a
test can pin the layers line and the warnings on their own: a change that dropped
one of them from the report while leaving the block intact would otherwise fail
only the block's tests.
