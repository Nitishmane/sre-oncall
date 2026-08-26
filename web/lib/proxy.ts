/**
 * Path handling for the harness proxy.
 *
 * The browser reaches the harness only through `/api/harness/*` on this origin.
 * This module decides what upstream path that becomes. It is separated out and
 * tested because a mistake here is a security bug: the proxy attaches a bearer
 * that grants full harness access, so it must never be persuaded to send that
 * bearer somewhere other than the configured upstream.
 */

/** Rejects anything that could escape the upstream's `/chat` prefix. */
export function safeUpstreamPath(segments: string[]): string | null {
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    // A segment arrives already URL-decoded; an encoded slash or backslash here
    // means someone is trying to synthesise path structure.
    if (segment.includes("/") || segment.includes("\\")) return null;
    if (segment.includes("\0")) return null;
  }
  return `/${segments.join("/")}`;
}

/**
 * Builds the upstream URL. `base` is the orchestrator's authenticated `/chat`
 * proxy; the result can only ever be a path underneath it.
 */
export function upstreamUrl(base: string, path: string, search: string): string | null {
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return null;
  }
  if (root.protocol !== "https:" && root.protocol !== "http:") return null;

  const prefix = root.pathname.replace(/\/+$/, "");
  const target = new URL(root.toString());
  target.pathname = `${prefix}${path}`;
  target.search = search;

  // Belt and braces: after all the URL parsing, confirm we are still under the
  // configured origin and prefix.
  if (target.origin !== root.origin) return null;
  if (!target.pathname.startsWith(`${prefix}/`)) return null;
  return target.toString();
}

/** Request headers worth forwarding upstream. Everything else is dropped. */
const FORWARD = new Set(["accept", "content-type", "accept-language"]);

export function forwardableHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    if (FORWARD.has(name.toLowerCase())) out.set(name, value);
  }
  return out;
}
