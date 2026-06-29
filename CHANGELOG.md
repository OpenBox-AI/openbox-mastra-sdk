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

### Added (follow-up: no blind spot)

- Every HTTP call observed inside an agent run (any URL, any method, but not routed through a wrapped tool) now produces a per-call activity. The classifier is:
  - POST to a known LLM provider host (OpenAI / Anthropic / Google) → `activity_type: "llm_call"`
  - Anything else (CopilotKit telemetry, runtime infra POSTs, `GET /v1/models`, etc.) → `activity_type: "http_call"`
  
  Both shapes use the same 4-event group (creation + 2 hook_trigger updates + completion). Closes the previously-silent gap for non-LLM agent-context HTTP. Operators that want to suppress noise from specific hosts should pass them in the `ignoredUrls` config.

### Why

The suppression branch (introduced in commit `60e1765`, 2026-03-17) routed agent LLM HTTP hook spans into a `synthetic_model_usage_span` rollup on `WorkflowCompleted`. openbox-core's events-list endpoint never denormalized that rollup, so the LLM evidence was effectively invisible in the session UI. Mirroring the canonical Temporal/LangGraph emission pattern surfaces the same evidence as renderable per-call activity rows.
