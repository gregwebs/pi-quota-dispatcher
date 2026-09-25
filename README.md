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
implementer -> deepseek/deepseek-flash    [unchanged]  (deepseek ok (metered))
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

## Commands

| Command | Effect |
|---|---|
| `/quota-dispatch` | Show rail budgets and the current decision per agent. Read-only. |
| `/quota-dispatch refresh` | Force a re-fetch, then show. Read-only. |
| `/quota-dispatch apply` | Write the decisions out now. The only form that touches a file. |

The two reporting forms are read-only by construction — `report()` has no way to
be asked to write, so "show me the state" cannot rewrite your agents.

## Configuration

Everything lives in `DEFAULT_CONFIG` at the top of `src/index.ts`.

```ts
routes: {
  reviewer: {
    primary:   { model: "openai-codex/gpt-6-astra",    rail: "codex" },
    alternate: { model: "claude-bridge/claude-opus-5-5", rail: "claude" },
  },
  // ...
}
```

| Key | Default | Meaning |
|---|---|---|
| `routes` | planner / reviewer / implementer | Which agents are managed, and where each moves. Agents not listed are never touched. |
| `sessionSwitchAt` | `75` | Used-percent at which the primary's **session** budget is considered tight |
| `weeklySwitchAt` | `90` | The same for its **weekly** budget, deliberately higher — see [the policy](#the-policy) |
| `margin` | `10` | The alternate must be **more than** this many points healthier, on the *same* budget |
| `ttlMs` | `180000` | How long a quota reading is reused |
| `pollMs` | `300000` | How often to re-evaluate while a session is open |

`agentDir`, `claudeCredsPath` and `piAuthPath` are overridable mainly so the
test suite can point at a fixture directory.

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
   `sessionSwitchAt`, and the alternate's **session** budget is more than
   `margin` points healthier, move to the alternate.
2. **Weekly is a backstop.** The same rule on the weekly budget, with its own
   `weeklySwitchAt`. Each compares like with like: session against the
   alternate's session, weekly against its weekly. It runs whether or not the
   session budget is tight, so a spent week is not masked by a merely tight
   session.
3. **The destination has to be somewhere worth going.** A rail is only a valid
   target if — besides being better on the budget that triggered the move — it
   is **not itself tight on the other budget**. A rail tight on its *other* cap
   would block the work just as surely, so switching there trades one cap for
   another rather than relieving anything. Without this, one pass can move an
   agent *onto* the very rail it moves another agent *off*.
4. Otherwise stay on the primary.
5. **Unreadable is not the same as idle.** If either rail cannot be read, or a
   capped rail fails to report a budget, the dispatcher makes no assignment at
   all: `Decision` is either an assign or an explicit hold, and a hold carries
   no model, so there is nothing to write. Every agent file is left exactly as
   you left it. A failed HTTP call must never move work onto the other plan —
   least of all back onto the rail that was under pressure. Reading a missing
   5-hour window as "0% used" is how a rail that was blocked outright once came
   to look like the roomiest place to send work.

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
| Claude | `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` | `api.anthropic.com/api/oauth/usage` |
| Codex | `~/.pi/agent/auth.json` → `openai-codex.access` + `accountId` | `chatgpt.com/backend-api/wham/usage` |

Credentials are read, never logged, and never transmitted anywhere except to the
provider that issued them.

## Caveats

- **The Claude token expires** (typically within hours). Claude Code refreshes it
  on use; this extension only reads it. Once it lapses, the Claude rail reports
  unavailable and the dispatcher holds, leaving every agent file untouched. If
  you stop using Claude Code the Claude side goes dormant — but nothing gets
  moved onto the other plan to compensate, so the failure is quiet.
- **Global state.** The agent files are shared across all sessions and projects,
  exactly as they are when you edit them by hand.
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

Zero runtime dependencies. Tests use the Node built-in runner:

```bash
npm test        # 44 tests, no install required
npm install && npm run typecheck
```

## License

Apache-2.0
