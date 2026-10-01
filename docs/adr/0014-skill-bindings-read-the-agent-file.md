# A skill binding selects what the agent file says

## Context

A skill is a prompt pi expands and runs on the **main session**, and the main
session runs on whatever model and thinking level it already had. Yet the user
has already said, per agent, which model its work belongs on and how hard that
work should think: that is what a route and its candidates are. A skill's work
is no different in kind — `/skill:implementation-plan` is planning work — so the
preference that should govern it is one the user has already stated somewhere
else.

The tempting shortcut is a second table, skill to model. That second table would
have to be kept in step with the routes by hand, and nothing would make the two
agree: the same skill's work would run on one model through the dispatcher's
route and on another through the hand-written entry, and the drift would be
invisible until someone noticed the bill or the quality. So the binding does not
name a model at all. It names a route.

## A binding names a route, and the file answers

The `skills` table maps a skill name to the name of an existing agent route —
the same name pi spawns that agent under (ADR
[0012](0012-an-agent-is-named-as-pi-spawns-it.md)) — not to a filename and not to
a model. At invocation, the extension resolves that route's agent file *by its
pi-visible name*, reads the `model:` and `thinking:` it states right then, and
selects them for the session.

The file is the authority, not the route. A route is a policy for choosing among
candidates; the file is what a spawn of that agent would actually run on. Those
are rarely the same thing, and it is the file the user means: if the dispatcher
has held the agent on an alternate, or the user has edited the frontmatter by
hand, the file says so and the session should follow it.

There were three ways to answer "which model does this skill's work belong on",
and the file was the only one that does not either duplicate or contradict
something:

- **Re-decide from quota.** Send a vendor request, pick a candidate, use it. That
  puts a network round trip — bounded, but real (ADR
  [0006](0006-bounded-quota-reads.md)) — in front of every skill, and it is the
  poll's job: the poll is already keeping the file current, so the file is the
  cheap, already-computed answer.
- **Re-derive the level through `thinkingFor`.** That function resolves a level
  from the route and the model table (ADR
  [0004](0004-thinking-levels.md)). It is the *write* path's resolution, and
  using it here would be a second resolution that can disagree with what the file
  says — two answers to one question, drifting apart.
- **Read the file.** One read of the agent dir, no quota, no credential, no
  write. The answer is the one a spawn gets.

A file left stale by a hold is therefore used as it is, on purpose. The
staleness is the point: the file is what the agent would run on, and this path
is not the thing that keeps it current.

## Only an explicit invocation

pi gives extensions an `input` event, and it runs input handlers **before** it
expands a `/skill:<name>` command. The handler sees the raw text, is awaited, and
may change the session; returning nothing leaves the text to pi, which then
expands the skill and runs it on the selection just made. So the switch lands
before the skill's work, and the user's arguments are never touched.

The skill name is split **exactly as pi splits it**: the text starts with
`/skill:`, and the name runs to the first space. Anything else is an ordinary
prompt. That is the whole trigger, and it is deliberately narrow:

- A skill the model loads by itself — through an auto-loaded `<skill>` tag — is
  not an explicit invocation and changes nothing. There is no reliable way to see
  that moment from an extension anyway, and switching the model in the middle of
  a turn would be surprising.
- A prompt that merely *mentions* a skill changes nothing; only the prefix does.
- An unbound skill changes nothing and says nothing. Only a configured binding
  may touch the session or the screen.

## All or nothing, model first

The file's whole selection is validated before the session is touched: a model
must be stated, the level — if one is stated — must be one of the seven, and the
model must be one this pi's registry knows. A file that cannot be applied in
full is applied not at all, because a model with some other level is a selection
nobody stated. And the thinking level is set only **after** `setModel` succeeds,
so a failed model switch never leaves a level that was meant for a different
model.

That atomicity is atomic **validation**, not atomic **application**, and the
distinction is not pedantic. pi's own `setModel` assigns the model to the session
*before* it can fail — the session entry is appended and the model event emitted
afterwards — so a fault in the middle can leave the session moved onto the new
model. The extension therefore does not claim the switch "changed nothing" after
a fault. It captures the previous model and level, puts them back as far as the
API allows (model first, because restoring the model re-applies pi's own level
rule), and reports *whether* that worked: `… could not be selected (<detail>)`
when it did, and the same clause followed by ` and the previous session selection
could not be restored` when it did not. A second session write can fail the same
way the first did, so the warning never promises a rollback it cannot guarantee.

