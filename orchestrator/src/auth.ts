import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Bearer-token gate. Used twice with different secrets: on `/webhook/*` (the
 * Grafana contact point) and on `/chat/*` (the Vercel chatbox, which has
 * already checked the user's GitHub OAuth session). Nothing in this service is
 * reachable without one of them.
 */
export function requireBearer(expected: string): RequestHandler {
  return (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || token === undefined || !safeEqual(token, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
