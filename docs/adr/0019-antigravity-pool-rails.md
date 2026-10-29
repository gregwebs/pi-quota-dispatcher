# Antigravity is three pool rails behind one vendor read

## Context

An account in Google's Antigravity CLI is capped in three places that move
independently: a weekly-only pool for `gemini-4-argon`, a
session-and-week pool for the other Gemini models, and a session-and-week pool
for the Claude and GPT models it proxies. Spending the Claude-and-GPT pool tells
you nothing about the Gemini one, so a single "antigravity" rail would make the
policy blind to two thirds of the account: an agent would be moved onto a pool
that is already blocked, and the headroom of the pool it left would be lost.

This extension therefore knows three rails, `antigravity-argon`,
`antigravity-gemini` and `antigravity-3p`, and one vendor call answers for all
three. The three are a pool group, not accounts: they share one credential, one
endpoint and one response body, and differ only in which buckets of that body
they own. See the **Rail** and **Rail reading** terms in
[CONTEXT.md](../../CONTEXT.md) for the vocabulary this rests on.

## One request, three rails

`POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` answers
with groups of buckets, and each bucket's **id** — not its group's display name
— says which pool owns it:

```text
  auth.json[antigravity] ──▶ one POST retrieveUserQuotaSummary
                                    │ one body, one readAt
   groups[].buckets[].bucketId      │
        │                           │
        ├ gemini-argon-…  ──▶ antigravity-argon   [weekly]
        ├ gemini-…        ──▶ antigravity-gemini  [session, weekly]
        └ 3p-…            ──▶ antigravity-3p      [session, weekly]
```

Argon is matched before the general `gemini-` prefix, because the Argon pool's
bucket is a Gemini bucket too (`gemini-argon-wtu-weekly`). Group order and
display names are treated as presentation: a renamed or reordered group changes
nothing, and a bucket no prefix claims is dropped rather than guessed into a
pool. `window: "5h"` is the session budget and `window: "weekly"` the weekly one;
any other window is kept as a display-only window, because guessing it into a
budget would make a required budget look reported when the vendor never said so.
`remainingFraction` is the vendor's number, so a window's usage is its complement
in whole percent, clamped to `[0, 1]`: a fraction outside that range would
otherwise weigh as a negative or impossible usage figure.

Every successful pool carries the **whole** response as its `raw`, the same
object three times over. The buckets were partitioned on the way in, so any one
pool's raw describes the whole account — there is no per-pool view of the
document to hand out, and a generator reading one pool sees what the vendor said
about the others.

