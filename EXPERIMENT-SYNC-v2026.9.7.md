# Experimental: sync of the floai fork onto upstream v2026.9.7 (2026-10-01..05)

**Status: shelved, NOT merged, not for prod.** Decision: stay on the 6/22 base (`floai`) for feature work; the FlowOS
backend is expected to change substantially, so a full upstream sync is not worth it now.

What this branch is: upstream `v2026.9.7` + the fork-only extensions (flowos-*, celia-canvas, qwen-audio-tts),
qwen realtime, and the small core patches that were ported (plugin tool ctx runId/trigger, subagent
runTimeoutSeconds/getRunStatus, device-bootstrap re-exports, celia-card-inject rewrite). FlowGo (Raspberry Pi) cluster
intentionally NOT ported (device retired). Verified on a local gateway: chat, realtime call (qwen), half-modal,
space/task; ESP32 onboarding was not tested.

Known work left if resumed: build/CI files (Dockerfile.floai, Node 24 + pnpm 12.5.1), prod config.baseline migration
(`openclaw doctor --fix` rewrites 9 keys), session SQLite migration of tenant state, TOOLS.md merged into AGENTS.md by
doctor, re-pointing launchd/Docker to Node >=24.16, flowos-task-center-auth integration test needs the new shared-state
test broker. Notes: see ~/Desktop/FlowOS/openclaw-patch-disposition-20261001/.

To resume: `git switch experiment/sync-v2026.9.7`, `corepack pnpm@12.5.1 install`, `pnpm build` (Node 24).