## The session's level survives a switch

pi's `setModel` does more than change the model: it re-derives the thinking level
for the new model from pi's own settings — a per-model setting, else the settings
default, else the current level. Following only the file would therefore let pi
impose a default the file never stated, which is exactly the "preserve the
current session level" the feature is asked to do.

So the level is **read before** the model switch and re-applied **after** it. A
file that states a level wins; a file that states none asks for the session's
level to survive, and the notice says `thinking retained (<level>)` rather than
naming a level as if the file had stated it.

pi also clamps a level to what the target model supports, so the level the
extension asks for is not always the level running. The extension never
pre-clamps — it asks for the file's level, or the session's, and lets pi answer —
and it reads the level **back** afterwards. The notice names what is actually
running: `thinking xhigh, clamped to medium by pi`, or `thinking retained
(medium, clamped from high)`. A notice that named only the request would be
false about the session.

The cost is metadata. When pi's intermediate level (from its own switch rule)
differs from the level the extension re-applies, the session ends up with two
`thinking_level_change` entries — pi's, then the restore — and two
`thinking_level_select` extension events. That is accepted in exchange for the
level actually surviving the switch.

## No restore

The selection persists. It stays until the user changes it by hand or invokes
another bound skill; nothing puts the previous model or level back when the
skill's work "ends". pi has no signal for that end, and any heuristic — a timer,
watching for the next prompt — would switch models under the user at a moment
they did not ask for. Following later dispatcher writes is the same mistake from
the other side: the session would change model mid-task with no invocation, and
the dispatcher's writes are about where the *agent file* points, not about where
the user's live session should be.

## Where the failures are reported

A `skills` entry that could never fire or names no possible route is a **load**
warning: a `skills` value that is not an object, a skill name that is empty or
holds a space (pi names a skill up to the first space, so such a binding could
never match), or a binding whose value is not an agent name. These follow the
ordinary config rule — warn, and the layer beneath stands.

A binding to a route `agents` does **not** configure is deliberately *not* a load
warning. Another layer may complete the table, and a route may be defined only in
the effective config the user has not written yet. It warns at invocation
instead, naming the skill it cost.

Every runtime failure warns **once** and lets the skill run, on the user's
current selection. The preflight failures — an unknown route, a file no single
readable file defines, a file that states no model or a malformed level, a model
this pi does not know, a provider with no authentication — leave the session
exactly as it was. An application fault is reported for what it is, as above.

One consequence worth being explicit about: pi's own `setModel` performs the
SDK's provider-authentication check, and that check can fail. It is pi's check,
and it is not the credential *refresh* the extension elsewhere refuses to
trigger on its own — the extension still reads no quota, runs no ping and writes
no file on this path.

## Consequences

- A bound invocation can move the session to a model the user was not on, and a
  model switch can cost a prompt-cache miss. That is the point of the feature,
  and it is bounded by the user having bound the skill.
- The session can gain an extra `thinking_level_change` entry when pi's own
  switch rule and the re-applied level differ.
- The file can be stale relative to the route, and that is intended: the file is
  what the agent would run on.
- The binding fires on an explicit `/skill:<name>` for a **bound** name even if
  pi has no loaded skill by that name. pi then passes the text through
  unexpanded. The trigger is the typed command, which is the user's stated
  intent; confirming the skill exists through `getCommands()` would add an SDK
  dependency the feature does not otherwise need.
- Invoking the skill while the session is streaming runs the handler immediately,
  so the switch also affects the in-flight run. That is the same consequence as
  changing models by hand mid-stream, and detecting "the end of skill work" is
  out of scope.

## Considered options

**A virtual-model router.** Expose a fake provider that forwards each request to
a real model chosen per request. This is invasive — it changes what "the session
model" means, and every consumer of the session's model would then be talking to
a proxy — and it pushes the decision into the request path rather than the
invocation the user typed.

**Scanning requests for auto-loaded `<skill>` tags.** Watch the outgoing text for
a `<skill>` marker and switch then. There is no reliable trigger for when such a
skill actually begins, and switching mid-turn is exactly the surprising behaviour
the explicit-only rule avoids.

**Restoring the previous model when the skill "ends".** Rejected above: pi has no
such signal, and any heuristic switches models under the user.

**Following later dispatcher writes.** Rejected above: it would retarget a live
session with no invocation.

**A second skill-to-model table.** Rejected above: it would drift from the routes
the user already configured.
