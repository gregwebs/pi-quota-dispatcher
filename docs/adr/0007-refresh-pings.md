# An expired Claude token is refreshed by pinging Claude Code, never by writing the credential

The Claude rail reads an OAuth access token that belongs to Claude Code: an
8-hour credential that only Claude Code refreshes, as a side effect of being run.
Driven through a bridge rather than through `claude` directly, nothing refreshes
it while the machine is idle, so the first read after a night's sleep finds the
token expired — and an expired token is a missing reading, which holds every
route that depends on it (rule 5 in the README, ADR 0006). The rail is unreadable
exactly when a new session wants to read it.

The note said `run Claude Code to refresh`, which is advice for a user who does
not exist here: this extension's whole premise is that Claude is reached through
a bridge, and the bridge refreshes the token only while it is being used. The
instruction appeared precisely when it could not be followed.

`claudeRefresh` decides what to do about it, and ships `off`:

- **`off`** — read the credential, report the expiry, change nothing.
- **`offline-ping`** — run one throwaway Claude Code process whose model request
  is pointed at a loopback listener this extension answers itself.
- **`ping`** — the same run without the diversion. A real request, costing a real
  answer's worth of tokens.

## The refresh is delegated, not performed

The extension never posts the refresh token and never writes the credential
store. It runs `claude` and lets Claude Code resolve its own credential:

```sh
claude -p hi --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<ephemeral port>"}}'
```

Authentication is resolved while the API client is constructed, **before** any
request is put on the wire, and the token endpoint is `platform.claude.com` —
which `ANTHROPIC_BASE_URL` does not touch, because that variable only sets the
messages client's base URL. So the credential is refreshed and persisted, and the
model request dies on loopback having encoded nothing. Measured against a
backdated credential: **zero tokens** — every `usage` counter zero,
`total_cost_usd` zero — the account's own five-hour and weekly percentages
identical before and after, and one request logged on the listener. The new
credential was written ~100 ms *before* that request was dispatched, which is
what makes the request's fate irrelevant to it.

The run itself took 1 second in that first measurement and 3.9–5.3 s in later
runs on the same machine, all of it inside Claude Code's own startup: nothing
about the diversion, and nothing the flags in "Considered options" below can
trim.

Doing the refresh here was the obvious alternative and is now rejected on
measured grounds rather than on caution. The refresh token **rotates**: the
server hands back a new one and it supersedes the old. Claude Code then treats
`invalid_grant` for a token matching the one it stored as proof the session is
over and **empties the credential** — `{refreshToken:"", accessToken:"",
expiresAt:0}`, which ends the login. A second writer of this credential is
therefore not merely redundant, it is a way to log the user out, and the only way
to be sure there is never a second writer is not to have one. The same reasoning
rules out a credential from `setup-token` or `CLAUDE_CODE_OAUTH_TOKEN`: those are
inference-only scoped, they cannot read the usage endpoint (it needs
`user:profile`), and Claude Code's own save path declines to persist them at all.

Delegation also inherits the cross-process refresh lock for free: a bridged
Claude Code running in another pane and a ping cannot both be refreshing, and the
loser is told so.

The child also gets a deliberately narrowed environment. It would otherwise
inherit pi's, and an `ANTHROPIC_API_KEY`, a `CLAUDE_CONFIG_DIR` or a
`CLAUDE_CODE_OAUTH_TOKEN` exported there could make Claude Code refresh — or
spend — a credential other than the one the dispatcher read, which the
default-path rule cannot see. A provider switch (`CLAUDE_CODE_USE_BEDROCK` and
the like) or another vendor's base URL is dropped for a sharper version of the
same reason: it moves the model request off our listener and bills that other
provider. Everything a normal run needs — `PATH`, `HOME`, proxies, locale — is
still inherited. `ANTHROPIC_MODEL` is dropped for a separate reason: an id the
running install does not recognise is rejected before authentication is reached,
which is the one outcome that would defeat the exercise. The list is a denylist
rather than an allowlist because it must not omit anything the child needs —
being wrong there turns a working refresh into a silent failure — and the
residual it leaves is bounded: a selection variable it does not know about
surfaces as an `undiverted` run, which halts the feature until the resolved
`claude` changes or `/quota-dispatch refresh` is run.

## A listener, not a dead port

The diversion points at a socket this extension owns rather than at an unroutable
port, and both reasons are measured.

A port with nothing behind it does **not** fail fast: the run took **181 seconds**
to report `ECONNREFUSED`, because the client arms a 180 s first-byte timeout for
first-party requests and waits it out instead of noticing the refusal. The same
run against a listener that answers `400` finished in about a second — *The
bounds* below has the spread that figure comes from.

