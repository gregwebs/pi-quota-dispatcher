# Rail readings are shared through one locked, versioned file

Every pi process on a machine that runs this extension reads the same few vendor
endpoints: Claude's `/api/oauth/usage` and Codex's `/wham/usage`. Each process
cached the result in its own `Map`, so three open sessions polled the vendor
three times per `ttlMs` for one account. The cost is not only redundant requests:
the endpoints rate-limit, and the answer to the third request is a 429 that says
nothing about the account, only about how many processes happened to be open.

Rail readings now live in one file beside the global config,
`<agentDir>/quota-dispatch-readings.json`, and every dispatcher reads and writes
it. Two processes polling the same credential make **one** vendor request per
TTL between them. The reading is keyed by rail *and* by the resolved credential
path (`resolve(cfg.claudeCredsPath)`, `resolve(cfg.piAuthPath)`), so a second
Claude profile or a second pi auth file never inherits another account's
numbers. The metered rail is never stored: it has no endpoint to ask and nothing
that could go stale.

The same file also holds the refresh ping's gates — a per-credential cooldown
and per-episode halt, and one machine-wide sticky halt (ADR 0007) — so a ping
one process makes is not repeated by the next, and a gate it arms is honoured by
all of them. The gates are written under the same lock and read atomically with
the same `0600` atomic replace, and a gate this process armed is kept in memory
as well, so a write that cannot be made still protects the process that made the
attempt. What is kept in memory is only the operations this process has not yet
published, applied on top of a freshly loaded document; an operation retires
once it lands, so a peer's later clear or re-arm is never hidden behind a stale
local copy.

Version 2 of the format adds the `gates` list and the `stickyHalt` record. The
format is internal, not a public contract. Nothing outside `src/readings-file.ts`
names a key of it, and the only thing a caller sees is the same `RailReadings`
the in-memory cache produced plus the `RefreshGates` the dispatcher asks for by
credential.

## One file, not one per rail

A shared cache could have been one file per rail and credential, each written
last-writer-wins. It was rejected because the two rails are read at the same
moment by the same pass and a per-rail file multiplies the failure surface: two
locks to keep in step, two partial-write windows, two places a crash can leave a
truncated document. One file is one read-modify-write, and one lock over it. The
cost of one file is that a writer has to preserve the *other* rail's entry, which
is why the write is a locked read-modify-write rather than a blind replace (see
below).

## A shared failure is a shared answer

A failure is cached like a success, for the same TTL. That is deliberate and it
is the point of the change as much as the request count is: a 429, a 500, or a
missing credential is a fact about the account and this instant, so a second
process on the same credential would get the same answer from a request of its
own. Sharing the failure is what stops a lapsed or rate-limited rail from being
hammered once per process per TTL — the failure is answered, held, and left
alone.

The policy does not change with it. `latest` is still what routing decides on;
a failed latest read still **holds** rather than routing on numbers it could not
confirm (ADR 0006), and a `lastGood` read out of the file is still never routed
on. A failure written by another process could carry a last good reading with it,
and a reader of the file gets that reading as `lastGood` — the same object
relationship the in-memory cache had: a success is its own last good reading, and
a failure carries forward whatever good reading preceded it.

## One fetch at a time, with a bounded wait

Two processes that find the same lapsed rail must make one request, not two. The
first takes a **per-key fetch lock** — a sibling of the readings file, named by a
hash of rail and credential — and the rest wait for its result, then read the
entry it published. The lock is not a mutual exclusion over the request for its
own sake; it exists so the waiters can be handed the answer.

```
  read(rail, credential) — one entry, three places it can come from
  ─────────────────────────────────────────────────────────────
  overlay (memory)  ── fresh ─────────────────────────────▶ serve
        │ stale or absent
        ▼
  file (shared)     ── fresh ────────────────▶ serve, copy to overlay
        │ stale or absent
        ▼
  take per-key fetch lock
        │
        ├─ holder published a different entry ────────▶ serve it
        │
        └─ no, fetch the vendor
               │
               ▼
           under the file write lock:
           read whole doc ─▶ merge this key ─▶ 0600 temp rename
               │
               ▼
           publish to overlay, release

  a waiter whose fetch-lock wait passes fetchWaitMs fetches for itself
```

