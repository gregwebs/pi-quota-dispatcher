# The Codex token is refreshed by running the CLI, when and only when a human asks

## Context

[0023](0023-an-expired-codex-token-is-named.md) gave the codex rail a sentence
instead of a doomed request: a token past its own `exp` is reported as
`codex token expired`, and the report stops sending. That fixed the wrong
question — a `401` read like a broken credential — but not the dormancy. The
Codex CLI is the only thing that refreshes that token
([0022](0022-openai-routes-read-the-codex-ledger.md)), so a machine that has not
used the CLI for a while has a rail it cannot read and a policy that holds, while
the models themselves keep answering on pi's own sign-in.

The temptation is the one [0007](0007-refresh-pings.md) already settled for
Claude: run the client, divert the model request to a loopback listener, and let
the client do its own refresh. For Claude that is a background ping, because
Claude Code refreshes on any run and costs a stalled session start. The Codex CLI
is not that. It is a coding agent, its startup is not a token refresh, and what it
reads on the way up — project config, `.env`, managed policy, a credential store
of its own choosing — is far more than a CLI ping's surface. Running it behind the
user's back would be spending an agent on a token.

So this decision is smaller in scope and larger in consent: **a command a human
runs, that runs the CLI once in the foreground, and then says what the file
holds.** Nothing here writes a Codex credential, and no path of this extension
runs the CLI except that command.

## The command, and what it claims

`/quota-dispatch refresh-codex` is its own form, one word, matched whole like
every other. `refresh codex` is not it. It is answered from the active
configuration before the boot: it boots nothing, reads no quota, never touches
the gauge, and returns after one notification plus the notice that precedes the
run.

```text
/quota-dispatch refresh-codex
   │
   ├─ admit ──── eight cheap local facts (§ below) ──── refused? say which, spawn nothing
   │                 └─ token good for > 5 min? ─────── not-due, spawn nothing
   │
   ├─ open our loopback listener        (the URL the run is pointed at)
   ├─ make a private workdir, vet it    (no .git or foreign .codex above it)
   ├─ admit again                       (the before-snapshot the run starts from)
   ├─ spawn codex exec … chatgpt_base_url="http://127.0.0.1:<port>"
   │      wait ≤ 90 s ─── TERM ── +5 s ── KILL ── +5 s ── stop waiting
   │
   └─ read auth.json again, compare with the before-snapshot
          new token, same account, future exp, numeric exit before the deadline
             ──▶ "the credential file holds a new token for the same account (valid until …)"
          anything else
             ──▶ what was observed, and "not reported as a refresh"
```

The child is the Codex CLI, so the exit code is not the verdict: the diverted run
is *expected* to exit non-zero, because the listener answers `400` and the client
gives up on that request. What the command can observe is the file — and it says
exactly that, no more.

## The admission list: eight local facts, in this order

Each check is cheap, local, and fails closed. The order is the order they run, and
the first failure is the one sentence the user sees.

| # | Fact established | Refuses with |
|---|---|---|
| 1 | the platform is not Windows | `not supported on Windows` |
| 2 | `CODEX_HOME` (or `~/.codex`) is an absolute path | `CODEX_HOME or HOME is not a usable absolute path` |
| 3 | the file is not the same inode as pi's own `auth.json` | `codexCredsPath is pi's own auth.json` |
| 4 | the file resolves to the CLI home's own `auth.json` | `codexCredsPath is not the Codex CLI's own auth.json` |
| 5 | the CLI home has no `.env` | `the Codex CLI home has a .env file (or could not be checked)` |
| 6 | `config.toml` leaves the credential in the file | `config.toml chooses a credential store other than the file` |
| 7 | the document is the managed ChatGPT login | `the file is not the Codex CLI's managed ChatGPT login` |
| 8 | a `codex` is executable on an absolute `PATH` entry | `no executable codex on PATH` |

The checks are stated as refusals rather than assertions because each one is a
*reason not to run*, and a user can act on a reason. The exact predicates — which
`stat` fields, which `lstat`, which two regular expressions over `config.toml` —
live in `src/codex-refresh.ts`, next to the sentence each one earns; this list is
the shape of the argument, and that module is where it is implemented.

The due check sits between 7 and 8 because it is not a refusal: a token with more
than five minutes left is not worth a subprocess, and the CLI's own proactive
refresh window is the same five minutes (`manager.rs:233` in the pinned release
below). A refusal that ran before it would report "no codex on PATH" for a token
that needed nothing.

`config.toml` is read as text, not parsed: a TOML parser would have to be right
about tables, profiles, includes and multi-line strings that this module never
uses, and being subtly wrong would admit a config the CLI reads differently. Two
narrow checks — no escaped keys, and every mention of `cli_auth_credentials_store`
is the plain `"file"` assignment — reject what cannot be vouched for and pass
everything else. `.env` is refused on existence alone, for the same reason: it
could put back a base URL, a proxy or a credential that the run's stripped
environment assumes away.

