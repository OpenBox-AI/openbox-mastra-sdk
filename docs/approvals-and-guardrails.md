# Approvals And Guardrails

This document explains how verdicts returned by OpenBox Core are enforced by the SDK.

## Verdicts

The SDK understands five primary verdicts:

| Verdict | Meaning | Runtime effect |
| --- | --- | --- |
| `allow` | continue normally | execution proceeds |
| `constrain` | advisory or constrained continuation | execution proceeds, constraints are available in the response |
| `require_approval` | human review required | execution suspends or polls for approval |
| `block` | operation must not continue | execution throws a stop error |
| `halt` | workflow or agent run must stop | execution throws a halt error |

Backward-compatible legacy action strings such as `continue`, `stop`, and `require-approval` are normalized into these verdicts.

## Boundary Event Enforcement

The SDK applies verdicts at boundary events.

For governed activities:

1. `ActivityStarted` is evaluated first
2. guardrails may redact or reject input
3. execution happens
4. `ActivityCompleted` is evaluated
5. guardrails may redact or reject output
6. approval may be required on either side

For workflows and agents:

- `WorkflowStarted` can stop execution early
- `WorkflowCompleted` can still be evaluated for policy and telemetry
- `WorkflowFailed` records failure context

## Guardrails

OpenBox responses may contain `guardrails_result`.

The SDK uses it in two ways:

### Input Redaction

If the response for `ActivityStarted` includes:

- `guardrails_result.input_type = "activity_input"`
- `guardrails_result.redacted_input`

the SDK applies that redacted input before calling the underlying tool or step.

### Output Redaction

If the response for `ActivityCompleted` includes:

- `guardrails_result.input_type = "activity_output"`
- `guardrails_result.redacted_input`

the SDK applies that redacted output before returning it to the caller.

### Validation Failure

If `guardrails_result.validation_passed` is `false`, the SDK throws `GuardrailsValidationError`.

The error message is derived from the guardrail reasons when available.

## Human Approval Flow

The approval path depends on where execution is happening.

## Workflow-Backed Activity Execution

When a tool or step executes inside a workflow context and OpenBox returns `require_approval`:

- the SDK creates an approval payload
- the workflow suspends through Mastra suspend/resume
- approval context is stored in the approval registry
- later resume paths emit a `SignalReceived` event and poll approval state

This is the preferred path for long-running human review.

## Non-Workflow Activity Execution

When there is no workflow suspend context available, the SDK polls approval inline.

Current inline polling characteristics:

- total timeout: 5 minutes
- initial poll interval: 2.5 seconds
- exponential backoff up to 15 seconds

If approval does not resolve in time, the SDK throws `ApprovalPendingError`.

## Approval Outcomes

While polling approval status:

- `allow` marks the activity approved and execution continues
- `block` or `halt` throws `ApprovalRejectedError`
- expired approval throws `ApprovalExpiredError`
- missing/temporary approval API failure retries with backoff until timeout

## Output-Time Approval

Approval is not limited to `ActivityStarted`.

If `ActivityCompleted` returns `require_approval`, the SDK can:

- suspend the workflow after execution and before returning output
- or poll inline when no workflow suspension context exists

This is useful when policy wants to review the actual output, not just the requested action.

## Agents And Approval

Wrapped agents also participate in approval polling through their workflow-like lifecycle.

Because agent runs emit signals such as `user_input`, `resume`, and `agent_output`, approval state can be resumed consistently across retries or resume calls.

## Error Types You Should Expect

These are the main runtime errors surfaced by approval and guardrail enforcement:

| Error | Meaning |
| --- | --- |
| `GovernanceHaltError` | OpenBox returned a stop verdict or fail-closed API failure was converted into a halt |
| `GuardrailsValidationError` | guardrails validation failed |
| `ApprovalPendingError` | approval is still pending or timed out in inline polling |
| `ApprovalRejectedError` | approval explicitly rejected the activity |
| `ApprovalExpiredError` | approval expired before resolution |

## Policy Design Recommendations

To keep approval flows clean:

1. require approval on business boundary events such as `ActivityStarted` and `ActivityCompleted`
2. avoid requiring approval on internal hook-triggered telemetry unless intentionally needed
3. use signal events for agent-specific review and monitoring

If policy requires approval on both:

- `writeFile` boundary events
- hook-triggered `http_request` or `db_query` telemetry

you can create duplicate approval requests for a single logical operation.

## Example Approval Payload Shape

When the SDK suspends a workflow for approval, it creates a payload similar to:

```json
{
  "openbox": {
    "activityId": "call_abc123",
    "activityType": "writeFile",
    "approvalId": "apr_123",
    "reason": "Human approval required",
    "requestedAt": "2026-03-17T12:00:00.000Z",
    "runId": "run-123",
    "workflowId": "agent:coding-agent",
    "workflowType": "coding-agent"
  }
}
```

## Operational Guidance

Recommended production behavior:

- model approval as a real operator workflow, not just a transient UI interaction
- do not suppress `resume` signals if you rely on approval traceability
- log and surface `ApprovalExpiredError` distinctly from normal business failures
