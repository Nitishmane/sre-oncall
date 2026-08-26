import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { openStore } from "./store.ts";
import { createHarness } from "./trueforge.ts";
import { createPipeline, type SessionListener } from "./pipeline.ts";
import { createApp } from "./server.ts";
import { createSlackApp, type SlackApp } from "./slack/app.ts";
import { join } from "node:path";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const store = openStore(join(config.DATA_DIR, "incidents.db"));
const harness = createHarness(config, log);

// Slack is optional: without both tokens the alert pipeline still runs headless,
// and approvals are decided through the console instead.
let slack: SlackApp | null = null;
const onSessionStarted: SessionListener = (started) => {
  void slack?.announceIncident(started);
};

const pipeline = createPipeline({ config, log, store, harness, onSessionStarted });
const app = createApp({ config, log, store, pipeline, harness });

const server = app.listen(config.PORT, () => {
  log.info("orchestrator listening", {
    port: config.PORT,
    harness: config.TRUEFORGE_API_URL,
    agent: config.TRUEFORGE_AGENT_NAME,
    maxConcurrent: config.MAX_CONCURRENT_SESSIONS,
    slack: config.slackEnabled,
  });
});

if (config.slackEnabled) {
  slack = createSlackApp({ config, log, store, harness });
  slack.start().catch((err: unknown) => {
    log.error("slack app failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
} else {
  log.info("slack disabled (SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set)");
}

function shutdown(signal: string) {
  log.info("shutting down", { signal });
  void slack?.stop().catch(() => {
    // Already disconnected; nothing to do.
  });
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