The wait is **bounded**, and that bound is the whole reason this is safe. It is
computed from the quota read's own limits:
`attempts × timeoutMs + (attempts - 1) × backoffMs + CLAUDE_PING_TIMEOUT_MS` —
every attempt timing out, every backoff between them, and the one refresh ping a
Claude read may run inside an attempt. That sum covers the vendor-side work only:
it does **not** include the holder's keychain read or its gate writes, so a
perfectly healthy holder can in principle exceed the bound and hand a waiter a
duplicate fetch. That is the same bounded-wait duplicate the considered options
below already accept, and it is deliberate — the bound is the longest a *vendor*
read can honestly take, not the longest a read of any kind could, because padding
it for the local work would make a genuinely stuck holder cost more than the
redundant request it avoids. A waiter that reaches that bound fetches for
itself. The alternative — waiting however long the holder takes — would let
one process with a stuck or paused holder stall an evaluation that another
process is waiting on, which is exactly the failure ADR 0006 exists to refuse.
The bounded wait trades a rare duplicate request for the guarantee that a holder
in trouble cannot cost a caller the reading it came for.

The lock itself is the same primitive the agent-file writes use
(`withLockPath`, extracted from `withFileLock` in ADR 0013): a create-exclusive
file, a held record naming a pid and host, a crashed holder recovered at once, an
unconfirmable one after the staleness bound, and a live one left alone. None of
that is reimplemented here.

## The write is best effort, and never refuses to work

A read writes the entry it fetched, under the file's write lock, as a
read-modify-write: read and decode the document, replace only this key's entry,
re-encode, rename a `0600` temp file over the path. Replacing only this key is
what keeps two processes fetching two rails from losing each other's entry.

If the write lock cannot be taken in time, the write is skipped — and nothing
else changes. If the write itself fails, the failure is swallowed. The reading
is already in the process-local **overlay**, which is the copy this process
answers from, and the file is an optimisation over that overlay rather than a
dependency. A cache write must never turn a quota evaluation into an error, and a
holder it cannot wait out must never be a reason to refuse to answer.

The overlay is also what makes a read inside the TTL cost no file I/O: the entry
is served from memory, and the file is consulted only when that entry is stale.
Concurrent reads of one key within the process are joined to a single promise, so
this process never queues behind its own fetch lock and never makes two requests
for one rail from two callers.

## The file is `0600`

A `GoodReading.raw` body is the vendor's own document, kept because it is what
normalization leaves out, and it can carry account details — an email, a metadata
block. The report deliberately never prints it, and a cache is not a reason to
publish it: the file is created `0600` and its staging file is created `0600`
before a byte of content is written, so the contents are never visible to another
user even mid-write.

## A corrupt file is reported, not fatal

The document is decoded all-or-nothing. Not JSON, not an object, an unknown
version, any single entry that fails the reading schema, or any gate or sticky
record that fails its own makes the whole file read as empty and raises one
warning line, which the report prints. The file is
skipped, never repaired in place, and the next successful write replaces it with
a valid document — so a file a future version wrote, or one a hand edit broke, is
a message and a re-fetch, not a broken dispatcher. The warning is in the report
because that is where rail numbers are read: "these numbers came from the vendor,
not from a peer" is the fact a reader of the report needs.

## Considered options

A shared file with no lock, written by plain last-writer-wins, was rejected: two
processes adding the two rails' entries would have each published a document
missing the other's, and the shared cache would lose entries exactly when it was
busiest.

Waiting without a bound on the fetch lock was rejected for the reason ADR 0006
gives: one process's stuck holder must not become another process's hung
evaluation. The bound is what makes the wait a promise rather than a gamble.

Holding a lock *permanently* for the whole TTL, so exactly one request per TTL is
made even across a crash, was rejected as over-engineering: the TTL is minutes,
the entry is written the moment the request finishes, and a lock that outlived
its holder would need its own recovery for a redundancy the entry already
provides.

Storing the metered rail was rejected: it has no endpoint and no reading that can
change, so an entry for it would be a file write that says nothing.

Storing readings per process *and* per credential in separate files was rejected
in favour of one file keyed by both, so a single read-modify-write keeps every
account's entry consistent and one warning covers the whole store.

## Consequences

The dispatcher's per-rail cache is now a shared resource with a lifecycle: a
corrupt file is a state a user can see and fix, and a stale one is a state the
next read repairs. The report grew a warning tail for exactly that.

The store is keyed by the resolved credential path, so the config's credential
paths are part of the cache's identity; changing `claudeCredsPath` starts reading
a different account's entry rather than serving the old one, which is why the
resolution happens at the key, not at the config.

The store is still fundamentally a cache: a read that cannot write still answers,
and a gate that cannot be written is still kept in the process that armed it.
Two processes can therefore both fetch a rail, or both ping, when the file is
unwritable or the fetch lock's bounded wait runs out. That is the deliberate
direction of the trade — a duplicated request at worst, never a refused
evaluation or an un-gated retry.

`knownReadings()` now reads through this store, which is the seam ADR 0015 named
for the generator path. It stays age-blind: it returns an entry whatever its
freshness, applying no TTL the policy owns, and the only new thing it gains is
that the entry may have been written by a peer process.
