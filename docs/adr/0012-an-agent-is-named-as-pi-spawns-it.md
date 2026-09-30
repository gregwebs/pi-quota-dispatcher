# An agent is named as pi spawns it

A route is keyed by an agent name, and pi spawns an agent under a name it reads
from the agent file. The dispatcher used to decide both of those for itself, and
both were wrong.

pi's rule is one line of the subagents plugin: a custom agent's name is its
frontmatter `name:`, trimmed, when that is non-empty, and its filename stem
otherwise. Any case and any characters are legal; a *declared* name containing
`:` is the single exception, and such a file is skipped whole because the plugin
reserves that for its own scoped ids.

This repo's rule was `const AGENT_NAME = /^[a-z][a-z0-9-]*$/`, justified in its
own comment by "agent names are filenames: `<agentDir>/<name>.md`". That
justification is true of the path `<agentDir>/<name>.md` and false of everything
else. A name outside that charset was dropped at load, and the file that defines
an agent was assumed to be the one named after the route key.

The reported symptom was a `quota-dispatch.json` that routed `Plan` and
`Explore`, whose files are `Plan.md` and `Explore.md` and declare no `name:`. pi
spawns both. The dispatcher rejected both keys at load and managed neither, so
two agents stayed pinned to whatever their files happened to say.

## The name and the file are independent

One rule now answers both questions, and it is pi's:

> An agent's name is the name pi spawns it under: the file's declared `name:`,
> trimmed, when that is non-empty, else its filename stem. A file whose declared
> name contains `:` is not an agent at all. A route keyed by that name writes the
> file that declares it, and writes nothing when no file or more than one file
> claims it.

The middle sentence is not our policy, it is pi's: the dispatcher skips such a
file because pi does, so no route can point at an agent pi will never spawn.

