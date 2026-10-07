# The Chief

The Chief is a standalone, headless supervisor for Cheverton's orchestration backend. It is a separate Windows sign-in task and Node process. Closing the desktop console, ChatGPT, or Codex does not stop it. It checks the private backend every ten seconds and starts it after three failed checks **only when port 4173 is free**. It never kills an occupied listener or launches a duplicate while its own child is starting.

The backend still contains the business task engine. The Chief is the independently restartable process owner, not a claim that the entire task engine has been extracted into a new application.

## What it owns

| Tool | Responsibility |
| --- | --- |
| `the-chief.mjs` | Single-instance private supervisor on `127.0.0.1:4175`; health checks and safe backend restart. |
| `the-chief-policy.mjs` | Deterministic decision: healthy / wait / occupied-preserve / start. |
| `chief-ui.html` | Local chat front end served by The Chief at `/`. No secrets in the page; every call needs the intake key. |
| `chief-gateway.mjs` | Intake and pause/resume gateway: key check, route allowlist, concurrency cap, failure breaker. |
| `chief-runtime-preference.mjs` | Durable owner choice: `drain` or `resume`. Missing or invalid state defaults to paused. |
| `Install-TheChief.ps1` | Registers a per-user Windows sign-in task with failure restart settings and starts it now. |
| `Start-TheChief.ps1` | Passes the selected backend checkout to the supervisor without opening the console. |

The Cheverton backend uses its own orchestration layer for agent selection, task/model weight, competency checks, review, approvals, and agent audit. The Chief supervises that layer; it does not let an LLM choose its own authority or provider. A direct agent assignment remains assigned to that agent. Automatic simple tasks use local Qwen when available; harder work escalates through hosted model tiers. External actions remain governed by the backend's approval controls.

See [ORCHESTRATION.md](ORCHESTRATION.md) for the task path, model-tier policy, restart rules, audit fields, and status interfaces.

## Install and operate (Windows)

Requires Node.js 24+ and an existing Cheverton backend checkout. From the Cheverton checkout, run:

```powershell
& .\scripts\Install-TheChief.ps1
```

For a separate checkout of The Chief, pass the backend directory:

```powershell
& .\Install-TheChief.ps1 -BackendRoot 'C:\path\to\Cheverton-Business'
```

Inspect health without opening the console:

```powershell
Invoke-RestMethod http://127.0.0.1:4175/status
Get-ScheduledTask -TaskName 'The Chief'
```

The owner pauses or resumes the task queue in the Administration Console. That explicit choice is saved in `infrastructure/local-state/chief-runtime-preference.json` and replayed on backend recovery. On first install with no saved choice, The Chief starts the backend **paused**. The supervisor never approves business actions, submits filings, sends email/texts, spends money, or deploys changes. It can pause the queue, and it can resume it only when the owner-held intake key is presented (see below).

## Intake and control gateway

The Chief is the front door for task inputs and pause/resume, on `127.0.0.1:4175` only. Callers present the **intake key** (`chief-intake.key`, created on first start next to the console's `session.key`) in the `x-chief-intake-key` header. The Chief reads the console key itself at request time, attaches it, and never logs or returns it. Browser requests (any `Origin`) are refused.

| Route | Forwards to | Notes |
| --- | --- | --- |
| `POST /intake/command` | `/api/command` | 8 KB limit |
| `POST /intake/chat` | `/api/chat` | 96 KB limit |
| `POST /control/drain` | `/api/runtime-control` | Always allowed, ignores the capacity cap |
| `POST /control/resume` | `/api/runtime-control` | Fixed action only; needs `{"acknowledgeBreaker":true}` after a trip |
| `GET /console/status` | `/api/runtime-control` | Read-only |

The Chief also serves a small chat page at `http://127.0.0.1:4175/` (ask, assign a task or command, pause, resume, live status). You paste the intake key once per browser tab; it is kept in that tab's session storage only. Command payloads are `{"command":"...","agentId":"optional"}` and chat payloads are `{"messages":[{"role":"user","content":"..."}]}`.

Everything else, including approvals, vault, email, payments and settings, is not reachable and returns 404. Forwarded work is capped at 6 concurrent requests (`CHIEF_MAX_IN_FLIGHT`). After 5 consecutive console failures the breaker trips: intake stops and The Chief drains the console automatically. It never resumes on its own.

To stop automatic supervision, disable the Windows task named `The Chief`. An already-running backend is intentionally left running if The Chief exits; stopping it separately should use the console's drain control.

## Public-repo boundary

This repo contains only The Chief's generic supervisor, preference helper, tests, and operations guide. It does not contain Cheverton task history, agent prompts, local model weights, credentials, business records, `.env.local`, or the private backend. The backend checkout is supplied locally during installation.
