# CLAUDE.md — SRE-Oncall (TrueForge Hackathon)

This directory is the **seed** for the SRE-Oncall hackathon project. It was prepared on 2026-08-23 (the day before the hackathon) on a different machine/Claude account; all context needed to continue lives in the files below — read them before doing anything.

## What this project is

An AI SRE on-call agent built on the **TrueForge agent harness** for the WeMakeDevs "Agent Harness" hackathon (**Aug 24–30, 2026**, submission by 8 PM London time Aug 30). **Authenticated chatbox** (Next.js on Vercel, GitHub-OAuth allowlist — the chat can invoke the harness, so it is never public) + Slack surfaces; **Grafana-alert-triggered healing pipeline** (local kube-prometheus-stack webhook → orchestrator → healing session; PagerDuty was removed on 2026-08-25); approval-gated remediation; postmortem generation into a **SaaS Notion database** (official Notion MCP, integration token) + oncall-handoff generation; MCP tool connectivity (Grafana, **Kubernetes for live-event debugging, ArgoCD for deploy correlation/rollback, Terraform for infra-as-code changes, n8n for workflow automation — including agent-built workflows from natural-language requests**, GitHub). Architecture modeled on a production internal Slack SRE agent — the anonymized analysis is in `research/`.

## Read these, in order

1. **`PLAN.md`** — the consolidated project plan: hard hackathon constraints, decision log, architecture diagram, components to build, day-by-day schedule, accounts/keys checklist, env vars, open questions. This is the source of truth.
2. **`research/trueforge-hackathon.md`** — hackathon rules, prizes/tracks, judging criteria, and vendor-by-vendor deep dive (TrueForge, Qodo, PagerDuty, Grafana, Daytona, Exa/Tavily…).
3. **`research/reference-agent-analysis.md`** — anonymized forensic analysis of the internal reference implementation: concurrency model, session resume, Slack Socket Mode setup + scopes, PagerDuty triage flow, security patterns to port.
4. **`research/architecture-research.md`** — PagerDuty Events API v2 / webhook v3 payloads and setup, ngrok wiring, MCP server inventory, capability feasibility (postmortem, handoff), demo script.
5. **`research/n8n-mcp-research.md`** — n8n's three MCP modes (Server Trigger, Client Tool, czlonkowski builder), self-hosted Docker setup, ngrok analysis, and 10 SRE use cases ranked by demo value.

Also here: **`index.html`** — the public architecture explainer / project landing page (self-contained static file, dark console theme). Deploys to Vercel as-is; Vercel integration and the what-runs-where split are documented in PLAN.md §11.

## Non-negotiables (from hackathon rules — details in PLAN.md §2)

- The agent must genuinely run on **TrueForge** (`npx @truefoundry/trueforge`).
- **Qodo** must be installed on the public repo from day one with visible PR review history → do all work via PRs.
- **Human approval gates** before any remediation are a judging criterion.
- All coding happens Aug 24–30; disclose AI coding assistants; no API keys in the repo or demo video.
- **This is a public event: no company names, internal hostnames, internal repo/channel names, or any employer data in code, docs, prompts, commits, or the demo.** The research docs are already anonymized — keep them that way.

## Current status (as of 2026-08-23)

- Research + planning complete. **No code written yet** (coding may not start before Aug 24, 8 AM London).
- No accounts created yet — Day 1 checklist in PLAN.md §7.
- NOTE: research files still describe PagerDuty flows — they are **historical reference**; the live decision (PLAN.md §3) replaced PagerDuty with Grafana Alerting as the healing trigger on 2026-08-25.
- Open questions to resolve on Day 1 are in PLAN.md §9.

## Conventions for this repo

- **Secrets live ONLY in `.env`** (already created from `.env.example`, and blocked by `.gitignore` — verified with `git check-ignore`). Never commit tokens; never put real values in `.env.example`; Vercel chatbox secrets go in the Vercel dashboard, never in files. Before any push, run `git status` and confirm no `.env`/key material is staged.
- Build order: orchestrator → alert pipeline → observability/demo-env → Slack + approval gates → postmortem/handoff → UI polish (PLAN.md §6).
- When implementing, port the named reference-agent patterns (PLAN.md §8) rather than re-deriving them; the code snippets are in `research/reference-agent-analysis.md`.
