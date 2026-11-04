# A rail read is its own module, and it is stateless

Getting one number out of a vendor — find the credential, prove it is still
usable, make the request, retry the failure another attempt could fix, parse the
document — was a closure inside `createDispatcher`, beside 685 lines of
credential reading in the entry point. The two were entangled because the
**Claude** path may only find a token by consulting the machine-wide **refresh
gates**: `claudeToken` reads and writes the **rail readings file**, holds the
ping's single-flight, and compares the **cooldown** before any request is made.

The entanglement was visible to anyone testing the policy. `createDispatcher`
took a `fetchImpl`, so a test about a **switch** had to answer
`api.anthropic.com`, `chatgpt.com` and the Antigravity endpoint, in the right
document shape, before it could assert one decision line.

## What a read is

A **rail read** is one vendor request and the **rail reading(s)** it produced.
Its unit is a source, not a rail: `claude` and `codex` are one rail per request,
and the three Antigravity pools are one request that answers for all three — see
[0019](0019-antigravity-pool-rails.md). A read takes a credential already in
hand:

```text
  credential ──▶ readRail(rail, token)  ──┐
  credential ──▶ readPool(token)         ─┼──▶ RailReading · AntigravityReadings
                                           │      (the store's own payload types)
  transport ──▶ one attempt               ─┘
  pacing    ──▶ attempts, deadline, backoff
```

The three credentials are shaped differently — a Claude token, a Codex
`{access, accountId}`, an Antigravity `{token, projectId?}` — so the module
offers one function per shape and its caller maps rail to function. No union
tagged by `rail`, and no switch inside: a function that must first ask which
rail it is reading is the branching this removes.

## What stays outside, and why

| Concern | Where it stays | Why not in the read |
| --- | --- | --- |
| Single-flight, the cross-process fetch lock, the cache, **last good reading** | The **rail readings file** | Machine-wide, shared with every pi process ([0016](0016-shared-rail-readings.md)) |
| Which file a rail's credential is read from | The dispatcher | Configuration knowledge, and the store's own cache key |
| Acquiring the Claude token: keychain fallback, **refresh gate**, paid **refresh ping** | The dispatcher, until the gate policy has a module of its own ([0007](0007-refresh-pings.md)) | Acquisition reads and writes gates; a ping spends money and must happen once per machine |
| Whether a failure is worth retrying, and how it reads in a report | The read module | It owns the attempts, so it owns their phrasing |

`readings.read(rail, credential, { ttlMs, force, fetch })` already took the
vendor request as a closure. This decision names that closure and gives it a
home, rather than building it inline in the dispatcher.

## The transport, and the two clocks

The transport is a one-method adapter: it returns a status and the parsed body,
or a failure classified as a timeout, an unreadable body, or a network error. It
never retries and never writes a sentence a user reads — `status >= 500` is the
read's judgment, and so is `after 2 attempts`.

`now` is a dependency, so a pass keeps one clock and one document's three pools
share one `readAt` and one `raw`. The backoff sleep is deliberately **not**
injectable: `deps.sleep` moves the store's lock waiter, and a clock that also
shortened retry backoff would make "asked again and gave up" unobservable in the
tests that pin it.

## Consequences

A policy, report or gauge test injects the read and hands over a reading; only
the read module's own test names a vendor URL, a header or the pinned
Antigravity user agent. `fetchImpl` is deleted rather than kept as an alias,
because a second way to fake a request would preserve the ambiguity this
removes.

`rail-read.ts` reaches for no store, no config object and no pi type. Moving
`claudeToken` in is the tempting next step, and it is the one thing this record
exists to stop: it would put the gates and a paid subprocess inside a module
whose whole value is that it has no state. When the gate policy does become a
module, the Claude token's acquisition moves *beside* the read, not into it.
