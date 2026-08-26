# AI assistance disclosure

The hackathon rules permit AI coding assistants and require that their use be
disclosed, and that the authors be able to explain the code they submit. This
file is that disclosure.

## What was used

- **Claude Code** (Anthropic) — used throughout, for the orchestrator, the agent
  definition and system prompt, the runbook skills, the demo environment, and
  this documentation.
- **Qodo** — reviews every pull request in this repository. Its findings are
  visible in the PR history.

## How it was used

Planning and research were done before the hackathon window opened (permitted by
the rules; see `PLAN.md` and `research/`). All code in this repository was
written inside the window, Aug 24–30 2026.

The working pattern was: decide the design, have the assistant draft an
implementation, then review, correct, and test it. Notable places where the
generated approach was changed after review:

- The initial design assumed stdio MCP servers, following the plan. Reading the
  TrueForge SDK's `McpServerManifest` showed it accepts `type: "remote"` only;
  the design changed to front each stdio server with a local HTTP bridge
  (`mcp/`).
- The alert-handling path carries identifiers only, with shape validation, rather
  than passing through the alert body — a deliberate narrowing, tested in
  `orchestrator/test/payload.test.ts`.

## Model provider at runtime

The agent's model is configuration, not code: `SRE_ONCALL_MODEL` names a
`provider/model` FQN, and the provider half decides which provider is registered
on the harness and which API key is read. The project has been provisioned
against both `anthropic/claude-opus-5` and `openai/gpt-5-6-sol` without a code
change. `npm run provision -- --list-models` lists what a given harness offers.

This is separate from the authoring tools disclosed above, which wrote the code
but are not part of what runs.

## What the authors can explain

All of it — that is the standard the rules set. The parts worth asking about are
the concurrency model in `orchestrator/src/concurrency.ts` (a per-fingerprint
promise chain under a global semaphore, ported from the prior art described in
`research/reference-agent-analysis.md`), the trust boundary in
`orchestrator/src/alerts/payload.ts`, and the approval policy expressed on each
MCP attachment in `agent/agent.ts`.
