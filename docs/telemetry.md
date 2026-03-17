# Telemetry

This SDK uses OpenTelemetry internally, but it does not simply forward raw OTel spans to OpenBox. It captures, buffers, enriches, and normalizes spans into governance-ready payloads.

## What Gets Captured

## HTTP

Enabled by default through `httpCapture: true`.

The SDK installs:

- Node HTTP instrumentation
- Undici instrumentation
- fetch patching for request/response body capture

In practice this covers:

- `fetch`
- Node `http` and `https`
- Undici-based clients

Captured fields can include:

- method
- URL
- request headers
- response headers
- request body
- response body
- status code

Text-like content types are eligible for body capture. Binary payloads are not captured as text bodies.

## Databases

Enabled by default through `instrumentDatabases: true`.

Supported database library selectors:

- `pg`
- `postgres`
- `mysql`
- `mysql2`
- `mongodb`
- `mongoose`
- `redis`
- `ioredis`
- `knex`
- `oracledb`
- `cassandra`
- `tedious`

If `dbLibraries` is omitted, the SDK enables all supported database instrumentations it can resolve.

## File I/O

Disabled by default through `instrumentFileIo: false`.

When enabled, the SDK can emit spans for file operations such as:

- open
- read
- write
- readline
- readlines
- writelines
- close

Default skip patterns include:

- `/dev/`
- `/proc/`
- `/sys/`
- `\\?\pipe\`
- `__pycache__`
- `.pyc`
- `.pyo`
- `.so`
- `.dylib`

Override with `fileSkipPatterns` when using manual telemetry setup.

## Traced Functions

You can create explicit function spans with `traced()`:

```ts
import { traced } from "@openbox-ai/openbox-mastra-sdk";

const summarize = traced(
  async function summarize(text: string) {
    return text.slice(0, 120);
  },
  {
    captureArgs: true,
    captureResult: true,
    module: "summary"
  }
);
```

Supported options:

- `captureArgs`
- `captureResult`
- `module`
- `name`
- `tracerName`

## How Telemetry Reaches OpenBox

The SDK has two telemetry paths:

1. buffered spans that are attached to later workflow or activity payloads
2. hook-triggered governance payloads sent during execution

Hook-triggered payloads are used for internal operational spans such as HTTP, DB, file, and traced function activity.

## Hook Payload Characteristics

Hook payloads:

- include `hook_trigger: true`
- include normalized OpenBox spans under `spans`
- carry one started or completed span phase per hook event
- attach to an existing parent workflow/activity context

For agent-only LLM traffic with no business activity parent:

- spans are queued
- later emitted on `SignalReceived(agent_output)`

## Privacy Design

Bodies and headers are not stored as ordinary OTel span attributes. Instead:

1. the SDK captures them into its internal span processor
2. the SDK merges them into governance payloads when required
3. external OTel exporters are not relied on to carry sensitive HTTP bodies

This is a deliberate boundary between observability for OpenBox governance and generic distributed tracing infrastructure.

## Ignored URLs

Always ignore your OpenBox Core URL so the SDK does not govern its own governance requests.

`withOpenBox()` does this automatically by adding `apiUrl` to ignored URLs during telemetry setup.

If you install telemetry manually, do the same:

```ts
const telemetry = setupOpenBoxOpenTelemetry({
  governanceClient: client,
  ignoredUrls: [config.apiUrl],
  spanProcessor
});
```

## Payload Budgeting

Agent `WorkflowCompleted` payloads can become large because they may include:

- workflow output
- model metadata
- usage metrics
- buffered spans

The SDK handles this by attempting progressively smaller payloads:

1. full telemetry payload
2. compact payload
3. ultra-minimal payload

The budget threshold is controlled by `maxEvaluatePayloadBytes`.

This fallback logic is especially important for agent runs with large outputs or rich LLM/tool telemetry.

## Telemetry Controller Lifecycle

`setupOpenBoxOpenTelemetry()` returns:

- active instrumentations
- tracer provider
- `shutdown()`

Because the SDK maintains one active controller at a time, initialize it once during process bootstrap unless you explicitly want to replace the prior controller.

## Operational Recommendations

Recommended defaults:

- keep `httpCapture` enabled
- keep `instrumentDatabases` enabled
- enable `instrumentFileIo` only when you actually need file telemetry
- keep `ignoredUrls` aligned with internal service endpoints that should not be governed

## Common Policy Interaction

If policy treats hook-triggered telemetry as separate user actions, you can see:

- duplicate approval requests
- noisy `http_request` or `db_query` activity rows
- approval loops while a parent activity is already pending approval

Recommended policy behavior:

- govern workflow and activity boundary events
- treat hook-triggered payloads as internal telemetry unless explicitly required