More importantly, a request *arriving* is the only evidence that the diversion
took effect. A diverted ping and an authentication failure both exit non-zero, so
exit status cannot tell them apart; without the listener, an override that
silently failed to apply would be reported as a failed refresh while the request
it really sent cost a real answer's worth of tokens — around 31k of them in the
measurement. No request arriving is an anomaly to report, never something to
retry: a clean exit that reached no request is its own verdict (`undiverted` in
the code), and it halts the feature until the resolved `claude` changes or
`/quota-dispatch refresh` is run, because a clean exit means the model call was
answered *somewhere* and the diversion may have failed at the cost of a real
request. That halt is the one that outlives a usable token — see *The bounds* for
why — and the rail says so, because "the feature is off until you update Claude
Code or run refresh" otherwise reads as a bug.

Arrival is proof only that a connection reached this socket, not of who made it:
a stray loopback connection during the run counts. That is accepted rather than
guarded, because any local process able to reach the port could already read the
credential file — the socket exists to prove the diversion took effect, not to
authenticate its caller.

The listener binds an ephemeral port on `127.0.0.1` (the OS picks, so there is no
collision to handle), answers with a `400`, and **never reads the request's
headers**: they carry the freshly refreshed access token, and a listener that
recorded one would be the only place in this extension that holds a credential.

## Expiry is the only trigger

Not a 401, which is an answer about a token that was just read — a ping cannot
fix it, and the subprocess would only obscure it. Not a 429, which is the usage
endpoint asking us to slow down, and ADR 0006's rule that a 429 is the endpoint's
answer rather than a failure. The one reason a ping can fix is that the stored
token has run out, so that is the one reason the credential read carries as a
tag; the dispatcher acts on the tag, never on the message.

The ping is gated on the default credential path for the same reason the keychain
fallback is (ADR 0003): it refreshes *this machine's* default Claude Code profile
and can say nothing about another one.

## The bounds

A ping is awaited by `session_start`, so it is bounded the way the quota reads
are: a 10 s timeout, chosen above a spread of measured runs that goes from under
a second to 5.3 s. The spread is unexplained — all of it is inside Claude Code's
own startup — and it is wide enough that "about a second" is not a number to
design against.

The bound does not have to be tight to be safe: the refresh is written ~100 ms
in, so a bound short enough to protect the session start still leaves a completed
refresh behind. It just cannot *say so* — the listener is what makes the run
self-reporting.

Killing a run has one residual cost, and it is narrow. If the bound lands after
Claude Code has POSTed to the token endpoint but before it has written the
response, the server has already rotated the refresh token while the store still
holds the old one — and a stored refresh token the server has superseded is what
Claude Code turns into an `invalid_grant` wipe. The window is the token round
trip, a few hundred milliseconds inside a run that otherwise takes seconds, which
is why the bound is generous rather than tight. Two ways out were considered and
rejected: a bound above the child's own 30 s token timeout, so that the child
would always finish or report its own stall, at the cost of a session-start stall
of that size — the constraint ADR 0006 exists for, and the reason the spec chose
a bounded kill; and a do-not-kill race that lets a slow run finish once it has
signalled it is refreshing, which needs a signal the child does not provide. A
future reader with a reason to revisit this should start here.

Single-flight covers the callers that race *inside one process*: `railReadings`
is reached from the startup path, the poll, and `/quota-dispatch refresh`, and
only one of those runs a `claude` at a time. Across processes the ping is
covered by the per-credential fetch lock the shared readings file already takes
(ADR 0016): the ping runs inside the read the lock serialises, so two pi
processes on one credential make one ping between them, and the loser is handed
the winner's reading.

Two gates sit over the *next* attempt, and they are deliberately different. A
**cooldown** — 15 minutes — follows a `failed` attempt: nothing appears to have
happened (the binary is missing, the run stalled before any request), so one
retry is worth making. `pollMs` ships at 5 minutes, so without it a dead refresh
token would mean one subprocess per poll for the rest of the day.

A **halt** follows anything that could have spent money or that ran without
effect — a `failed` attempt in `ping` mode, or a `pinged` run whose re-read
still finds no token. Those halts are **per-episode**: a credential read that
yields a usable token ends one, and a later expiry is a new episode that may
ping again. The `undiverted` halt is the exception and is **keyed to the Claude
Code install**: a clean exit that reached no request is a property of the
*environment*, not of that one expiry, so the next expiry would fail to divert
the same way and pay again. It therefore survives the usable token that ends the
episode. It is cleared when the resolved `claude` path or mtime changes — an
update to Claude Code is what could change "this build ignores the diversion" —
or explicitly by `/quota-dispatch refresh`. Neither gate is re-armed by a hit: a
read inside the cooldown does not push its own window out, however many 5-minute
polls land in it.