The seam accepts a name when it is a safe single path segment and usable as an
object key, and rejects it otherwise — empty, `.`, `..`, `/`, `\`, NUL, or a name
from `Object.prototype`. That is the whole guarantee, and it is the one the old
comment already claimed to make: a name is not a naming convention, it is a
filename. Charset and case are pi's business; `Plan`, `Explore`, `v1.2`,
`snake_case`, `Code Reviewer` and a colon-bearing `a:b` are all names a route may
key. Two keys that differ only by case are distinct here and may name one file on
a case-insensitive filesystem; that is the OS's business, and resolution matches
pi-visible names exactly, so no route is ever written through a case-folded path.

Resolving a route key against the agent dir yields one of three states. One
readable file claims it: that file is the definition. None does: the definition's
file is the path `/agents` would create, `<agentDir>/<name>.md`, and it is never
written — the file already at that path may be some other agent, and editing it
would retarget that agent. More than one claims it: see below.

## A contested name is held

Two files can declare the same name, and pi does not refuse them: it keeps
whichever it loads last, in `readdir` order. Writing either file would be a guess
about which one pi spawns, and a wrong guess is a route that reports `written`
while pi spawns the other file on the old model. That failure is invisible from
outside, which is the kind this extension exists to avoid.

So a name claimed by two or more readable files is **held**: nothing is written,
the boot warning names the claimants in filename order, and every report carries
a `held` line with the same sentence. Holding is what CONTEXT.md's **Hold**
already means — assign nothing, leave the files as the user left them — and
containment failure already holds for a write outside the agent dir, so a
contested name is the same kind of fact. A misconfiguration a rename fixes should
not become a coin flip.

The startup snippet never proposes a contested name, for the same reason: a
pasted one would be held on its first boot.

## The no-file warning moved to boot

`loadConfig` can no longer make this check. S2 makes the file's name independent
of the route key and a declared name lives in frontmatter, whose parser is in
`index.ts`; `index.ts` imports `config.ts`, not the other way round, so the
config seam cannot read it.

The check is now `checkAgentFiles` in `index.ts`, run once by `bootOnce`
beside `checkModels`, and its lines join `loaded.warnings` between the load
warnings and the model warnings. That is `checkModels`' established shape — a
check that needs something `config.ts` cannot know runs at boot, warns through a
sink, and joins the same list — so the warning still reaches all three surfaces
that read `loaded.warnings`: the console log, the report's warning tail and
`/quota-dispatch config`. The only shift is that it is logged at the first boot
rather than at module load, and every surface a reader sees is post-boot.

`loadConfig` also loses `LoadConfigDeps.fileExists`. A function that loads config
files no longer looks at the agent dir at all.

## Provenance keys are quoted for an unusual name

The seam admitting `.` makes a flat dotted source key stop naming one agent:
`agents.a.primary.thinking` would be both agent `a`'s primary level and agent
`a.primary`'s route level, and disabling `a` would wipe `a.b`'s provenance.

So `agentKey(name)` spells `agents.<name>` for a plain identifier
(`[A-Za-z0-9_-]`) and `agents[<json>]` otherwise: `agents["v1.2"].primary.model`,
`agents["Code Reviewer"].thinking`. Each key then belongs to exactly one agent,
`clearAgentSources` can match a whole key or its `<key>.` prefix rather than a
bare `agents.<name>.` string, and every name the old rule accepted is plain, so
no existing key or expectation changed. The disabled marker is read back by
parsing that same encoding and round-tripping it through `agentKey`, so a key a
user wrote by hand is never mistaken for an agent.

## Considered options

**Keep stem identity, and document it.** The smaller change, and it leaves the
`Plan`/`Explore` bug in place: pi spawns an agent under its declared name, so a
route keyed by the stem of a file that declares one can never fire.

**Pick one claimant deterministically.** First by filename, or preferring the
file whose stem equals the name. Deterministic, and wrong about half the time —
the pass would report `written` for a file pi may not spawn.

**Write every claimant.** This routes correctly whichever file pi picks, and it
turns one decision into N writes, changes `Outcome` and the report layout, and
edits files the user may be keeping as stale copies. Too much surface for a
misconfiguration the user should fix by renaming.

**Inject a resolver into `loadConfig`.** `config.ts` cannot supply a correct
default — its only possible one is "stems of `*.md`", which reintroduces the
defect for any caller that forgets the dependency — and it would make a function
that loads config files depend on agent-file IO.

**Move the frontmatter reader into its own module that `config.ts` imports.**
A ~250-line move of code shared with `upsertModel` and `upsertThinking`, done
only so one warning can stay in one function. Worth revisiting if `index.ts` is
ever split; not needed for this.

## Consequences

`decide`'s containment check is now the only guarantee that a write lands inside
the agent dir. The seam proves a name is a path segment, not that a definition
is inside `agentDir` — `decide` may be handed a hand-built definition — so the
path check stays, and `decide` holds rather than assigning when it fails.

The agent dir is read once per pass rather than once at boot. That is deliberate:
a file created with `/agents` after the boot warning is written on the next pass,
as it is today, and a `name:` edited mid-session is picked up. The cost is one
`readdir`, its `stat`s and 64 KiB prefix reads every five minutes by default, a
cost `report` already paid.

An unreadable file now defines no agent. pi cannot read it either, so it is not
the agent pi spawns; it can only be the occupant of the path `/agents` would
create, and a route keyed by its stem is `skipped (no file)`. This also removes a
throw: such a route used to reach `applyDecision`, fail to read the file and
reject the whole pass.

Three divergences from pi's YAML reading are accepted, and the dispatcher does
not replicate the parser:

- **Typing.** The dispatcher reads a `name:` as text where pi types it as YAML.
  An unquoted `name: 123` is a non-string to YAML, so pi uses the stem while the
  dispatcher reads the literal `123` — a route keyed `123` would name a file pi
  calls by its stem.
- **Block scalars.** A block scalar (`name: >-`, with its text on the following
  line) is read as the literal `>-`, so the startup snippet proposes a key that
  can never fire.
- **Byte-order mark.** A byte-order mark before `---` hides the frontmatter from
  the dispatcher, which then uses the stem — and that one is not harmless: pi
  reads past the mark, so a BOM-prefixed `plan-work.md` declaring
  `name: Architect` is spawned as `Architect`, and the boot warning sends the
  user to create an `Architect` that already exists.

Replicating pi's YAML typing means depending on which schema its parser uses,
for names nobody writes, so the dispatcher does the smaller thing and stays out
of the parsing business.
