# Event Model

This SDK emits OpenBox governance events and hook-triggered telemetry payloads. Understanding the event model is important for:

- policy design
- UI expectations
- approval routing
- troubleshooting duplicate or missing events

## Core Governance Event Types

The SDK uses six top-level event types:

| Event type | Emitted by | Typical payload fields |
| --- | --- | --- |
| `WorkflowStarted` | wrapped workflows and agents | `workflow_id`, `workflow_type`, `run_id`, `task_queue` |
| `WorkflowCompleted` | wrapped workflows and agents | `workflow_output`, `model_id`, usage fields, optional `spans` |
| `WorkflowFailed` | wrapped workflows and agents | `error`, `workflow_id`, `run_id` |
| `SignalReceived` | workflow resumes and agent lifecycle signals | `signal_name`, `signal_args`, optional `spans` |
| `ActivityStarted` | wrapped tools and wrapped non-tool workflow steps | `activity_id`, `activity_type`, `activity_input` |
| `ActivityCompleted` | wrapped tools and wrapped non-tool workflow steps | `activity_id`, `activity_output`, timing fields, `error` when present |

All evaluate payloads are sent with:

- `source: "workflow-telemetry"`
- `timestamp`

## What Counts As An Activity

In this SDK, a business activity is:

- a wrapped Mastra tool execution
- a wrapped non-tool workflow step execution

What is not a business activity:

- internal HTTP hook telemetry
- internal DB query hook telemetry
- internal file operation hook telemetry
- internal traced function hook telemetry
- agent-only LLM completions

Those are operational spans, not standalone user-facing activities.

## Activity Type Normalization

The SDK normalizes activity type names to camelCase before sending them to OpenBox.

Examples:

| Original identifier | Emitted `activity_type` |
| --- | --- |
| `writeFile` | `writeFile` |
| `Write File` | `writeFile` |
| `Search crypto coins` | `searchCryptoCoins` |
| `search_crypto_coins` | `searchCryptoCoins` |

This matters for:

- `skipActivityTypes`
- policy matching in OpenBox
- UI filtering

## Workflow And Agent Identity

## Workflow Identity

Wrapped workflows use:

- `workflow_id = workflow.id`
- `workflow_type = workflow.id`

## Agent Identity

Wrapped agents use:

- `workflow_type = agent.id ?? agent.name ?? "agent"`
- `workflow_id = "agent:" + workflow_type`

This is why agent runs appear as workflow-like entities in OpenBox.

## Signals

Signals are used for resume events and agent lifecycle events.

### Workflow Signals

`wrapWorkflow()` emits `SignalReceived` when a workflow resumes.

Fields include:

- `signal_name`
- `signal_args`
- `run_id`
- `workflow_id`
- `workflow_type`

If the resume payload includes `label`, that label becomes the signal name. Otherwise the default is `resume`.

### Agent Signals

`wrapAgent()` emits these signals:

| Signal name | When emitted | Purpose |
| --- | --- | --- |
| `user_input` | `generate()` or `stream()` start | carries the initiating prompt/input |
| `resume` | `resumeGenerate()` or `resumeStream()` | carries resume payload |
| `agent_output` | successful completion or failure finalization | carries agent output and agent LLM spans |

## Goal Propagation

When available, the SDK includes `goal` on agent-related payloads.

Goal resolution order:

1. `OPENBOX_AGENT_GOAL`
2. goal previously associated with the current run
3. latest user prompt from the interaction payload
4. agent instructions

This is the primary path by which goal alignment and drift analysis receives goal context from agent runs.

## Hook-Triggered Telemetry

Operational telemetry is sent through hook-triggered governance payloads.

Characteristics:

- `hook_trigger: true`
- `spans` contains normalized OpenBox span objects
- a single hook event carries a single started or completed span phase
- the span remains associated with its parent activity or workflow context

Supported hook span families:

- `http_request`
- `db_query`
- `file_operation`
- `function_call`

## Started And Completed Hook Spans

The SDK emits separate hook span phases:

- a `started` span phase
- a `completed` span phase

The important distinction is:

- these are operational spans, not standalone business activities
- they should be interpreted by policy as internal telemetry unless you intentionally want policy to act on them

## Agent LLM Span Semantics

Agent-only LLM calls do not create standalone `agentLlmCompletion` business activities.

Current behavior:

- started and completed LLM-related spans are routed into the agent telemetry path
- they are surfaced on `SignalReceived` with `signal_name: "agent_output"`
- they can also influence `WorkflowCompleted` telemetry payloads

This keeps the activity list focused on actual business operations while preserving LLM observability.

## Tool And Step Event Sequence

Typical governed activity sequence:

```text
ActivityStarted
→ zero or more hook-triggered span payloads during execution
→ ActivityCompleted
```

Boundary events represent business lifecycle. Hook-triggered payloads represent internal operations that happened during that lifecycle.

## Agent Event Sequence

Typical agent run sequence:

```text
WorkflowStarted
→ SignalReceived(user_input)
→ internal LLM / HTTP hook spans
→ SignalReceived(agent_output) with spans
→ WorkflowCompleted
```

Resume-capable agent runs may also include:

```text
SignalReceived(resume)
```

## Simplified Examples

### Activity Boundary Event

```json
{
  "source": "workflow-telemetry",
  "event_type": "ActivityStarted",
  "workflow_id": "agent:coding-agent",
  "workflow_type": "coding-agent",
  "run_id": "run-123",
  "activity_id": "call_abc123",
  "activity_type": "writeFile",
  "activity_input": {
    "path": "hello_world.txt"
  },
  "timestamp": "2026-03-17T12:00:00.000Z"
}
```

### Hook-Triggered Span Payload

```json
{
  "source": "workflow-telemetry",
  "event_type": "ActivityStarted",
  "workflow_id": "agent:coding-agent",
  "workflow_type": "coding-agent",
  "run_id": "run-123",
  "activity_id": "call_abc123",
  "activity_type": "http_request",
  "hook_trigger": true,
  "span_count": 1,
  "spans": [
    {
      "hook_type": "http_request",
      "stage": "started",
      "http_method": "POST",
      "http_url": "https://api.example.com/v1/run"
    }
  ],
  "timestamp": "2026-03-17T12:00:01.000Z"
}
```

### Agent Output Signal With LLM Spans

```json
{
  "source": "workflow-telemetry",
  "event_type": "SignalReceived",
  "workflow_id": "agent:ops-summary-agent",
  "workflow_type": "ops-summary-agent",
  "run_id": "run-123",
  "signal_name": "agent_output",
  "signal_args": [
    {
      "text": "ok"
    }
  ],
  "span_count": 2,
  "spans": [
    {
      "hook_type": "http_request",
      "stage": "started"
    },
    {
      "hook_type": "http_request",
      "stage": "completed"
    }
  ]
}
```

## Policy Guidance

Recommended policy stance:

- treat boundary workflow/activity events as governable business actions
- treat hook-triggered span payloads as internal telemetry unless you have a strong reason to gate them directly

If hook-triggered payloads are treated as separate governable actions, you can create:

- duplicate approvals
- approval loops
- noisy activity listings
- harder-to-read operator timelines
