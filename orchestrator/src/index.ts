import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { openStore } from "./store.ts";
import { createHarness } from "./trueforge.ts";
import { createPipeline } from "./pipeline.ts";
import { createApp } from "./server.ts";
import { join } from "node:path";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const store = openStore(join(config.DATA_DIR, "incidents.db"));
const harness = createHarness(config, log);
const pipeline = createPipeline({ config, log, store, harness });
const app = createApp({ config, log, store, pipeline, harness });

const server = app.listen(config.PORT, () => {
  log.info("orchestrator listening", {
    port: config.PORT,
    harness: config.TRUEFORGE_API_URL,
    agent: config.TRUEFORGE_AGENT_NAME,
    maxConcurrent: config.MAX_CONCURRENT_SESSIONS,
  });
});

function shutdown(signal: string) {
  log.info("shutting down", { signal });
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