A pool the vendor omitted is that pool's own failure — `no usage windows
returned` — while its neighbours are read normally. That is the honest shape of
the failure this feature has to survive: Google omits the `Gemini 4 Argon` group
for old client strings, and an Argon rail reported as unavailable is a rail the
policy holds on, not a zero the policy routes on.

## Argon carries one budget

The Argon pool has a weekly bucket and no 5-hour window at all. Rails therefore
declare which budgets they carry, and the policy distinguishes two cases that
used to be one:

| Rail | Carried budgets | Effective usage of an uncarried budget |
|---|---|---|
| Claude, Codex, `antigravity-gemini`, `antigravity-3p` | session, weekly | — |
| `antigravity-argon` | weekly | session = 0 |
| DeepSeek (metered) | none | 0 for either |

**A missing carried budget is unknown; an uncarried budget is no cap.** Argon's
absent session window is not evidence that a session budget is free — it is a
budget the vendor never imposed, so nothing can be tight there and no threshold,
not even one configured as `0`, can make it so. Reading the two cases alike
would hold every Argon primary for a window that does not exist, and would let
`sessionAlwaysSwitchAt` refuse Argon as a destination for a cap it does not have.
The same rule applies to a destination's *other* budget: an alternate only has
its spare budget checked when it carries that budget, so an Argon destination is
weighed on its week alone while still being refused if that week is itself tight.

## The token is pi's, so the refresh is pi's

`auth.json` holds Antigravity's `access` token beside an optional `expires` (epoch
milliseconds) and an optional `projectId`. The dispatcher reads it and never
writes it. When the stored token is expired — `expires <= now`, equality
included, because a token with no remaining life would only spend a request on a
401 — and the file is the **default** one, the refresh is delegated:
`ctx.modelRegistry.getApiKeyForProvider("antigravity")` runs `pi-ai`'s stored-OAuth
resolution, which locks `auth.json`, refreshes through `pi-antigravity`'s own
provider, and persists the result. Afterwards the dispatcher re-reads the file,
because the refresh is only useful if something usable was persisted — the
resolver's return value is a JSON credential document in pi's internal shape, not
a bearer token, and sending it as one would be a 401.

This is [ADR 0007](0007-refresh-pings.md)'s principle applied to a second
credential: a rotated refresh token plus a second writer is how a session gets
logged out, so there is exactly one writer and it is not this extension. Three
things must hold before a refresh is attempted — the token is expired, the file
is the default one, and a resolver is wired — because a non-default `piAuthPath`
names another profile, and refreshing *this* machine's provider says nothing
about that one. A 401 or a 429 never triggers a refresh either: expiry is the
trigger, so an account that is merely rate-limited is not refreshed three times
an hour.

The wait is bounded (`PROVIDER_TOKEN_TIMEOUT_MS`, 10s) and the registry offers no
cancellation, so a wait that runs out leaves the refresh to finish in the
background — the refresh still holds its single-flight slot until it actually
settles, so a timed-out wait never starts a second refresh. The next credential
read is what finds out whether it worked. Reads and notes are sanitized: a
malformed `auth.json` and a throwing resolver both produce fixed text, because a
JSON syntax error quotes the document and the document is a credential store.

## The `User-Agent` is pinned

Requests carry
`antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)`
unless `ANTIGRAVITY_USER_AGENT` overrides it (trimmed, blank ignored). This
header is load-bearing rather than polite: Google omits the `Gemini 4 Argon`
group from `retrieveUserQuotaSummary` for older or generic agent strings, so a
request that looks like an old client silently reports two pools instead of
three. The failure would surface as an Argon rail with no windows and no cause
anywhere in the body, which is why the string is one named constant and the
override is documented rather than improvised.

## One fetch group, per-rail entries

Three pools behind one request means the fetch, the lock and the publication are
grouped while the *storage* stays per rail:

```text
  readAntigravity(selectedRail, credential)
       │
       ├─ join the group's in-flight record ─────────────────┐
       └─ all three overlay entries fresh? ─── yes ──▶ serve  │
             │ no                                             │
             ▼                                                │
       take ONE group fetch lock                              │
             │                                                │
             ├─ a peer published a complete fresh group ─────▶ serve
             └─ POST retrieveUserQuotaSummary once
                   │
                   ▼
             under the file write lock:
             read doc ─▶ merge all three entries ─▶ 0600 rename
                   │
                   ▼
             install all three in the overlay, then project the selected rail
