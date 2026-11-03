# The Codex credential is read through a path of its own, in either document shape

## Context

`fetchCodex` read `cfg.piAuthPath`, and `piAuthPath` is an `OWNED_PATH_SCALARS`
key: a config file naming it is answered with "relocate the agent dir with
`PI_CODING_AGENT_DIR`" rather than obeyed. That rule is right for a path the
dispatcher **edits** — `agentDir` holds the agent files it rewrites, and since
[0019](0019-antigravity-pool-rails.md) `piAuthPath` is the file pi's own provider
refreshes — but a credential is read and never written, and `claudeCredsPath`
is already exactly that seam. That seam is why the Claude rail works in the same
sandbox: its guest credential is a placeholder the proxy swaps for the host
token on the way out.

Codex had no such seam, and inside `agent-vm pi` that showed up as
`codex: unavailable — no openai-codex.access` (issue #89). The host's
`~/.pi/agent/auth.json` is deliberately **absent** from any fork of the Pi home
(agent-vm's `protected_host_files`, ADR-0011 / issue #91), so the guest has no
`openai-codex` entry and `pi --list-models` there lists no `openai-codex`
provider either. The one Codex credential in the guest is the sandbox's own
placeholder, published at `/agent-vm-state/codex/auth.json` in **the Codex CLI's**
document shape, and it reads the usage document with a 200 when sent with
`fetchCodex`'s exact headers. So the only missing piece *for reading the rail*
was somewhere to read it from; whether that guest can also spawn an
`openai-codex` model is pi's registry's business and not changed here.

So the seam has to answer two questions at once: which file, and what shape.

## One read-only path, defaulting to pi's own file

`codexCredsPath` is a scalar beside `claudeCredsPath`, and it defaults to the
file `piAuthPath` names — `<agentDir>/auth.json`:

| Rail | Path key | Settable from a config file? | Written by |
|---|---|---|---|
| `claude` | `claudeCredsPath` | yes | Claude Code, and the refresh ping's `claude` |
| `codex` | `codexCredsPath` | yes | whichever client owns the file; never this extension |
| the three Antigravity pools | `piAuthPath` | no — pi owns it | pi's `antigravity` provider |
| all rails' readings | `readingsPath` | no — derived from the agent dir | this extension |

The distinction that decides the middle column is **read versus write**, not
"credential versus pi's": a JSON file pointing a path the dispatcher writes
elsewhere would only rewrite files nothing reads, while a path it reads changes
*which account's numbers* it acts on. That is the whole consequence, and it is
not a small one: these numbers are what agent files are rewritten on, so the
credential named here has to be the account that runs the models the routes
name. Pointing it at another account's file does not report a second account
beside the first — it routes work on headroom that work will not spend, which is
the failure [0003](0003-claude-credential-stores.md) refused when it made the
keychain a fallback for the default Claude file only. Codex adds no writing
seam: the rail never refreshes an OAuth token, so a stale token stays the 401 it
is today, and nothing here can be made to act on a credential.

The default is pi's own file rather than "unset means pi's file" because the
value is then always a path: it is one row in the provenance block, one field in
the type, and no caller has to re-derive what an absent key means. The cost is
that a *programmatic* config states both keys; the loader's defaults derive both
from the same `getAgentDir()`, so the two can only drift where a caller sets one
by hand, which the type makes visible.

## Two document shapes, one reader

Two writers publish a Codex credential, so two documents are recognised. A shape
is claimed by its **section**, never by the file's name: a credential file is a
credential file whatever wrote it.

```text
  codexCredsPath ──▶ parseCodexCredential(text)
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
  openai-codex: {access, accountId}       tokens: {access_token, account_id}
  pi's auth.json                          the Codex CLI's auth.json
        └───────────────────┬───────────────────┘
                            ▼
              first usable shape wins
        (access, accountId) ──▶ GET /backend-api/wham/usage
```

pi's shape is tried first, because it is the default file's own shape and the
common case then costs one lookup. **First usable wins, and neither shape is a
precedence**: a document carrying a half-written `openai-codex` section beside a
usable `tokens` one still answers, because the two sections are spellings of one
fact and refusing a credential the file really holds would report a readable rail
as unavailable.

`accountId` is required in both shapes. It is not a secret, but it selects *which
account's* headroom the request asks about, so a defaulted one would report
another account's numbers — the failure the per-credential key below exists to
prevent.

Two kinds of note, both credential-safe:

- a section that is present but unusable names the field it was missing in that
  shape's own spelling — `no openai-codex.access`, `no tokens.account_id` — which
  is the actionable half of "this is the wrong file";
- a document with **neither** section names both fields a file could carry —
  `no openai-codex.access or tokens.access_token` — which is what says the file
  is the wrong one rather than that the account is broken.

A parse failure is fixed text (`codex credential is not valid JSON`) and a read
failure is the errno. `fetchCodex` previously echoed `JSON.parse`'s message,
which quotes the text it could not parse: the document is a credential store, so
that leak is closed here.

## The shared reading stays keyed by the credential

[0016](0016-shared-rail-readings.md) forbids two accounts sharing one entry, so a
second Codex source has to be a second key. `credentialFor` therefore returns
`resolve(cfg.codexCredsPath)` for the Codex rail and keeps `resolve(cfg.piAuthPath)`
for the three pools:

```text
  codex  ──▶ resolve(codexCredsPath) ──▶ entry "codex\0<path>"
  claude ──▶ resolve(claudeCredsPath) ──▶ entry "claude\0<path>"
  pools  ──▶ resolve(piAuthPath)      ──▶ one group entry per credential
```

By default those two paths are one file, so the key is byte-for-byte the key
existing entries were written under: an upgrade re-reads nothing, and a reader
with a custom `codexCredsPath` gets an entry of its own.

What the key cannot see is the *account* behind one path. A client that logs
into another Codex account by rewriting the same file leaves the old entry
standing for up to `ttlMs`, so the rail can report the previous account's
headroom until that entry ages out — the same property every rail here has had
since [0016](0016-shared-rail-readings.md), where a pi-side re-login rewrites
`auth.json` under a path that does not change. Keying by the token or the
account id would fix it and was rejected: the token rotates, so the key would
change with it, every Codex read would start with a credential read and a cache
miss, and the default key would no longer be the one existing entries hold. A
path is what a configuration names, so a path is what the entry follows.

## Considered options

**A token in the config (`codexAccess` + `codexAccountId`), which the issue also
offered.** Rejected on two counts. It puts a secret in a plaintext JSON file that
is committed, copied between machines and handed to the generator — and the
provenance block prints every scalar, so `/quota-dispatch config` would print the
bearer token. And a token typed into a file has no owner to rotate it, so it
would go stale while the CLI's own file stayed current; a path is read fresh on
every fetch by construction.

**An environment variable naming the path, "for a launcher to set".** Rejected
because the config layers are the one place a value's origin is known and
reported, and an env var would be a second config surface that the provenance
block cannot attribute, the tests cannot exercise through the loader, and a user
cannot find by reading their own files. A launcher that forks the Pi home is
writing a copy it already owns, so it can put `codexCredsPath` in that copy —
which is also what makes the guest's path visible in `/quota-dispatch config`
inside the guest.

**Accepting only pi's shape, and having the launcher publish a pi-shaped file.**
Rejected because the file it would have to publish is a credential-shaped
`auth.json`, which is exactly what the sandbox refuses to carry; a placeholder
under that name weakens the protection that made it refuse one. It would also
mean a launcher keeping a document in pi's shape alongside the vendor's own.

**An implicit fallback chain (`piAuthPath`, then `~/.codex/auth.json`).**
Rejected: a second source nobody named is another account's headroom reported
under the first's name, and the path key is the user's statement of which
account this rail draws on.

**Widening `piAuthPath` (or an antigravity seam) in the same change.** The three
pools need the same shape of seam, but they are blocked further out — a shielded
guest has no Google credential at all and `cloudcode-pa.googleapis.com` is not
granted — and their `projectId` makes the seam not identical. Deciding Codex
alone keeps that later decision from having to undo this one.

## Consequences

The default is the same file as before, so an install that could read the Codex
rail still can, and its shared entry is the same entry. What changes for a user
who names nothing is the report's wording when the file is missing or malformed:
`no pi auth file` becomes `no codex credential file`, and a malformed document no
longer echoes the parser's message.

"Which account is the Codex rail reading?" is now answerable from
`/quota-dispatch config`'s `codexCredsPath` line, and two Codex accounts on one
machine are two paths and two shared entries.

Nothing about the Antigravity pools moves: they still read `piAuthPath`, still
delegate their one refresh to pi, and still keep their own warning that the file
is pi's to own. A launcher that later publishes a Google credential gets that
decision on its own terms, with this file as the precedent for it.

The reader is now a function of the *file*, not of pi: a Codex credential file
with no `openai-codex` section is a normal, readable credential, so a future
change that adds a third shape has one place to say so.
