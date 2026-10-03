# Configuration can be generated, but only when asked and all-or-nothing

A config file may declare a `generator`:

```json
{
  "generator": { "command": "my-dispatcher-config", "timeoutMs": 5000 },
  "agents": {
    "planner": {
      "primary": { "model": "claude-bridge/claude-opus-5-5", "rail": "claude" }
    }
  }
}
```

`/quota-dispatch generate` runs the command under Bash with the file's own
directory as the working directory, and replaces that file's *ordinary*
configuration with what the command prints on stdout. The declaration itself is
never part of the effective config and is preserved (as the same JSON value, so
its formatting may be normalised) across the replacement, so the next run still
knows its command. `/quota-dispatch generate project` does the same for the
project layer; a project file's generator is not inherited from the global one.

The point is programmatic reuse: a program can compute the table — swap a
pinned Opus and Sol while keeping the planner's and reviewer's opposing primary
preferences — and print ordinary configuration JSON. No new routing vocabulary
is needed, and none was added: routes, models and skill bindings mean exactly
what they meant when written by hand.

## What runs, and when

The command runs **only** on the two explicit generate forms. It never runs on
load, `/reload`, `session_start`, a poll tick, or `/skill:` input. A file that
declares a generator behaves, on every other path, exactly like a file without
one, which is what keeps an expensive or side-effecting program from being
invoked by accident. This is deliberate: a generator is trusted user code, and
the only safe trigger is the user typing its name.

A run is **bounded**, not sandboxed. The command runs in its own process group
(POSIX) with stdout capped at 1 MiB and stderr kept as a 16 KiB tail; on timeout
or overflow the group is killed and the run fails, without waiting on a pipe a
descendant holds open. stdin is a pipe carrying the rail readings document
(below), closed once it has been written, so a command that reads it gets the
document and one that never reads it has its writes fail without that being the
run's verdict. What that does *not* promise is containment: a
descendant that deliberately detaches survives, and side effects the command
performs are the command's own. There is no rollback of a generator's work, only
of this extension's.

## Layer semantics

The output replaces **one layer**, not the merged configuration. A global
generator produces a global layer; the project file is still read from disk and
still wins where it states something. A generator cannot express "the whole
effective config" and must not try to.

The output is validated **all-or-nothing**, and that is the one place generation
differs from ordinary loading. An ordinary load is tolerant by design: an
invalid value warns and the previous value stands, so a typo cannot take the
dispatcher down (see [0011](0011-an-unusable-config-file-is-reported-as-such.md)).
Accepting part of a generated layer would be the wrong failure: the generator
printed a whole layer, and keeping the half that parsed would activate a
configuration nobody wrote. So any problem *in the generated layer* rejects the
whole run and leaves the file and the active configuration unchanged. Warnings
that are not the generated layer's own — one from the other layer, a model this
pi does not know, an agent with no file — do not reject, because they are not
something the generator got wrong.

Making that true needed a real check, not just "reject the warnings". Tolerant
loading never looks inside an entry a skip flag parks, and it silently keeps the
old `alternates` when an element names neither a model nor a rail. Both are
right for a hand-written file and both are holes in an all-or-nothing check, so
the strict path validates supplied fields before a skip instruction acts and
rejects a candidate that cannot complete (see
[0002](0002-removal-and-alternates.md)). The findings that are about the
*environment* rather than the config — a model this pi does not know, an agent
with no file — stay warnings, because they are not things a generator got wrong
(see [0009](0009-unknown-models-at-startup.md)).

## Publication and activation

The order is: read the target, validate the declaration, gather the rail
readings, run the command outside any lock with those readings on its stdin,
validate the exact bytes to be written, build the runtime the new configuration
implies, take the same-extension write fence, then take the file lock, compare
the bytes the run started from, and rename the new file into place.

Every step before the rename is failure-preserving. A nonzero exit, a timeout,
unparseable output, an invalid entry, a configuration that cannot be built into
a runtime, a lock held by another process, or a target edited while the command
ran all leave the file's bytes and the active configuration exactly as they
were. A changed target is reported, not overwritten: the external edit wins.
Once the rename lands the change is committed, and a later failure — releasing
the lock, evaluating the new policy, a UI error — is reported as a note rather
than as an unchanged state, because the file has already moved.

