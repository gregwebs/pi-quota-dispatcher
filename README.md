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

planner -> claude-bridge/claude-opus-5-5  [unchanged]  (claude 27% ok)
reviewer -> openai-codex/gpt-6-astra      [unchanged]  (codex 64% ok)
implementer -> deepseek/deepseek-flash    [unchanged]  (deepseek 0% ok)
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
| `/quota-dispatch` | Show rail pressure and the current decision per agent |
| `/quota-dispatch refresh` | Force a re-fetch, then show |
| `/quota-dispatch dry` | Show what it *would* write, change nothing |

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
| `switchAt` | `75` | Used-percent at which the primary rail is considered tight |
| `margin` | `10` | The alternate must be at least this many points healthier |
| `ttlMs` | `180000` | How long a quota reading is reused |
| `pollMs` | `300000` | How often to re-evaluate while a session is open |

`agentDir`, `claudeCredsPath` and `piAuthPath` are overridable mainly so the
test suite can point at a fixture directory.

## The policy

Deliberately small and stateless — the target model is a pure function of
current rail pressure, so re-evaluating is idempotent and cannot drift:

1. Move to the alternate when `primary.pressure >= switchAt` **and**
   `alt.pressure < primary.pressure - margin`.
2. Otherwise stay on the primary.
3. **Unreadable quota is not evidence of pressure.** If either rail cannot be
   read, hold the primary rather than flapping onto the other plan on the
   strength of a failed HTTP call.

Rails are per-provider: `claude-bridge/*` and `anthropic/*` consume the Claude
subscription, `openai-codex/*` consumes the Codex subscription, and `deepseek/*`
is modelled as zero pressure because it is metered per token rather than capped.

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
  unavailable and the dispatcher *holds* rather than moving work. Safe, but if
  you stop using Claude Code the Claude side goes dormant.
- **Global state.** The agent files are shared across all sessions and projects,
  exactly as they are when you edit them by hand.
- **A running agent keeps its model.** A switch applies to the next spawn, not to
  work already in flight.
- **Same-rail congestion is possible.** If both plans are tight, agents can end
  up resting on the same rail. The margin rule stops rapid flapping but does not
  balance load across agents.
- **Cosmetic duplication.** When the dispatcher selects a model that also appears
  in your commented notes, you get `model: X` alongside `# model: X`. Harmless,
  and deduping would mean deleting your notes.

## Development

Zero runtime dependencies. Tests use the Node built-in runner:

```bash
npm test        # 23 tests, no install required
npm install && npm run typecheck
```

## License

Apache-2.0
