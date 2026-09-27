# The Claude credential is read from the file, then from the login keychain

Claude Code stores its subscription credential in two places, and on macOS the
one it actually refreshes is the login keychain, not
`~/.claude/.credentials.json`. The Agent SDK reads the keychain as the primary
store and treats the file as a plaintext fallback; a machine driven through a
bridge rather than through `claude` directly therefore ends up with a
long-expired file and a current keychain. Reading only the file made the rail
report `claude token expired (run Claude Code to refresh)` while Claude was
answering every turn in another session — advice that was not merely useless but
wrong, because Claude Code *was* refreshing the credential, into a store the
extension never looked at.

So the credential file is read first, and when it cannot supply an unexpired
token the keychain is read through `security find-generic-password -a $USER -w -s
"Claude Code-credentials"` — the same call Claude Code and the SDK make, against
the same item they write.

## Considered options

Reading the keychain **first**, as Claude Code and the SDK do, is the faithful
option and was rejected on cost: it spawns a subprocess and touches the user's
keychain on every poll, and if the item's access control is not granted, a
poller that runs every few minutes is a permission dialog that runs every few
minutes. The file-first order keeps a healthy install — every Linux install, and
any macOS install whose file is still current — paying nothing at all, and pays
the subprocess only in the case that is broken today.

Reading it on **every platform** was rejected because there is no such store to
read elsewhere: off macOS the file is what Claude Code writes, so a fallback
would be a second way to read the same credential.

Asking the user to **log in to Anthropic in pi** instead was rejected as a
non-option rather than a trade-off. It is a different credential for a different
client: pi's `auth.json` is read for the Codex rail only, and a pi-side Anthropic
login lands in a store this extension never consults, so it changes nothing about
the numbers the Claude rail reports.

Leaving the keychain available to **any** configured `claudeCredsPath` was
rejected as a silent wrong answer. A `CLAUDE_CONFIG_DIR` profile keeps its
credential in its own file and never writes the keychain, so for any path but the
default the keychain holds a *different account's* token — reporting one
account's headroom while work draws on another is worse than reporting nothing.

## Consequences

A custom `claudeCredsPath` is now a statement that the credential lives in that
file and nowhere else, and it disables the fallback. The keychain is therefore
answered for exactly one path: the default file, which is the only path whose
profile has a keychain at all.

When both stores fail, the note names both reasons — the file's, then the
keychain's after `; keychain: ` — because "why can't the Claude rail be read" is
only answerable if the reader learns that both were tried and how each failed.
That is the same reasoning that makes an unreadable rail a hold: a missing
reading is not evidence of room, so no agent moves on the strength of it.

Nothing regresses where the keychain cannot be read. A denied or missing item
leaves the file's reason standing alone, the rail unreadable, and the dispatcher
holding — byte-for-byte the behaviour that existed before the fallback. The read
is bounded the way the vendors bound it, so a wedged keychain delays a session
start rather than hanging it.

Tests never touch a real keychain: the reader is injected, and the darwin argv is
covered through a fake command runner. That is also what keeps the suite able to
run on Linux CI, where the store does not exist.
