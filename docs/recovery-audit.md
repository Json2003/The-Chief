# Recovery audit — October 11, 2026 (UTC)

Scope: The-Chief standalone supervisor and Windows launch scripts, with related
Cheverton-Business PR #1 inspected for its watchdog-validation limitation.
No production backend, owner queue, credentials, or scheduled tasks were changed.

## Findings and corrections

- A child terminated by a signal has null exitCode but a populated signalCode.
  The old liveness check could indefinitely suppress recovery. Check both fields.
- spawn() returns before OS startup succeeds. Previously restarts incremented and
  status reported backend-started even on spawn errors. Count only the spawn event;
  clear a failed child reference and expose backend-launch-failed for retry.
- Stop now clears timers and checks its stopping flag after asynchronous health,
  port and preference reads, preventing an in-flight check from spawning on shutdown.
- Extract an importable supervisor factory for isolated testing. CLI ports, timings,
  loopback binding, detached backend, environment forwarding, and preference rules
  retain their defaults. Status adds failure count and last successful spawn time.

## Automated evidence

Node 24.19.0, Linux: npm test passes 18 tests, zero failures/skips. Two original
policy/preference tests retained; 16 new integration cases use ephemeral loopback
ports and temporary directories. Real Node fixture children are killed on cleanup.
Tests cover three-failure startup, health reset, signal recovery, booting child and
concurrent-check duplicate suppression, healthy/error/malformed/hung occupied
listeners, singleton bind failure, read-only HTTP surface, missing backend, OS spawn
failure, crash/restart preferences, missing/malformed/invalid defaults, later drain
superseding resume, supervisor stop/adoption, timer-driven startup and shutdown races.
The fixtures have no task engine or external-action integrations. Passing tests prove
supervisor process behavior, not real Cheverton task execution or authorization.

The workflow runs the same suite on Ubuntu and Windows with Node 24. Windows CI
results must be checked independently; adding a workflow is not a passing result.

## Remaining limitations

An occupied unhealthy listener or live child that never binds is deliberately left
alone indefinitely; there is no forced-kill policy. /health reports supervisor
availability, not backend readiness; inspect /status.action and lastError.
Port probing is a point-in-time observation, not an atomic backend ownership lock:
an unrelated process could bind after the probe, and a replacement supervisor can
miss an orphan backend still booting before it binds. The backend must enforce its
own singleton/write ownership. Do not infer guaranteed duplicate prevention across
that restart race from these tests. Missing/invalid preference defaults to paused;
preference changes during spawning still require the backend's runtime control to
apply the owner's newest choice. No resume endpoint or approval bypass was added.

## Windows acceptance (isolated VM first)

Use an owner-controlled disposable Windows account and synthetic backend checkout,
Node 24, and unused production-default ports. Keep external actions disabled. Do not
install over the live Garcia Lab task for these checks.

1. Run npm test. Run Install-TheChief.ps1 with an explicit backend root containing
   spaces. Inspect the registered action, working directory, owner, Interactive
   logon type, Limited run level, sign-in trigger, no execution limit and restart
   settings. Confirm Start-TheChief.ps1 forwards Node's exit code and root settings.
2. Confirm sign-in starts one supervisor without a console window. Re-run installer
   and launcher: one 4175 listener, no second backend. The task is per-user and
   interactive: startup before sign-in and continued operation after sign-out are
   not guaranteed by this installation design.
3. Close launcher/desktop console; confirm supervisor and synthetic backend remain
   reachable. Restart supervisor alone and confirm an already-bound backend survives.
4. With synthetic backend paused, terminate only that backend. Observe three failed
   checks and recovery, check the new PID and paused state. Repeat with malformed
   preference; never run a live external-action queue for this exercise.
5. Hold 4173 with an unhealthy synthetic listener: verify occupied-preserve and no
   termination or second writer. Hold 4175: verify launcher fails and task restart
   behavior is visible in Task Scheduler history.
6. Record Task Scheduler LastTaskResult/history, timestamps, PIDs and redacted status.
   Remove the disposable task and fixtures after testing.

## Garcia Lab acceptance (still unverified)

In a maintenance window, first inspect deployed versions, saved owner preference,
existing supervisor/backend PIDs, scheduled-task definition and port ownership.
Use a separate staging checkout/account where possible. Confirm actual backend
reads CHEVERTON_START_PAUSED and never starts paused queued work on recovery; inspect
queue/audit records and authorization checks with synthetic, local-only tasks.
Confirm console closure independence, crash recovery, saved pause after Windows
sign-in, no duplicated task writes, retained outputs, and active-work recovery.
Do not change saved drain to resume to make a health check pass. Any live resume
requires the owner's explicit choice through existing authorized runtime controls.
Task Scheduler installation and real Garcia Lab backend recovery remain unverified
until those checks have evidence. The related console PR makes the same distinction.
