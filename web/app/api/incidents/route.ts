import { auth } from "../../../auth.ts";
import { isAllowed, parseAllowlist } from "../../../lib/allowlist.ts";

/**
 * Incident and approval history for the timeline panel. Served by the
 * orchestrator, not the harness, so it has its own small handler rather than
 * going through the harness proxy.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!isAllowed(session?.user?.name, parseAllowlist(process.env["CHAT_ALLOWLIST"]))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const base = process.env["TRUEFORGE_API_URL"];
  const token = process.env["TRUEFORGE_BRIDGE_TOKEN"];
  if (base === undefined || token === undefined) {
    return Response.json({ error: "console is not configured" }, { status: 503 });
  }

  // The orchestrator serves /incidents and /approvals as siblings of /chat.
  const root = new URL(base);
  root.pathname = root.pathname.replace(/\/chat\/?$/, "");
  const hours = new URL(req.url).searchParams.get("hours") ?? "24";

  try {
    const [incidents, approvals] = await Promise.all(
      ["incidents", "approvals"].map(async (name) => {
        const target = new URL(`${root.pathname.replace(/\/+$/, "")}/${name}`, root);
        target.search = `?hours=${encodeURIComponent(hours)}`;
        const res = await fetch(target, {
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        return res.ok ? await res.json() : {};
      }),
    );
    return Response.json({ ...incidents, ...approvals });
  } catch {
    return Response.json({ error: "orchestrator unreachable" }, { status: 502 });
  }
}
