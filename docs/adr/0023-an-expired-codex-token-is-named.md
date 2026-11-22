# An expired Codex token is named, not sent

## Context

The codex rail reports `unavailable — HTTP 401` on a machine whose OpenAI models
work perfectly well. That pair is not a contradiction, it is
[0022](0022-openai-routes-read-the-codex-ledger.md) working as built: the models
run on pi's ChatGPT sign-in, which refreshes itself, while the rail reads the
Codex CLI's own `tokens` credential, which nothing here refreshes. A CLI left
unused until its access token lapses leaves a file whose token is past its `exp`
— and every read of it is a request whose answer is already known:

```text
  ~/.codex/auth.json ──▶ tokens.access_token   exp 2026-11-21T17:13Z
        │                       │
        │                       └──▶ GET wham/usage ──▶ 401 (rejected, expired)
        │                             (x2, per ADR-0006's retry)
        └── nothing rewrites it; only the Codex CLI does
                                    ▲
        pi's "openai" sign-in ──────┘  a different file, refreshing itself,
                                       which is why the models keep answering
```

The rail's note was the endpoint's reply and nothing else. Two costs follow.
The report sends a user to the wrong question — a `401` reads like a wrong
credential, a moved endpoint or a broken header, when the answer was "run the
Codex CLI once" and the evidence was in a field the extension had already read.
And the read pays two doomed requests on the path `session_start` awaits, for an
answer local data settles.

`HTTP 401` is not wrong, it is just not the fact. The fact is that the token
expired, and the token says so itself.

## The token's own `exp`, and no request after it

`readCodexCredential` decodes the access token's JWT payload and compares `exp`
against the clock it was handed, the way `parseAntigravityToken` compares
`expires` and `parseClaudeToken` compares `expiresAt`:

```text
  exp absent, not a JWT, payload not an object  ──▶ send it; the endpoint answers
  exp * 1000 >  now                             ──▶ send it
  exp * 1000 <= now                             ──▶ "codex token expired", no request
```

The token is the one place this fact lives in both document shapes. pi's
`auth.json` copies the same claim into `openai-codex.expires` (`exp` × 1000), and
the Codex CLI's file states it nowhere else, so decoding the token is one rule
instead of a per-shape field with a fallback. `<=` is Antigravity's boundary: a
token whose expiry *is* this instant has no life left.

No signature check, because the claim is not what makes the credential trusted —
the file it was read from is, per
[0020](0020-codex-credential-seam.md), and that file already names the account.
The claim only spares a request; a tampered `exp` can make this extension hold a
rail it could have read, never spend an account it should not.

A token that makes no readable statement is sent. An absent claim is not evidence
of expiry, the position every reader here takes, and the `401` that follows is
the same report a wrong-account token earns.

## Considered options

**Enriching the `401` with the expiry instead of pre-empting it.** The note would
read `HTTP 401 (token expired 19h ago)`, and the two doomed requests would still
be made. Rejected because the expiry is local knowledge, not something the
endpoint taught us: a report that waits for a vendor to be asked before saying
what the file already says is a report that depends on the vendor being
reachable.

**Reading `openai-codex.expires` where a shape has it.** It is the same fact
copied, and the Codex CLI's document has no such field, so the rule would be two
rules — a field that can drift from the token beside a fallback to it — to
answer a question the token answers directly.

**A skew grace, or treating the token as good until the endpoint says
otherwise.** A token past its `exp` is never accepted, so a grace only widens the
window in which this extension acts on a wrong local clock. Claude's and
Antigravity's reads already take that position on the same kind of token; a
machine whose clock is wrong is a machine to fix, not a rule to soften.

**A `codexRefresh` mode that runs the Codex CLI once, as `claudeRefresh` does.**
Not refused here on its merits, but it is a separate decision with its own cost
(the CLI is an agent, not a token refresher) and 0022's rejection of refreshing
the token ourselves still stands. The note is what makes the human's own fix
findable; nothing in this change touches the credential file.

## Consequences

The codex line reads `codex: unavailable — codex token expired`, which names both
what happened and, for anyone who reads the README, what to do: use the Codex
CLI. Policy is unchanged — an expired token is a missing reading, so agents
hold, and nothing falls back to the last good reading or onto another rail.

`HTTP 401` on the codex line now means something narrower and more useful: the
token was *not* past its expiry and the endpoint refused it anyway — a wrong
account, a wrong audience, a moved document. The two failures 0022 separates in
prose are now separated in the report.

The read no longer costs requests it knows will fail, so an install whose Codex
CLI has gone dormant stops sending two doomed requests on the path
`session_start` awaits for the answer "expired".

The credential read takes a clock (`readCodexCredential(path, now)`), which is
what keeps the comparison a pure function of its inputs, and is the same seam
`parseClaudeToken` and `parseAntigravityToken` already have. Any fixture that
reaches the codex rail with a JWT-shaped token now has to give it a future `exp`
or none at all; a fixture token shaped like `tok` states nothing and is sent, as
before.
