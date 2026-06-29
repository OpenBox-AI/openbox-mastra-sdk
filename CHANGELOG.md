# Changelog

## 0.3.0

### Breaking

- `WorkflowCompleted` no longer carries `synthetic_model_usage_span`, `workflow_model_id`, or `workflow_model_provider`. Top-level `model_id`, `model`, `model_provider`, `provider`, and token-usage fields are unchanged. Operators that read LLM evidence from the workflow rollup must read it from the new per-call `ActivityStarted{activity_type: "llm_call"}` events instead.
- `OpenBoxSpanProcessor.appendAgentSignalHookSpan` and `OpenBoxSpanProcessor.consumeAgentSignalHookSpans` are removed. These were internal helpers used to queue suppressed agent LLM hook spans onto the `agent_output` signal; they are no longer needed and have no external consumers.

### Added

- Per-LLM-HTTP-call governance emission. Each LLM HTTP call observed inside an agent context (source=agent, POST method, host matched by `inferProviderFromUrl`) now produces four events that mirror the existing tool-path wire shape openbox-core renders:
  - One creation `ActivityStarted` with `activity_type: "llm_call"`, a fresh UUID `activity_id`, and `span_count: 0`
  - One `ActivityStarted{hook_trigger: true, hook_stage: "started"}` attaching the started HTTP hook span
  - One `ActivityStarted{hook_trigger: true, hook_stage: "completed"}` attaching the completed HTTP hook span (with response body, status, server-computed `semantic_type: "llm_completion"`)
  - One `ActivityCompleted` with `activity_id: "<uuid>-c"` and a serialized model response on `activity_output`
  
  openbox-core aggregates the two hook spans onto the creation event, so events-list returns `span_count: 2` with both spans inline on the `llm_call` ActivityStarted row. Verified against a live `mastra-weather-agent` session.

### Removed

- `syntheticAgentActivity` short-circuit in `evaluateHookGovernance` and the matching synthetic agent-context branch in `resolveActivityContext`. Agent-context LLM calls are no longer suppressed and re-attached to the `agent_output` signal.
- `buildWorkflowTelemetrySpans`, `createSyntheticModelUsageSpan`, `hasParseableModelUsageSpan`, `resolveProviderUrl`, `resolveSyntheticModelId`, `getTraceIdCandidate`, and `isLlmProviderUrl` helpers in `wrap-agent.ts`.

### Fixed

- `ActivityCompleted` events emitted by `wrap-tool` now always carry `activity_type`. Previously stripped when `hitlEnabled` was true (the default), which caused the openbox-core UI to render completion rows with no name.

### Added (follow-up: agent-context HTTP coverage)

- Generalises the per-call HTTP emission so every agent-context HTTP call (not just LLM POSTs) becomes a renderable activity row. The classifier is:
  - POST to a known LLM provider host (OpenAI / Anthropic / Google) → `activity_type: "llm_call"`
  - Any other HTTP made inside an agent run (e.g. `GET /v1/models`, custom HTTP from agent code that bypasses a wrapped tool) → `activity_type: "http_call"`

  Both shapes use the same 4-event group (creation + 2 hook_trigger updates + completion). Scope is deliberately narrow:
  - Tool-context HTTP (inside a wrapped tool's `executeGovernedActivity`) keeps the existing inline hook-update pattern attached to the tool activity.
  - HTTP that fires outside any OpenBox execution context (server middleware running between requests, infra POSTs at startup) is left silent — the SDK does not synthesise workflow attribution for calls that did not originate from an agent. Operators that want those captured should wrap their middleware with `runWithOpenBoxExecutionContext` or rely on the existing `ignoredUrls` config to manage noise.

### Why

The suppression branch (introduced in commit `60e1765`, 2026-03-17) routed agent LLM HTTP hook spans into a `synthetic_model_usage_span` rollup on `WorkflowCompleted`. openbox-core's events-list endpoint never denormalized that rollup, so the LLM evidence was effectively invisible in the session UI. Mirroring the canonical Temporal/LangGraph emission pattern surfaces the same evidence as renderable per-call activity rows.
