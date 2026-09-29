# An unusable config file is reported as such, not as an unconfigured install

A file that does not parse leaves no layer, so the effective table is empty and
the startup path takes the unconfigured branch. That branch is right for a fresh
install and was actively wrong here: it raised

```
quota-dispatcher: no agents are configured, so nothing is managed yet.
Name them in ~/.pi/agent/quota-dispatch.json to start routing.
For example:
  … a paste-ready snippet built from the agent files it found …
```

to someone whose file is right there and names those agents. A trailing comma
had thrown the whole layer away, and the only other trace was a `console.error`
line carrying V8's own message:

```
~/.pi/agent/quota-dispatch.json: Expected double-quoted property name in JSON at position 27 (line 3 column 1)
```

That line says the file was dropped only if the reader already knows that a
failure to parse means one, and it points at a byte offset. It also scrolls past
at session start, the failure ADR 0009 already rejected for the unknown-model
case.

An install in this state now gets its own notice, on the same three reasons an
unconfigured install is asked on:

```
quota-dispatcher: a config file could not be used.
~/.pi/agent/quota-dispatch.json: not valid JSON (line 3, column 1: Expected double-quoted property name) — the file is skipped whole, so the layers below it still apply
Fix the file, then /reload. Run /quota-dispatch at any time to see what it would do.
```

## It is the same state when other layers still manage agents

An unusable layer is not the same as an unusable config. A project file with a
typo over a working global one leaves every agent managed and every route exactly
as written — except the ones the file was overriding, which are now the global
layer's values. Nothing about that is visible from the outside: it is the shape
ADR 0009 raised the unknown-model warning for, where the symptom of a real
problem and the symptom of a healthy setup are the same.

So the notification fires whenever a config file could not be used, not only
when it left the table empty, on the same three reasons the unconfigured ask uses
and silent on `resume` and `fork`. What the footer line says about it is the one
thing this leaves to a later change: the footer holds the two states that persist
silently across a `resume` — the unconfigured one and the unknown-model one — and
a skipped file that leaves a working layer behind has a standing record in
`/quota-dispatch`'s warning tail, which is a form the user can ask for.

That is deliberately short of ADR 0009's range, and the cost is that a session
resuming after the mistake was made says nothing about it. The obstacle is not
that a third state cannot be shown, it is that nothing owns the footer: the
unknown-model check sets it or clears it on every reason, so a skipped-file
status set beside it would be wiped by a check with no misses of its own. Doing
it properly means one place deciding the footer from both facts, with a rule for
which of two bad states the line names — a change to ADR 0009's own decision, not
a line in this one.

## One rendering of one fact, three places it is read

`unusableConfigFileLines` turns the files that produced no layer into `<path>:
<fault>` lines; `loadConfig` splices those into the warnings it returns and
logs, and `unusableConfigNotice` prints the same function's output. The report's
warning tail therefore carries the notice's line verbatim, which is the deal
`unknownModelNote` already keeps between the boot warning, the dropped-alternate
note and the report.

The notice takes the `ConfigFile`s rather than their lines. A function that says
a config file could not be used should not be able to be handed anything else,
and the fault is data the file's state already carries.

## The fault is a case, and `present` became one with it

`ConfigFile.present` was a boolean, and its own doc had to explain that a file
which does not parse is still `present`. That boolean is now `ConfigFileState`:
`absent`, `applied`, or `unusable` with a `ConfigFileFault` — itself a case, of
`unreadable`, `not-json` carrying the parser's diagnosis and position, or
`not-an-object`. Both answers the code needs fall out of the case: "is the file
there?" is every case but `absent`, and "was it skipped?" is a `kind` comparison
that cannot be wrong about which file it is reading.

The fault is typed rather than a finished sentence for the reason ADR 0009 gives
about its own data: a `string` fault is a sentence a test can write and the
loader can never produce, and the "a skipped layer costs this" clause would then
have to be remembered at every construction site instead of applied once, in the
renderer.

The alternative was to recover the skipped files from the warnings the load
already returns. Rejected: warnings are written for a reader, and taking them
back apart means matching on wording that the next reworded warning breaks.

## What the warning says, and what it leaves out

- **The parser's diagnosis, kept.** `Expected double-quoted property name` is
  what a trailing comma looks like, and no rewording of ours says it better.
- **The position, rendered as a line and a column.** Current Node reports
  `(line 3 column 1)`, an older one reports only `at position 27`; the offset is
  converted against the file's own text so both spellings render the same way,
  since a line and a column are what an editor is opened with.
- **No offset beside the line.** Same fact, second spelling, and the one that
  makes the reader count their way through the file.
- **No position invented.** The parser reports none when it quotes the character
  that stopped it — a trailing comma before a `]`, a byte-order mark — and none
  for `Unexpected end of JSON input`, which is what an empty file gives. The line
  says what the parser said and no more.
- **The parser quoting the file back, cut — before anything else is read out of
  the message.** V8 appends a window of the file around the failure, truncated on
  the left, the right, or both (`..."..."...`), with the file's newlines in it. It
  is not a reliable locator — that is what the truncation gives up — it is text
  the reader already has, and it would carry line breaks into a message every
  surface prefixes as one line. Cutting it first is also what keeps the file from
  speaking for the parser: a config whose value reads `at position 5` would
  otherwise be read as the parser naming a place the file never failed at.
- **A character the reader cannot see, spelled out.** The quoted character is
  whatever the file holds, so an invisible one arrives as `Unexpected token
  '\uFEFF'` rather than as a mark nobody can see, and a line separator cannot
  break the warning in two.
- **The consequence, on every file fault.** `the file is skipped whole, so the
  layers below it still apply`. A file that is not a JSON object and a file that
  cannot be read at all end with the same clause, because the reader's next
  question is the same one and the answer does not depend on the fault.

## Considered options

**Improving the warning and leaving the notice alone.** The smaller change, and
not enough: the notice is the one surface a user sees unbidden, and it was the
sentence that was wrong.

**Keeping the parser's quoted window as the locator.** It is the only locator
V8 offers for the character it could not place. Rejected in the list above: it is
truncated, so it does not point anywhere reliably, and it is the file's own text
in somebody's notification.

**Printing the offending line with a caret under it.** Better for a one-line
file, and impossible in this shape — a caret needs a second line, and a warning
that is two lines breaks the report's `  warning: ` prefix. Where the parser
gives a line and a column, those already locate the character.

**A special case for the empty file** (`the file is empty`). One more branch and
one more test for a case the parser names itself, and the position-free
rendering already covers it. A `touch`ed config reads as `not valid JSON
(Unexpected end of JSON input)`.

**A third footer status for the skipped file.** Rejected in the section above,
pending a change to who owns the footer: one status line, two owners already,
and the unknown-model check clears it on every reason where it has no misses of
its own.

## What did not change

`unconfiguredNotice` is untouched: a missing file, and a file that parses and
names no agents, still get the ask and the paste-ready snippet, which is what
those installs need. When nothing is managed, the skipped-file notice replaces
the ask and the footer still says `no agents configured` — an empty table is an
empty table whether or not a file fed it.

`describeConfigLayers` still renders a skipped file as `present`. The layers line
answers "which files am I reading?", and the file is there — reporting it as
absent would send someone looking for a file that is right where they left it.
The fault is a separate fact with a separate line.

A load still never throws, and the console line is still the log of record. What
changed is that the line is written for a reader, and the two top-level readers —
the log and the startup notify — say the same sentence.
