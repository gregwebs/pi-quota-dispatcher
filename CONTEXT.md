# pi-quota-dispatcher

Keeps each agent on a model its account can still afford, by rewriting the model
declared in the agent's own definition file.

## Language

**Dispatcher**:
The extension as a whole: the thing that reads rail budgets and decides where
each agent belongs.
_Avoid_: router, scheduler, balancer

**Agent**:
A named identity that pi can spawn, defined by a file in the agent dir. Its name
is the name pi spawns it under — the file's declared `name:`, else the filename
stem — so the name and the filename are independent, and a route key is a name,
not a filename.
_Avoid_: subagent, agent config, agent entry

**Agent Definition**:
What a route resolves to before any model is chosen: the name pi spawns the
agent under, and the file a write for it lands in. Where no file claims the
name, it is the path `/agents` would create, and nothing is written there.
_Avoid_: agent target, file reference

**Agent Route**:
The destination policy for one agent: its primary and its list of alternates.
A route is never described as disabled — an entry in a config file either names a
route or is skipped, and a skipped entry names no route at all.
_Avoid_: route, routing rule, mapping, agent route entry, disabled route

**Skill binding**:
The association a `skills` entry states between a skill name and an existing agent route. An explicit
`/skill:<name>` invocation applies that route's agent **file** to the current session — its `model:` and, when it
states one, its `thinking:` — and the selection persists until it is changed by hand or by another bound
invocation.
_Avoid_: skill role, skill model, role mapping

**Candidate**:
One model on one rail, considered as a possible destination for an agent. The
rail comes from the candidate's own `rail` when it states one, otherwise from the
model's entry in the `models` table; a candidate with neither is rejected.
_Avoid_: option, target, model entry

**Thinking level**:
How hard pi tells a model to think before it answers, stated as `thinking:` in
the agent file and read by pi-subagents at every spawn. One of `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`. Whether the model can do the level asked
for is pi's business, not the config's: pi clamps.
_Avoid_: thinking budget, reasoning effort, thinking mode, thinking setting

**Model default**:
The rail and thinking level a model carries wherever a route names it, stated in
the `models` table. The rail is the recommended place to register a model's
account, and a candidate may state its own to override it. The level is the
weakest of the three places one can be stated — a route default and a candidate
both outrank it. Both are inert for a model no route names.
_Avoid_: model config, per-model setting, model entry

**Resolved level**:
The one level a write uses: the candidate's, else the route's, else the model's,
else nothing at all. Nothing means no line is written — never a level of `none`.
There is no *restore*: a level once written stays until some pass resolves
another one, so the guarantee is about the pass being made and never about what
the file used to hold.
_Avoid_: effective level, final level, thinking default

**Unmanaged**:
Describes an agent file whose agent no agent route names. The dispatcher never
touches it, and that is a normal state rather than a fault.
_Avoid_: disabled, ignored, unconfigured, unrouted

**Primary**:
The candidate an agent sits on when nothing is tight.
_Avoid_: default, home

**Alternate**:
A candidate an agent can move to while its primary is tight. An agent route lists
its alternates in priority order and the dispatcher takes the first usable one;
an empty list means the agent is pinned to its primary.
_Avoid_: fallback, secondary, backup

**Rail**:
One account whose quota is consumed by model calls. A rail is per-account, not
per-provider: several model prefixes can draw on the same rail.
_Avoid_: provider, plan, account, budget

**Rail reading**:
What one quota read reports for one rail: each window the vendor reported, how
much of it is used, which budget it counts toward and when it resets — or why
the read failed. A reading states facts only; whether a budget is **tight** is a
judgment the policy makes about it, not part of it.
_Avoid_: usage data, quota data, rail state, usage snapshot

**Last good reading**:
A rail's most recent successful **rail reading**, kept even after later reads of
that rail fail.
_Avoid_: cached reading, stale reading, fallback reading

**Rail readings file**:
The one file a machine's pi processes share their **rail readings** through, so
two processes polling one credential make one vendor request per TTL between
them. It sits beside the global config, is created `0600` because a reading
carries the vendor's own response body, and is keyed per rail and credential, so
a second account never inherits a first's numbers. Its format is internal and
versioned, not a public contract: a **rail reading** read back out of it is the
same shape a process cached itself. A corrupt or unknown-version file is skipped
rather than fatal — the whole file reads as empty, the **report** carries the
warning, and the next successful write repairs it. See
[docs/adr/0016](docs/adr/0016-shared-rail-readings.md).
_Avoid_: cache file, quota file, shared store, readings cache

**Session budget**:
A rail's short-window cap — the acute one that blocks work mid-task and clears
within hours.
_Avoid_: 5h window, short window, primary window

**Weekly budget**:
A rail's long-window cap. It rarely blocks work, but when it does it does so for
days, so a switch made on it is close to one-way.
_Avoid_: 7d window, long window, secondary window

**Metered**:
Describes a rail billed per token rather than quota-capped. It reports no budgets
and is never tight.
_Avoid_: uncapped, unlimited, free

**Tight**:
At or above the threshold for its budget. Only ever said of a rail's budget, not
of an agent.
_Avoid_: hot, exhausted, blocked, over

