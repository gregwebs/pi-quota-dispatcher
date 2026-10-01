# A shared agent file is written under a lock, and replaced in one step

The agent dir is global state. Every pi under one OS user reads the same files,
and every project routes into the same set of them — a project layer decides
*what* gets written, not *where*, which the README has said in
[Caveats](../../README.md#caveats) since the project layer existed. What the
write itself did was this:

```ts
const src = await readFile(file, "utf8");
const next = upsertThinking(upsertModel(src, model)!, thinking);
await writeFile(file, next, "utf8");
```

Two passes that overlap on one file lose each other's work, and the loss is
silent: the second read happened before the first write, so the second write
puts back the first pass's `model:` line without ever having seen it — in the
benign case where the two passes agree, and in the harmful one where a project
override and a global route disagree. The rewrite also lands on a file another
process may be reading, and `writeFile` truncates before it writes, so a reader
can open the file in between and see a frontmatter with no `model:` line in it
at all.

Two changes, and they are deliberately separate guarantees.

## The lock is mutual exclusion; the rename is what a reader is owed

A pass now takes a **per-file lock** — a create-exclusive sibling file of the
**resolved target**, `<target dir>/.<target name>.lock` — and does its read, its
rewrite and its write inside it. For an agent file that is a link into a
dotfiles repo the lock is `<dotfiles>/team/.planner.md.lock`, which may be
outside the agent dir: the coordination lives where the file does, and the
*target's* directory has to be writable for it to work. `open(path, "wx")` is the
one primitive to hand that is genuinely atomic rather than a check-then-act, and
it needs no dependency: the package installs nothing. The protocol is a few
hundred lines once recovery and release are counted, which is the honest cost of
the no-dependency choice — a library would still leave us configuring its
recovery to this agent dir's semantics (see "Considered options").

It is taken only when there is a write to make. A pass reads first and answers
`unchanged` if the file already says what was decided — the lock exists to
serialise *writes*, and reading a file is what this extension did before any of
this. Two things follow, both wanted: a poll does not create and delete a lock
file per agent for no write at all, and an agent dir that refuses new files (a
read-only mount, a permissions accident) still reports on the agents whose files
are already right, instead of failing every pass on a lock file it cannot make.

The lock is the smaller of the two guarantees, and the one that can be lost. It
is what stops two cooperating passes from interleaving, and it says nothing
about a reader: a reader does not take locks, and pi's own agent loader will
never have heard of this file. What a reader is owed is the **atomic replace** —
write the new text to a temp file, `fsync` it, `rename` it over the target.
Same-directory `rename` is atomic, so a reader sees the old file or the new one
and never a truncated one, whether or not the lock was held at the time.

The temp file's name is unique to the write that made it — `planner.md.tmp.<pid>.<n>`
— and that is the difference between a lost update and a corrupt file. A lock can
be taken over, by a process that judged it stale or by two recoverers at once,
and a fixed staging name would make the two writers share one file: each would
write through the other's open handle, and the text one of them published could
be the other's half-finished bytes. Nothing is shared here, so whatever the lock
does, what is published is one writer's whole text or the other's. The cost is
that a crash between the create and the rename leaves a stray temp file behind;
nothing reads it, and it is not an `.md` file for pi to load.

That temp file is created `0o600` and given the target's mode only once its
text is complete, because an agent file is usually private and the mode it is
replaced *under* is not the mode it should be exposed at: a staging file that
inherited umask would offer a `0o600` agent's contents to every user on the
machine for as long as the write took, and for good if the process died in the
middle of it.

The path is **resolved exactly once**, when the lock is taken, and that one string
is what the read, the lock, the release and the rename all name. The lock is a
sibling of that resolved target, so the same file reached through two names — two
symlinks, or one directory under `/tmp` and `/private/tmp` on macOS — is one
lock. An agent file is allowed to be a symlink — `readAgentFiles` follows one on
purpose, and a user who keeps their definitions in a dotfiles repository has
exactly that — and the rename lands on the resolved target, so the user's link
survives rather than being replaced by a regular file that detaches the copy they
edit.

Publication does not resolve again. A *second* resolution is a second identity,
and the name can be changed between the two — a pass waiting on the lock has time
for exactly that — so it can follow a link the first resolution did not and land
this pass's bytes in a file it never locked, one another process may be holding.
Removing the second resolution is what keeps the read, the lock and the rename
naming one file. It does not cover a *directory* in the path being retargeted
mid-pass; that needs `openat` against the pinned parent, which Node does not
expose, so the parent must stay put for the critical section.

## A crashed process must not wedge the file forever, and a live one is not stolen from on `staleMs`

A live holder is not stolen from on `staleMs`, however old it looks, but it is
not protected forever either: the much longer `ABANDONED_LOCK_MS` is allowed
past it. A lock file left by a killed process is a file that would otherwise
never be removed, and a tool that stopped writing agent files because of a crash
three weeks ago is worse than one that never locked anything. So a lock is
judged three ways on what can be established about its holder:

- **gone** — the record names a pid on this host and `process.kill(pid, 0)` says
  `ESRCH`: the lock is stolen **immediately**, whatever `staleMs` says. Recovery
  from a crash is not a delay.
- **unknown** — the record names no pid, a pid on another host, or a pid this
  platform will not answer about: the lock is stolen once `now - at >= staleMs`,
  with `at` from the record and the lock's own mtime when the record has no
  usable one. This is the only thing `staleMs` still governs. A record with no
  `host` at all is read as *this* host — the field is newer than the locks
  already on disk, and treating absence as another machine would age a live
  holder out early. That is a compatibility assumption, not proof the pid is
  ours.
- **alive** — a pid on this host that exists (`EPERM` counts as alive): the lock
  is not stolen by `staleMs`, however old it looks. A stopped or slow holder
  keeps its file, and the other pass waits `waitMs` and then holds, its reason
  naming the pid, so a wedged process is visible and killable rather than
  silently overwritten. The one bound past that is `ABANDONED_LOCK_MS` (ten
  minutes): the critical section is one read, one rewrite and one rename —
  milliseconds — so a live-pid lock ten minutes old is an abandoned *release*,
  not active work, and protecting it until that process exits (which can be
  days) is the worse failure. The cost is symmetric and stated with it: a holder
  stopped inside the critical section for longer than ten minutes can be
  overtaken when it resumes.

The accepted price of not evicting a live holder on `staleMs` is the
pid-recycling hazard: a holder that crashed whose pid was recycled before the
next pass reads as alive, so the file holds — with the pid named in the report —
until that process exits or the abandoned-release bound clears it, whichever
comes first. Evicting on age alone would trade that rare stuck lock
for the everyday overlap of a paused writer being overwritten, which is the
guarantee the lock exists to give; the three-way split with a ten-minute bound
is the middle path, keeping a live holder through a realistic pause while still
freeing a release that never came. Even so, a live holder is *not* unconditionally
protected: a record with a foreign host or no pid is `unknown` and ages out, and
a creator interrupted before it publishes its record is aged out too (see
`stillHolds` below). The absolute rule a report needed — that this pass either
had a lock or held — is what the code implements, not "a live process is never
overwritten".

Removing a stale lock is itself a race, and it is the one place this protocol is
subtle: if the thief's verdict is based on a lock that the rightful owner has
already replaced, unlinking it deletes a *live* lock. The removal is therefore
guarded by a second `stat` immediately before the `unlink`, and does nothing
unless the inode and mtime are the ones the verdict was based on. A release is
guarded the same way, against the same interleaving from the other side, and it
checks the inode as well as the record so that a late release cannot delete a
lock that has been taken over.

Neither guard closes the window, and it is worth being exact about what that
leaves open. POSIX has no *unlink-if*, so between the `stat` and the `unlink`
there is always an instant: two processes can both judge the same lock stale and
both remove it, and the second can be scheduled at any point after its check —
even suspended there until the first has entered a whole critical section. It
therefore does not need both processes judging at the same *moment*; one
suspended recoverer is enough. When it happens, two writers are inside what the
lock was supposed to serialise. What that costs is an assignment, not a file:
each writes its own temp file and renames it, so a reader still sees one whole
version or the other, and the conflict rule still refuses to overwrite a model
that appeared under it. The file cannot be corrupted through this door; the worst
case is that the answer of whichever pass renamed last is the one that stands.

The same shape has two other ways in, and it is worth naming all three together
rather than pretending recovery overlaps one way only:

- the **two-recoverer race** above, where each of two processes clears the lock
  the other would clear;
- the **empty-record creator** — a creator paused between the exclusive create
  and the record write, whose empty lock a recoverer ages out and takes before
  the creator resumes. Before running its body the creator now checks that the
  lock at the path is still the inode it made (`stillHolds`), and if it is not,
  treats the miss as another writer's lock rather than entering alongside it.
  That closes this window for a creator; it does not close the two-recoverer
  race, which needs two processes to have already judged the same lock stale;
- the **abandoned release** of the `alive` case above, where a takeover of a
  live-pid lock past `ABANDONED_LOCK_MS` can meet a holder that was merely paused
  for longer than ten minutes.

```
  writer A                          writer B
  ─────────────────────────────     ─────────────────────────────
  create lock  ──┐
                 │  (A dies here)
                 ▼
  lock sits with A's record
                                    create → EEXIST
                                    judge: pid gone → stale
                                    stat(ino, mtime) ─┐
                                                      │ unlink, create
                                    <A's lock is gone, B's is in place>
                                    read, rewrite, rename, release
```

Patience is counted in **attempts** rather than in elapsed time. A wait loop
bounded by an injected clock can spin forever if a test's clock does not advance,
and how long we wait for a lock is not a fact that should depend on the clock
being real. Recovery is counted too: the loop has to be bounded by something the
code controls, and "clear it and look again" is otherwise a spin whenever a lock
reads as stale the instant it is made.

## The conflict rule compares against what the pass read

Serialization alone answers "who writes last", which is not the question a user
with two disagreeing configs is asking. So a write is also checked against the
line it was allowed to replace, and that line is taken from the **pass's own read
of the agent dir** rather than from a fresh read at write time. That distinction
is the whole mechanism: a fresh read under the lock would already contain the
other process's model and would look like the state the decision had been made
against.

With that base, a write may only replace the model it was decided against:

- the file still says what the pass read — the decision is applied, and anything
  else in the file that changed in the meantime (a body edit, a new `tools:`
  line, a re-quoted `name:`) survives, because the rewrite is applied to the
  **fresh** text and touches only the `model:` and `thinking:` lines;
- the file now says exactly what this pass would write — another process already
  reached the same answer, and the pass reports `unchanged` and writes nothing,
  which is how identical decisions converge without a write;
- the file now says some **third** model — another process assigned something
  different while this pass was deciding, and this pass holds, naming both
  models, instead of overwriting an answer that is at least as fresh as its own.
  A file left with *no* `model:` line at all is held the same way and given its
  own wording: the line this write was allowed to replace is gone, and
  `undefined` is not a model a report should send anyone looking for;
- the file said nothing and the pass read nothing — the same as the first case:
  there is no earlier answer to lose, so the model line is added.

A `thinking:` disagreement is not a conflict. A level is written forward only and
is never restored ([0004](0004-thinking-levels.md)), so it is already the one
value in the file whose contents depend on the order of past passes; treating it
as a conflict would hold a model change over a line the dispatcher will re-resolve
on the next alternate anyway.

The check cannot tell another pass from a hand edit: an editor writing a
`model:` line into that same window is treated exactly as a peer's assignment,
the file is left alone, and the next pass writes from whatever it then reads.
That is the wanted behaviour for both — the pass about to write is the one
holding the stale read — and the alternative, guessing the editor apart from the
peer, has nothing to go on.

A dry run does none of this locking. It writes nothing, and a report that could
block a real write — or fail because another pi was mid-write — would be a worse
report. It reads the fresh text, so the conflict it shows is the same check made
without the coordination.

## What coordination does not do

Coordination does not resolve a policy conflict, and it must not be described as
if it did. If two projects override the same agent with different models, each
pass writes its own answer and the file settles on whichever pass ran last; at
poll cadence the two can trade the file back and forth indefinitely. Nothing in a
shared file records which configuration put a model there, and there is no
principle that makes one project's answer win: both are correct for their own
config, and the file is the one thing they share by accident. The fix is for the
projects to stop disagreeing.

What a user can act on:

- a model another process writes **while this pass is holding the lock** is not
  overwritten by this pass — the pass holds and says so, on the report line,
  naming both models. The promise is exact about the instant: the check compares
  the model it finds on disk against the one the pass decided against, so a model
  *visible at that re-read* is never the one discarded. A publication that lands
  after that read is not detected, and can overwrite this pass's line — detection
  of a conflict is a comparison, not a lock on the other process's mind;
- an edit that landed before this pass re-read the file survives byte-for-byte,
  because the rewrite is applied to the bytes on disk and touches only the two
  lines the dispatcher owns.

A torn or partially written file is impossible. Two writers can be inside the
same file at once only through the overlaps enumerated above — the two-recoverer
race, the abandoned-release bound, and (before `stillHolds`) the empty-record
creator — and the cost of each is bounded: an assignment, not a file, and a
reader still sees one whole version or the other.

The preservation guarantee is bounded, and worth stating exactly: an edit that
lands *between* that re-read and the rename is lost, because this write has
already composed the bytes it is about to publish. That window is the
read-transform-rename of one file, and every read-modify-write has it — the
reason the re-read happens inside the lock rather than before it is to make the
window as small as it can be, not to pretend it is zero.

The semantics are otherwise unchanged. A written file is read by pi-subagents at
the next spawn, so an assignment applies to future spawns and not to work already
in flight or to the parent pi's model.

## Considered options

**`proper-lockfile`, or a lock directory instead of a lock file.** A dependency
would be the first runtime dependency in a package whose whole install story is
that it has none, and the library's own recovery rules (mtime heartbeats, a
compromise callback) would have to be configured to match the agent dir's
semantics anyway. `mkdir` is the other classic atomic primitive and is a worse
fit here: a directory cannot carry the holder's pid *by itself*, so recovering
from one would need a second record file beside it. That is added protocol
— another file to create, publish and clean up, and one more window in which it
and the directory disagree — not an impossibility; the single lock file carries
the record for free.

