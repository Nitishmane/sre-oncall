import { Router } from "express";
import type { Logger } from "../logger.ts";
import type { Pipeline } from "../pipeline.ts";
import { normalizeAlerts, webhookPayloadSchema } from "../alerts/payload.ts";

/**
 * `POST /webhook/grafana` — the Grafana Alerting webhook contact point (and the
 * Alertmanager webhook receiver, whose body shape is compatible).
 *
 * Grafana runs in the kind cluster and posts straight to the host, so this path
 * never crosses a tunnel. Bearer auth is applied by the caller.
 */
export function webhookRouter(pipeline: Pipeline, log: Logger): Router {
  const router = Router();

  router.post("/grafana", async (req, res) => {
    const parsed = webhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      log.warn("malformed webhook payload", { issues: parsed.error.issues.length });
      res.status(400).json({ error: "malformed payload" });
      return;
    }

    const alerts = await normalizeAlerts(parsed.data);
    if (alerts.length === 0) {
      res.status(202).json({ accepted: 0 });
      return;
    }

    const outcomes = pipeline.ingest(alerts);
    log.info("webhook accepted", {
      alerts: alerts.length,
      firing: alerts.filter((a) => a.status === "firing").length,
    });
    // Answer fast: Grafana retries on slow deliveries, and the work is queued.
    res.status(202).json({ accepted: outcomes.length, outcomes });
  });

  return router;
}