The predicate is deliberately not the CLI's whole loader. The pinned CLI also
requires `last_refresh` to load the document (`manager.rs:657–669`), which admission
does not check — a file the CLI would reject is rejected by the CLI, and the
after-check then reports no matching change rather than an invented success.

## Why native `realpath`, and never `path.join` first

The one place this command must not be clever is which file it is looking at.
Node's `path.join` and its legacy `fs.realpathSync` collapse `..` **lexically**,
before any symlink is resolved, and the OS — the one the CLI also uses — resolves
each component as it walks:

```text
CODEX_HOME = /tmp/t/link/../home        link ──▶ /tmp/t/alt/sub

  lexical collapse:  /tmp/t/link/../home  =  /tmp/t/home        ✗
  OS resolution:     /tmp/t/link  =  /tmp/t/alt/sub
                     /tmp/t/alt/sub/.. =  /tmp/t/alt
                     /tmp/t/alt/home                     ✓  (the CLI's home)
```

A checker that disagreed with the writer about which file it had been shown would
either refuse a working install or admit a file the CLI will not write. So the
home is resolved once with `fs.promises.realpath` (native `realpath(3)`, the same
one `fs.realpathSync.native` uses), `"auth.json"` is joined onto the *resolved*
home, and the configured credential path is resolved on its own and compared to
that. No `path.join` runs before a `realpath` on either side, and every lookup
error refuses rather than being skipped: "could not tell" is not an answer to run
a subprocess on.

## A deadline, an escalation, and a file compared with itself

The run is waited for to a monotonic 90 s deadline — `performance.now`, not the
wall clock, so a clock jump cannot make a waiting run look finished. At the
deadline the child is asked to stop (`SIGTERM`), five seconds later told to
(`SIGKILL`), and five seconds after that the command stops waiting and says no
exit was observed. A signal is never taken as proof the child stopped, and only
the direct child is signalled; both are stated in the residuals below.

An exit observed at or after the deadline is *late*, not successful, even if it
arrives before the `SIGTERM` timer's callback runs: the clock and the timer are
one rule read twice. And a pre-deadline exit on a signal is not success either —
the exit code is the only thing that says the child stopped on its own terms.

The listener is the address the model request is pointed at, and it exists for
that ownership, not for proof: it answers `400` with a body the client never has
to read, and it records only that *a request arrived*. That is a diagnostic
detail, quoted in one outcome line, and never part of the success predicate — a
stray local request would otherwise read as a diverted run. The one thing it does
flag is the anomaly the exit code hides: a clean exit with nothing on the
listener, which the diverted run is not expected to do, is reported as exactly
that.

Success is therefore: a numeric exit before the deadline, **and** the file
holding a new access-token digest, the same `account_id`, and an `exp` in the
future. That is a statement about the file. It is not a statement about authorship
— a concurrent writer can leave the same observation — and the residuals say so.

## The hint is rendered, never stored

The report's `codex token expired` note gains one clause, computed at print time
from the same admission list the command runs:

| Readiness | The clause |
|---|---|
| ready | `run /quota-dispatch refresh-codex to have the Codex CLI refresh it` |
| not due | `the file now holds a token valid until …; /quota-dispatch refresh reads it again` |
| refused | `not refreshable from here: <the refusal sentence>` |

Computing it at print time is what keeps it honest — a hint stored on the reading
would describe the machine as it was when the read happened — and it is why the
hint cannot suggest a run that would refuse. It is never part of a reading, the
readings file, the generator input, or the gauge: those are what was read, and
this is what to do next. Only the expired note carries one; `HTTP 401` and every
other failure do not, because they are not the same fact.

## Residual risks

`/quota-dispatch refresh-codex` checks only the eight cheap, local facts in the
admission list above. Before/after checks observe only whether `auth.json` changed
to a new, future-dated token for the same `account_id` after a pre-deadline
numeric exit; they do **not** identify which writer changed the file or prove the
spawned child caused the change, and the command makes no guarantee of:

- **Save-ability:** whether the CLI can atomically replace `auth.json` or take
  `auth.lock` (hard links, single-file or read-only mounts, file permissions,
  ACLs, sticky directories, immutable flags, full disk, or lock contention).
- **Managed, system, or cloud configuration:** `--ignore-user-config` skips the
  user's `config.toml` only. System (`/etc/codex/config.toml`), MDM/managed,
  requirements, and cloud layers still load. They can force a non-file credential
  store (mutating another store or leaving `auth.json` unchanged) or enforce
  login/workspace restrictions that actively log the account out during CLI
  startup.
- **Strict isolation:** managed or plugin hooks, MCP server startup, proxies
  ignoring `NO_PROXY`, the issuer in `oauth_provenance`, and CLI non-session state
  (`auth.lock`, state DB) are outside our flags. Zero model egress is a
  measurement of `codex-cli 0.170.0`, not a sandbox guarantee; the operator's own
  environment is the trust boundary.
