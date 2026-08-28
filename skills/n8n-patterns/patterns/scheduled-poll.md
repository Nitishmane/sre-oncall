# Scheduled and polling workflows

**Use when** the trigger is time: "every morning", "hourly", "check for new
tickets". Also when someone says "when X happens" about a system that has no
webhook — that requirement is a poll wearing an event's clothing, and the
interval is the first thing you have to ask about.

## Ask these before building

The requirement almost never contains them, and each one changes the workflow:

- **How often, exactly?** "Every morning" is a time and a timezone. n8n's
  Schedule Trigger runs in the instance's timezone, not the requester's.
- **What counts as new?** This is the hard one. See below.
- **What if a run is slow?** Scheduled runs can overlap. If a run can take
  longer than the interval, decide now whether that is safe.
- **Who finds out if it stops?** A workflow that silently stops running is worse
  than one that never existed, because people are relying on it.

## The idempotency problem

A poll re-reads the same source every interval. Without something to mark
progress, it re-processes everything it sees, every time — sending the same
Slack message hourly forever. This is the defining failure of the pattern and
you must decide the mechanism explicitly.

In rough order of preference:

1. **Ask the source for only what is new.** A `since` / `updated_after` filter
   or a cursor. Best, because nothing has to be remembered locally.
2. **Filter on a timestamp** against the last run. Workable, but clock skew and
   boundary conditions cause duplicates and gaps.
3. **Remember what has been seen.** n8n's Remove Duplicates node, or a data
   table keyed on the record id. Necessary when the source offers nothing else.

Never rely on "it will probably be fine because the interval is short".

Overlap the window slightly and dedupe, rather than slicing it exactly. An exact
window drops records that arrive during the boundary; an overlapping one
produces duplicates you have already decided how to remove.

## Don't hammer the source

- Pull a page at a time and let the loop handle the rest, rather than asking for
  everything and filtering in n8n.
- Use the specific node — it knows the API's pagination and rate limits.
- Match the interval to how fast the data actually changes. A five-minute poll
  on something that updates daily is 288 pointless requests a day, and on a
  rate-limited API it is how you lose access to it.

## Empty is the normal case

Most runs will find nothing. That is success, not failure:

- Do not notify on an empty result. A workflow that says "nothing to report"
  every hour trains people to ignore it, and they will still be ignoring it on
  the day it matters.
- Make sure an empty result does not error. A downstream node handed zero items
  is a common cause of "the workflow is red every hour and everyone stopped
  looking".

## Verify

Run it once manually before activating, against a window you know contains data,
and check the execution output is what you expect.

Then reason about the second run out loud: if it ran again right now, would it
re-send what it just sent? If you cannot answer that from the workflow's own
logic, the idempotency mechanism is not real yet.

After activation, tell the person which execution to open and what a healthy
empty run looks like — otherwise the first quiet run reads as a failure.
