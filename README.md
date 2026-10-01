# pi-quota-dispatcher

Keeps your [pi](https://pi.dev) agent config in sync with your subscription
headroom, so you stop hand-editing `~/.pi/agent/agents/*.md` every time a quota
starts to run low.

You already know the loop this replaces: check the quotas, notice one plan is
getting tight, edit the agent frontmatter, get back to work. This does the same
thing on a timer.

```
$ /quota-dispatch
claude: 5h 0%, 7d 27%
codex: 5h 0%, 7d 64%
deepseek: ok — metered

planner -> claude-bridge/claude-opus-5-5 (thinking: high)  [unchanged]  (claude ok (session 0%, weekly 27%))
reviewer -> openai-codex/gpt-6-astra      [unchanged]  (codex ok (session 0%, weekly 64%))

config: built-in < global ~/.pi/agent/quota-dispatch.json (present) < project .pi/quota-dispatch.json (absent)
```

The last line says which config layers were read. Where each *value* came from is
one command further, because it is a question you ask deliberately rather than
one you want on every run:

```
$ /quota-dispatch config
config: built-in < global ~/.pi/agent/quota-dispatch.json (present) < project .pi/quota-dispatch.json (absent)
  sessionSwitchAt = 75  [built-in]
  weeklySwitchAt = 80  [global]
  models.openai-codex/gpt-6-sol.rail = codex  [global]
  models.openai-codex/gpt-6-sol.thinking = low  [global]
  agents.planner.primary.model = claude-bridge/claude-opus-5-5  [global]
  agents.planner.primary.rail = claude  [global]
  agents.planner.primary.thinking = high  [global]
  agents.planner.alternates[0].model = openai-codex/gpt-6-sol  [global]
  ...
```

## Why

If you pay a flat monthly fee per provider, tokens are not the scarce resource —
**quota is**. The thing that costs you is hitting a wall halfway through a review,
or leaving one plan half-idle while the other saturates.

That is a routing problem, not a compression problem. It is also the kind of
routing decision that is easy to make deliberately and tedious to make
repeatedly, which is exactly what automation is for.

## Requires `@tintinweb/pi-subagents`

The files this extension edits are not a pi core concept. The agent dir holding
`<agent-dir>/agents/*.md`, the `name:`/`model:`/`thinking:` frontmatter read from
them, and the rule for which name an agent is spawned under all come from
[`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — the
plugin that reads those files on every spawn, and the one this extension writes
them for.

Install it alongside this extension:

```bash
pi install npm:@tintinweb/pi-subagents
```

Without it there are no agent files and nothing to route. The formats the
dispatcher depends on are that plugin's, not pi's, so a different subagents
implementation could read and name its agents differently; see
ADR [0012](docs/adr/0012-an-agent-is-named-as-pi-spawns-it.md).

## Install

```bash
pi install git:github.com/gregwebs/pi-quota-dispatcher
```

Or try it without installing:

```bash
pi -e git:github.com/gregwebs/pi-quota-dispatcher
```

Then `/reload`, and run `/quota-dispatch` to confirm it registered.

## First run: it says what it needs

Nothing is managed until you name it, so a fresh install fetches no quota and
writes no file. What it does instead is say so. On `startup`, `new` and
`reload` — not on `resume` or `fork`, which pick up work already in progress —
it raises a warning naming the config file to edit, listing the agent files it
found, and carrying a snippet you can paste:

```
quota-dispatcher: no agents are configured, so nothing is managed yet.
Name them in ~/.pi/agent/quota-dispatch.json to start routing.
For example:

{
  "models": {
    "claude-bridge/claude-opus-5-5": {
      "rail": "claude"
    }
  },
  "agents": {
    "planner": {
      "primary": {
        "model": "claude-bridge/claude-opus-5-5"
      }
    }
  }
}

Agent files found in ~/.pi/agent/agents:
  planner.md — model: claude-bridge/claude-opus-5-5
  writer.md — model: (none)

Then /reload. Run /quota-dispatch at any time to see what it would do.
```

The snippet is built from the model each agent file **already** declares, and
each model's `rail` is derived from its prefix and registered once under
`models`, so the snippet is inert until you paste it. A file with no model, or
with a model whose prefix is not one of the rails this extension reads, is
listed but left out rather than guessed at.

While the table is empty, a footer line (`quota-dispatcher: no agents
configured`) holds the state, and clears as soon as a route exists. In modes
with no footer there is nothing to render, so neither the ask nor the status is
shown.

`/quota-dispatch` still works while unconfigured: it prints one line per rail,
which is the diagnostic you want when the quotas are what you came for. It is
also where **unmanaged** files are reported — any agent file whose agent no
route names is listed by the plain and `refresh` forms. The startup ask mentions
them only while the table is empty; a configured install does not narrate the
files it deliberately does not manage.

Config is read once per extension load, so `/reload` is what picks up a new
route — and what stops the ask.

### When the file is there but unusable

An install whose config file cannot be used is a different state, and saying
"name your agents" to it is telling its owner to do what they already did. So it
gets its own notice — on the same three reasons an unconfigured install is asked
on — leading with the fault and ending with the fix:

```
quota-dispatcher: a config file could not be used.
~/.pi/agent/quota-dispatch.json: not valid JSON (line 3, column 1: Expected double-quoted property name) — the file is skipped whole, so the layers below it still apply
Fix the file, then /reload. Run /quota-dispatch at any time to see what it would do.
```

The line under the headline is the same sentence the log and `/quota-dispatch`
print. A file that is not a JSON object, and one that cannot be read at all, are
the same state and get the same treatment.

The notice fires whether or not the layers below the skipped one still manage
agents: a route that quietly is not the one you wrote looks the same from the
outside as a route you pinned, which is why a model this pi cannot spawn is
surfaced the same way (see [below](#a-model-this-pi-does-not-know)). It is not a
footer state — the footer line holds the two states that persist silently across
`resume` and `fork` — so the standing record is the warning tail of
`/quota-dispatch`, where the skipped file is named whether or not a notification
was ever seen.

Where the parser reported a place, the line names the line and column of it. The
parser reports one for a structural failure — a trailing comma before a `}`, a
missing comma — and reports only the character it could not read when the file
is malformed in a way it struggles to place (a trailing comma before a `]`, a
byte-order mark). Both are spelled out rather than guessed at, so a character
the reader cannot see arrives as an escape (`Unexpected token '\uFEFF'`), and
when the parser names no place at all — `Unexpected end of JSON input`, which is
what an empty file gives — none is invented.
[0011](docs/adr/0011-an-unusable-config-file-is-reported-as-such.md) has the
reasoning and the options not taken.

## A model this pi does not know

The other state that needs a person is a config that names a model the running pi
cannot spawn. Agents are not left broken by it — an unknown **primary** holds its
agent, an unknown **alternate** is dropped — but nothing moves or gets written
until someone fixes the id, so the same three reasons raise a warning-level
notification listing every occurrence and the file to edit:

```
quota-dispatcher: a configured model is unknown to this pi.
agents.reviewer.primary.model: this pi does not know model openai-codex/gpt-astra-6 — a newer pi may
agents.reviewer.alternates[0].model: this pi does not know model openai-codex/gpt-sol-6 — a newer pi may
Edit ~/.pi/agent/quota-dispatch.json, then /reload, or upgrade pi.
```

One message per session however many ids are wrong, one line per occurrence, and
the file named is the layer the id is actually written in — a project-layer typo
names the project file. The line under a held agent says "unknown **to this pi**"
rather than "invalid", because a newer pi may well know the id.

A footer line (`quota-dispatcher: a configured model is unknown to this pi.`)
holds the state on every reason, including `resume` and `fork`, where no notify
is raised: a resumed session still has to be able to see that the dispatcher is
stepping over a model. A pi with no model registry cannot answer the question at
all: the check does not run, so no warning is raised and the footer is only
cleared, as on any configured install. Everything here is an addition to the
log, never a replacement for it: each miss is still written to `console.error`,
`/quota-dispatch` ends with the same lines as its warning tail, and
`/quota-dispatch config` repeats them at the end of its provenance block — which
stays the durable record. More in
[0009](docs/adr/0009-unknown-models-at-startup.md).

## Commands

| Command | Effect |
|---|---|
| `/quota-dispatch` | Show rail budgets and the current decision per agent, plus any agent files no route names. Read-only. |
| `/quota-dispatch refresh` | Force a re-fetch, then show. Read-only. |
| `/quota-dispatch config` | Print where each configured value came from. Local, so it reads no quota and touches no file. |
| `/quota-dispatch apply` | Write the decisions out now. The only form that touches a file. |

The argument is a form name and nothing else, matched whole: `/quota-dispatch
refresh apply` is not read as `apply`, and a word that names no form is answered
with the list above rather than silently showing the report.

The two reporting forms are read-only by construction — `report()` has no way to
be asked to write, so "show me the state" cannot rewrite your agents — and
`config` never gets as far as a rail: it is answered from the config files, so it
works when a vendor is unreachable or you would rather not spend a request.

`/quota-dispatch config` is also what answers "why is reviewer on gpt-6-astra?"
without opening three files. The report keeps the one line that says which layers
were read, and every warning: neither is provenance, and a config that is not
doing what you meant has to say so on the run that read it. More in
[0010](docs/adr/0010-report-and-provenance-are-separate.md).

## Configuration

Configuration lives in JSON files you own, not in the installed package — so
`pi install`/update cannot silently revert your agent routes:

| Layer | Path |
|---|---|
| built-in defaults | `defaultConfig()` in `src/config.ts` |
| **global** | `<agent dir>/quota-dispatch.json`, normally `~/.pi/agent/quota-dispatch.json` |
| **project** | `.pi/quota-dispatch.json` (the project Pi config directory) |

The agent dir comes from `getAgentDir()`, so `PI_CODING_AGENT_DIR` and a
rebranded distribution's config directory are honoured; the project path is
built from pi's `CONFIG_DIR_NAME` rather than a hardcoded `.pi`.

**Nothing is managed until you name it.** `agents` ships `{}` and an agent the
file does not name is never touched — not routed, not rewritten, and read only
for its `model:` when a report lists it as unmanaged. That is deliberate: this
extension writes to agent files, so a shipped table of names would edit files
you never mentioned and move work onto rails you never chose.
A fresh install says so and offers a snippet built from the files it found — see
[First run](#first-run-it-says-what-it-needs). Copy this into
`~/.pi/agent/quota-dispatch.json` and adjust the names and models to your own:

```json
{
  "models": {
    "claude-bridge/claude-opus-5-5": { "rail": "claude" },
    "openai-codex/gpt-6-sol": { "rail": "codex", "thinking": "low" }
  },
  "agents": {
    "planner": {
      "thinking": "high",
      "primary": { "model": "claude-bridge/claude-opus-5-5" },
      "alternates": [{ "model": "openai-codex/gpt-6-sol" }]
    }
  }
}
```

Each agent is keyed by its **name** — the name pi spawns it under: the file's
`name:` when it declares one, otherwise the filename stem (`Plan.md` → `Plan`;
`plan-work.md` declaring `name: Architect` → `Architect`). A route writes the
file that defines its agent, wherever that file sits in the agent dir. Each route
gives a `primary` and an `alternates` list. A candidate names a
`model`; the `rail` it draws on is registered once for that model under
`models`, so a route never repeats the account. A candidate may still state its
own `rail` (which outranks the registration) and a `thinking` level, and a route
or a model may state a thinking default — see [Model rails](#model-rails) and
[Thinking levels](#thinking-levels).

An agent name outside letters, digits, `_` and `-` is quoted wherever a
configured value is named — `agents["v1.2"].primary.model`,
`agents["v1.2"] = disabled [project]` — so that a dotted key always names
exactly one agent.

**Precedence: built-in < global < project**, deep-merged per agent. A file only
has to state what it changes:

```json
{
  "weeklySwitchAt": 80,
  "models": {
    "claude-bridge/claude-opus-5-5": { "rail": "claude" }
  },
  "agents": {
    "reviewer": {
      "primary": { "model": "claude-bridge/claude-opus-5-5" }
    }
  }
}
```

That global file moves `weeklySwitchAt` and `reviewer`'s primary, registers the
model's rail once, and leaves every other agent and scalar alone. Merging inside
a candidate is field-wise, so a layer that names only a `thinking` level (or
only a `rail`) keeps the rest of the candidate beneath it. A layer that names a
`model` already registered in `models` re-resolves the rail from that model's
entry, so moving to another provider needs no rail restated; a candidate may
still state its own `rail`, and the loader warns when that disagrees with the
model's prefix. The `models` table is deep-merged the same way, per model id, so
a project file can register one model's rail without restating the rest.

### Model rails

A candidate names a `model`; the rail — the account whose quota that model's
calls consume — is registered once per model under `models`, keyed by the same
`provider/modelId` pi uses:

```json
{
  "models": {
    "claude-bridge/claude-opus-5-5": { "rail": "claude" },
    "openai-codex/gpt-6-sol": { "rail": "codex" }
  },
  "agents": {
    "planner": {
      "primary": { "model": "claude-bridge/claude-opus-5-5" },
      "alternates": [{ "model": "openai-codex/gpt-6-sol" }]
    }
  }
}
```

Registering it once keeps a route from restating the account on every candidate
that names the model. A candidate may still state its own `rail`, which outranks
the registered one, and a layer that moves a candidate to another model
re-resolves the rail from that model's entry rather than gluing the old one to
the new model. If the new model registers none, the move is rejected — the old
rail is not carried along and the loader warns to register one — while a rail
the candidate states itself is kept, field-wise. An invalid `rail` is warned
about and ignored; it does not block a model change beside it, which still
re-resolves. Either way a candidate whose model has no registered rail and which
states none of its own is rejected: there is no account to route to, so the
loader warns instead of guessing. The
model's prefix is **not** used as a fallback — the prefix is only checked
against the registered rail, and a disagreement warns, which is what turns a
mis-pointed route into a visible mistake rather than a silent route to the
wrong quota.

### Thinking levels

A **thinking level** is the `thinking:` line pi-subagents reads from an agent
file when it spawns it (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`). The dispatcher writes it beside the `model:` it chose, because the model
a budget can afford is often a model that should think differently. Three places
can state one, and the most specific wins:

