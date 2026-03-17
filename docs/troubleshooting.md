# Troubleshooting

This document covers the most common integration and policy issues seen with the Mastra SDK.

## Startup Fails With Configuration Error

Symptoms:

- `OpenBoxConfigError`
- `OpenBoxAuthError`
- `OpenBoxInsecureURLError`

Checks:

1. verify `OPENBOX_URL` is set
2. verify `OPENBOX_API_KEY` is set
3. verify the API key matches `obx_live_*` or `obx_test_*`
4. verify non-localhost URLs use HTTPS
5. if using a mock server, set `validate: false`

## No Events Show Up In OpenBox

Checks:

1. confirm your process is using the governed Mastra instance returned by `withOpenBox()`
2. confirm the first operation is actually wrapped
3. enable `OPENBOX_DEBUG=true`
4. confirm your OpenBox API URL is reachable from the runtime
5. confirm your local consuming app is loading the rebuilt SDK output if you are using the repo by path

If you are consuming this repo locally:

```bash
npm run build
```

Then restart the consuming application.

## Duplicate Approval Requests

Most common cause:

- policy is treating hook-triggered internal telemetry as a governable activity in addition to the real boundary activity

What to check:

- payloads with `hook_trigger: true`
- hook span content under `spans`
- `activity_type` values such as `http_request`, `db_query`, `file_operation`, or `function_call`

Recommended fix:

- only require approval on real workflow or activity boundary events
- exclude internal hook-triggered telemetry from approval policy

## `http_request` Shows Up As A Separate Activity Row

This usually indicates policy or UI interpretation is treating hook-triggered telemetry like a business activity.

Operationally:

- hook payloads are internal telemetry
- tools and workflow steps are the business activities

Recommended policy behavior:

- govern the parent activity
- treat hook-triggered payloads as internal telemetry

## Agent LLM Spans Are Missing

Checks:

1. make sure `skipSignals` does not include `agent_output`
2. confirm the agent is wrapped with `withOpenBox()` or `wrapAgent()`
3. enable `OPENBOX_DEBUG=true` and verify `SignalReceived` with `signal_name: "agent_output"`
4. if consuming the SDK locally, rebuild `dist/` and restart the app

Important behavior:

- agent-only LLM completions are emitted as spans on `agent_output`
- they are not intended to appear as standalone `agentLlmCompletion` business activities

## Started Or Completed Spans Are Missing

Checks:

1. confirm telemetry is installed only once and not being replaced unintentionally
2. confirm the relevant instrumentation is enabled
3. confirm the operation is not excluded by ignored URLs or file skip patterns
4. confirm your OpenBox UI is looking at the correct parent activity or signal

For agent LLM activity:

- inspect `SignalReceived(agent_output)`

For tools and steps:

- inspect the parent governed activity plus associated hook-triggered span payloads

## OpenBox API Failures Cause Unexpected Continuation Or Stoppage

Check `onApiError` / `OPENBOX_GOVERNANCE_POLICY`.

Expected behavior:

- `fail_open`: execution usually continues
- `fail_closed`: execution halts on OpenBox API failure

If the runtime is behaving differently than expected, verify that:

- the value is actually what you think at startup
- you are not mixing explicit code config with environment variables

## Approval Never Resolves

Checks:

1. verify OpenBox approval responses eventually return `allow`, `block`, or `halt`
2. verify the approval request keys match:
   - `workflow_id`
   - `run_id`
   - `activity_id`
3. verify you are resuming the correct workflow step or agent run
4. check whether approval expired before response

For non-workflow inline approval paths, remember:

- the SDK polls with bounded backoff
- if approval does not resolve in time, `ApprovalPendingError` is raised

## Guardrails Are Not Redacting Input Or Output

Checks:

1. verify OpenBox is returning `guardrails_result`
2. verify `guardrails_result.validation_passed` and `redacted_input`
3. verify `guardrails_result.input_type` is one of:
   - `activity_input`
   - `activity_output`

The SDK only applies redaction when those fields are present in the verdict response.

## Local Code Changes Are Not Reflected In My App

If you are consuming this repo locally, source changes are not enough. The consuming app needs the rebuilt package output.

Run:

```bash
npm run build
```

Then restart the consuming process.

If the consuming app uses a copied tarball or cached install, refresh that dependency path too.

## I Initialized Telemetry Twice

Symptoms:

- spans disappear unexpectedly
- instrumentation behaves inconsistently
- earlier runtime appears to stop capturing

Reason:

- `setupOpenBoxOpenTelemetry()` owns one active controller at a time
- a new initialization tears down the previous active telemetry controller

Fix:

- initialize telemetry once during process bootstrap
- share the resulting runtime across all wrappers in that process

## Useful Debug Mode

Set:

```bash
export OPENBOX_DEBUG=true
```

This enables summarized logs for:

- evaluate requests
- evaluate retries
- approval polling
- response summaries including age/goal-alignment metadata when present
