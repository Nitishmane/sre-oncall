# Slack app setup

The bot runs in **Socket Mode**, so it needs no public URL and no request-signing
secret — Slack holds a WebSocket open to the orchestrator process.

Use a personal or throwaway workspace you control. Do not install this into an
employer's workspace.

## 1. Create the app

At [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From
an app manifest**, paste:

```yaml
display_information:
  name: SRE-Oncall
  description: An AI on-call engineer that investigates alerts and proposes fixes behind approval gates.
  background_color: "#1a1d21"
features:
  bot_user:
    display_name: SRE-Oncall
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read   # receive @mentions
      - chat:write          # post, edit and delete the status message
      - channels:history    # read thread replies in public channels
      - channels:read       # channel info
      - groups:history      # private channels, if you use one for incidents
      - groups:read
      - im:history          # DMs
      - im:read
      - im:write
      - users:read          # resolve approver user ids
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true        # required for the Approve/Deny buttons
  socket_mode_enabled: true
  org_deploy_enabled: false
```

## 2. Get the two tokens

- **Bot token** (`xoxb-…`): *OAuth & Permissions* → Install to workspace →
  copy the Bot User OAuth Token → `SLACK_BOT_TOKEN`.
- **App token** (`xapp-…`): *Basic Information* → App-Level Tokens → Generate,
  with the `connections:write` scope → `SLACK_APP_TOKEN`.

The orchestrator starts the bot only when both are present; without them the
alert pipeline still runs headless.

## 3. Point it at a channel

Create an incident channel, invite the bot (`/invite @SRE-Oncall`), and copy the
channel ID from *View channel details* → bottom of the dialog:

```bash
SLACK_INCIDENT_CHANNEL=C0XXXXXXXXX
```

Alert-triggered sessions post there and thread their whole investigation under
that message. Without it the pipeline runs silently — useful for load testing,
useless for a demo.

## 3b. The second bot: Automation-Agent

A separate app, not a second channel on the first one — it gets its own bot
user, its own identity in Slack, and its own Socket Mode connection. Same
recipe as above with a different manifest:

```yaml
display_information:
  name: Automation-Agent
  description: Runs n8n automations on request, behind an approval gate.
  background_color: "#1a1d21"
features:
  bot_user:
    display_name: Automation-Agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
```

**Each app needs its own app-level token.** The first app's `xapp-…` will not
work here — generate a new one under *Basic Information → App-Level Tokens*
with `connections:write`. Reusing the first is the mistake people make, and it
fails at connect time with a message that does not say so.

```bash
SLACK_AUTOMATION_BOT_TOKEN=xoxb-…
SLACK_AUTOMATION_APP_TOKEN=xapp-…
SLACK_AUTOMATION_CHANNEL=C0XXXXXXXXX     # the #automation-agent channel
```

Invite it to `#automation-agent` and nothing else. This bot routes to the
**automation-engineer** agent, which holds the n8n tools and no cluster access.

### Keeping the two bots out of each other's rooms

`app_mention` fires in **any** channel a bot is a member of, so two bots invited
to one channel would both answer. Two controls, and using both is worth it:

- **Do not invite @SRE-Oncall to #automation-agent.** The event never fires for
  a channel an app is not in, so this is a real control rather than a
  convention.
- **Set `SLACK_CHANNELS`** to the incident channel id. Then the on-call bot
  ignores mentions anywhere else, and the guarantee no longer depends on who
  ran `/invite`.

DMs are exempt from both — a DM channel id is never in an allow-list, and being
able to message either bot privately is useful.

## 4. Restrict who can approve

```bash
SLACK_APPROVER_IDS=U0XXXXXXXXX,U0YYYYYYYYY
```

Comma-separated Slack user IDs (profile → *More* → *Copy member ID*). Only these
people can act on an approval gate; everyone else gets an ephemeral refusal, and
the attempt is logged.

**Leave it unset and any workspace member can approve remediation.** That is a
legitimate choice for a solo demo workspace, and the approval prompt says so on
every message — but set it before anyone else joins the workspace.

## What it does once running

- **@mention in a channel, or DM it** — starts a session; replies in the thread
  resume that same session rather than starting a new one.
- **A Grafana alert fires** — the orchestrator starts a healing session and the
  bot announces it in the incident channel, threading the investigation under it.
- **The agent hits an approval gate** — a Block Kit message shows the exact tool
  and its full arguments, with Approve and Deny. The decision is claimed
  atomically, so two people clicking at once cannot both submit; the second gets
  told who decided.
- Every gate is written to an audit table before it is shown, readable at
  `GET /approvals?hours=24` with the bridge bearer — so the record survives even
  if Slack is down.

## Progress display

One status message per session, edited in place ("Running
`grafana.query_prometheus`…"), deleted when the session ends. Long answers are
split on paragraph boundaries. A dropped harness connection posts a warning into
the thread rather than leaving the status line stuck forever.