| Place | Spelling | Meaning |
|---|---|---|
| Candidate | `agents.<name>.primary.thinking` (or `.alternates[i].thinking`) | This destination, whatever route it is on |
| Route | `agents.<name>.thinking` | The work: "planning thinks hard" |
| Model | `models.<provider/modelId>.thinking` | The model, wherever a route names it |

```json
{
  "models": {
    "openai-codex/gpt-6-sol": { "rail": "codex", "thinking": "low" },
    "claude-bridge/claude-opus-5-5": { "rail": "claude", "thinking": "high" }
  },
  "agents": {
    "planner": {
      "thinking": "xhigh",
      "primary": { "model": "claude-bridge/claude-opus-5-5" },
      "alternates": [{ "model": "openai-codex/gpt-6-sol", "thinking": "off" }]
    }
  }
}
```

Here planner thinks `xhigh` while it sits on Opus; on the codex alternate its own
`off` wins; any other agent that routes to Opus gets `high` from the model
table, and one that routes to `gpt-6-sol` thinks `low` unless its route or
candidate says otherwise. A level nothing states is **not** written: the file's
`thinking:` line is left as it is.

A level is validated for its *spelling* only. Whether a given model can do it is
not the config's business — pi clamps the level to what the model supports when
the agent is spawned, so `xhigh` on a model whose ceiling is `medium` runs at
`medium` rather than failing.

