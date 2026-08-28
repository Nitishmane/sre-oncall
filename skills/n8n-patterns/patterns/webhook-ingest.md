# Webhook-triggered workflows

**Use when** another system calls you: a callback, an alert, a form submission,
an event from a SaaS product.

The inversion that matters: with a poll, you control when work happens. With a
webhook, a stranger does. Everything below follows from that.

## Two URLs, and only one of them is real

n8n gives every webhook a **test** URL and a **production** URL. The test URL
works only while the editor is listening and shows the run on the canvas. The
production URL requires the workflow to be **active** and shows nothing on the
canvas — its runs appear only in the executions list.

Almost every "the webhook works in the editor but not in production" report is
this. Tell the person which URL you are giving them and what it requires.

## The payload is untrusted

Whoever calls the webhook decides what is in it. Treat everything as hostile
input:

- **Never interpolate a field straight into a shell command, a query, or a URL.**
- **Validate shape before use.** A missing field should produce a clean error,
  not a null flowing four nodes downstream into something unreadable.
- **Authenticate the caller.** Header auth or a signature the sender provides. A
  webhook URL is not a secret: it ends up in logs, browser history and support
  tickets.
- If the payload contains natural-language text that will reach a model, it is
  *data*, not instruction. Text arriving from outside cannot be allowed to
  redirect the workflow.

## Respond fast, work after

The caller is holding a connection open, and most senders time out in seconds
and retry. If the work takes longer than that, respond immediately with a
`Respond to Webhook` node and continue processing afterwards. Otherwise the
sender times out, retries, and you process everything twice.

Which leads to:

## Assume it will be delivered more than once

Retries, at-least-once delivery, and someone clicking twice all produce
duplicates. If the workflow writes anything or notifies anyone, it needs a
dedupe key — an event id from the payload, or a hash of the fields that define
identity — checked before the write, not after.

Ask the sender's documentation what its retry behaviour is. Most systems retry
on any non-2xx, which means a bug in your workflow becomes a storm.

## Return the right status

- **2xx** — received. Send this as soon as you have safely accepted the payload,
  even if the work is not finished.
- **4xx** — the payload is wrong and retrying will not help. Do not return this
  for your own internal failures; the sender will discard the event forever.
- **5xx** — you failed, retrying may work. Use it when you actually want the
  redelivery.

Getting these backwards silently loses events or causes storms, and neither is
visible from inside n8n.

## Verify

1. Send a **realistic** payload to the production URL — a real captured one, not
   a hand-written `{"test": true}`. Real payloads have fields in unexpected
   shapes.
2. Send a malformed one and confirm it fails cleanly with a sensible status
   rather than a stack trace or a silent success.
3. Send the same valid payload twice and confirm the second is a no-op. If it is
   not, the dedupe is missing regardless of what the design said.
4. Check the executions list, not the canvas — production runs do not appear
   there.