**Evicting any lock older than `staleMs`, regardless of liveness.** This is the
simplest recovery rule and what an earlier version implemented. It was rejected
because it makes every paused writer's lock the same as a dead one: a process
stopped at a breakpoint, or stalled in a slow `fsync` for longer than the bound,
loses its file to a pass that only measured the time — which is the overlap the
lock exists to prevent. The three-way split above replaces it: `staleMs` is the
bound for a holder that cannot be confirmed, and only the much longer
`ABANDONED_LOCK_MS` is allowed past a live pid, so a realistic pause is never
evicted while a release that never came still is.

**Locking the agent dir rather than the file.** One lock for a pass is simpler to
reason about and stops two passes from interleaving *anywhere*, but it makes
unrelated agents contend: a report on one agent would wait behind a write to
another, and a wedged holder would block the whole directory rather than one
file. The exclusion is needed at the granularity the state is shared at, which
here is the file.

**Last write wins, with no conflict check.** This is what the lock alone gives,
and it is cheaper. It is not enough: the case that motivates all of this is the
write that cannot have seen the line it is replacing, and a lock taken *after*
the stale read does not fix that — it serializes the writes and still lets the
second one clobber the first. The base comparison is what makes the stale read
detectable rather than merely unlikely.

**A sidecar claim recording which config wrote the model**, so that a pass whose
config is not the claimant holds, and one project's answer outranks another's for
good. It would be a real resolution rather than a detection, and it was rejected
because the ordering it imposes is arbitrary — two projects have no precedence
between them, so the rule would freeze whichever config happened to write first
— and because it makes the file's meaning depend on state this extension would
then own, keep fresh, and reconcile against hand edits. The claim would be wrong
the moment a user edited the `model:` line themselves, which is the same reason
[0004](0004-thinking-levels.md) refuses to remember a previous level.

**Replacing the file only when the content differs, without a temp file.**
`writeFile` after a byte comparison is what the code already did, and it is not
atomic: the comparison narrows the window in which a reader can observe a
truncated file, but does not close it. The rename is what closes it.