**The dispatcher makes no promise about that line beyond the pass it is making.**
It does not remember what your file said before, and it does not put anything
back. So on a route where only the alternates state a level, the level written on
the way out is still in the file on the way home: moving an agent back to a
primary that states none changes its model and leaves its `thinking:` alone. If
you want a level on the way home, state one — on the candidate, on the route, or
in the `models` table. Removing the line is yours to do as well; nothing here
does it.

### Adding, removing and parking an agent

An agent entry carries two entry-level **skip instructions**, read while the
layers are folded and never kept in the effective config:

| Spelling | Effect |
|---|---|
| `"disable": true` | Remove the agent, whatever lower layers said, and report it once as `agents.<name> = disabled [<layer>]`. |
| `"ignore": true` | This copy of the entry contributes nothing and warns nothing; a lower layer's route stands. It wins over `disable`. |
| `"disable": false` | Inert — the rest of the entry still applies. |
| `"ignore": false` | Inert, exactly as `disable: false`. |

`disable` and `ignore` are how you say "off" and "not this copy" without letting
a mistyped value do either by accident. A `false` flag asserts nothing, so an
entry carrying only flags names no agent route at all: on an agent no lower layer
defines it changes nothing and gets no `has no primary` warning (the only warning
such an entry can produce is about a non-boolean flag, and that one is the flag's
own), and `/quota-dispatch config`'s provenance block simply does not mention the
agent. `agent "<name>" has no primary` is for an entry that named a field of an
agent route — `primary`, `alternates`, or a `thinking` default — and could not
complete one: a candidate with no rail, or an `alternates` list with nothing for
it to hang from. There is **no `null`** anywhere: a `null` at the agent or candidate level
warns and leaves the previous layer's value standing — it removes nothing.

