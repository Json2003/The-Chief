# Orchestration contract

The Chief keeps the Cheverton orchestration backend running without a desktop window, ChatGPT chat, or Codex session. The business task engine remains in the Cheverton Administration Console backend; The Chief supervises that process and does not itself run agents or external actions.

## Task path

1. A task enters the backend with a requested agent (if specified), outcome, and optional inference profile.
2. The backend validates the agent and retains direct assignments. For automatic assignments it weighs role, availability, and the available synthetic competency evidence. Synthetic checks are **not** professional accreditation.
3. The backend's deterministic routing layer classifies task complexity and selects the model profile. A user-selected provider remains explicit. Automatic tasks can increase model weight after a failed quality check. If a lane is unavailable, recovery follows the configured gateway policy and records the actual provider used.
4. The worker produces a local draft or artifact. Structural checks, independent review, and owner/board approval gates remain separate. No LLM response can grant itself external authority.
5. The backend writes metadata-only audit transitions to `infrastructure/local-state/agent-audit.jsonl`. The Task Center shows recent events, and `/api/agent-audit` supports bounded read-only queries.

| Automatic tier | Default inference | Escalation |
| --- | --- | --- |
| Simple | Local Qwen with hosted Luna High recovery | Luna High |
| Routine | GPT-5.6 Luna High | Terra High |
| Substantive | GPT-5.6 Terra High | Sol High |
| Complex | GPT-5.6 Sol High | Review/owner direction if quality still fails |

Availability depends on the installed local model, the user's hosted account, and the backend's usage limits. The table is a routing policy, not a promise that every model is available on every account. The Chief itself has no subscription credential or inference API key.

## Restart and pause rules

- The Chief binds only `127.0.0.1:4175`. A second instance cannot take that port.
- It reads backend health from `127.0.0.1:4173/api/runtime-control`.
- It starts the backend only after repeated failed checks and only if the backend port is unoccupied. It preserves an occupied but unhealthy listener for diagnosis instead of starting a duplicate database writer.
- A backend launched by The Chief receives the saved pause/resume preference. Missing or invalid preference means **paused**. It never silently resumes work after a fresh install.
- The Chief leaves the backend running if its own process stops, so an orchestrator restart need not interrupt active work. Windows Task Scheduler restarts The Chief after a failure and at the next sign-in.

## Audit fields and limits

Each task transition records time, task and agent IDs, requested agent ID, division, task state, route tier/profile, selected and actual model, quality state, review state, and whether an external action executed. Entries are append-only and SHA-256 hash-chained across process restarts. The audit omits prompts, task details, deliverables, credentials, personal contact details, and free-form error text. Full task content remains in the private task store for authorized local review. The public repository contains **no live audit records**.

This trail begins when the backend version with audit support is deployed. It does not reconstruct historical transitions. A storage failure pauses new work; operators should resolve it before resuming.

## Interfaces

- `GET http://127.0.0.1:4175/status`: The Chief process health and most recent recovery state.
- `GET http://127.0.0.1:4173/api/runtime-control`: backend pause/readiness state.
- `GET http://127.0.0.1:4173/api/agent-audit?limit=100`: recent metadata events; optional `taskId` and `agentId` filters.
- Administration Console → Task Center → **The Chief · agent audit trail**: recent audit in the UI.

All ports are loopback-only. These endpoints are local status/control surfaces, not internet services.
