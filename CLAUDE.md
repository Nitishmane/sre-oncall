# CLAUDE.md — TrueForge Agents (TrueForge Hackathon)

## What this project is

Two agents on the **TrueForge agent harness** — `sre-oncall` and `automation-engineer` for the WeMakeDevs "Agent Harness" hackathon (submission by 8 PM London time Aug 30, 2026). **A static explainer page on Vercel** (no auth, no harness connection, no secrets — it is the submission artefact) + two Slack bots as separate apps; **Grafana-alert-triggered healing pipeline** (local kube-prometheus-stack webhook → orchestrator → healing session); approval-gated remediation; postmortem generation into a **SaaS Notion database** (official Notion MCP, integration token) + oncall-handoff generation; MCP tool connectivity (Grafana, Kubernetes for live-event debugging, ArgoCD for deploy correlation/rollback, Terraform for infra-as-code changes, GitHub). A **second agent, Automation-Engineer**, turns spoken requirements into n8n workflows; it holds the n8n MCP servers and the on-call agent holds none of them.

**Demo scenario:** a bad release breaks a liveness probe → the alert fires → the agent correlates it to the ArgoCD sync and the offending commit → it opens a revert pull request carrying its full reasoning → a human reviews and merges → ArgoCD auto-syncs → the alert resolves and the agent posts a resolution summary in the same Slack thread. The PR review is the approval gate; the agent never merges its own PRs.

## Reference material

- `PLAN.md` and `research/` are local-only working notes (gitignored, not part of the public repo) — read them if present in this checkout, but don't assume a fresh clone has them.
- **`index.html`** — the public architecture explainer / project landing page, deployed to Vercel as-is.

## Non-negotiables (hackathon rules — details in PLAN.md §2)

- The agent must genuinely run on **TrueForge** (`npx @truefoundry/trueforge`).
- **Qodo** must be installed on the public repo with visible PR review history → do all work via PRs.
- **Human approval gates** before any remediation are a judging criterion.
- Disclose AI coding assistants; no API keys in the repo or demo video.
- **This is a public event: no company names, internal hostnames, internal repo/channel names, or any employer data in code, docs, prompts, commits, or the demo.** Keep `research/` anonymized.

## Conventions for this repo

- **Secrets live ONLY in `.env`** (gitignored — verified with `git check-ignore`). Never commit tokens; never put real values in `.env.example`; Vercel chatbox secrets go in the Vercel dashboard, never in files. Before any push, run `git status` and confirm no `.env`/key material is staged.
- MCP tool gating: `@write`/`@destructive` selectors classify by tool-name shape and routinely block reads on multi-purpose tools (Grafana, Notion, GitHub) — gate by explicit tool name instead.
- Skills load from `main`; a runbook edited on a branch is invisible to the agent until it merges or `SKILLS_REPO_REF` points at that branch.
