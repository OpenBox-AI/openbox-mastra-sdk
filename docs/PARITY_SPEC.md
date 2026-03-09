# OpenBox Mastra SDK Parity Spec

## Purpose and Scope

This document is the definition of done for `@openbox-ai/openbox-mastra-sdk`.
The TypeScript SDK must provide production-grade OpenBox governance, approvals, guardrails, and observability for Mastra with full functional parity to the OpenBox governance contract.
No required behavior in this contract may be omitted, weakened, or approximated.

This spec is intentionally implementation-driving:

- This contract is the source of truth.
- Mastra integration must use real Mastra APIs, not inferred abstractions.
- Each requirement below must be covered by automated tests before the ticket is considered complete.

## Compatibility Targets

- OpenBox Core endpoint contract reviewed for auth, governance evaluation, and approvals.
- Existing OpenBox governance semantics reviewed for verdicts, guardrails, and approval lifecycle behavior.
- Mastra runtime target: `@mastra/core@1.8.0`
- Mastra docs checked for workflow suspend/resume semantics: `https://mastra.ai/docs/workflows/suspending-and-resuming`
- Node runtime target: `24.10.0`

## Public API

The SDK must export both zero-code and manual wiring APIs.

### Zero-code API

- `withOpenBox(mastraInstanceOrApp, options)`
- `getOpenBoxRuntime(mastraInstanceOrApp)`
- Result must be a governed Mastra instance or wrapper with OpenBox hooks installed for:
  - tools
  - agents
  - workflows
  - workflow suspend/resume
  - OpenTelemetry setup
- Supported zero-code targets are:
  - `Mastra` instances
  - app-like wrappers shaped as `{ mastra: Mastra }`

### Manual API

- `initializeOpenBox(config)`
- `OpenBoxClient`
- `OpenBoxSpanProcessor`
- `setupOpenBoxOpenTelemetry(options)`
- `wrapTool(tool, options)`
- `wrapAgent(agent, options)`
- `wrapWorkflow(workflow, options)`
- typed errors
- core types and enums

### Export Stability

- ESM-only package output
- top-level exports plus documented subpath exports
- generated `.d.ts` for all public APIs
- no undocumented default export

## Config and Environment

The TypeScript SDK must support explicit configuration and environment-based configuration with canonical OpenBox semantics plus Node/Mastra-specific toggles.

### Required config

- `openboxUrl` / `OPENBOX_URL`
- `openboxApiKey` / `OPENBOX_API_KEY`

### Core config

- `governanceTimeout` / env equivalent
- `evaluateMaxRetries` / `OPENBOX_EVALUATE_MAX_RETRIES`
- `evaluateRetryBaseDelayMs` / `OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS`
- `maxEvaluatePayloadBytes` / `OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES`
- `governancePolicy` with values:
  - `fail_open`
  - `fail_closed`
- `sendStartEvent`
- `sendActivityStartEvent`
- `skipWorkflowTypes`
- `skipActivityTypes`
- `skipSignals`
- `hitlEnabled`
- `instrumentDatabases`
- `instrumentFileIo`
- HTTP body/header capture toggle
- HTTP capture size limits
- optional DB library allowlist
- optional file path deny/allow filters

### Validation rules

- API key format must match the OpenBox key pattern: `^obx_(live|test)_[a-zA-Z0-9_]+$`
- non-localhost HTTP URLs must be rejected
- `http://localhost`, `http://127.0.0.1`, and `http://::1` must be allowed
- timeout values must be validated
- invalid config must throw typed config errors

### Initialization behavior

- initialization must optionally validate API key against OpenBox Core
- successful initialization must persist normalized config for later wiring
- API URL must be normalized without trailing slash
- secrets must be masked in string representations and logs

## OpenBox Core API Contract

The client layer must implement the OpenBox Core endpoint contract.

### Endpoints

- `GET /api/v1/auth/validate`
- `POST /api/v1/governance/evaluate`
- `POST /api/v1/governance/approval`

### Request headers

- `Authorization: Bearer <apiKey>`
- `Content-Type: application/json` where JSON body is sent
- `User-Agent: OpenBox-SDK/1.0` parity header

### Client semantics

- auth validation:
  - `200` means valid
  - `401` and `403` raise auth error
  - other HTTP errors raise network/API errors
- evaluate:
  - parse both `verdict` and legacy `action`
  - return normalized verdict response
  - preserve compatibility metadata fields
  - retry transient failures with bounded backoff when configured
  - transient failures include `429`, `5xx`, timeout signatures, and context-deadline signatures
- approval poll:
  - request body must contain `workflow_id`, `run_id`, `activity_id` or Mastra-equivalent identifiers
  - if `approval_expiration_time` is present and in the past, mark result as expired
  - timestamp parsing must accept:
    - ISO with `Z`
    - ISO with offset
    - space-separated datetime
  - naive timestamps are treated as UTC

### Failure policy

