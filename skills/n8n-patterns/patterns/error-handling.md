# Failure behaviour

Not a pattern you choose — every workflow needs this, and it is the part nobody
asks for. "Notify me when a deploy fails" contains no answer to "and what
happens when the notification itself fails?", but somebody will need one at
2am, and by then the automation will have been quietly dead for a month.

Decide it during CLARIFY and write it into the spec. Retrofitting it means
rebuilding the node chain.

## Ask one question

**"When this breaks, who should find out, and how?"**

Push back on "it won't break". Every workflow here depends on at least one
network call to a system you do not control.

The answers worth offering:

- **Notify a person or channel.** Right for anything a human is relying on.
- **Log and continue.** Right for a batch where one bad row must not stop the
  other 499.
- **Retry, then notify.** Right when failures are usually transient.
- **Fail loudly and stop.** Right when a partial run is worse than no run —
  anything that writes money, permissions, or production config.

"Nothing" is a legitimate answer for something genuinely disposable. Make it an
explicit choice rather than a default, and say it out loud so it is a decision
somebody made.

## The three levels

**Node level.** Most nodes offer *Retry On Fail* (with attempts and wait) and
*Continue On Fail*. Retry transient network errors. Never retry something
non-idempotent unless you have a dedupe key — three retries on a payment is
three payments.

*Continue On Fail* routes the error down the normal output with an `error`
field, which is what you want for per-item batch handling. It is also how a
failure becomes invisible, so if you use it, do something with that field.

**Branch level.** Check the thing you depend on before you use it. An `If` node
on "did this return what I expected" is clearer than discovering four nodes
later that a field was undefined.

**Workflow level.** n8n's **Error Workflow** setting runs another workflow
whenever this one fails, and it is the only thing that catches failures your
node-level handling missed — including the ones in your error handling. Set it.
One shared error workflow that posts to a channel serves every workflow in the
instance.

## Batches: partial success is the normal outcome

Processing 500 items, 3 fail. Neither "stop at item 4" nor "silently drop 3" is
right.

Collect the failures, complete the rest, and report both counts at the end:
`497 processed, 3 failed` with enough identifying detail to retry those three by
hand. A run that reports success while having dropped 3 items is worse than one
that fails outright, because nobody goes looking.

## Do not put secrets in error messages

Error output frequently includes the request that failed — headers included. If
that reaches a Slack channel, the credential is now in Slack. Send the error
*type* and the identifying context, not the raw exception body.

## Verify

Test the failure path, not just the happy path. It is the half that runs when
someone is depending on it.

- Point a node at something that will fail — a bad host, a revoked credential —
  and confirm the notification actually arrives, in the right channel, saying
  something a human can act on.
- Confirm a partial batch reports both numbers.
- Confirm the error workflow fires by breaking something it does not know about.

An untested error path is not error handling. It is an intention.