**Switch**:
Moving an agent off its primary onto one of its alternates, because the primary is
tight. Applies to the next spawn; work already in flight keeps the model it
started on. On the session budget a switch normally needs an alternate `margin`
points healthier, but once the primary reaches a configured
`sessionAlwaysSwitchAt` an alternate only has to be strictly below that same
threshold — the margin is replaced, not widened, and an alternate at or above it
is not a destination.
_Avoid_: failover, migration, rotation

**Contested**:
Describes an agent name that two or more agent files claim, so pi spawns
whichever it loads last. A contested route is **held**.
_Avoid_: ambiguous, duplicate, shadowed

**Hold**:
A decision to assign nothing, leaving the files of the agents involved exactly as
the user left them. What the dispatcher does when a reading it does not have
could have changed the answer — an unreadable rail, or a budget that was not
reported — and when no single file could carry a write: a **contested** name,
where two or more files claim it. It is also the decision for an agent whose
**primary** this pi cannot spawn: there the model is *known bad* rather than
*unknown*, no reading could change the answer, and it is dropped from
consideration instead of waited on. A pass also holds when the write itself
cannot be made: a **conflicting assignment**, or a **lock** another process still
holds.
_Avoid_: skip, no-op, hold-off, fall back

**Unusable file**:
A config file that is there but produced no layer: it is not JSON, it is JSON but
not an object, or it could not be read. The dispatcher skips it whole. Distinct
from an *absent* file, which is simply not a layer, and from an unconfigured
install: the file names routes, and those routes were thrown away.
_Avoid_: invalid config, bad config, missing file, absent file

**Lock**:
The per-file claim a pass holds while it rewrites an agent file, so that two
cooperating pi processes do not rewrite one agent file at once. Only a pass with
a write to make takes one: a pass that finds the file already right needs no
coordination, and reports **unchanged**. Separate from the file being *replaced*
in one step, which is what keeps a reader — pi's own agent loader included, since
it takes no locks — from ever seeing a half-written file. A lock is held on the
**resolved target**, so two names for one file share one claim. A lock left by a
crashed process is recovered rather than waited on: a holder whose pid is gone is
taken over at once, and one with no confirmable holder — no pid, another host —
once it is older than the configured staleness. A holder whose local live pid the
lock confirms is not taken over by that staleness, whatever its age; the pass
waits and then **holds**, naming it. Only once such a lock is older than the
abandoned-release bound — ten minutes, far past the millisecond critical section
— is it taken over, as an abandoned release rather than active work.
_Avoid_: mutex, semaphore, claim, lease

**Conflicting assignment**:
The state of an agent file whose `model:` was changed by another cooperating pass
while this pass was deciding. The pass **holds** — it does not overwrite an
answer at least as fresh as its own — and its reason names both models. Detected,
never resolved: two project overrides that disagree have no principle that makes
either win, so each writes its own answer on its own poll and the report is where
the disagreement is visible. Distinct from a *contested* name, where two files
claim one agent and no single file could carry a write at all.
_Avoid_: overwrite, race, lost update, merge conflict

**Refresh ping**:
One throwaway Claude Code process run for a single purpose: to make Claude Code
refresh its own access token, which is the only thing that can. In its diverted
form the model request is pointed at a loopback listener this extension answers
itself, so the run never reaches a model and spends no budget; the undiverted
form is a real request and spends a real answer's worth. Either way it is not a
quota read and reports nothing — it exists so that the *next* credential read has
a token to read. What the extension delegates is the refresh, not the credential:
it never posts a refresh token and never writes the store, because that token
rotates and a second writer is a way to end the user's session.
_Avoid_: token refresh, credential refresh, re-login, keepalive

**Report**:
The answer to "what is my state?": the rail readings, one decision line per
agent, the files no route names, and every warning. Printed by `/quota-dispatch`
and its `refresh` form; the per-value **provenance** is deliberately not part of
it.
_Avoid_: output, status, summary, dump

**Provenance**:
The record of which config layer supplied each effective value, printed by
`/quota-dispatch config`. A warning is not provenance: the **report** and the
provenance block both carry it.
_Avoid_: config dump, debug output, source block

**Generator input**:
The JSON document a **configuration generator** is fed on stdin: every rail's **rail reading** from the **dispatcher** — a rail it does not hold being read once first — each capped rail's **last good reading** standing in for a failed latest one beside a `latestFailure` marker, and no **tight** judgment. Versioned (`version: 1`); a capped rail with no successful reading refuses the run rather than being sent empty.
_Avoid_: stdin payload, usage snapshot, generator config, rail state

**Configuration generator**:
A command a config file declares, which prints a whole ordinary configuration
layer as JSON. What it prints replaces that one file's ordinary configuration —
all-or-nothing, one invalid entry rejecting the whole run — leaving the
declaration that named it in place. The routes a generator emits are ordinary
configuration, so reusable routes and model swaps are the generator's business,
not new dispatcher behaviour. It is fed the **generator input** on stdin.
_Avoid_: route template, generator config, config script, dynamic config