Activation is immediate: the new file is published, the in-memory configuration
is swapped so the two cached handles agree, the poll cadence is rescheduled from
the new `pollMs`, and the new policy is evaluated once, exactly as
`session_start` would — including doing nothing when the generated table manages
no agents, so an empty table costs no vendor request. No `/reload` is needed.
That immediacy is local to this pi process: another running session keeps its own
configuration until it reloads. Evaluations already in flight on the old
configuration are drained just before publication and new ones are fenced for
that instant, so an old pass cannot write after the new one. The boot a fenced
evaluation uses is read when the evaluation starts, not when it was requested,
so a `session_start` cannot evaluate the superseded policy after the fence is
released. Its whole body — the empty-table gate, the announcements and the
evaluation — runs on that one boot; a `session_start` that arrives while the
fence is up waits for the release instead of being dropped, because the
session's first spawn is held on its evaluation. A poll tick is dropped (the
next one catches up) and `apply` is refused (the user can try again). The fence
is not a scheduler and does not arbitrate between processes (see
[0013](0013-agent-file-writes-are-coordinated.md)).

## The generator's input

Every run writes one JSON document to the command's stdin and closes the pipe. It
reports what the **active** configuration's dispatcher already knows: the
readings are the ones its two credential paths produced, since those are the
paths in force before the run, and a generator is being asked what to change
*because of* what they say. The shape is versioned (`version: 1`) and every rail
key is always present. A capped rail is never sent empty, though: one with no
usable reading refuses the run, so `rails.codex` being present is a promise the
generator can rely on rather than a key it has to test.

It is the cheapest honest input, not a fresh one. A reading the dispatcher
already holds is sent **whatever its age** — generation is explicit, so the
numbers describe the moment the user asked rather than the moment a vendor
answered — and there is no forced read and no `generate refresh` form. Only a
rail with no reading at all is read, once and unforced, before the command
starts. The readings are no longer the dispatcher's private memory: they live in
the shared [rail readings file](0016-shared-rail-readings.md) (ADR 0016), so
whatever replaces a dispatcher — a `/reload`, or a generation whose publication
swaps in a freshly built one — no longer empties them, and a new dispatcher
serves a peer's or its predecessor's reading without a request. A generated
table that manages agents still warms the fresh dispatcher with its activation
evaluation, so the next generate usually costs nothing, but that is now an
optimisation rather than the only thing that can. An empty table has no
activation to warm it, yet its fresh dispatcher still finds whatever the file
holds, so an unconfigured install re-reads a rail only when the file has no
entry for it.

When the newest read of a rail failed, its **last good reading** is sent with a
`latestFailure` marker beside it, naming the newer failure and when it happened.
That is the one place a failed read does not simply hold: nothing is routed on
the reading here, and refusing every run whose cache held a failure would take
generation away on a transient 500. The alternative — sending the failure, with
its empty windows — was rejected because it tells a generator less than the
input already holds.

If `claude` or `codex` has **no successful reading** in what the dispatcher
holds, the generator is not run: the failure names the rail and why, and the file
and the active configuration are left as they were, like any other generation
failure. Without a single reading the command could not make the choice it exists
to make, and a placeholder is the guess [0006](0006-bounded-quota-reads.md)
refuses to route on. The refusal covers only a failure with no earlier success: a
failure that left a last good reading behind is sent as that reading instead, so
an install whose vendor is flaky can still generate.

A cached failure is deliberately **not** retried, even though it may be one
transient error standing between the user and a working generate. "A rail with no
entry at all is read once" makes a recorded failure an entry, and re-reading it
is the forced read this design does not have. The refusal is not silent about it:
it names the rail, quotes the failure, and points at `/quota-dispatch refresh`,
which is a forced read the user asked for. A configured install also recovers on
its own, because the poll re-reads the rail once its `ttlMs` has lapsed, within
about a polling interval; an unconfigured one has no poll, so `refresh` is the
way out. The known consequence is that an install with only one of the two
quota-capped rails cannot generate.

