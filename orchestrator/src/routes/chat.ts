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
    const target = safeTarget(upstreamPath, config.TRUEFORGE_API_URL);
    if (target === null) {
      log.warn("chat proxy refused a path", { path: upstreamPath });
      res.status(400).json({ error: "bad path" });
      return;
    }

    const headers = new Headers();
    const accept = req.get("accept");
    const contentType = req.get("content-type");
    if (accept) headers.set("accept", accept);
    if (contentType) headers.set("content-type", contentType);
    if (config.TRUEFORGE_TOKEN) headers.set("authorization", `Bearer ${config.TRUEFORGE_TOKEN}`);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    // Bound the wait for response *headers* only. An SSE turn stays open for
    // as long as the agent is thinking, so the timer is cleared the moment the
    // upstream responds — a blanket request timeout would cut live streams off
    // mid-investigation.
    const abort = new AbortController();
    const headerTimer = setTimeout(() => abort.abort(), HEADER_TIMEOUT_MS);

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        signal: abort.signal,
        ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      });
      clearTimeout(headerTimer);

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
      clearTimeout(headerTimer);
      log.error("chat proxy failed", {
        path: upstreamPath,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: "harness unreachable" });
    }
  });

  return router;
}

/** How long to wait for the harness to start responding. */
const HEADER_TIMEOUT_MS = 30_000;

/**
 * Resolves the upstream URL for a proxied `/chat` path, or null if the path
 * tries to leave the configured harness base.
 *
 * `new URL()` normalises `..` away, so `/chat/../incidents` would otherwise
 * resolve to the orchestrator's *own* `/incidents` route — which is guarded by
 * a different bearer than the one the caller presented. Mirrors the equivalent
 * check in `web/lib/proxy.ts`.
 */
export function safeTarget(upstreamPath: string, base: string): URL | null {
  if (upstreamPath.includes("\0")) return null;

  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return null;
  }
  if (root.protocol !== "http:" && root.protocol !== "https:") return null;

  const [rawPath = "", ...rest] = (upstreamPath || "/").split("?");
  for (const segment of rawPath.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === "..") return null;
    if (decoded.includes("\0")) return null;
  }

  const prefix = root.pathname.replace(/\/+$/, "");
  const target = new URL(root.toString());
  target.pathname = `${prefix}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
  target.search = rest.length > 0 ? `?${rest.join("?")}` : "";

  if (target.origin !== root.origin) return null;
  if (prefix !== "" && !target.pathname.startsWith(`${prefix}/`)) return null;
  return target;
}
