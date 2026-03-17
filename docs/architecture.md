# Architecture

This document describes how the SDK is structured internally so that production integrations can reason about behavior, ownership, and operational tradeoffs.

## High-Level Architecture

```text
Mastra Application
├─ Tools
├─ Workflows
└─ Agents
        │
        ▼
OpenBox Mastra SDK
├─ Mastra wrappers
│  ├─ wrapTool()
│  ├─ wrapWorkflow()
│  ├─ wrapAgent()
│  └─ withOpenBox()
├─ Governance runtime
│  ├─ OpenBoxClient
│  ├─ config parsing
│  └─ approval registry
├─ Telemetry runtime
│  ├─ OpenBoxSpanProcessor
│  ├─ OpenTelemetry instrumentation
│  └─ hook-governance bridge
└─ Type surface
   ├─ verdicts
   ├─ guardrails
   ├─ event types
   └─ errors
        │
        ▼
OpenBox Core API
├─ /api/v1/auth/validate
├─ /api/v1/governance/evaluate
└─ /api/v1/governance/approval
```

## Main Components

## `withOpenBox()`

Responsibilities:

- create runtime objects
- install process-wide telemetry
- patch current and future Mastra registries
- expose the runtime for shutdown and diagnostics

Why it exists:

- most applications want one OpenBox runtime per Mastra process
- startup should be deterministic and centralized
- patching future registrations prevents drift after bootstrap

## `OpenBoxClient`

Responsibilities:

- validate API key
- send governance evaluate payloads
- poll approval status
- apply retry and timeout policy
- normalize evaluate payloads before sending

Notable behavior:

- evaluate retries are bounded and exponential
- debug logs are summarized, not full raw payload dumps
- `fail_open` returns `null` on API failure instead of throwing

## `OpenBoxSpanProcessor`

Responsibilities:

- buffer spans per workflow and run
- associate traces with workflow and activity context
- hold captured bodies and headers until governance payload assembly
- maintain hook-related runtime state used by approvals and agent signals

Why buffering exists:

- OpenBox governance payloads need enriched spans, not raw exported OTel spans
- HTTP bodies and headers should not live on ordinary OTel span attributes
- parent activity context must be recoverable when child spans complete later

## Telemetry Setup

`setupOpenBoxOpenTelemetry()` installs:

- HTTP instrumentation
- optional database instrumentation
- optional file I/O instrumentation
- fetch patching for request/response body capture
- hook-governance evaluation when a governance client is supplied

Operational constraint:

- the SDK maintains one active telemetry controller per process
- re-running telemetry setup tears down the previously active one

## Mastra Wrapper Layer

## Tool Wrapper

`wrapTool()` routes a tool through `executeGovernedActivity()`.

That path:

1. resolves activity identity and workflow context
2. emits `ActivityStarted` if enabled
3. applies guardrail redaction or validation
4. executes the underlying tool in a traced activity span
5. collects child telemetry
6. emits `ActivityCompleted`
7. enforces verdicts and approval flow

## Workflow Wrapper

`wrapWorkflow()` governs:

- workflow lifecycle
- workflow resumes
- non-tool steps

Workflow wrapper responsibilities:

- emit `WorkflowStarted`, `WorkflowCompleted`, `WorkflowFailed`
- emit `SignalReceived` on resume
- wrap step execution through `executeGovernedActivity()`

Tool component steps are intentionally not double-wrapped.

## Agent Wrapper

`wrapAgent()` models an agent run as a workflow-like entity.

Responsibilities:

- emit workflow lifecycle events for the agent run
- emit `user_input`, `resume`, and `agent_output` signals
- infer and propagate agent `goal`
- route agent-only LLM spans into the `agent_output` signal instead of fabricating a separate business activity
- compact large `WorkflowCompleted` payloads to respect payload budgets

## Approval Registry

Approval state is maintained separately from OpenBox Core responses so the SDK can:

- suspend and resume workflows correctly
- avoid duplicate approval loops for nested hook telemetry
- remember activity approval state across retries or resumes

This registry is part of runtime control flow, not a persistence layer.

## Event Flow

## Tool Or Step Flow

```text
wrapped activity starts
→ ActivityStarted evaluate
→ possible guardrails or approval requirement
→ underlying execution runs
→ HTTP/DB/file/function spans are captured
→ ActivityCompleted evaluate
→ possible output redaction or approval requirement
→ return or suspend
```

## Workflow Flow

```text
workflow start
→ WorkflowStarted
→ governed steps execute
→ optional SignalReceived on resume
→ WorkflowCompleted or WorkflowFailed
```

## Agent Flow

```text
agent generate/stream starts
→ WorkflowStarted
→ SignalReceived(user_input)
→ underlying agent execution
→ LLM and hook spans buffered
→ SignalReceived(agent_output) with spans
→ WorkflowCompleted or WorkflowFailed
```

## Hook Telemetry Flow

Operational spans such as HTTP or DB work use a hook-governance path:

1. the span is converted into a normalized OpenBox span payload
2. the SDK attaches it to the current parent workflow/activity context
3. the payload is marked with `hook_trigger: true`
4. the span is sent as a governance event or queued for agent-output signal emission

For agent-only LLM activity without a real business activity parent:

- the SDK queues the spans
- `agent_output` emits them later
- this avoids synthetic `agentLlmCompletion` business activity rows

## Data Ownership Boundaries

| Data | Owned by |
| --- | --- |
| runtime config | `OpenBoxConfig` |
| API transport | `OpenBoxClient` |
| span buffering | `OpenBoxSpanProcessor` |
| Mastra lifecycle interception | wrapper layer |
| approval state | approval registry |
| final policy decisions | OpenBox Core |

## Failure Handling Model

The SDK distinguishes between:

- OpenBox API failure
- governance stop verdict
- approval pending / rejected / expired
- guardrails validation failure
- underlying tool/workflow/agent error

These are surfaced as distinct runtime errors so application code can reason about them intentionally. See [approvals-and-guardrails.md](./approvals-and-guardrails.md) and [api-reference.md](./api-reference.md).