The document is **facts only**; what each field means is the README's
["What the generator reads on stdin"](../../README.md#what-the-generator-reads-on-stdin)
section, which is the canonical contract. It carries the vendor's response body
beside the windows parsed from it (`raw`), because normalization drops what a
generator may need — a window no parser classifies, a limit flag, an account
figure. That body may carry account details, so it is for the generator and not
for a log. What the ADR fixes is why the document carries no verdict: it does not
say a budget is **tight**, because that judgment belongs to the policy, and the
policy is one of the things a generator's output may change — so a generator
receives the numbers and owns its own thresholds.

`generator.timeoutMs` covers the subprocess alone, starting when it is spawned.
Gathering the readings happens before the spawn and is bounded by the quota
read's own limits (ADR 0006), so a slow vendor cannot consume the command's time
— which is why the readings reach the runner as text rather than as a promise it
would have to wait on.

Reading stdin is optional: a command that ignores it, or exits before reading it,
is not a failure. Success stays the process's exit status. A stdin write error
that means the reader is gone — the contract's own case — is not the run's
verdict either; one that means anything else is a write this run could not make,
so it fails the run like any other failed write.

The readings live in the dispatcher's memory, and the generator path reads them
through one dispatcher method, `knownReadings()`. That method is the seam a later
change re-backs when readings are shared across pi processes — and the reason
nothing else in the generator path reads the cache directly. It is deliberately
**age-blind**: a cached entry is returned whatever its TTL, unlike
`railReadings`/`allReadings`, whose TTL is the policy's freshness rule for
routing. #61 must preserve that, because the caller is asking what is already
known, not what is fresh: a shared store still answers per rail and credential,
and must not start applying a freshness rule the policy owns. The per-rail
projection is a pure function of the readings, so the contract is testable
without a dispatcher, a clock or a subprocess.

## Considered options

A `generator` that produced the *whole* config was rejected: it would make the
project layer meaningless, and precedence is the one thing the two-file layout
exists to express.

Loading the generator's output tolerantly, like any other file, was rejected for
the reason above: a partially accepted layer is a configuration nobody wrote.

Running the generator on load or on a poll was rejected. It would make `/reload`
and every session start do arbitrary work, and would give a flaky or slow
program the power to move agents without being asked.

Reusing pi's own `exec` helper was rejected: its capture is unbounded, its exit
status is ambiguous when a signal killed the child, and its timeout leaves the
process alive. A small local runner is the bounded thing the contract needs, and
it is not a sandbox either way.

Feeding the generator only on request, or not at all unless the generator
advertises that it wants the document, was rejected: the two explicit forms are
the whole opt-in, a flag inside the config would be a second one, and a generator
that had to be told it may read stdin could not be written portably.

Forcing a fresh read before every generation was rejected: it would make an
explicit form pay a vendor round trip whether or not the user wanted fresh
numbers, and it would tie generation's latency to vendor health beyond the
refusal rule. Sending an empty or unknown reading in place of a never-read rail
was rejected for the reason the refusal exists — a generator would be choosing on
a guess.

Handing a generator the **failure** when the newest read failed, instead of the
last good reading, was rejected: the input already holds real numbers and when
they were taken, and a generator that is told both is strictly better served than
one told the read failed.

Templates, a `swap` policy, or per-agent "primary preference" keys were
considered and rejected: they would grow the routing vocabulary to serve one
use, where a generator that prints ordinary JSON adds none.

## Consequences

The command and its `timeoutMs` are validated where they are declared; a
malformed declaration warns on an ordinary load and fails a generate. A
generator's output is validated against the layer beneath it, so a route the
output leaves out falls back to the other layer rather than disappearing.

The extension now starts a process and writes a config file, both of which it
did not do before; both are behind an explicit form the user has to type, and
the README warns that a project-declared command is code the repository ships.

How a generator is written is out of scope here: like `apply`, generation makes
the dispatcher's answer durable, and making an external program produce that
answer is the user's to build.