`alternates` is a **priority list**, consulted in order, and it replaces whole:

- A layer that mentions `alternates` replaces the entire list, and the list is
  accepted or rejected as a unit — one unusable element discards the whole list
  and the previous layer's list stands. Merging element by element would not be
  what a priority order means.
- `"alternates": []` (or no `alternates` at all) **pins the agent to its
  primary**: the primary is then assigned with no readability check and is never
  held, because there is nothing else the answer could be.

The list is never re-sorted by headroom — the first usable alternate wins —
because the order is the one piece of intent the numbers cannot express.
`disable` and `ignore` are entry-level only, a candidate carries `model` and
optionally `rail` and `thinking`, and a lone candidate object is not shorthand
for a one-element list.

| Key | Default | Meaning |
|---|---|---|
| `agents` | `{}` — nothing managed | Which agents are managed, and each one's `primary` and `alternates` list. Agents not listed are never touched. |
| `models` | `{}` | Per-model defaults, keyed by `provider/modelId`. `rail` and `thinking` are read; an entry for a model no route names is inert, though a `rail` that contradicts the model's prefix is still a wrong registration and warns. |
| `sessionSwitchAt` | `75` | Used-percent at which the primary's **session** budget is considered tight |
| `weeklySwitchAt` | `90` | The same for its **weekly** budget, deliberately higher — see [the policy](#the-policy) |
| `margin` | `10` | An alternate must be **more than** this many points healthier, on the budget that triggered the move |
| `sessionAlwaysSwitchAt` | unset — off | At or above it the primary's **session** margin is set aside and the first alternate, **in the order you listed**, whose session budget is strictly below it is chosen. Must be at least `sessionSwitchAt`; 0–100, fractional allowed. An invalid ordering in the final merged config warns and disables this override alone. |
| `ttlMs` | `180000` | How long a quota reading is reused |
| `pollMs` | `300000` | How often to re-evaluate while a session is open |
| `claudeRefresh` | `off` | Whether an expired Claude token is refreshed by running Claude Code once — see [Keeping the Claude token fresh](#keeping-the-claude-token-fresh) |

`claudeCredsPath` is settable too, defaulting to
`~/.claude/.credentials.json`; choosing a different Claude profile is a real
use. Naming **any other path** is a statement that the credential lives in that
file and nowhere else, which also turns off the [macOS keychain
fallback](#where-the-numbers-come-from) and makes `claudeRefresh` inert: the
keychain and the refresh ping both speak for this machine's **default** profile,
and reporting its headroom — or refreshing its token — while a different profile
runs would be worse than doing nothing. `agentDir` and `piAuthPath` (defaults
`<agent dir>/agents` and `<agent dir>/auth.json`) are deliberately **not**
settable from JSON: they are
paths pi itself owns, derived from `getAgentDir()`, so a file pointing them
elsewhere would only make the dispatcher edit files nothing reads. Relocate
them with `PI_CODING_AGENT_DIR`, and note that naming either in a config file
warns. Both remain fields on the config object for programmatic use and tests.

### Migrating from `routes`

An earlier version spelled the table `routes`; rename it to `agents` and give
each route an `alternates` list instead of a single `alternate`. The old spelling
is never read — a file that still says `routes` warns
`unknown key "routes" (renamed to "agents")`.

### When something is wrong with it

Bad configuration never stops the dispatcher from starting:

- **Missing file** — not an error. It is simply not a layer.
- **Unparseable file, a file that is not a JSON object, a file that cannot be
  read** — logged to `console.error` and skipped whole, and the layers below it
  still apply: a half-applied config is harder to reason about than the
  defaults. The warning names the file, says the layer was skipped whole, and
  locates the failure as far as the parser could — see
  [above](#when-the-file-is-there-but-unusable). A skipped layer is otherwise
  invisible, because what is left running is the layer beneath it and that looks
  like a config that works.
- **Unknown key, malformed `model` (no `/`), an unknown `rail` (on a candidate
  or in `models`), a candidate whose model has no registered rail, a `thinking`
  that is not one of the seven levels, a `models` key that is not a
  `provider/modelId`, a route left without a `primary`, an out-of-range number,
  an invalid agent name, a value of the wrong type** — logged, and the previous
  layer's value stands for that key alone. A typo in a project file cannot undo a
  correct global one. An invalid value never removes a valid one; removing an
  agent stays explicit (`disable: true`).
- **A skip flag that is not `true` or `false`, or a `null` anywhere** — logged
  and treated as absent, so the previous layer's value stands.
- **A final `sessionAlwaysSwitchAt` below the effective `sessionSwitchAt`** —
  logged once, naming both values and both supplying layers, and it disables
  only the override: `sessionSwitchAt` and every other value are untouched and
  the normal margin policy keeps running. It is a whole-config relationship
  rather than a per-layer mistake — a project `sessionSwitchAt` can overtake a
  global `sessionAlwaysSwitchAt`, and neither layer was wrong on its own.
- **A configured agent no agent file defines** — logged at boot, naming
  `<agent dir>/<name>.md`, the path `/agents` would create, and, when a file
  already sits there, what it is: another agent, a file pi skips as scoped, or
  one it could not read. Nothing is written for it.
- **Two agent files claiming one name** — logged at boot, and the agent is
  **contested**, so it is **held** on every pass until one is renamed: pi spawns
  whichever it loads last, so writing either would be a guess.
- **A model id this pi does not know** — a config can outlive the pi that
  validated it: an id renamed upstream, a typo, a config copied from another
  machine. Every configured candidate is resolved at boot against the running
  pi's registry, and each miss is logged once per occurrence, naming the key it
  came from (`agents.reviewer.primary.model: this pi does not know model
  openai-codex/gpt-astra-6 — a newer pi may`) and raised as a single
  warning-level notification on the three startup reasons, held by a footer line
  on every reason. An agent whose **primary** is unknown is **held**, so its file
  is left exactly as it is; an **alternate**
  that is unknown is **dropped**, and the alternates after it stay eligible. If
  every alternate on a route is dropped, the route is left with none — the same
  as `alternates: []` — so the agent stays pinned to its primary. Those two are
  not the same fact to the reader, so the report tells them apart: a route you
  pinned says `no alternate configured`, while one whose alternates were dropped
  says `every alternate was dropped — pinned to the primary` and then names each
  of them, one per line, in the wording the boot warning used. More in
  [0008](docs/adr/0008-dropped-alternates-explained.md) and
  [0009](docs/adr/0009-unknown-models-at-startup.md).

An agent name is the name pi spawns it under, any case or characters pi accepts
(`Plan`, `Explore`, `code-reviewer`). It is refused only when it cannot be a
single filename — empty, `.`, `..`, or containing `/`, `\` or NUL — or when it
is a built-in object property such as `constructor`. See
[0012](docs/adr/0012-an-agent-is-named-as-pi-spawns-it.md). `ttlMs` and `pollMs`
must be whole milliseconds in Node's timer range (1–2147483647); the switching
thresholds, `margin` and `sessionAlwaysSwitchAt` are used-percentages in 0–100. A
numeric warning always states the range it enforced.

Every warning names the file it came from, and the `/quota-dispatch` report ends
with the same warning lines — the provenance block repeats them — so a config
that is not doing what you meant says so instead of quietly routing you
somewhere else.

Config is read once when the extension loads; `/reload` after editing.

### Out of scope

Config can only route among the rails the extension already knows how to read
(`claude`, `codex`, `deepseek`). Adding a genuinely new quota rail — its
endpoint and response parser — still requires code, so there is no `rails` block
to configure.

## The policy

Deliberately small and stateless — the target model is a pure function of
current rail headroom, so re-evaluating is idempotent and the model cannot
drift. The one thing a file does not converge on is the `thinking:` line, which a
pass that resolves no level leaves alone; see
[Thinking levels](#thinking-levels).

Each rail reports **two budgets that move on very different clocks**, and they
are weighed separately:

- **session** — Claude's 5-hour window, Codex's `primary_window`. This is the
  acute cap. It is what blocks you mid-task, and it clears within hours, so
  acting on it is reversible.
- **weekly** — the opposite shape. It rarely blocks you, but when it does it does
  so for *days*, so a switch made on it is close to one-way.

1. **Session first.** If the primary's session budget is at or above
   `sessionSwitchAt`, the alternates are walked **in the order you listed them**
   and the first one whose session budget is more than `margin` points healthier
   wins. When `sessionAlwaysSwitchAt` is configured and the primary's session
   budget has also reached it, that margin is set aside for the rest of the
   walk: an alternate is eligible as soon as its session budget is **strictly
   below** `sessionAlwaysSwitchAt`, and one at or above it is refused whatever
   the margin would have said. The override activates at exactly the threshold —
   inclusive on the primary, exclusive on the destination — and it *replaces*
   the margin rather than widening it, so it never lands work on a rail already
   under the same pressure. It stays a priority walk, not a healthiest-rail
   rule. It reaches the session budget only: the weekly pass, the destination's
   other-budget guard and every hold still apply, and when no alternate
   qualifies the primary is preferred again.
2. **Weekly is a backstop.** If the session walk did not switch, the same walk
   runs on the weekly budget under its own `weeklySwitchAt`. Each comparison is
   like with like — session against the alternate's session, weekly against its
   weekly — so a spent week is not masked by a merely tight session: an
   alternate that is tight on the week is refused by both passes.
3. **The destination has to be somewhere worth going.** A rail is only a valid
   target if — besides being better on the budget that triggered the move — it
   is **not itself tight on the other budget**. A rail tight on its *other* cap
   would block the work just as surely, so switching there trades one cap for
   another rather than relieving anything. Without this, one pass can move an
   agent *onto* the very rail it moves another agent *off*.
4. Otherwise stay on the primary.
5. **Unreadable is not idle — but it only holds where it could have changed the
   answer.** A reading the dispatcher does not have is not evidence of pressure
   and not evidence of room; it holds only where the missing number could have
   moved the decision:
   - the **primary's** rail unreadable, or silent about a budget it should
     report, holds: that is the number that decides whether to move at all;
   - a primary that is readable and **below every threshold** is assigned even
     when an alternate is unreadable, because no alternate could have been
     chosen;
   - when the primary is tight, an unreadable alternate holds only if it comes
     **before** the alternate that would otherwise win, or if none of the
     readable alternates qualifies — in both cases the missing reading might
     have won.
   A hold carries no model, so there is nothing to write and every agent file is
   left exactly as you left it: `Decision` is either an assign or an explicit
   hold. A failed HTTP call must never move work onto the other plan — least of
   all back onto the rail that was under pressure. Reading a missing 5-hour
   window as "0% used" is how a rail that was blocked outright once came to look
   like the roomiest place to send work.

   A rail is only called unreadable once the reading was given a real chance:
   every request is bounded by a timeout and a request that failed for a reason
   another one could fix is asked again (see [Where the numbers come
   from](#where-the-numbers-come-from)). What the reading cannot tell apart, the
   note does. A note with no count is a reading that asking again would not have
   fixed: the endpoint's answer, however unhelpful — `HTTP 401`, a rate limit
   asking us to slow down, a 200 carrying none of the windows this rail reports —
   or a local store that had nothing to give. `HTTP 500 after 2 attempts` is the
   other kind: a rail that was asked twice and given up on. Both hold — the
   reading is missing either way — but a hold that says which one it was is
   explainable rather than looking like a refusal.

Worked through with `sessionSwitchAt: 70`, `margin: 30` and
`sessionAlwaysSwitchAt: 90`, one alternate, both rails readable:

| Primary session | Alternate session | Selected | Why |
| ---: | ---: | --- | --- |
| 69 | 0 | Primary | below the normal threshold — no switch considered |
| 70 | 39 | Alternate | gap strictly greater than `margin` |
| 70 | 40 | Primary | gap exactly `margin` does not qualify |
| 70 | 50 | Primary | alternate within `margin` |
| 89 | 85 | Primary | override not yet active; gap insufficient |
| 90 | 85 | Alternate | override active; the margin is ignored |
| 95 | 89 | Alternate | alternate strictly below the override threshold |
| 95 | 90 | Primary | alternate has reached the override threshold |
| 100 | 90 | Primary | both at or above it; primary preference restored |

With two alternates, **order** decides rather than headroom. Primary 95 / first
92 / second 85: the first is at or above the threshold, so it is skipped and the
second is chosen. Primary 95 / first 89 / second 20: the first is strictly below
the threshold, so it wins and the healthier second is never consulted — priority
order is the intent the numbers cannot express, see
[0002](docs/adr/0002-removal-and-alternates.md).

A model this pi cannot spawn is the opposite case: it is *known bad*, not a
missing reading, so it is dropped from consideration — a primary that cannot be
spawned holds, and an unknown alternate is dropped — because no reading could
make it spawnable.

A rail is *metered* when it is billed per token rather than quota-capped. That
is a real reading of zero pressure, not a gap, so unlike everything else in
rule 5 it never holds — which is what makes DeepSeek a usable resting place.

Weighing the two budgets as a single number is the obvious simplification, and
it is wrong: the weekly figure is almost always the larger of the two, so it
quietly becomes the only one that matters. A rail with a completely full session
budget then gets abandoned for days because its *week* looks busy.

Rails are per-provider: `claude-bridge/*` and `anthropic/*` consume the Claude
subscription, and `openai-codex/*` consumes the Codex subscription. `deepseek/*`
is metered per token rather than capped, so it reports no windows at all and is
never tight — it is the resting place.

One thing this deliberately does *not* do is predict exhaustion. A weekly budget
at 65% with a third of the week gone is burning at roughly twice its sustainable
rate, and a flat threshold cannot see that. Switching on pace is [issue
#4](https://github.com/gregwebs/pi-quota-dispatcher/issues/4).

## Design decisions

**It writes frontmatter; it does not inject a `model` parameter.** Injecting the
model into `Agent` tool calls is the more obvious implementation, but it only
reaches the `Agent` tool. `SubagentWorkflow`'s `agent()` and `@agent` mentions
spawn through the manager and bypass it, so they would silently keep a stale
model. pi-subagents re-reads agent files on every spawn, so a written file is
what every path sees.

**Failure mode matters more than elegance here.** If this extension stops
loading, the last-written model persists and agents keep working. An injector
would leave frontmatter without a `model:` and agents would inherit the parent —
a reviewer quietly downgraded to the session model is a worse outcome than a
stale-but-sane one.

**It never touches your notes.** Only the uncommented `model:` line is rewritten
— plus the uncommented `thinking:` line, and only when a level actually resolved.
`# model:` alternatives, `fallbackModels:` blocks, a commented-out `# thinking:`
note, and everything else in the frontmatter and body survive byte-for-byte. See
[Thinking levels](#thinking-levels) for the one guarantee that line comes with,
and ADR
[0004](docs/adr/0004-thinking-levels.md) for why it is only ever forward.

## Where the numbers come from

Two endpoints that the vendors' own clients use. Neither is a documented public
API, so treat them as best-effort — the extension is built to degrade quietly if
they change or move.

| Rail | Credential | Endpoint |
|---|---|---|
| Claude | the macOS login keychain (`Claude Code-credentials`), falling back to `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` | `api.anthropic.com/api/oauth/usage` |
| Codex | `<agent dir>/auth.json` (normally `~/.pi/agent/auth.json`) → `openai-codex.access` + `accountId` | `chatgpt.com/backend-api/wham/usage` |

Credentials are read, never logged, and never transmitted anywhere except to the
provider that issued them.

The Claude credential has two possible homes because Claude Code has two. On
macOS the one it actually refreshes is the login keychain; the
`~/.claude/.credentials.json` file is the store it used to write and now keeps
as a plaintext fallback, so on a machine driven through a bridge rather than
through `claude` directly the file sits there stale and expired while the
keychain stays current. The file is therefore read first — a healthy file must
not cost a subprocess, and macOS asks for keychain permission at most once —
and the keychain is consulted only when that file yields no usable token, via
`security find-generic-password -a $USER -w -s "Claude Code-credentials"`: the
same call Claude Code and the Agent SDK make against the item Claude Code
writes. When neither store can supply a token the note names both reasons, the
file's first and the keychain's after `; keychain: `.

The keychain is consulted only when `claudeCredsPath` still names the default
file, because a `CLAUDE_CONFIG_DIR` profile keeps its credential in its own file
and never writes the keychain: for any other path the keychain would answer for
a different account.

Both reads are **bounded**, because the evaluation that `session_start` awaits
depends on them. Each attempt is abandoned by a 5s timeout, and a failed attempt
is retried once after 250ms; a rail still unreadable after that is a missing
reading like any other, so it holds rather than falling through to a later
alternate.

Anything that goes wrong while making the request is retried — a 5xx, DNS, TLS, a
dropped connection, a body that stalled mid-stream, or a body that is not the
JSON this endpoint promises, since a reply truncated without framing and a
captive portal arrive looking the same. What is *not* retried is an answer the
endpoint will simply repeat: a 4xx (an expired token, a moved endpoint), a 429
asking us to slow down, or a 200 whose payload carries none of the windows this
rail reports. The report distinguishes the two: a failure with no attempt count
is not one another request would have changed, and a counted one is a request
that was still being tried when the read stopped. The timings are deliberately
not config-file keys: how long to wait for a socket is a fact about this network,
not a routing preference. See [0006](docs/adr/0006-bounded-quota-reads.md).

### Keeping the Claude token fresh

Claude Code's credential is an 8-hour access token, and Claude Code is the only
thing that refreshes it. Driven through a bridge, nothing refreshes it while the
machine is idle, so the first read of the morning finds it expired — and an
expired token is a [missing reading](#the-policy), so every route whose primary
is on the Claude rail holds. `claudeRefresh` decides what to do about that:

| Mode | What it does |
|---|---|
| `off` (default) | Report the expiry. What an install did before this key existed. |
| `offline-ping` | Run `claude -p hi` once with its model request pointed at a loopback listener this extension answers itself, so Claude Code refreshes its own credential and the request dies on loopback having encoded nothing. |
| `ping` | The same run without the diversion — a real request, costing a real answer's worth of tokens. The fallback if the diversion ever stops working. |

`offline-ping` is the one to turn on, and it is measured rather than hoped —
zero tokens, nothing reaching Anthropic, and a credential persisted *before* the
request was sent. It costs a few seconds of session start, once per expiry, and
all of it Claude Code's own startup, which no flag was able to trim. It is worth
being precise about who refreshes what: this extension never posts a refresh
token and never writes the store. It runs Claude Code and lets Claude Code do it,
because that token rotates on every use and a second writer is how a session gets
logged out.

The extension is deliberately not talking to a model, and it proves that instead
of assuming it: the request has to arrive on its own listener. A clean exit with
no request on that listener is reported as exactly that, and the attempt is never
repeated — a run whose model call was answered somewhere else means the diversion
this feature rests on may have failed at the cost of a real request. The child
also runs under a deliberately narrowed environment, so a `CLAUDE_CONFIG_DIR`,
a `CLAUDE_CODE_OAUTH_TOKEN` or an `ANTHROPIC_API_KEY` exported into pi cannot
make it refresh — or spend — a different credential from the one the dispatcher
read, and a provider switch such as `CLAUDE_CODE_USE_BEDROCK` cannot move the
request off the listener to bill another provider.

An attempt costs a subprocess, so there is at most one at a time. After an
attempt that merely failed — the binary missing, a stall before any request — the
dispatcher backs off for a while and then retries once. After one that could have
spent a real request, or that ran and did not work, it stops making attempts: a
repeat can only pay again. That stop lasts until a credential read finds a usable
token — the end of the expiry — except for a run that never diverted at all,
which keeps the feature off for the rest of the session, because the next expiry
would pay again; only a new pi process clears that one. A run that collides with
Claude Code's own refresh lock is neither — it is reported as a deferral, because
the other process is doing the work, so the next read may try again.
See [0007](docs/adr/0007-refresh-pings.md) for the measurements, the bounds, and
the alternatives that were rejected.

## Caveats

- **The Claude token expires** (typically within hours). Claude Code refreshes it
  on use; this extension only reads it — unless you set
  [`claudeRefresh`](#keeping-the-claude-token-fresh), which makes it run Claude
  Code once to cause that refresh rather than waiting for you to use Claude
  Code. Once *both* stores lapse — the file and, on macOS, the keychain — and
  nothing refreshes them, the Claude rail reports unavailable and the dispatcher
  holds, leaving every agent file untouched. If you stop using Claude Code the
  Claude side goes dormant — but nothing gets moved onto the other plan to
  compensate, so the failure is quiet.
- **The macOS keychain read can ask for permission.** `security` is a different
  process from the one that created the item, so macOS may prompt the first time
  and remember your answer; choose *Always Allow* if you want the poll to stay
  silent. A denied or wedged keychain is not fatal: the read is abandoned after
  5s and the rail degrades to the file alone, exactly the behaviour it had before
  the fallback existed.
- **Global state.** The agent files are shared across all sessions and projects,
  exactly as they are when you edit them by hand. A project override therefore
  changes the model written into a file that every project reads; the project
  layer decides *what* gets written, not *where*.
- **A running agent keeps its model.** A switch applies to the next spawn, not to
  work already in flight.
- **Same-rail congestion is possible.** If both plans are tight, agents can end
  up resting on the same rail; the policy does not balance load across agents.
- **The margin is not hysteresis.** Each evaluation compares the two rails
  against each other only, with no memory of what an agent is currently assigned
  to. So when a budget hovers around its threshold — primary session at 90,
  alternate oscillating either side of 80 — an agent can alternate between rails
  on successive polls. `sessionAlwaysSwitchAt` does not change that: it is a
  second threshold evaluated on the same comparison, not a second force with
  memory, so a reading oscillating around it can flap the switch just as one
  around the margin can. Making the policy stateful is a known open improvement.
- **A stalled endpoint delays session start, but only briefly.** Each quota read
  is abandoned after 5s and retried once after 250ms, so a vendor that has gone
  quiet costs a session about 10s — a few seconds more on macOS, where a Claude
  credential that has to fall back to the keychain waits out its own 5s first,
  since the two rails are read in parallel. A `claudeRefresh` ping adds a bounded
  run of its own and the credential re-read that follows it, once per expiry —
  see [Keeping the Claude token
  fresh](#keeping-the-claude-token-fresh). The agents whose route depends on that
  reading then *hold*, exactly as they do for any other missing reading,
  rather than being switched to an alternate chosen on evidence nobody read; rule
  5 of [the policy](#the-policy) says which routes those are.
- **A failed reading is cached like a successful one.** A rail that is still down
  after both attempts stays unreadable until its cached reading lapses (`ttlMs`):
  a plain `/quota-dispatch` run, or another `session_start` inside that window,
  reports the same failed reading instead of trying again. `/quota-dispatch
  refresh` (and `apply`) is what forces a fresh read.
- **Cosmetic duplication.** When the dispatcher selects a model that also appears
  in your commented notes, you get `model: X` alongside `# model: X`. Harmless,
  and deduping would mean deleting your notes.
- **A written thinking level outlives the assignment.** Nothing restores or
  removes a `thinking:` line, so an agent that moved to an alternate with a level
  keeps that level when it moves home, unless the primary states one too. That is
  the deliberate absence of a guarantee; if you care what an agent thinks at,
  state a level on every candidate of its route.
- **The model check is only as fresh as the running pi.** Each configured model
  id is resolved against the pi that is running, so a model a *newer* pi knows
  is reported as unknown by an older one. When a model you expect is reported as
  unknown, either upgrade pi — a newer pi may know it — or correct the id;
  `pi --list-models` lists what this pi knows.

## Development

Zero runtime dependencies. Tests use the Node built-in runner, but `npm test`
needs the dev dependency installed, because `src/config.ts` reads pi's config
helpers at run time:

```bash
npm ci && npm test    # install the dev dependency, then run the suite
npm run typecheck
```

## License

Apache-2.0
