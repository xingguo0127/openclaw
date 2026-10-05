# Experiment: floai fork synced onto upstream v2026.9.7 (2026-10-01..05)

**Status: verified on a local gateway, NOT merged into `floai`, NOT deployed to prod. Decision on rolling out is pending.**
Baseline before any of this work: branch `archive/pre-upgrade-20260930` (= tag `floai-pre-slim-20260930`, 41185a57c93).
`floai` additionally has the 10-01 slimming merges (ambient/collab and knowledge-graph moved into plugins).

## What this branch is

Upstream `v2026.9.7` + fork-only extensions (flowos-*, celia-canvas, qwen-audio-tts) + qwen realtime + the small core
patches that were ported (plugin tool ctx runId/trigger, subagent runTimeoutSeconds/getRunStatus, device-bootstrap
re-exports, celia-card-inject rewrite for the SQLite session store). The FlowGo (Raspberry Pi) cluster is intentionally
NOT ported (device retired). One fix on top: `flowos-execution-runtime` background work now runs on the Gateway's
context-free async root (`Symbol.for("openclaw.detachedAsyncContext")`), because upstream revokes the operator/tool-caller
authority of a run when it ends, which broke planned-artifact finalization and repair dispatch; and execution bindings are
saved JSON-serializable (plugin state rejects `undefined`).

## Verified locally (phone + ESP32 + logs)

chat + cards, phone realtime call (qwen), half-modal ambient context, spaces/tasks, image generation + set avatar,
Surface Context bind, route-book long task (start -> validate -> repair -> register artifact -> complete),
ESP32 realtime call (talk.* relay + consult tool), ESP32 meeting minutes (Assist-only, no gateway), node command allowlist,
flowos_capability tool, plugin post-upgrade compat check (0 findings).

## Not verified / known gaps

ESP32 re-onboarding (flowos.deviceOnboardingProvision), MAA, GUI agent (being tested by owner), gateway-side TTS plugin
(not configured locally before or after). ESP32 live call currently needs the device token approved for 5 operator scopes
(branch asks for them; the paired token only has read+write).

## Work left before prod

- Dockerfile.floai / CI image (Node >=24.16, pnpm 12.5.1); prod `config.baseline` migration (`openclaw doctor --fix` rewrites
  `agents.list`->`agents.entries`, `gateway.nodes.allowCommands`->`commands.allow`, `memorySearch`->`memory.search`, ...).
- Tenant state migration to SQLite (effectively irreversible): back up, rehearse on the test tenant, then roll out per tenant.
- Doctor merges `TOOLS.md` into `AGENTS.md`; repo conventions (codegen, sync-agent.sh, bootstrap copies) must adapt.
- Assist must read `agents.entries` (and still `agents.list`).
- 3 extension tests fail: 2 pre-existing/stale (tool count 6 vs 10, macOS /private/var), 1 needs the new shared-state test broker.

Notes and per-patch disposition: ~/Desktop/FlowOS/openclaw-patch-disposition-20261001/
To resume: `git switch experiment/sync-v2026.9.7`, `corepack pnpm@12.5.1 install`, `pnpm build` (Node 24).