- when OpenBox is unavailable:
  - `fail_open` allows execution to continue
  - `fail_closed` produces blocking/halt behavior
- `WorkflowCompleted` evaluate must support tiered fallback payloads:
  - full telemetry payload
  - compact payload
  - ultra-minimal payload
- payload preflight must enforce `maxEvaluatePayloadBytes` before dispatch
- error classification must distinguish:
  - config errors
  - auth errors
  - insecure URL errors
  - network errors
  - API response errors

### Assumption locked by this spec

The TypeScript SDK centralizes the HTTP contract in `OpenBoxClient` without changing runtime semantics.

Mastra agent executions do not expose engine-level workflow IDs.
For parity event emission and trace/session correlation, the SDK treats an agent execution as a pseudo-workflow with:

- `workflow_id = agent:<agentId>`
- `workflow_type = <agentId>`
- `run_id = Mastra agent runId`

## Verdict Semantics

The SDK must support the five-tier OpenBox response model.

### Canonical verdicts

- `ALLOW`
- `CONSTRAIN`
- `REQUIRE_APPROVAL`
- `BLOCK`
- `HALT`

### Legacy/back-compat parsing

- `continue` -> `ALLOW`
- `stop` -> `HALT`
- `require-approval` -> `REQUIRE_APPROVAL`
- `request-approval` -> `REQUIRE_APPROVAL`
- `request_approval` -> `REQUIRE_APPROVAL`
- invalid or missing values -> `ALLOW`

### Priority ordering

- `HALT = 5`
- `BLOCK = 4`
- `REQUIRE_APPROVAL = 3`
- `CONSTRAIN = 2`
- `ALLOW = 1`

### Derived behavior

- `shouldStop()` is true for `BLOCK` and `HALT`
- `requiresApproval()` is true only for `REQUIRE_APPROVAL`
- `highestPriority([])` returns `ALLOW`
- response `.action` compatibility mapping must match the OpenBox compatibility contract:
  - `ALLOW -> continue`
  - `HALT -> stop`
  - `REQUIRE_APPROVAL -> require-approval`
  - others return canonical string value

## Event Model

The SDK must emit canonical workflow-boundary governance events, adapted to Mastra execution.

### Required event types

- `WorkflowStarted`
- `WorkflowCompleted`
- `WorkflowFailed`
- `SignalReceived`
- `ActivityStarted`
- `ActivityCompleted`

### Mastra equivalents

- workflow start -> `WorkflowStarted`
- workflow success -> `WorkflowCompleted`
- workflow failure -> `WorkflowFailed`
- workflow resume after suspension -> `SignalReceived`
- tool or workflow step start -> `ActivityStarted`
- tool or workflow step completion/failure -> `ActivityCompleted`

### Resume mapping locked by this spec

- workflow `resume()` and `resumeStream()` emit `SignalReceived`
- agent `resumeGenerate()` and `resumeStream()` emit `SignalReceived`
- default Mastra resume signal name is `resume`
- when a workflow resume label is present, it becomes `signal_name`

### Required payload fields

- `source`
- `event_type`
- workflow/run identifiers
- workflow type/name
- step or tool identifiers for activity events
- attempt count where available
- timestamps in RFC3339 UTC form
- status/error payloads for completed and failed events
- span count and buffered spans where available
- input and output payloads after guardrail redaction is applied
- correlation identifiers needed to join governance events to traces

### Ordering and determinism

- start event must precede complete/fail events for the same unit of work
- activity start must precede activity complete
- resume event must be emitted before resumed execution continues
- ordering must be deterministic within a run/session buffer

## Filtering and Toggles

The SDK must implement canonical event suppression behavior.

### Skip lists

- `skip_workflow_types`
- `skip_activity_types`
- `skip_signals`
- default `skip_activity_types` must include the SDK’s own governance transport activity equivalent
- default HITL skip list must include the SDK’s own governance transport activity equivalent

### Send toggles

- `sendStartEvent`
- `sendActivityStartEvent`

### Expected behavior

- skipped items must bypass governance network calls for the skipped event only
- observability state must remain internally consistent even when specific events are skipped

## Guardrails

The SDK must support the same guardrail response model returned by OpenBox Core.

### Supported guardrail fields

- `redacted_input`
- `input_type`
- `raw_logs`
- `validation_passed`
- `reasons`

### Input redaction semantics

- `activity_input` in activity events must be serialized as an argument list
- when `input_type === "activity_input"` the redacted payload replaces the original tool/step/agent input used downstream
- list-vs-dict handling must preserve canonical guardrail behavior:
  - single dict redactions may be normalized to list form when matching original arg layout
- structured inputs must be updated without losing runtime shape when possible

### Output redaction semantics

- when `input_type === "activity_output"` the redacted payload replaces downstream return data

### Validation semantics

- when `validation_passed === false`, execution must halt/block with typed error semantics
- reason strings must be joined deterministically for error text

### Global redaction hook

