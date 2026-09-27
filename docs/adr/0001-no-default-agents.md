# No agent is managed until the configuration names it

The dispatcher ships with an empty `agents` table. It used to ship three routes —
`planner`, `reviewer`, `implementer` — each with an opinion about which plan it
should rest on, which meant a first run edited files the user had never named and
baked someone else's agent names and routing preferences into their setup. The
tool exists so that this decision is made deliberately once instead of tediously
many times; making it on the user's behalf on install is the opposite of the
point.

## Consequences

On a fresh install the extension does nothing, and says so: on `startup`, `new`
and `reload` it reports that nothing is configured, lists the agent files it
found so that the names are discoverable, and prints a snippet to paste. A reader
must not mistake that for a broken install, so the README leads with the snippet
rather than burying it in a configuration table.

Removing the defaults also removes what they happened to get right: a new user no
longer inherits a working example. That is the trade — the README's example is
the example, and it is inert until copied.
