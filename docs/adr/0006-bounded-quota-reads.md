# A quota read is bounded, and retried before its rail reads as unreadable

A rail the dispatcher cannot read can hold the agents whose route depends on its
reading: the policy treats a missing reading as something that could have changed
the answer, so it assigns nothing. Rule 5 in the README says which routes those
are — the ones whose primary is on that rail, and the ones whose tight primary
would have moved onto it. That rule is right, but "unreadable" was covering two
failures that are nothing alike — an endpoint that answered and said no, and one
that was never heard from at all.

The second kind was the dangerous one. Neither quota request set an abort signal,
so a stalled endpoint did not fail; it *waited*, delaying the evaluation that
`session_start` awaits, and a route whose preferred alternate was the very rail
that stalled then held on the strength of a request still in flight.

A read is now bounded and given a second chance:

- **every attempt carries `AbortSignal.timeout(5_000)`**, and the body is read
  inside the attempt, on the same signal, so an endpoint that starts replying and
  then stops is abandoned by the same deadline;
- **a failed attempt is retried once, after 250ms**, because a dropped connection
  or a 5xx is a blip that a second request usually answers;
- **only a failure another request could fix is retried** — a 5xx, a dropped
  connection, a stalled body, a body that is not the JSON this endpoint promises
  (a reply truncated without framing and a captive portal arrive looking the
  same). A 4xx is the endpoint's reply to the question asked, and an expired
  token would be expired again. A 429 is not retried either: it asks us to slow
  down, and asking again 250ms later without honouring `Retry-After` is the thing
  it is asking us not to do;
- **the note separates an answer from a give-up**. `HTTP 401` is an answer;
  `HTTP 500 after 2 attempts` is a reading that was tried and given up on. A
  count appears only on the second kind, because how many times we asked is only
  a fact about a failure worth asking about;
- **a request error is reported by its cause, not by its message**. undici
  flattens a network failure to a bare "fetch failed" anyway, while an error
  thrown while *building* the request quotes the header value it rejected — and
  the `Authorization` header is where the credential lives. The note takes the
  cause's code (`ECONNREFUSED`, `ENOTFOUND`, a TLS failure) and otherwise says
  `request failed`, so a diagnostic cannot become a credential in a log line.

The shape problem is left out on purpose. A 200 whose payload carries none of
the windows this rail reports is an answer, and it is reported as one (`no usage
windows returned`) without a retry: asking an endpoint that has already said what
it is going to say can only cost a request.

The policy itself does not move. A rail still unreadable after its attempts is
still a missing reading, so it still holds rather than falling through to a later
alternate: an unreadable rail holds the routes that depend on its reading, and
falling through is a decision made on evidence nobody has. The attempts are how
the dispatcher earns the right to call the reading missing rather than merely
slow.

The note names the failure that *ended* the read, not the history of attempts
that led to it. A 503 followed by a timeout reads as the timeout, counted twice;
a timeout followed by a 401 reads as the 401, with no count. That is the useful
half of the history: what the rail is unreadable for now, and whether anything
was still being tried when the read stopped. Replaying every attempt would make
the line grow with a setting nobody tunes.

The timings are a seam on `DispatcherDeps` rather than config-file keys. How long
to wait for a socket is a fact about the network the extension runs on, not a
routing preference, and the two numbers only mean anything together — a timeout
without an attempt count is a bound of unknown size. Tests inject small ones so
the stall path can be exercised without waiting out the real 5s.

## Considered options

**A timeout with no retry.** It removes the stall, which is the acute problem,
but it also promotes every dropped connection to an outage — and an outage holds
the routes that depend on that rail's reading. The retry is what keeps a blip from
reading as a decision about the rail.

**Retrying every failure, including 4xx.** Simpler to state — "try twice" — and
wasteful in the one case that matters: an hourly-expired token would be re-read
every poll at two requests apiece, and each of those answers says the same thing.
Worse, it would make the attempt count meaningless: a count would say only that we
asked twice, which is true of every failure, rather than that the request, and not
the endpoint, had the last word.

**Retrying a 429.** Tempting, because a rate limit is transient by construction.
It is left out because the retry has no notion of time: it would ask again 250ms
later, which is the opposite of what a rate limit asked for. The rail holds either
way, and the next poll is minutes away rather than a quarter second.

**Reusing the last good reading past its `ttlMs` so a blip can be papered
over.** The tempting shortcut, and it is the same guess the hold rule exists to
refuse: the reading being reused is exactly the one the current numbers may have
invalidated. It stays out of scope.
