# The report names the rails that are routed

## Context

The report printed one line per rail in `RAILS`, whatever the configuration
routed. The rail gauge did not: it has always drawn "the capped rails some
effective route names", because a rail no route names is a number the reader
cannot act on. Two surfaces over the same passes disagreed about which pools the
install has.

That disagreement only became visible when a pool stopped being routed. An
account is retired by commenting its models out of the `models` table and its
agents out of `agents`; there is no rail-level `disable`. The gauge went quiet,
the reads kept happening, and `/quota-dispatch` kept printing the retired pools
as though work could still be sent to them. Nothing about the config was wrong —
the report was answering a question nobody had asked.

The reads are a separate question and stay as they are. A configured install
still reads every rail, because a **configuration generator** is fed every
rail's reading ([0015](0015-configuration-generation.md)): a generator may route
work onto a pool the current config does not name, and it needs that pool's
headroom to do it. The unconfigured install also has nothing to narrow to, and
there the rail lines *are* the diagnostic — which pool is worth writing a route
for.

## The report narrows by the same set as the gauge

Both surfaces now ask one function, `namedRails(cfg)`: every route's primary and
every alternate. They differ only in order and in which rails they keep.

```text
  cfg.agents ──▶ namedRails ──┬─▶ GAUGE_ORDER ∩ named ──▶ footer gauge (capped only)
                              └─▶ RAILS       ∩ named ──▶ report rail lines
                                      │
                                      └ nothing named ──▶ every rail (unconfigured
                                                          install's diagnostic)
```

An alternate counts: the policy can send an agent there, so the report has to say
what it would be sent to. A `models` entry no route names does not — an inert
registration is not a route, which is the same rule
[0009](0009-unknown-models-at-startup.md) applies to an inert model. The metered
rail is kept when a route names it, unlike the gauge: its line states that the
pool carries no budget, which is an answer rather than a figure the gauge has no
slot for.

## Considered options

**A `disabledRails` config key.** It would be a second way to state "no route
names it", merged across layers, with nothing keeping it in step with the routes
that are the real statement. An install that removed the last model of a pool
would still need to remember to add the key, and one that added a route back
would need to remove it. "No route names it" is already a fact the effective
config holds.

**Narrowing the reads too.** Rejected because of the generator contract: a rail
the config does not route still has a reading a generator may want, and the
readings file is where an unconfigured install's diagnostic comes from. The cost
is a vendor request for a rail not on screen — one request per source, already
shared, and the same request the generator would make anyway.

**Pinning the report to the configured rails at load.** The effective config can
be replaced by a generation without a reload, so the set has to be derived per
pass from the configuration in force. `namedRails` is called where the report is
built, after the config has been read, so a generated layer's routes are the ones
the same run reports.

## Consequence worth naming

There is no longer a surface that shows an unrouted pool's quota. A reader who
wants to check a pool before adding it to a route adds the route — even as an
alternate — and the next report prints it. The generator still receives every
rail's reading, so an install whose generator chooses routes from quota does not
lose its inputs.
