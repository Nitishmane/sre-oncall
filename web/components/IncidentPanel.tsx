"use client";

import { useEffect, useState } from "react";

/**
 * Incident and approval history alongside the chat, so the console shows the
 * agent's decisions and the human gates on them — not just the conversation.
 */

interface Incident {
  fingerprint: string;
  rule_name: string;
  status: string;
  first_seen_at: number;
  last_triaged_at: number | null;
  healing_session_id: string | null;
  postmortem_session_id: string | null;
}

interface Approval {
  tool_label: string;
  decision: "approved" | "denied" | null;
  decided_by: string | null;
  requested_at: number;
}

const relative = (ms: number): string => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

export function IncidentPanel() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/incidents?hours=24", { credentials: "same-origin" });
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { incidents?: Incident[]; approvals?: Approval[] };
        if (!live) return;
        setIncidents(body.incidents ?? []);
        setApprovals(body.approvals ?? []);
        setError(null);
      } catch {
        if (live) setError("Can't reach the orchestrator.");
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <aside
      style={{
        width: "22rem",
        flexShrink: 0,
        borderLeft: "1px solid var(--console-border)",
        background: "var(--console-panel)",
        padding: "1.25rem",
        overflowY: "auto",
      }}
    >
      <Section title="Last 24 hours">
        {error !== null && <Muted>{error}</Muted>}
        {error === null && incidents.length === 0 && <Muted>No incidents. Quiet shift.</Muted>}
        {incidents.map((incident) => (
          <div key={incident.fingerprint} style={{ marginBottom: "0.9rem" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
              <span
                style={{
                  color:
                    incident.status === "firing"
                      ? "var(--console-firing)"
                      : "var(--console-resolved)",
                }}
              >
                ●
              </span>
              <strong style={{ fontSize: "0.9rem" }}>{incident.rule_name}</strong>
            </div>
            <div style={{ color: "var(--console-muted)", fontSize: "0.78rem", paddingLeft: "1rem" }}>
              {relative(incident.first_seen_at)}
              {incident.healing_session_id !== null && " · healed"}
              {incident.postmortem_session_id !== null && " · postmortem"}
              {incident.last_triaged_at === null && incident.status === "firing" && " · not triaged"}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Approval gates">
        {approvals.length === 0 && <Muted>Nothing has needed approval yet.</Muted>}
        {approvals.map((approval) => (
          <div key={`${approval.tool_label}-${approval.requested_at}`} style={{ marginBottom: "0.7rem" }}>
            <code style={{ fontSize: "0.78rem" }}>{approval.tool_label}</code>
            <div style={{ color: "var(--console-muted)", fontSize: "0.78rem" }}>
              {approval.decision === null
                ? "waiting for a human"
                : `${approval.decision} by ${approval.decided_by ?? "someone"}`}
              {" · "}
              {relative(approval.requested_at)}
            </div>
          </div>
        ))}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "2rem" }}>
      <h2
        style={{
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--console-muted)",
          marginBottom: "0.8rem",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <p style={{ color: "var(--console-muted)", fontSize: "0.82rem" }}>{children}</p>
);
