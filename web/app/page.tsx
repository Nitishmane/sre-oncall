import { auth, signOut } from "../auth.ts";
import { Console } from "../components/Console.tsx";
import { IncidentPanel } from "../components/IncidentPanel.tsx";

export default async function Home() {
  const session = await auth();
  const agentName = process.env["TRUEFORGE_AGENT_NAME"] ?? "sre-oncall";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.65rem 1.25rem",
          borderBottom: "1px solid var(--console-border)",
          background: "var(--console-panel)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
          <strong style={{ fontSize: "0.95rem" }}>SRE-Oncall</strong>
          <span style={{ color: "var(--console-muted)", fontSize: "0.8rem" }}>
            read-only by default · every change is gated
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
          <span style={{ color: "var(--console-muted)", fontSize: "0.8rem" }}>
            {session?.user?.name}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button
              type="submit"
              style={{
                background: "none",
                border: "1px solid var(--console-border)",
                borderRadius: "0.4rem",
                color: "var(--console-muted)",
                fontSize: "0.78rem",
                padding: "0.3rem 0.7rem",
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, minWidth: 0 }}>
          <Console agentName={agentName} />
        </main>
        <IncidentPanel />
      </div>
    </div>
  );
}
