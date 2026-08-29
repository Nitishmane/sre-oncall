import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { openStore } from "./store.ts";
import { createHarness } from "./trueforge.ts";
import { createPipeline, type SessionListener } from "./pipeline.ts";
import { createApp } from "./server.ts";
import { startHandoffScheduler, type HandoffScheduler } from "./scheduler.ts";
import { createSlackApp, type SlackApp } from "./slack/app.ts";
import { join } from "node:path";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const store = openStore(join(config.DATA_DIR, "incidents.db"));
const harness = createHarness(config, log);

// Slack is optional: without a complete token pair the alert pipeline still runs
// headless, and approvals are decided through the console instead.
//
// There can be more than one bot — the on-call bot and the automation bot are
// separate Slack apps with separate identities. Only the bot that owns an
// incident channel hears about alerts; announcing them in the automation room
// would be noise nobody acts on.
const bots: SlackApp[] = [];
let incidentBot: SlackApp | null = null;

const onSessionStarted: SessionListener = (started) => {
  void incidentBot?.announceIncident(started);
};

const onIncidentResolved = (params: {
  fingerprint: string;
  ruleName: string;
  resolvedAt: Date;
}) => {
  void incidentBot?.markIncidentResolved(params);
};

const pipeline = createPipeline({
  config, log, store, harness, onSessionStarted, onIncidentResolved,
});
const app = createApp({ config, log, store, pipeline, harness });

const server = app.listen(config.PORT, () => {
  log.info("orchestrator listening", {
    port: config.PORT,
    harness: config.TRUEFORGE_API_URL,
    agent: config.TRUEFORGE_AGENT_NAME,
    maxConcurrent: config.MAX_CONCURRENT_SESSIONS,
    slack: config.slackEnabled,
    // Name each bot and the agent it drives: a misrouted bot is otherwise
    // invisible until someone posts in the wrong channel.
    slackBots: config.slackBots.map((bot) => `${bot.name}->${bot.agentName}`),
  });
});

if (config.slackBots.length > 0) {
  for (const profile of config.slackBots) {
    const bot = createSlackApp({ config, log, store, harness, bot: profile });
    bots.push(bot);
    if (profile.incidentChannel !== undefined) incidentBot = bot;
    // Started independently: a bad token on the automation app must not stop
    // the on-call bot from connecting.
    bot.start().catch((err: unknown) => {
      log.error("slack app failed to start", {
        bot: profile.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
} else {
  log.info("slack disabled (no complete bot token pair configured)");
}

// Handoffs are optional: without an interval, POST /handoff is still there
// for on-demand use, but nothing fires on its own.
let scheduler: HandoffScheduler | null = null;
if (config.HANDOFF_INTERVAL_HOURS !== undefined) {
  scheduler = startHandoffScheduler({ pipeline, log, intervalHours: config.HANDOFF_INTERVAL_HOURS });
  log.info("handoff schedule active", { intervalHours: config.HANDOFF_INTERVAL_HOURS });
} else {
  log.info("handoff schedule disabled (HANDOFF_INTERVAL_HOURS not set)");
}

function shutdown(signal: string) {
  log.info("shutting down", { signal });
  scheduler?.stop();
  // allSettled, not all: a bot that never connected rejects on stop(), and
  // Promise.all would then skip stopping the one that did.
  void Promise.allSettled(bots.map((bot) => bot.stop()));
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
