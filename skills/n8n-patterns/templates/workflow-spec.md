# Workflow specification

Read a requirement back in this shape **before building**, and get agreement.

Six lines is cheap to correct. A built workflow is not, and the misunderstanding
is usually in TRIGGER or DEDUPE — the two things people never state and always
have an opinion about once they see them written down.

```
NAME      what the workflow will be called
TRIGGER   what starts it — schedule and timezone, webhook, or tool call
STEPS     what it reads, what it decides, what it writes
WRITES    every system it touches and every person it can reach
DEDUPE    what stops it doing the same thing twice
FAILS     who finds out when it breaks, and how
NEEDS     credentials that must already exist, by name
```

## Worked example

```
NAME      notify-oncall-on-failed-deploy
TRIGGER   webhook, called by the CI system on pipeline completion
STEPS     filter to status=failed on the main branch; look up the commit
          author; post to Slack with the commit and the failing job link
WRITES    Slack #deploys only. No writes to CI, no tickets.
DEDUPE    pipeline id — CI retries the callback on any non-2xx
FAILS     if the Slack post fails, retry twice then raise to the shared error
          workflow. Never silent: a missed deploy failure is the whole point.
NEEDS     Slack credential "deploys-bot" (exists), CI webhook secret (to create)
```

## Filling it in

**NAME** — what it does, findable in a list of two hundred.

**TRIGGER** — "every morning" is not a trigger. `0 9 * * 1-5, Europe/London` is.
For a webhook, say which system calls it and whether the URL needs auth.

**STEPS** — enough that someone else could build it. Not node names yet; you do
not know those until you have looked them up.

**WRITES** — the blast radius, and the line the person is actually approving.
Be exhaustive: every channel, sheet, table, and address. If it can message a
human, say which humans.

**DEDUPE** — the field or mechanism, not the intention. "pipeline id" is a
mechanism. "we'll make sure it doesn't duplicate" is not.

**FAILS** — from `patterns/error-handling.md`. "Nothing" is allowed if it is
chosen rather than defaulted.

**NEEDS** — credential *names*, marked as existing or to-be-created. Never
values.

## After it is built

Report back in the shape from the agent's own BUILD phase — DOES / TRIGGER /
STEPS / WRITES / FAILS / NEEDS — and add:

- that it was created **inactive**, and exactly how to turn it on
- which execution to open on the first run, and what a healthy result looks
  like, including what an empty run looks like for a poll
- anything in the spec you did **not** build, and why

That last line is the one that matters. An automation that silently covers four
of five cases is worse than one that says it covers four, because only one of
them tells the truth to the person relying on it.
