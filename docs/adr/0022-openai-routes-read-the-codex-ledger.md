# OpenAI routes read their ledger through the Codex credential

## Context

pi 1.5 gives the ChatGPT subscription its own sign-in: provider `openai`,
"Sign in with ChatGPT", `baseUrl` `https://api.openai.com/v1`, which is what
pi calls `isSubscription`. The provider that used to carry it, `openai-codex`
against `https://chatgpt.com/backend-api`, is now registered as
**OpenAI Codex (legacy)**. The models are the same subscription's models
(`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, …), served under the new id.

So a route that used to name `openai-codex/gpt-6.1-sol` now names
`openai/gpt-6.1-sol`, and the rail it draws on — the 5h and weekly ledger at
`chatgpt.com/backend-api/wham/usage` — has not changed at all. Two questions had
to be answered to keep that rail readable: what reads it, and whether the `openai/`
prefix can now imply it.

## The sign-in credential cannot read the ledger

The `openai` entry pi writes to `auth.json` is an OAuth credential for one
audience:

```text
  aud   https://api.openai.com/v1
  scope chatgpt.tokens.use.direct email offline_access openid profile resource.invoke
```

Sent at the usage document it is rejected before the document is consulted —
`401 rejected_by_access_enforcement`, `code: no_matching_rule` — with the
Codex account id in a `ChatGPT-Account-Id` header as well as without one. The
same answer comes from `chatgpt.com/backend-api/me`, `/accounts/check`, and
`api.openai.com/v1/me`: the token is valid for model requests on
`api.openai.com/v1` and for nothing else. Its `https://api.openai.com/auth` claim
carries only `per_user_salt` and `encrypted_auth_metadata` — no
`chatgpt_account_id`, and no email — so it cannot even say *which* account it is
for.

A model request on that credential answers with no rate-limit headers either:
`api.openai.com/v1/responses` returns `x-codex-safety-buffering-enabled`,
`x-codex-turn-state` and their kin, and no `x-ratelimit-*`. There is no live
header, and therefore no read that costs an answer.

What still answers the document is the Codex CLI's own credential — the
`tokens.access_token` + `tokens.account_id` shape
[0020](0020-codex-credential-seam.md) already taught `parseCodexCredential` to
recognise. On this machine `~/.codex/auth.json` returned `200` with the plan's
two windows while the sign-in token returned `401` for the same request.

## So the model credential and the reading credential are different files

That is the arrangement `codexCredsPath` exists for, and it is now the ordinary
one rather than a sandbox workaround:

```text
  model work  ──▶ pi's auth.json, "openai" entry   (what pi spawns the model with)
  rail read   ──▶ ~/.codex/auth.json, "tokens"     (what the ledger is asked with)
                        ▲
                        └── same ChatGPT account, stated by pointing the path there
```

The identity guarantee is 0020's, unchanged and for the same reason: the path is
the user's statement of which account this rail describes. It has to be the
account the models run on, because these numbers are what agent files are
rewritten on; a second account would route work on headroom that work never
spends. Nothing here can check it for the user — the sign-in token names no
account and reaches no endpoint that would name one — so the statement stands
alone, which is exactly the contract 0020 chose when it made the path the
account's identity.

The freshness contract is 0020's too: this extension does not refresh a Codex
token, so the file is only as current as the last Codex CLI use. An expired
token is a `401`, the rail is unreadable, and the policy holds — it does not
fall back to the last good reading or to a guess. If the Codex client goes away
entirely, this rail has no reader left, and `unavailable` is the honest answer.

## `openai/` names no rail

`railFromModel` keeps `openai-codex/` → `codex` for the legacy provider and
returns `undefined` for `openai/`. One provider id, two billing arrangements is
the whole reason: `openai` authenticates with either an API key
(`OPENAI_API_KEY`, pay-per-token, its own balance) or the ChatGPT sign-in
(subscription, the 5h/weekly ledger read here). A prefix that can mean either is
not a statement about which pool a call draws on, and
[0005](0005-model-rails.md) already refused to treat prefixes as account
facts — "the same vendor prefix can be reached through more than one account" is
this exact case arriving.

The consequence is stated rather than papered over: a route naming `openai/*`
must have its rail registered in the `models` table, and the prefix-contradiction
warning cannot fire for it, because there is no prefix fact to contradict. For
those models the `models` entry is the only statement of which account the work
draws on.

The startup snippet degrades with it: `agentTableSnippet` skips an agent file
whose model has no recognised prefix rather than inventing a rail, so a fresh
install whose files already declare `openai/*` models gets no proposal for
them. That is the same choice 0005 made — no guess the user then pastes and the
loader then warns about — and improving it means deriving from the `models`
table, which is its own change.

## Considered options

**Accepting the `openai` entry as a third credential shape.** It would parse,
and then every read would report `HTTP 401` for a credential that is perfectly
good — a document named as a source that cannot answer. Worse, the natural next
step from there is guessing at what a `401` meant, and there is nothing in the
token to guess with.

**Reading usage from a model request's headers.** Rejected because there are
none: the response carries Codex safety headers, not rate limits, and a read
that costs an answer would be a poor trade for a poll that runs every
`pollMs`.

**Deriving the codex rail from `openai/`.** Rejected above: one id, two
accounts. A machine on an OpenAI API key would then be reported on the ChatGPT
plan's numbers.

**Renaming the rail from `codex` to `openai` or `chatgpt`.** The naming tension
is real — the models now say `openai` and the rail says `codex` — but the rail
is a pool, not a provider: the pool is the ChatGPT plan, its reader is the Codex
client's credential, and its endpoint is the Codex usage document. A rename would
change the persisted readings keys, the gauge labels and every `models` entry,
and answer no question the current name gets wrong. If the legacy provider is
removed and the Codex name stops meaning anything anywhere, that is the moment to
rename, on its own terms.

**Refreshing the Codex token ourselves.** 0020's rejection stands: the token
rotates, and a second writer to the file is a way to end the user's session. The
refresh belongs to the client that owns the credential.

## Consequences

A machine whose pi is signed in with ChatGPT points `codexCredsPath` at the
Codex CLI's file — `~/.codex/auth.json` on this host — and everything else
follows the existing shape: the rail is `codex`, the reading is keyed
`codex\0<path>`, and the first read after the change is a cold one because the
key changed.

The extension reads the ChatGPT plan's meter, not the sign-in token's own
accounting. Both providers serve the same subscription, and requests on the
sign-in path are answered with `x-codex-*` headers — but the meters are the
vendor's business, so the useful confirmation is observational: after real work
has run on `openai/*`, the weekly percentage at `wham/usage` should have moved.
If it never does, the ledger describes the legacy client's spending only, and
that is worth an issue rather than a guess.

The guest keeps `agent-vm-codex/*` and the credential agent-vm publishes for it
until the guest's pi has the sign-in provider; its cue file says so. Nothing
here assumes every machine has migrated: `openai-codex/` still maps to the rail,
and a config naming it still routes and reads as before.