```

`SharedReadings.readAntigravity` is the one new method, and the singleton `read`
keeps its existing callers by being narrowed to the rails that really have a
request of their own. The in-flight record and the fetch lock are keyed by the
**source** — `antigravity\0<credential>` — so two concurrent pool reads, or two
processes asking for different pools, join one fetch. The group key lives in its
own domain so Codex, which is configured from the same `auth.json`, is not swept
into it.

A complete group is three entries that exist and are fresh; a pool the vendor
omitted is a *failure entry*, which is a reading like any other and is honoured
for the TTL rather than re-fetched in a loop. A group that is missing one member
is not a cache hit — the fetch populates all three. One `at` stamps the whole
group, since it is one vendor answer, while each member's `lastGood` is computed
from that member's own prior entry and never from a neighbour's.

The file format goes to **version 3**, which is a change to what an entry's
`rail` may be: the accepted vocabulary widened. A version-2 document is still
**read**, because its entries can only be Claude and Codex ones, whose shape did
not change, and keeping them — the refresh gates and sticky halt above all —
through the upgrade is what stops an upgrade from forgetting that a ping already
spent money. Writes are always version 3, so a v2 file is upgraded by the next
publication. That keeps [ADR 0016](0016-shared-rail-readings.md)'s shared-cache
properties intact: one file, one write lock, one atomic replace, best-effort
writes, and `knownReadings` still age-blind.

## What the rest of the extension sees

Six rails, in one canonical order: Claude, Codex, the three pools, then the
metered rail. The report prints one line per rail, so a failed pool is visible
beside two healthy ones. `knownReadings` reads the pools as one picture — a group
with a member missing from the store is warmed by one fetch and then read back
whole — so a generation is never fed two pools read now beside a third read
earlier. `generatorInput` projects **five** capped rails at
`version: 1`, and refuses the run when any of them has never succeeded, naming
every failing rail in that order — the wire shape did not change, only the
vocabulary grew. Consequently an install without an authenticated Antigravity
account cannot generate at all, which is the deliberate consequence of
generation being all-or-nothing (ADR 0015).

Rails are still configuration: `railFromModel` classifies the three prefixes
(`antigravity/gemini-4-argon*`, `antigravity/gemini-*`,
`antigravity/claude-*`/`antigravity/gpt-*`) and is used for the mismatch warning
and the startup snippet, never as a fallback for a missing rail
([ADR 0005](0005-model-rails.md)).

## Considered options

**One account rail called `antigravity`.** Simpler, and it matches the
credential's shape — but the three caps move independently, so one rail would
have to invent a single number for them. It would be wrong in both directions:
an agent held off a fresh Gemini pool because the Claude-and-GPT pool is spent,
and an agent moved onto a spent pool because the Gemini one is idle.

**Inferring the pools from `fetchAvailableModels`.** The vendor's model list does
not report caps, so the pools would have to be derived from model ids and then
mapped back to bucket ids — a second, undocumented contract that would silently
disagree with the bucket ids the quota endpoint actually uses. The bucket id is
the only thing that says which cap a number belongs to.

**Three independent quota requests, one per pool.** Cleanest per rail, and it
makes the rails look like Claude and Codex. It was rejected because it is three
times the request volume against an endpoint that rate-limits, and because the
pools are answered by one body: three requests would also mean three partial
failures where the vendor gave one answer, and three chances to see a different
account state.

**Refreshing the token here.** Posting the refresh token to Google's OAuth
endpoint and writing `auth.json` would remove the dependency on pi's registry. It
was rejected for ADR 0007's measured reason: the refresh token rotates, pi treats
an `invalid_grant` for the token it stored as the end of the session, and a
second writer is how a user gets logged out. The dispatcher asks pi to refresh and
then reads what pi persisted.

**Sharing one promise in the dispatcher instead of grouping the store.** A
dispatcher-level `Promise.all` dedupe would share one HTTP call within a single
process and still leave three fetch locks and three sequential partial writes
across processes — two pi sessions would each make the request, and a crash
between two of three writes would publish half a group. The grouping therefore
lives in the module that already owns the lock, the overlay and the file, which
is what keeps that module deep: callers learn a grouped read, not lock naming,
publication order or overlay management.

## Consequences

The private endpoint and its pinned `User-Agent` can change under this feature;
when they do, an omitted group stays an honest failed rail rather than
fabricated zero pressure.

Per-pool raw means the whole vendor document is stored three times, which grows
the readings file and the generator's stdin. That is the price of the wire shape
staying facts-only per rail; unrelated deduplication is deliberately not
introduced here.

An older extension process rejects a version-3 document and can overwrite it with
a version-2 one, losing the pool entries (and any refresh gate it ignored). Reload
**all** sessions when updating; the reader's v2 compatibility cannot fix an old
writer.

The delegated refresh can time out without cancelling pi's writer. The dispatcher
never becomes a second writer; the next credential read determines whether the
background refresh succeeded.
