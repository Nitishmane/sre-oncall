import { auth } from "../../../../auth.ts";
import { isKnownUser, parseConsoleUsers } from "../../../../lib/credentials.ts";
import { forwardableHeaders, safeUpstreamPath, upstreamUrl } from "../../../../lib/proxy.ts";

/**
 * The harness proxy — the only path from the browser to the agent.
 *
 * The browser sends a same-origin request with its session cookie. This handler
 * re-checks the session *and* the account (middleware already did, but this
 * route attaches a bearer that grants full harness access, so it does not
 * delegate that decision), then forwards to the orchestrator's authenticated
 * `/chat` proxy with the server-side bridge token.
 *
 * The browser never receives the tunnel URL or the token.
 */

// The harness streams turn events; a Node runtime keeps the stream unbuffered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

async function handler(req: Request, { params }: Params): Promise<Response> {
  const session = await auth();
  const login = session?.user?.name;
  if (!isKnownUser(login, parseConsoleUsers(process.env["CONSOLE_USERS"]))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const base = process.env["TRUEFORGE_API_URL"];
  const token = process.env["TRUEFORGE_BRIDGE_TOKEN"];
  if (base === undefined || token === undefined) {
    // Misconfiguration, not a client error — and never leak which value is missing.
    console.error("harness proxy is not configured: TRUEFORGE_API_URL / TRUEFORGE_BRIDGE_TOKEN");
    return Response.json({ error: "console is not configured" }, { status: 503 });
  }

  const { path } = await params;
  const safePath = safeUpstreamPath(path);
  if (safePath === null) return Response.json({ error: "bad path" }, { status: 400 });

  const search = new URL(req.url).search;
  const target = upstreamUrl(base, safePath, search);
  if (target === null) return Response.json({ error: "bad upstream" }, { status: 500 });

  const headers = forwardableHeaders(req.headers);
  headers.set("authorization", `Bearer ${token}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: await req.arrayBuffer() } : {}),
      // Server-sent events must stream, not buffer.
      cache: "no-store",
      // @ts-expect-error -- Node's fetch needs this for a streaming request body.
      duplex: "half",
    });

    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    if (contentType?.includes("text/event-stream")) {
      responseHeaders.set("cache-control", "no-cache, no-transform");
      responseHeaders.set("connection", "keep-alive");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("harness proxy failed", err instanceof Error ? err.message : String(err));
    return Response.json({ error: "harness unreachable" }, { status: 502 });
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
