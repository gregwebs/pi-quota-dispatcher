# A thinking level is stated in three places, and the file's own line is never restored

The dispatcher writes `thinking:` beside the `model:` it chose. A level can be
stated on a **candidate**, on a **route**, and on a **model**, and the most
specific one wins: candidate, then route, then model. Nothing states one, nothing
is written — the file keeps whatever `thinking:` line it already had.

```json
{
  "models": { "openai-codex/gpt-6-sol": { "thinking": "low" } },
  "agents": {
    "planner": {
      "thinking": "xhigh",
      "primary": { "model": "claude-bridge/claude-opus-5-5", "rail": "claude" },
      "alternates": [
        { "model": "openai-codex/gpt-6-sol", "rail": "codex", "thinking": "off" }
      ]
    }
  }
}
```

## Why three places

They answer different questions, and a route that can only answer one of them
forces the others to be repeated:

- the **candidate** is about this destination — `off` on a cheap model that is
  only there to keep work moving, `high` on the expensive one it falls back to;
- the **route** is about the work, not the model — "planning thinks hard" is true
  whether the plan is being written by Opus or by Sol, and restating it on every
  candidate would make it drift the first time a model is added;
- the **model** is the fact that travels: Sol is a low-thinking model wherever it
  appears, in every route and in every project, and `models` is the only place
  where that can be said once.

The `models` table is a table of *defaults*, not of models that must be used. An
entry for a model no route names is inert and warns nothing — a shared table is a
normal thing to have, and a warning would make every project file that does not
restate it noisy. For the same reason, a level is not checked against the
model's capability: pi clamps a level the model cannot do when it spawns the
agent, so `xhigh` on a model whose ceiling is `medium` runs at `medium`. A clamp
is not a configuration error, and pretending otherwise would tie this seam to a
model catalogue it does not own.

## Why nothing is restored

The line is written forward only. The dispatcher does not record what a file said
before it wrote a level and does not put anything back when an agent moves to a
candidate that states none. Two consequences, both deliberate:

- On a route where only the alternates state a level, the level written on the
  way out is still in the file on the way home. Moving back to a primary that
  states none changes the model and leaves `thinking:` alone.
- A `thinking:` line the dispatcher wrote is never removed. Removing a line is
  not something this tool does to a file it did not create — `model:` is only
  ever *replaced*, and the same rule now covers `thinking:`.

The alternative is a remembered previous value, which has to be stored somewhere
and is wrong the moment the user edits the file by hand — the exact case the
whole design is built around, since the file is shared state that several
sessions and projects read. A guarantee about what a file used to hold cannot be
kept without owning the file. So the guarantee is only ever "this is what this
pass resolved", and a route that wants a level on the way home states one on
every candidate.

## Considered options

**A single per-model map, and nothing per route.** Simplest to explain, and it
covers the case that motivated this ("Sol is cheap, make it think less"). It
fails on the case that motivated the route: planning wants to think hard on
*whichever* model it ends up on, and a per-model map can only say that by
repeating itself on every model in the table.

**Reading the level from the agent file and treating it as the resolved one.**
This is the inversion of what the tool does now: it would make the file's current
line authoritative, so a hand edit would silently pin an agent until something
else changed, and the configuration would no longer say what an agent runs at.
The configuration is the source of truth here, as it is for `model:`. Note that
this is a different objection from the stale level described above — a level left
behind by an earlier pass stays in the file under the chosen design too, and is
resolved by stating a level, not by reading one.

**Refusing to write a level for a candidate whose model does not support it**,
following the `checkModels` rule for model ids. Rejected because the failure
modes are not comparable: an unknown model id makes the spawn fail, so it is
*known bad* and the agent is held; an unsupported level is clamped by pi and the
spawn succeeds, so there is nothing to protect the user from. It would also put a
second, quieter copy of the model catalogue in this extension.

**Restoring the previous line on the way back.** Rejected above, and it is the
one option that would make the tool's own state authoritative over the file.
`pi-quota-dispatcher` deliberately holds no state about the files it writes; the
decision is a pure function of the current config and current headroom, and this
change does not make it less pure.
