# Submission checklist

Required components, per `research/trueforge-hackathon.md`, mapped to their
actual state in this checkout. "Verified" means checked against the code or
git history in this repository; "outstanding" means it needs action before
8:00 PM London, Aug 30 2026, and could not be confirmed from here.

| Required | State | Notes |
|---|---|---|
| Public source code repository with a functioning README | **Outstanding / unverified** | This worktree has no `git remote` configured (`git remote -v` returns nothing). Whether a public GitHub repo exists, what its visibility is, and whether this history has been pushed to it cannot be confirmed from this checkout. Confirm the remote, confirm the repo is public, and push. |
| README describes the project accurately | Verified, with one addition | `README.md` matches the code: layout table, running-it steps, and the design-notes claims (trust boundary, two bearers, approval gates, concurrency) all check out against `orchestrator/src/*`. Added a short "Status" note (see below) since the existing README otherwise reads as if a healing session has completed, which it hasn't. |
| Agent runs on TrueForge, judges see genuine harness work | **Partially verified** | Session/turn creation, MCP attachment, skill loading, and model-provider registration are all real calls against the TrueForge SDK (`orchestrator/src/trueforge.ts`, `agent/agent.ts`) and were exercised against a live harness per the commit history (`e3cd589`, `4ca1671`, `5b61428`). No live *agentic run* — an actual investigation and remediation — has completed, because there's no funded model key. The demo will need Plan A in `docs/demo-script.md` to show genuine harness work end to end. |
| ~3-minute demo video | **Outstanding** | `docs/demo-script.md` is the rehearsable script, timed to 3:00, with an honest Plan A / Plan B split depending on whether a funded Anthropic key is available by recording day. Not yet recorded. |
| Technical write-up | Done | `docs/technical-writeup.md`. Covers architecture, the MCP remote-only constraint, the tool-name/`preloadTools` silent-failure story, the rate-limit-counted-successes bug, the `turn.done` pause-vs-end story, the trust boundary, the two-bearer split, and an explicit "what is not built" section. |
| AI-assistant disclosure | Done, pre-existing | `docs/ai-assistance.md` already covers this — which tools, how they were used, and what the authors can explain. Not modified as part of this pass; it was already accurate against the commit history checked here. |
| No personal API keys or sensitive data in the repo or video | Verified, in this checkout | `.gitignore` blocks `.env`, `*.pem`, `*.key`, `*_token*`, `.data/`, kubeconfigs, and Terraform state. A grep for common key shapes (`sk-ant-`, `xoxb-`, `xapp-`, `ntn_`, `ghp_`, AWS access keys) across tracked file types found two matches, both placeholders: `research/reference-agent-analysis.md:413` (`ANTHROPIC_API_KEY=sk-ant-...`, an illustrative `.env` line) and `orchestrator/test/server.test.ts:168` (`xapp-1-A`, a test fixture). Slack identifiers in the docs were deliberately rewritten to unmistakable placeholder shapes (`C0XXXXXXXXX`, `U0XXXXXXXXX`) per `e1e4a9c`. This check does not extend to the demo video, which doesn't exist yet — re-run a visual check of the recording before publishing it, especially any terminal pane showing `.env` contents or a Grafana/ArgoCD token minted live. |
| Qodo installed from day one, PR review history visible | **Outstanding / unverified** | No `.github/` directory and no Qodo config file exist in this checkout, and there's no way to confirm from local files whether the Qodo GitHub App is installed on the actual repository or whether any PRs (with Qodo review comments) exist — that lives on GitHub, not in the tree. All 9 commits in this history were made directly (no merge commits, no PR references in commit messages), which suggests work has not yet gone through the PR-per-change flow `PLAN.md` §6 calls for. If the Q Branch / Best Code Quality track matters, this needs the Qodo app installed and at least some of the outstanding work routed through reviewed PRs before submission. |
| No company names, internal hostnames, or employer data | Verified | `research/reference-agent-analysis.md` is explicitly marked as anonymized, with placeholder identifiers rewritten in `e1e4a9c` specifically to close this gap. The docs written in this pass (`demo-script.md`, `technical-writeup.md`, this file) introduce no new identifiers of that kind. |
| AI coding assistants disclosed, authors can explain the code | Consistent with `docs/ai-assistance.md` | Every commit in the history carries `Co-Authored-By: Claude Opus 5`, matching the disclosure. |

## What's outstanding, in priority order

1. **Get a funded Anthropic key and complete one real healing session.**
   Everything else in the demo script depends on this being true before
   recording; without it, judging criterion 3 (technical excellence and
   reliability) has nothing live to point at beyond the plumbing.
2. **Confirm the GitHub repository: public, has a remote, is what gets
   pushed.** This checkout can't verify any of that.
3. **Install Qodo and route at least some remaining work through PRs**, if
   the Best Code Quality track is a goal — the current history is 9 direct
   commits with no PR trail.
4. **Record the demo video** using `docs/demo-script.md`.
5. **Wire up at least one of Slack or the console for real**, so the
   approval-gate beat in the video is a real human clicking a real button,
   not a description of one. The console (username/password, no external
   workspace needed) is the lower-setup-cost option.
6. **Visually re-check the recorded video** for anything that slipped past
   the grep check above — a Grafana admin token minted on screen, a
   `kubectl` output showing a real kubeconfig path, etc.
