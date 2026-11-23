# A config edit is adopted by the next pass

The effective configuration was resolved once per extension load, and `/reload`
was the only way to pick up an edit. That is the same deal as every other pi
config file, and it is wrong for this one, because this file is the *policy*: it
says which rail an agent may sit on and at what percentage it must move. A user
who lowers `weeklySwitchAt` from 90 to 80 and sees nothing happen has no way to
tell whether the threshold is wrong, the edit did not land, or the session never
read it. There is no line anywhere that says "this session is still on the file
it booted with".

Config is now **revalidated** before every pass: each `/quota-dispatch` form that
boots, `refresh-codex`, each poll tick, `session_start`, and an explicit
`/skill:` invocation. A pass stamps the two config files — the global layer and
the project one — and compares them with the stamp taken for the configuration in
force. If nothing moved, that is the whole cost: two `stat`s. If something moved,
the files are read, merged and booted exactly as a load would, and the resulting
configuration is **activated**: the cached configuration and the boot built from
it are exchanged together, the footer is redrawn, and the poll cadence is retaken
from the new `pollMs`. `/reload` remains what picks up a changed *extension*.

Activation does **not** evaluate. What a new policy should do next belongs to the
caller: a generation writes because that is what `generate` is for, a poll tick
evaluates immediately after, `apply` forces a pass, `session_start` runs the
session's own pass — and a report must write nothing at all. An activation that
evaluated made every one of them write, so `/quota-dispatch` after an edit
rewrote agent files before it showed what it would do, and `config`, documented as
costing no request and no write, did both.

## Why a stamp and not the file's contents

A pass has to be able to ask "is this still the config?" more cheaply than
re-reading, or a file that is unusable would be re-read on every tick — a load, a
warning in the log, a boot — every `pollMs`, for as long as the fault lasts. A
stamp of `mtimeMs`, `ctimeMs`, `size` and `ino` per file answers it with one
`stat`: an in-place write moves the times, an editor's or a generator's
rename-replace moves the inode, an appended route moves the size, and a `chmod`
moves the ctime and nothing else — which is how a config file that was readable
and became unreadable, or the reverse, is noticed at all.

Hashing the bytes instead was rejected: it reads both files on every pass to
answer a question a `stat` answers, and it does not remove the ordering rule
below, so it buys exactness the inode already provides for a price paid on the
path that must stay cheap.

The stamp is taken **before** the read that produces the configuration, never
after it. Taken after, an edit landing mid-read would be recorded as adopted by a
load that never saw it, and the file would then have to be edited again to be
picked up. Taken before, that same edit leaves a stamp that looks stale to the
next check, so the worst case is one extra re-read.

A file that cannot be examined is part of the stamp, with its error code, so that
it settles: without it the two sides could never be equal and every pass would
re-read a broken file.

What no stamp can see is a same-size in-place save inside one timestamp granule —
HFS+, FAT and some network shares report to the second, and a shared VM config is
a real setup for this file. That edit waits for the next save. It is the one
shape of missed edit this design accepts, and the alternative (comparing contents
on every pass) was rejected above rather than overlooked.

## The check is outside the fence; the activation is inside it

The fence (ADR 0015) orders evaluations against the publication of a new
configuration. Only the publication needs it: a `stat` comparison cannot race a
pass into writing a file. Taking the fence to *ask* would park every command
behind whatever pass is in flight — a pass that may itself be waiting minutes on
another process's agent-file lock (ADR 0013) — for a question one `stat` answers.
So the check runs outside, and the fence is taken only once an edit has been
found, wrapped around the read, the boot and the activation.

Inside the fence the check is asked again. A generation holds the fence across
its own file publish, so a revalidation that read the file before that publish
and activated afterwards would bring back the configuration the generation had
just replaced. Re-reading both sides under the fence makes the answer "what is
active now" rather than "what was active then".

Being a second holder made a latent flaw real: the fence was a flag, so two
`acquire` calls both "held" it and whichever released first lowered it for both.
Nothing arbitrated between them because a generation was the only holder.
`acquire` is now exclusive — a second holder waits for the first to release — and
the flag stays up until the last one does.

## A generation carries no stamp

A generation activates the file its own run wrote, and that configuration was not
read off the pair of files: the generated layer came from the command's stdout and
the other layer was read before the run waited for the fence. A stamp taken after
the rename would record anything that changed during that window as already
adopted, and lose it until the file were saved again.

So a generation's activation has no stamp, and the next pass reads both files
once and settles. That single re-read is also what makes a hand edit racing a
generation harmless, without any of the guessing a stamp would need.

## An unusable file is activated, not held

A save that leaves the file unparseable is adopted as a `/reload` would adopt it:
the layer is skipped whole, the layers beneath it stand, the warning reaches the
log and the report's warning tail, and the next save repairs it. Holding the old
configuration instead was rejected. It would make a save mean something different
from a reload, and a session quietly running a policy the file no longer states is
the exact failure this decision exists to remove.

It is also the safe direction here, which is not obvious: the dispatcher's
product is a write to an agent file. A skipped layer can empty the table, and an
empty table decides about nothing and evaluates nothing — no route names a file,
so no file is written. The route that a half-written file removes is not
rewritten on the strength of it; it is simply not managed until the file is fixed,
which is what the footer and the report then say.

## What a watcher would add, and why it is not here

`fs.watch` would adopt an edit without waiting for the next tick, and it was
deferred rather than refused. It does not remove any of the above: the same
`revalidate` call is what a watcher would make, so the seam is one function.
What it adds is its own set of shapes to get right — both files are replaced by
rename, so the directory would have to be watched and the watch re-armed after
each save; a burst of events from one save needs debouncing; and a watched
directory on a network mount or in the VM this config is sometimes shared with
can silently stop reporting. The tick already bounds the delay at `pollMs` (five
minutes by default), and any command that boots adopts immediately, which is the
loop a user is actually in when they change a threshold.

## Consequences

The delay is bounded, not zero: an edit is adopted by the next tick unless a
command or an invocation runs first. A table that routes nothing has no tick at
all — `scheduleTimer` is what skips it, so an install with nothing configured is
only adopted from when a command runs, which is what its notice tells the reader
to do.

Nothing announces an adoption on its own — a background pass must not interrupt —
but it does leave one log line naming the files, because a policy that changed
under a running session is exactly the state a reader of the log has to be able
to account for. Which layer is in force, and what the current policy decides, is
the report's job; the footer carries the states that would otherwise be invisible
(a gauge that can no longer be drawn, an emptied table, a model this pi does not
know).

Each process still holds its own configuration, so two sessions adopt at their
own pace — at each one's next pass — where before both needed a `/reload`. The
cross-process warning in the README (two sessions on opposing policies rewriting
the same files every `pollMs`) does not go away; it becomes self-correcting
rather than manual.

The generated-file path is unchanged in what it means: a declared
**configuration generator** is still run only on the two explicit `generate`
forms and never by a revalidation, so an edit to a *source* that a generator
prints from (a `.cue` file, say) still needs that generator run. Adoption makes
the generated file live; it does not make the generator automatic.

A session can now hold a configuration different from the one it booted with,
which is why the stamp and the configuration are one value (`ActiveConfig`)
rather than two caches that could disagree.
