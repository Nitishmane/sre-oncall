import express from "express";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Harness } from "./trueforge.ts";
import type { Store } from "./store.ts";
import { requireBearer } from "./auth.ts";
import { webhookRouter } from "./routes/webhook.ts";
import { chatRouter } from "./routes/chat.ts";

export interface ServerDeps {
  config: Config;
  log: Logger;
  store: Store;
  pipeline: Pipeline;
  harness: Harness;
}

export function createApp({ config, log, store, pipeline, harness }: ServerDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Unauthenticated: liveness only, no incident data.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, ...pipeline.stats() });
  });

  app.get("/readyz", async (_req, res) => {
    const harnessUp = await harness.health();
    res.status(harnessUp ? 200 : 503).json({ ok: harnessUp, harness: harnessUp });
  });

  app.use("/webhook", requireBearer(config.GRAFANA_WEBHOOK_BEARER), webhookRouter(pipeline, log));
  app.use("/chat", requireBearer(config.TRUEFORGE_BRIDGE_TOKEN), chatRouter(config, log));

  // Operator-facing: recent incidents, for the handoff panel in the chatbox.
  app.get("/incidents", requireBearer(config.TRUEFORGE_BRIDGE_TOKEN), (req, res) => {
    res.json({ incidents: store.incidentsSince(windowStart(req.query["hours"])) });
  });

  // The approval audit log: every gate the agent hit, and who decided it.
  app.get("/approvals", requireBearer(config.TRUEFORGE_BRIDGE_TOKEN), (req, res) => {
    res.json({ approvals: store.approvalsSince(windowStart(req.query["hours"])) });
  });

  // On-demand handoff: the scheduled one (config.HANDOFF_INTERVAL_HOURS) covers
  // routine shift changes; this covers "someone is leaving early" and demos.
  app.post("/handoff", requireBearer(config.TRUEFORGE_BRIDGE_TOKEN), (req, res) => {
    const hours = clampHours((req.body as Record<string, unknown> | undefined)?.["windowHours"]);
    pipeline
      .runHandoff(hours)
      .then((sessionId) => res.status(202).json({ sessionId, windowHours: hours }))
      .catch((err: unknown) => {
        log.error("on-demand handoff failed", { error: err instanceof Error ? err.message : String(err) });
        res.status(502).json({ error: "harness unreachable" });
      });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not found", path: req.path });
  });

  return app;
}

/** Clamps a caller-supplied hour count into a sane range, defaulting to a day. */
function clampHours(raw: unknown): number {
  const hours = Number(raw ?? 24);
  return Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : 24;
}

/** Clamps a `?hours=` query into a sane lookback window. */
function windowStart(raw: unknown): number {
  return Date.now() - clampHours(raw) * 3_600_000;
}
