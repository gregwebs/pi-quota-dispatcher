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
One model on one rail, considered as a possible destination for an agent.
_Avoid_: option, target, model entry

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
the answer — an unreadable rail, or a budget that was not reported.
_Avoid_: skip, no-op, hold-off, fall back
