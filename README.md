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

planner -> claude-bridge/claude-opus-5-5  [unchanged]  (claude ok (session 0%, weekly 27%))
reviewer -> openai-codex/gpt-6-astra      [unchanged]  (codex ok (session 0%, weekly 64%))

config: built-in < global ~/.pi/agent/quota-dispatch.json (present) < project .pi/quota-dispatch.json (absent)
  sessionSwitchAt = 75  [built-in]
  weeklySwitchAt = 80  [global]
  agents.planner.primary.model = claude-bridge/claude-opus-5-5  [global]
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
  "agents": {
    "planner": {
      "primary": {
        "model": "claude-bridge/claude-opus-5-5",
        "rail": "claude"
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
`rail` is derived from that model's prefix, so it is inert until you paste it.
A file with no model, or with a model whose prefix is not one of the rails this
extension reads, is listed but left out rather than guessed at.

While the table is empty, a footer line (`quota-dispatcher: no agents
configured`) holds the state, and clears as soon as a route exists. In modes
with no footer there is nothing to render, so neither the ask nor the status is
shown.

`/quota-dispatch` still works while unconfigured: it prints one line per rail,
which is the diagnostic you want when the quotas are what you came for. It is
also where **unmanaged** files are reported — any `<agent dir>/<name>.md` that no
route names is listed by the plain and `refresh` forms. The startup ask mentions
them only while the table is empty; a configured install does not narrate the
files it deliberately does not manage.

Config is read once per extension load, so `/reload` is what picks up a new
route — and what stops the ask.

## Commands

| Command | Effect |
|---|---|
| `/quota-dispatch` | Show rail budgets and the current decision per agent, plus any agent files no route names. Read-only. |
| `/quota-dispatch refresh` | Force a re-fetch, then show. Read-only. |
| `/quota-dispatch apply` | Write the decisions out now. The only form that touches a file. |

The two reporting forms are read-only by construction — `report()` has no way to
be asked to write, so "show me the state" cannot rewrite your agents.

Every form also prints where each configured value came from, so "why is
reviewer on gpt-6-astra?" is answerable without opening three files.

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
  "agents": {
    "planner": {
      "primary": { "model": "claude-bridge/claude-opus-5-5", "rail": "claude" },
      "alternates": [{ "model": "openai-codex/gpt-6-sol", "rail": "codex" }]
    }
  }
}
```

Each agent is keyed by its **name** — the filename stem, `<agent dir>/<name>.md`
— and each route gives a `primary` and an `alternates` list. A candidate is a
`model` and the `rail` it draws on; state both, because the model's prefix and
the rail are checked against each other and a mismatch warns.

**Precedence: built-in < global < project**, deep-merged per agent. A file only
has to state what it changes:

```json
{
  "weeklySwitchAt": 80,
  "agents": {
    "reviewer": {
      "primary": { "model": "claude-bridge/claude-opus-5-5", "rail": "claude" }
    }
  }
}
```

That global file moves `weeklySwitchAt` and `reviewer`'s primary, and leaves
every other agent and scalar alone. Merging inside a candidate is field-wise, so
naming only a `model` keeps the `rail` beneath it — usually not what you want
when you move to a different provider, so state both, as above; the loader warns
when a model's prefix reads like a rail other than the one declared.

### Adding, removing and parking an agent

An agent entry carries two entry-level **skip instructions**, read while the
layers are folded and never kept in the effective config:

| Spelling | Effect |
|---|---|
| `"disable": true` | Remove the agent, whatever lower layers said, and report it once as `agents.<name> = disabled [<layer>]`. |
| `"ignore": true` | This copy of the entry contributes nothing and warns nothing; a lower layer's route stands. It wins over `disable`. |
| `"disable": false` | Inert — the rest of the entry still applies. |

`disable` and `ignore` are how you say "off" and "not this copy" without letting
a mistyped value do either by accident. There is **no `null`** anywhere: a `null`
at the agent or candidate level warns and leaves the previous layer's value
standing — it removes nothing.

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
`disable` and `ignore` are entry-level only, a candidate has exactly `model` and
`rail`, and a lone candidate object is not shorthand for a one-element list.

| Key | Default | Meaning |
|---|---|---|
| `agents` | `{}` — nothing managed | Which agents are managed, and each one's `primary` and `alternates` list. Agents not listed are never touched. |
| `sessionSwitchAt` | `75` | Used-percent at which the primary's **session** budget is considered tight |
| `weeklySwitchAt` | `90` | The same for its **weekly** budget, deliberately higher — see [the policy](#the-policy) |
| `margin` | `10` | An alternate must be **more than** this many points healthier, on the budget that triggered the move |
| `ttlMs` | `180000` | How long a quota reading is reused |
| `pollMs` | `300000` | How often to re-evaluate while a session is open |

`claudeCredsPath` is settable too, defaulting to
`~/.claude/.credentials.json`; choosing a different Claude profile is a real
use. Naming **any other path** is a statement that the credential lives in that
file and nowhere else, which also turns off the [macOS keychain
fallback](#where-the-numbers-come-from): that keychain holds the default
profile's credential, and reporting its headroom while a different profile runs
would be worse than reporting nothing. `agentDir` and `piAuthPath` (defaults
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
- **Unparseable file** — logged to `console.error` and skipped whole, and the
  layers below it still apply. A half-applied config is harder to reason about
  than the defaults.
- **Unknown key, malformed `model` (no `/`), unknown `rail`, a route left
  without a `primary`, an out-of-range number, an invalid agent name, a value
  of the wrong type** — logged, and the previous layer's value stands for that
  key alone. A typo in a project file cannot undo a correct global one. An
  invalid value never removes a valid one; removing an agent stays explicit
  (`disable: true`).
- **A skip flag that is not `true` or `false`, or a `null` anywhere** — logged
  and treated as absent, so the previous layer's value stands.
- **A configured agent with no file** at `<agent dir>/<name>.md` — logged at
  load, with the path to go and create, and the agent stays configured in the
  meantime.

Agent names are filenames (`<agent dir>/<name>.md`), so they must be lowercase
letters, digits and dashes, starting with a letter (`planner`,
`code-reviewer`); anything else is ignored. `ttlMs` and `pollMs` must be whole
milliseconds in Node's timer range (1–2147483647); the switching thresholds and
`margin` are used-percentages in 0–100. A numeric warning always states the
range it enforced.

Every warning names the file it came from, and the `/quota-dispatch` report ends
with the same provenance listing, so a config that is not doing what you meant
says so instead of quietly routing you somewhere else.

Config is read once when the extension loads; `/reload` after editing.

### Out of scope

Config can only route among the rails the extension already knows how to read
(`claude`, `codex`, `deepseek`). Adding a genuinely new quota rail — its
endpoint and response parser — still requires code, so there is no `rails` block
to configure.

## The policy

Deliberately small and stateless — the target model is a pure function of
current rail headroom, so re-evaluating is idempotent and cannot drift.

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
   wins.
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

**It never touches your notes.** Only the uncommented `model:` line is rewritten.
`# model:` alternatives, `fallbackModels:` blocks, and everything else in the
frontmatter and body survive byte-for-byte.

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

## Caveats

- **The Claude token expires** (typically within hours). Claude Code refreshes it
  on use; this extension only reads it. Once *both* stores lapse — the file and,
  on macOS, the keychain — the Claude rail reports unavailable and the dispatcher
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
  on successive polls. Making the policy stateful is a known open improvement.
- **Quota requests have no timeout yet.** Neither fetch sets an abort signal, so
  a stalled endpoint delays the evaluation that `session_start` awaits. The
  practical effect is a slow session start, not lost data.
- **Cosmetic duplication.** When the dispatcher selects a model that also appears
  in your commented notes, you get `model: X` alongside `# model: X`. Harmless,
  and deduping would mean deleting your notes.

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
