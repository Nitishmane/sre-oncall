"use client";

import { TrueForgeUI } from "@truefoundry/trueforge-ui";

/**
 * The chat itself.
 *
 * `baseUrl` points at this app's own `/api/harness` route, so every harness call
 * is a same-origin request carrying the session cookie. The route handler adds
 * the bridge bearer server-side — no token is passed here, and none reaches the
 * browser. `credentials: "same-origin"` is what makes the cookie ride along.
 */
export function Console({ agentName }: { agentName: string }) {
  return (
    <TrueForgeUI
      server={{
        type: "trueforge",
        baseUrl: "/api/harness",
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, credentials: "same-origin" }),
      }}
      layout="sidebar"
      agentConfig={{ mode: "SingleAgent", name: agentName }}
    />
  );
}
