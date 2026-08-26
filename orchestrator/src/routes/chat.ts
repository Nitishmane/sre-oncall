import { Router } from "express";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";

/**
 * `/chat/*` — the ONLY thing the ngrok tunnel exposes.
 *
 * The Vercel chatbox authenticates the user with GitHub OAuth (allowlisted),
 * then its server-side route handler forwards here with the bridge bearer.
 * We re-verify that bearer and proxy to the local TrueForge API. Raw TrueForge
 * is never tunneled: its local mode has no login of its own.
 *
 * SSE passes through unbuffered so the chat UI streams turn events live.
 */
export function chatRouter(config: Config, log: Logger): Router {
  const router = Router();

  router.all("/{*path}", async (req, res) => {
    const upstreamPath = req.originalUrl.replace(/^\/chat/, "");
    const target = new URL(upstreamPath || "/", config.TRUEFORGE_API_URL);

    const headers = new Headers();
    const accept = req.get("accept");
    const contentType = req.get("content-type");
    if (accept) headers.set("accept", accept);
    if (contentType) headers.set("content-type", contentType);
    if (config.TRUEFORGE_TOKEN) headers.set("authorization", `Bearer ${config.TRUEFORGE_TOKEN}`);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      });

      res.status(upstream.status);
      const upstreamType = upstream.headers.get("content-type");
      if (upstreamType) res.setHeader("content-type", upstreamType);

      if (upstreamType?.includes("text/event-stream")) {
        // Keep the stream open and unbuffered end to end.
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        res.flushHeaders();
        if (upstream.body) {
          const reader = upstream.body.getReader();
          req.on("close", () => void reader.cancel().catch(() => {}));
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
        return;
      }

      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      log.error("chat proxy failed", {
        path: upstreamPath,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: "harness unreachable" });
    }
  });

  return router;
}
