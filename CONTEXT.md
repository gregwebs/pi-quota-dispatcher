# pi-quota-dispatcher

Keeps each agent on a model its account can still afford, by rewriting the model
declared in the agent's own definition file.

## Language

**Dispatcher**:
The extension as a whole: the thing that reads rail budgets and decides where
each agent belongs.
_Avoid_: router, scheduler, balancer

**Agent**:
A named identity that pi can spawn, defined by its own file in the agent dir.
_Avoid_: subagent, agent config, agent entry

**Agent Route**:
The destination policy for one agent: its primary and its list of alternates.
A route is never described as disabled — an entry in a config file either names a
route or is skipped, and a skipped entry names no route at all.
_Avoid_: route, routing rule, mapping, agent route entry, disabled route

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
Describes an agent file that no agent route names. The dispatcher never touches
it, and that is a normal state rather than a fault.
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
started on.
_Avoid_: failover, migration, rotation

**Hold**:
A decision to assign nothing, leaving an agent's file exactly as the user left
it. What the dispatcher does when a reading it does not have could have changed
the answer — an unreadable rail, or a budget that was not reported. It is also
the decision for an agent whose **primary** this pi cannot spawn: there the
model is *known bad* rather than *unknown*, no reading could change the answer,
and it is dropped from consideration instead of waited on.
_Avoid_: skip, no-op, hold-off, fall back

**Unusable file**:
A config file that is there but produced no layer: it is not JSON, it is JSON but
not an object, or it could not be read. The dispatcher skips it whole. Distinct
from an *absent* file, which is simply not a layer, and from an unconfigured
install: the file names routes, and those routes were thrown away.
_Avoid_: invalid config, bad config, missing file, absent file

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