- SDK must provide a documented global redaction hook
- hook must run before data is stored or emitted anywhere outside process memory

## Telemetry Capture

The SDK must provide canonical telemetry buffering with stronger Node integration.

### Required behavior

- set up OpenTelemetry Node SDK
- buffer spans per workflow/session/run
- correlate `trace_id` and `span_id` with workflow/tool/step identifiers
- store request/response bodies and headers separately from span attributes
- attach buffered telemetry to governance event payloads

### Privacy posture

- bodies and headers must not be stored in OTel span attributes by default
- private content may be retained in the SDK’s side-channel privacy store for governance submission
- SDK logs must never print secrets or raw sensitive bodies unless explicitly redacted and allowed

### Instrumentation toggles

- HTTP capture
- DB instrumentation toggle
- File I/O instrumentation toggle
- file instrumentation must be opt-in
- system paths must be skipped for file capture
- OpenBox Core outbound calls must be ignored to avoid self-capture loops

## Mastra Hooking

The SDK must integrate with real Mastra primitives rather than emulated external orchestration concepts.

### Tools

- wrap `Tool` / `createTool` execution
- emit activity events around execution
- apply pre-execution guardrails and verdict handling
- apply post-execution guardrails and verdict handling
- preserve tool input/output typing

### Workflows

- wrap workflow start/finish/error
- wrap workflow step execution
- map Mastra suspension/resume to OpenBox approval and signal semantics
- preserve workflow typing and storage interaction

### HITL via suspend/resume

- `REQUIRE_APPROVAL` must suspend durably using Mastra’s suspend/resume APIs
- approval context must include approval ID and correlation metadata
- on resume, SDK must poll the OpenBox approval endpoint
- outcomes must match canonical OpenBox semantics:
  - approved -> continue
  - rejected -> terminate with typed rejection error
  - expired -> terminate with typed expiration error
  - still pending / poll failure -> remain pending or retry according to configured behavior

### Agents

- wrap `generate()`
- wrap `stream()`
- ensure tool calls invoked inside agent loops flow through governed wrappers
- emit equivalent activity and workflow-boundary events for agent execution sessions

## Reliability and Safety

- support concurrent workflows, tools, and agent runs without cross-session leakage
- maintain run-scoped span buffering for concurrent runs sharing the same workflow id
- maintain deterministic event ordering per session
- do not leak API keys or secret headers
- do not capture OpenBox transport traffic into governance payloads
- provide typed, actionable errors
- preserve original errors as causes where appropriate
- normalize failure behavior for fail-open and fail-closed policies

## Packaging

- strict TypeScript configuration
- Vitest test suite
- MSW-based HTTP mocking
- tsup ESM build with declarations
- ESLint and Prettier
- GitHub Actions CI running lint, typecheck, test, build
- publishable npm metadata and exports map
- docs:
  - `README.md`
  - `docs/ADVANCED.md`
  - `docs/SECURITY.md`
  - `docs/CHANGELOG.md`
- example app:
  - `examples/quickstart`
  - must exercise workflow suspend/resume plus tool and agent execution in one flow

## Test Matrix

Every item below requires automated coverage.

### 1. Unit tests

- verdict enum values, mappings, priorities, helpers
- workflow event enum values
- governance response parsing from `verdict` and legacy `action`
- guardrails result parsing and reason extraction
- typed error inheritance and messages
- config validation:
  - API key format
  - HTTPS enforcement
  - config defaults
  - config mutability rules
- span buffer registration, correlation, buffering, flushing
- privacy store behavior and redaction boundaries

### 2. Contract tests

- auth validate request method, path, headers, success handling
- auth invalid-key handling for `401` and `403`
- evaluate request payload/header contract
- approval poll payload contract
- timeout behavior
- evaluate transient retry/backoff behavior
- fail-open handling on network failure
- fail-closed handling on network failure
- approval expiration timestamp parsing formats

### 3. Integration tests

- governed tool execution:
  - allow
  - constrain
  - block
  - halt
  - require approval
- workflow lifecycle events
- workflow step activity events
- resume/suspend mapped to `SignalReceived`
- agent `generate()`
- agent `stream()`
- agent tool invocation inside loop
- workflow-completed fallback chain:
  - blob-size failure -> compact payload
  - compact timeout/failure -> ultra-minimal payload
- payload-budget preflight skips oversized tiers
- concurrent runs do not leak spans across run ids
- quickstart example smoke run

### 4. Privacy tests

- HTTP bodies and headers not present in span attributes by default
- HTTP bodies and headers present in governance payload side-channel when capture is enabled
- OpenBox API key never appears in logs, event fixtures, or span attributes
- file capture excludes configured system paths

### 5. Golden fixtures

- event payload fixtures under `test/fixtures/events`
- approval response fixtures under `test/fixtures/approvals`
- guardrail fixtures under `test/fixtures/guardrails`
- fixtures must be publish-reviewable and free of secrets