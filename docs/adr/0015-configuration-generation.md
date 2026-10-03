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
descendant holds open. stdin is the null device, so a command that reads it sees
EOF rather than blocking. What that does *not* promise is containment: a
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

The order is: read the target, run the command outside any lock, validate the
exact bytes to be written, build the runtime the new configuration implies, take
the same-extension write fence, then take the file lock, compare the bytes the
run started from, and rename the new file into place.

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