These numbers are constants rather than config-file keys, for the reason the
quota-read timings are: how long to wait for a subprocess is a fact about this
machine, not a routing preference.

## The gates are shared through the readings file

All three gates live in the shared readings file beside the readings (ADR 0016),
keyed by the resolved credential path, so a cooldown or halt armed by one pi
process is honoured by every other. A gate hit still writes nothing, so honouring
a peer's gate never pushes its window out.

The sticky halt is one record for the machine rather than one per credential: an
install that ignores the loopback diversion does so for every profile. It stores
the resolved `claude` path and mtime it was armed against. A later read whose
resolved install does not match ends the halt and lets the attempt be made
again; a read that cannot resolve the install keeps the halt rather than reading
"I could not find the binary" as "the binary changed". A halt armed when no
install could be resolved stores no path and is therefore only cleared by
`/quota-dispatch refresh`.

The write is best effort, exactly as a reading write is: a gate is also kept in
the process that armed it, so a file that cannot be written never turns the
gate that protects this process into an un-gated retry. The residual of the
shared design is the residual of ADR 0016's bounded fetch-lock wait: a process
that reaches the bound fetches — and so pings — for itself rather than waiting
out a holder it cannot see the end of. That bound is computed from the quota
read's own limits and does not include the holder's keychain read or the gate
writes this ADR added, so even a healthy holder can exceed it and a duplicate
ping is possible. The one-ping guarantee is therefore for the ordinary case
where the holder answers within the longest a *vendor* read can take, not an
absolute one.

## What is not known

Two facts the diversion rests on were read out of one Claude Code build and are
not a contract: that the credential is refreshed *before* the model request is
dispatched, and that `ANTHROPIC_BASE_URL` does not touch the OAuth token path.
The second is the one the listener covers — a version that routed the token
request through the base URL would send *that* request to our socket, so the run
would be reported `pinged` (a run that dispatched something and refreshed
nothing) rather than `undiverted`. The first is not detectable at all: a version
that dispatched the request first and refreshed afterwards would still divert
and still refresh, in the wrong order,
and every signal this extension has would look the same. A future reader should
re-run the measurement in issue #30's verification comment against a new Claude
Code before trusting the mode again.

The run time's spread — under a second in the first measurement, 3.9–5.3 s in
later ones on the same machine — is also unexplained. It is inside Claude Code's
own startup, so nothing in the flags tried changes it; it is only the reason the
bound is set where it is.

## Considered options

**Refreshing in the extension.** `POST` the token endpoint and write the store.
Rejected above: rotation plus the `invalid_grant` wipe make a second writer a way
to end the user's session.

**Reusing the bridge's or pi's credential refresh.** pi is never logged into
Anthropic here, and the bridge refreshes on its own schedule — while it is in
use, which is exactly when the rail is not the thing being read.

**`setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`.** Inference-only scope cannot read
the usage endpoint, and the save path refuses them, so they cannot even be the
credential this feature would refresh.

**Deferring the ping to the background.** It would keep the session start
instant, but the session that discovers the expiry is the one that holds — which
is the complaint this feature exists to answer. A few seconds, once per expiry,
is the cheaper trade.

**A real ping by default.** It is a genuine request with a real answer, so it is
proven to work in a way the diverted form is not. It is also ~31k tokens every
time, which is the budget the rail exists to report on. It stays as `ping`, the
fallback for a machine where the diversion stops working.

**Reducing the token cost of `ping` mode.** `--tools`, `--setting-sources`, a
`--system-prompt` and MCP suppression all shrink the prefix. Left undone because
it only matters if `offline-ping` stops working, and a mode nobody has needed yet
is not worth carrying. Measured afterwards, on latency rather than tokens:
`--setting-sources user`, `--strict-mcp-config` and `--tools ""` each move the
run time by less than the run-to-run noise, so there is nothing to buy there
either.

## What a `ping` costs the reading it enables

In `ping` mode the request is real, so the rail's own consumption lands in the
window the next read reports: a five-hour percentage that moved because the
extension asked a question. `offline-ping` spends nothing and so perturbs
nothing, which is another reason it is the mode to recommend.
