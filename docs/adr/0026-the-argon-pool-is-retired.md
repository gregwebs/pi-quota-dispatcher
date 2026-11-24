# The Argon pool is retired

## Context

[0019](0019-antigravity-pool-rails.md) split one Antigravity account into three
rails because the vendor capped three pools independently, one of them the
weekly-only Argon pool for `gemini-4-argon`. Google has since removed that quota
and is deprecating Argon itself.

A rail is a pool the dispatcher can route to. Once the vendor stops imposing the
cap, `antigravity-argon` is not a narrow pool any more; it is a name with no
budget behind it. Keeping it would leave a rail that can only be read as
unavailable — the vendor is free to omit the bucket at any time — and an
unavailable rail **holds**, so every agent still routed to it would be held for
a quota that no longer exists.

## Two pool rails remain

The account is now the two pools the vendor still caps: the Gemini one and the
one for the Claude and GPT models it proxies. Everything in
[0019](0019-antigravity-pool-rails.md) about the group read survives — one
credential, one `retrieveUserQuotaSummary`, one `readAt`, one publication — with
two members instead of three.

```text
  auth.json[antigravity] ──▶ one POST retrieveUserQuotaSummary
                                    │ one body, one readAt
   groups[].buckets[].bucketId      │
        │                           │
        ├ gemini-argon-…  ──▶ (dropped: retired pool)
        ├ gemini-…        ──▶ antigravity-gemini  [session, weekly]
        └ 3p-…            ──▶ antigravity-3p      [session, weekly]
```

Two things about the retired pool are deliberately **not** folded into the
Gemini rail:

- **Its buckets are dropped.** `gemini-argon-*` is refused before the general
  `gemini-` prefix can claim it. A number about a pool no route can spend is not
  pressure on the pool that is left, and weighing it there would make the Gemini
  rail look tighter or looser than the quota being spent.
- **Its model prefix is not.** `antigravity/gemini-4-argon*` needs no special
  case any more, so it falls into the general `gemini-` prefix and classifies as
  `antigravity-gemini`. There is no other pool left for such a model to draw on;
  and if the model is withdrawn with Argon, a config that still names it is
  corrected on its next edited rail rather than routed to a rail that answers
  nothing.

The **rail gauge** loses its `–` slot along with the pool. It was the display for
a budget a capped rail does not carry, and every capped rail now carries both;
keeping the arm would be a state no reading can reach. The policy still
distinguishes an uncarried budget from an unreported one, because the metered
rail carries neither — that is a fact about `RAIL_BUDGETS`, not about a slot the
gauge draws.

## The readings file keeps version 3

The file's version answers for what an entry's `rail` may be, and the vocabulary
has now **narrowed** — the opposite direction from 0019. The obvious move is a
version 4, with version 3 still read; it was rejected for the same reason the
gates are carried forward at all (ADR 0007): a bump makes every older extension
process still running on the machine reject the whole document as an unknown
version, discard the refresh gates and sticky halt, and publish its own version
back over the top. A cache upgrade must not cost a second paid ping.

So version 3 stays. A version-3 writer may legitimately have filed an entry for
`antigravity-argon`, so the reader **drops that entry** rather than faulting the
document (which it does for a version-2 document naming a pool, because that
writer could not have produced one). Dropping is safe because the entry
describes a pool no route can spend; faulting would discard the cooldown of a
ping that already ran. Writes never emit the retired rail, so the entry
disappears on the next publication, and an older process reading the narrowed
document simply sees one pool missing and reads it again — it keeps its gates
either way.

## Consequences

A configuration that still says `"rail": "antigravity-argon"` no longer names a
rail. The loader warns and ignores that statement, exactly as for any unknown
`rail`; because the prefix still implies `antigravity-gemini`, a candidate whose
model the `models` table registers is still routable. Configurations should
delete the entry rather than rename the rail on an Argon model.

The generator input's version stays `1`: the wire shape did not change, only its
vocabulary shrank. The document now names four capped rails instead of five, and
an install with no Antigravity account still cannot generate.

The report prints one fewer line, and the gauge one fewer label. Both are
derived from `RAILS`, so nothing else had to be re-stated.

## Considered options

**Keep `antigravity-argon` as a permanently unavailable rail.** It would hold
every agent routed to it, which is the honest answer to "we cannot read a quota"
but the wrong answer to "there is no quota". It would also keep an
`antigravity/gemini-4-argon` special case alive for a model that is being
withdrawn with the pool.

**Count the Argon buckets into `antigravity-gemini`.** The two pools were
capped separately, so their numbers cannot be added or compared; a bucket the
vendor still reports out of habit would weigh a quota nothing spends. Dropping it
is the same rule 0019 applies to a bucket no prefix claims, applied to a prefix
this version no longer knows.

**Bump the readings file to version 4.** Cleaner as a statement of the accepted
vocabulary, but it makes an older, not-yet-reloaded session throw the document
away and erase the record that a refresh ping already ran. The narrowing is
read-compatible, so a version bump buys nothing a dropped entry does not.
