/**
 * A retrying proxy in front of the model provider.
 *
 * The harness makes the model call itself and does not retry, so a 429 ends the
 * turn — and the whole investigation with it. That is the difference between a
 * healed incident and a dead session, and it is routinely a two-second wait:
 *
 *   Request failed (429): Rate limit reached for gpt-5.6-luna ... on tokens per
 *   minute (TPM): Limit 200000, Used 187225. Please try again in 2.307s.
 *
 * An agent turn makes many requests in quick succession, each resending the
 * whole context, so a single investigation can push a 200k-per-minute account
 * over the line without being expensive in dollars at all. Waiting is the
 * correct response, and nothing in the harness or the SDK will do it.
 *
 * `OpenAiModelProvider.baseUrl` overrides where the harness sends requests, so
 * this sits in between and absorbs the retryable failures.
 *
 *   node --experimental-strip-types --env-file-if-exists=.env agent/scripts/model-proxy.ts
 *
 * Deliberately narrow: it retries, and otherwise streams the response through
 * untouched. It reads no bodies it does not have to and logs no payloads — the
 * traffic is prompts and API keys.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env["MODEL_PROXY_PORT"] ?? 8120);
const UPSTREAM = (process.env["MODEL_PROXY_UPSTREAM"] ?? "https://api.openai.com").replace(/\/+$/, "");
const MAX_ATTEMPTS = Number(process.env["MODEL_PROXY_MAX_ATTEMPTS"] ?? 5);
/** Cap a single wait, so a pathological Retry-After cannot hang a turn forever. */
const MAX_WAIT_MS = 30_000;

/** Statuses worth trying again: rate limits, and the transient 5xx family. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * How long to wait. `Retry-After` is authoritative when present; otherwise
 * OpenAI states the wait in the error message ("try again in 2.307s"), which is
 * far better than a guess. Falls back to exponential backoff.
 */
function waitMs(attempt: number, headers: Headers, body: string): number {
  const header = headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  }
  const stated = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(body);
  if (stated?.[1] !== undefined) {
    const value = Number(stated[1]);
    if (Number.isFinite(value)) {
      const ms = stated[2]?.toLowerCase() === "ms" ? value : value * 1000;
      // A little headroom: returning at exactly the stated moment often 429s again.
      return Math.min(ms + 250, MAX_WAIT_MS);
    }
  }
  return Math.min(2 ** attempt * 500, MAX_WAIT_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Buffers the request body — it has to be replayable for a retry to be possible. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function forwardableHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    // `host` must not be forwarded: it would point upstream at ourselves.
    if (name === "host" || name === "connection" || name === "content-length") continue;
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

/** Best-effort error response; the socket may already be gone. */
function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // A rejection here used to be unhandled, which takes the whole process down —
  // an upstream ECONNRESET mid-stream killed the proxy and every model call
  // with it. A proxy that dies is worse than the rate limit it exists to
  // absorb, so nothing in here is allowed to escape.
  void handle(req, res).catch((err: unknown) => {
    console.error(`[model-proxy] request failed: ${String(err)}`);
    fail(res, 502, `model proxy: ${String(err)}`);
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  {
    const started = Date.now();
    const target = `${UPSTREAM}${req.url ?? "/"}`;
    const body = await readBody(req);
    const headers = forwardableHeaders(req);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: req.method,
          headers,
          ...(hasBody ? { body } : {}),
        });
      } catch (err) {
        if (attempt === MAX_ATTEMPTS - 1) {
          fail(res, 502, `model proxy: ${String(err)}`);
          return;
        }
        await sleep(Math.min(2 ** attempt * 500, MAX_WAIT_MS));
        continue;
      }

      if (!isRetryable(upstream.status) || attempt === MAX_ATTEMPTS - 1) {
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        if (upstream.body === null) {
          res.end();
          return;
        }
        // Streamed through, so server-sent token streams stay unbuffered.
        // Once headers are out we cannot turn a mid-stream failure into an
        // error response — the client has already been told this is a 200 —
        // so the most we can do is end the response cleanly and stay alive.
        const reader = upstream.body.getReader();
        req.on("close", () => void reader.cancel().catch(() => {}));
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (err) {
          console.error(`[model-proxy] upstream stream broke: ${String(err)}`);
        }
        res.end();
        return;
      }

      // Retryable: read the error (small) to find the stated wait, then wait.
      const text = await upstream.text();
      const delay = waitMs(attempt, upstream.headers, text);
      console.log(
        `[model-proxy] ${upstream.status} on attempt ${attempt + 1}/${MAX_ATTEMPTS}, ` +
          `retrying in ${Math.round(delay)}ms (${Date.now() - started}ms elapsed)`,
      );
      await sleep(delay);
    }
  }
}

// Last resort. Anything that still escapes is logged, never fatal: the harness
// has no retry of its own, so this process staying up is the whole point.
process.on("unhandledRejection", (reason) => {
  console.error(`[model-proxy] unhandled rejection: ${String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[model-proxy] uncaught exception: ${String(err)}`);
});
server.on("clientError", (_err, socket) => socket.destroy());

server.listen(PORT, () => {
  console.log(`[model-proxy] :${PORT} -> ${UPSTREAM}, up to ${MAX_ATTEMPTS} attempts`);
  console.log(`[model-proxy] point the harness at it with OPENAI_BASE_URL=http://localhost:${PORT}/v1`);
});
