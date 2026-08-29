# Submission checklist

Required components mapped to their actual state. "Verified" means checked
against the code, the live systems, or GitHub itself — not inferred.
"Outstanding" means it still needs doing before 8:00 PM London, Aug 30 2026.

| Required | State | Notes |
|---|---|---|
| Public source code repository with a functioning README | **Verified** | `github.com/Nitishmane/sre-oncall`, public, 48 commits. `README.md` describes the two agents, the layout, how to run it, and the design notes. |
| Agent runs on TrueForge, judges see genuine harness work | **Verified end to end** | Not just session creation: a real investigation over MCP tools, correlating an alert to an ArgoCD sync and opening a revert pull request, run against the live kind cluster with a funded provider (`openai/gpt-5-6-terra`). Two agents provisioned, disjoint toolsets, both driven from Slack. |
| Human approval gates before remediation | **Verified against a live workspace** | Real Block Kit prompts in Slack, decided by a named approver list, written to the audit table before display and claimed atomically. The revert PR's merge is itself the gate for the git path — the agent cannot merge. |
| ~3-minute demo video | **Outstanding** | `docs/demo-script.md` is rehearsable as written; every beat in it is now a verified capability rather than a plan. Not yet recorded. |
| Technical write-up | Done | `docs/technical-writeup.md` — architecture, the MCP remote-only constraint, the silent `preloadTools` failure, the `turn.done` pause-vs-end trap, the trust boundary, and an explicit verified/not-verified section. |
| AI-assistant disclosure | Done | `docs/ai-assistance.md`. Every commit carries `Co-Authored-By: Claude Opus 5`. |
| No personal API keys or sensitive data in the repo | **Verified** | `.gitignore` blocks `.env`, `*.pem`, `*.key`, `.data/`, kubeconfigs and Terraform state. Key-shaped strings in tracked files are placeholders or test fixtures. Slack identifiers in docs use placeholder shapes. The deployed page holds **zero** environment variables. |
| Qodo installed, PR review history visible | **Verified** | The Qodo GitHub App reviews pull request diffs; 8 PRs merged, with review comments on the diffs. One Qodo pass found four real defects that were fixed with regression tests before merge (PR #9). |
| No company names, internal hostnames, or employer data | Verified | Research notes are anonymised and untracked. Nothing added since introduces identifiers of that kind. |

## Outstanding, in priority order

1. **Record the demo video** using `docs/demo-script.md`. This is the only
   required component still missing.
2. **Check the two fragile prerequisites before recording**: `npm run
   model-proxy` on :8120 (without it every turn dies on the model call), and the
   ArgoCD MCP bridge, which has been seen timing out and which the correlation
   beat depends on.
3. **Visually re-check the recording** for anything a grep cannot catch — a
   token minted on screen, a `kubectl` output showing a real kubeconfig path, an
   editor tab with `.env` open.
4. **Decide how to state the two known gaps on camera.** Git-backed skills do
   not install on this host (runbooks come through the `raw-file` MCP server),
   and approval gates are tool-name-scoped rather than argument-aware. Both are
   stated on the public explainer. A judge who spots one you did not mention
   will discount the rest; a judge who hears it from you will not.

## What changed since this file last claimed otherwise

It previously said the repo had no remote, that no healing session had ever
completed, that there was no funded model key, and that the history was nine
direct commits with no PR trail. All four are now false. They are recorded here
rather than quietly deleted, because a checklist that silently rewrites its own
history is not one whose current entries you can trust.
