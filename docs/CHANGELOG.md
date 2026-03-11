# Changelog

## Unreleased

- Added evaluate retry/backoff controls in `OpenBoxClient` with transient error classification.
- Added payload-budget controls (`maxEvaluatePayloadBytes`) for governance evaluate dispatch.
- Normalized emitted `activity_type` values to camelCase across wrapped tools/workflow steps.
- Added agent input signal emission (`SignalReceived` with `signal_name: user_input`) for `generate()` and `stream()` runs.
- Added tiered `WorkflowCompleted` fallback payload strategy:
  - full telemetry
  - compact payload
  - ultra-minimal payload
- Added run-scoped span buffer isolation for concurrent runs sharing a workflow id.
- Added hook-level governance evaluate dispatch for HTTP/DB/file operations with `hook_trigger` payloads.
- Added `traced()` async helper for function-level hook governance (`function_call` started/completed).
- Added span processor activity-context/abort/halt/governed-span tracking APIs for hook orchestration.
- Updated activity boundary completion payloads to send `span_count: 0` and `spans: []`.
- Expanded unit, contract, and integration coverage for retries, fallback tiers, payload budgeting, and concurrency isolation.

## 0.1.0

- Added the initial ESM TypeScript SDK scaffold for Mastra.
- Added parity-locked verdict types, typed errors, config parsing, and OpenBox Core client support.
- Added privacy-aware OpenTelemetry setup and span buffering.
- Added governed wrappers for Mastra tools, workflows, and agents, including suspend/resume approval handling.
- Added `withOpenBox()` zero-code runtime wiring and `getOpenBoxRuntime()` shutdown access.
- Added a self-contained quickstart example and golden fixtures for governance events, approvals, and guardrails.