- **Expiry encoding or server validity:** the due check and after-check reuse
  `codexTokenExpiry`, which reads the JWT's unsigned `exp` claim without checking
  canonical encoding or signatures; a future `exp` is evidence about the file, not
  proof the server will accept it.
- **Process and concurrency edges:** only the direct child is signalled after the
  90 s deadline (wrappers spawning descendants, a child surviving `SIGKILL`, or pi
  exiting mid-run are not supervised). No cross-process lock coordinates two pi
  instances or a user-run `codex`: concurrent refreshes can race on a rotated
  refresh token, and a concurrent writer can leave a matching file change that
  this command cannot distinguish from its own child.

**The two failure modes that matter and their recovery:**

1. **Redeemed token that failed to save** — the CLI rotates the refresh token on
   OpenAI's server, then fails to write `auth.json` (any unchecked save condition
   above, a concurrent `codex` refresh, or termination attempts at the 90 s
   deadline).
2. **Managed configuration that logs the account out** — an administrator policy
   or login restriction triggers logout during CLI startup before the refresh
   completes.

Whenever no matching change is observed in `auth.json` (a new, future-dated token
for the same account after a pre-deadline numeric exit), the command reports a
non-success; it cannot prove either underlying failure did not occur. When either
failure mode invalidates the login, the recovery is the same: **run `codex login`
once.**

## Pinned upstream

Everything above about the CLI's own behaviour was read from the release this
command was measured against, not from a moving branch: `openai/codex`
`rust-v0.170.0`, commit `29eb79e9866b3262a777fdf8195c1b9e63684c91`. The login
manager is `codex-rs/login/src/auth/manager.rs` at that commit — Git blob SHA-1
`4e8f825ab243034c0c10a572399fb88a929c074c`, whose content hash is
`93a0ebc5a50d1f18b9e36a38757e03bce991fad8`. The five-minute refresh window is
`manager.rs:233`, the proactive refresh is `manager.rs:3660–3678`, the document
the CLI will load is `manager.rs:657–669`, and `chatgpt_base_url` — the config
key the diversion sets — is loaded at
`codex-rs/core/src/config/mod.rs:4711–4713`.

The pin is evidence about a release, not a runtime compatibility guarantee: the
resolver checks that some `codex` is executable, not that it is this one. A
different CLI is a different set of facts, and the residuals above are where that
shows.

## Considered options

**An automatic, supervised design — the one this ADR replaces.** The earlier
proposal was to refresh Codex tokens the way 0007 refreshes Claude's: a poll or
`session_start` path that notices an expired token, takes a cross-process claim on
the credential, runs the CLI in a supervised process group, and halts a machine
that has failed too often. Every one of those pieces turned out to need the
others: the claim needs a lease because a crashed supervisor must not wedge the
feature; the supervision needs a process group because the child is an agent that
can spawn descendants; `session_start` needs a bound on how much of a spawn can be
spent on someone else's login; and a halt needs an episode to be scoped to. Each
review of that design found another interaction, and the prize was refreshed
tokens nobody had asked for. A human-invoked command needs none of it: there is
one run, a human is watching it, and a failure is reported to the person who can
`codex login`. The machinery was dropped, not deferred.

**A maximal admission set — proving the CLI can save before running it.** The
other direction was to check more before spawning: whether `auth.json` is
atomically replaceable and `auth.lock` obtainable; that no managed, system or
cloud layer can select another store or force a logout; that the token's claims
are canonically encoded and its issuer the expected one. That is re-implementing
the CLI to predict what it will do, and it does not close the races it is aimed
at — a write can fail after the check that said it would not, and a managed policy
is evaluated by the CLI at startup, not by us. Stating the residuals and naming
`codex login` is simpler, more honest, and fails in one direction: a run that
changed the file in a way this command cannot vouch for is reported as
"not reported as a refresh", which is true.

## Consequences

A dormant Codex CLI is now recoverable from inside pi: `/quota-dispatch
refresh-codex` runs it once, in the foreground, and either the rail has a fresh
token to read or the user is told what was observed and that `codex login` is the
repair. The report stops being a dead end — its expired note names the command,
or names the refusal that says why the command would not help here.

The command is the one form of this extension that requests a Codex refresh
subprocess. It is also the only form that adds a network listener of its own: a
loopback socket that answers `400`, alive for the length of a run and gone
afterwards. What the spawned CLI contacts is the CLI's business under the
operator's own environment, which is why the README separates those two facts
rather than promising a boundary.

Nothing in the readings contract moves. The readings file has no new field, the
gauge draws nothing new, the generator input is unchanged, and `fetchWaitMs` —
which bounds a read, not a spawn — is untouched. A refresh is a thing the user
did, and the next `/quota-dispatch refresh` reads the rail again.
