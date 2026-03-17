# API Reference

This document summarizes the public API exported by `@openbox-ai/openbox-mastra-sdk`.

It is not a generated API reference. It is an integration-focused reference describing the public surface and how each export is intended to be used.

## Root Exports

The root module re-exports:

- `./client`
- `./config`
- `./governance`
- `./mastra`
- `./otel`
- `./span`
- `./types`

## Client Module

Import path:

```ts
import { OpenBoxClient } from "@openbox-ai/openbox-mastra-sdk";
```

### `type OpenBoxApiErrorPolicy`

```ts
type OpenBoxApiErrorPolicy = "fail_open" | "fail_closed";
```

Controls how API failures are treated.

### `interface OpenBoxClientOptions`

Key fields:

- `apiKey`
- `apiUrl`
- `evaluateMaxRetries`
- `evaluateRetryBaseDelayMs`
- `fetch`
- `onApiError`
- `timeoutSeconds`

### `class OpenBoxClient`

Main methods:

- `validateApiKey(): Promise<void>`
- `evaluate(payload): Promise<GovernanceVerdictResponse | null>`
- `pollApproval(payload): Promise<ApprovalPollResponse | null>`

Use this class when you want explicit control over transport and governance requests.

## Config Module

Import path:

```ts
import {
  API_KEY_PATTERN,
  getOpenBoxConfig,
  initializeOpenBox,
  parseOpenBoxConfig,
  setOpenBoxConfig,
  validateApiKeyFormat,
  validateUrlSecurity
} from "@openbox-ai/openbox-mastra-sdk";
```

### `interface OpenBoxConfigInput`

User-supplied config surface. See [configuration.md](./configuration.md) for the full table.

### `interface OpenBoxConfig`

Normalized runtime config with defaults applied and iterable fields converted to `Set<string>`.

### `parseOpenBoxConfig(input?, env?)`

Parses:

- explicit config object
- environment variables

Performs:

- required field checks
- API key format validation
- URL security validation
- default filling

### `initializeOpenBox(input?)`

Parses config and, if validation is enabled, validates the API key against OpenBox Core.

Useful when:

- you want config initialized before wiring wrappers
- you want startup validation separate from `withOpenBox()`

### `getOpenBoxConfig()` / `setOpenBoxConfig()`

Access or override the global config singleton.

Use sparingly. Prefer explicit runtime injection where possible.

## Mastra Module

Import path:

```ts
import {
  getOpenBoxRuntime,
  withOpenBox,
  wrapAgent,
  wrapTool,
  wrapWorkflow
} from "@openbox-ai/openbox-mastra-sdk";
```

### `interface WrapToolOptions`

Shared dependency bag used by wrappers:

- `client`
- `config`
- `spanProcessor`

### `wrapTool(tool, options)`

Wraps a Mastra tool in governed activity execution.

Typical effects:

- boundary activity events
- guardrails
- approvals
- telemetry association

### `wrapWorkflow(workflow, options)`

Wraps workflow lifecycle and non-tool workflow steps.

Typical effects:

- workflow start/completion/failure events
- resume signal events
- governed step execution

### `wrapAgent(agent, options)`

Wraps agent lifecycle.

Typical effects:

- workflow-like lifecycle events for the agent run
- `user_input`, `resume`, and `agent_output` signals
- agent goal propagation
- agent LLM spans routed through signal telemetry

### `interface WithOpenBoxOptions`

Extends `OpenBoxConfigInput` and adds:

- `client`
- `dbLibraries`
- `fetch`
- `fileSkipPatterns`
- `ignoredUrls`
- `spanProcessor`

### `interface OpenBoxRuntime`

Runtime returned indirectly by `withOpenBox()` and accessible via `getOpenBoxRuntime()`.

Fields:

- `client`
- `config`
- `spanProcessor`
- `telemetry`
- `shutdown()`

### `withOpenBox(target, options?)`

Recommended zero-code integration.

Accepts:

- a Mastra instance
- an object containing `.mastra`

Creates runtime, patches Mastra, installs telemetry, and returns the same logical target.

### `getOpenBoxRuntime(target)`

Returns the installed runtime when available. Use it for:

- shutdown
- access to the normalized config
- direct access to the client or span processor

## OTel Module

Import path:

```ts
import {
  setupOpenBoxOpenTelemetry,
  traced
} from "@openbox-ai/openbox-mastra-sdk";
```

### `interface OpenBoxTelemetryOptions`

Fields:

- `spanProcessor`
- `governanceClient`
- `captureHttpBodies`
- `dbLibraries`
- `fileSkipPatterns`
- `ignoredUrls`
- `instrumentDatabases`
- `instrumentFileIo`
- `onHookApiError`

### `interface OpenBoxTelemetryController`

Fields:

- `instrumentations`
- `tracerProvider`
- `shutdown()`

### `setupOpenBoxOpenTelemetry(options)`

Installs the SDK’s process-wide telemetry layer.

Use this directly when:

- you are not using `withOpenBox()`
- you need explicit bootstrap order
- you only want telemetry, not full Mastra patching

### `interface OpenBoxTracedOptions`

Fields:

- `captureArgs`
- `captureResult`
- `module`
- `name`
- `tracerName`

### `traced(fn, options?)`

Wraps an async function in a traced function span.

Use it for:

- custom operations outside standard tool/workflow boundaries
- explicitly named operational spans
- additional policy-relevant function telemetry

## Span Module

Import path:

```ts
import { OpenBoxSpanProcessor } from "@openbox-ai/openbox-mastra-sdk";
```

### `class OpenBoxSpanProcessor`

Implements the OpenTelemetry `SpanProcessor` interface and manages the SDK’s enriched governance span buffer.

Typical usage:

- pass it to `setupOpenBoxOpenTelemetry()`
- reuse it across wrappers
- let `withOpenBox()` create it for you unless you need manual control

Exported companion types:

- `StoredSpanBody`
- `StoredTraceBody`
- `StoredWorkflowVerdict`
- `OpenBoxSpanData`
- `OpenBoxSpanProcessorOptions`
- `WorkflowSpanProcessor` as an alias of `OpenBoxSpanProcessor`

## Types Module

Import path:

```ts
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceAPIError,
  GovernanceHaltError,
  GovernanceVerdictResponse,
  GuardrailsCheckResult,
  GuardrailsValidationError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "@openbox-ai/openbox-mastra-sdk";
```

### Verdicts

`Verdict` exposes:

- `ALLOW`
- `CONSTRAIN`
- `REQUIRE_APPROVAL`
- `BLOCK`
- `HALT`

Utility methods:

- `fromString()`
- `highestPriority()`
- `priorityOf()`
- `requiresApproval()`
- `shouldStop()`

### `WorkflowEventType`

Enum values:

- `WorkflowStarted`
- `WorkflowCompleted`
- `WorkflowFailed`
- `SignalReceived`
- `ActivityStarted`
- `ActivityCompleted`

### `GovernanceVerdictResponse`

Normalized response object returned by the OpenBox API wrapper.

Important fields:

- `verdict`
- `reason`
- `approvalId`
- `constraints`
- `guardrailsResult`
- `alignmentScore`
- `riskScore`
- `metadata`

### `GuardrailsCheckResult`

Represents guardrail output including:

- `inputType`
- `redactedInput`
- `validationPassed`
- `reasons`
- `rawLogs`

### Error Classes

Configuration and transport:

- `OpenBoxError`
- `OpenBoxConfigError`
- `OpenBoxAuthError`
- `OpenBoxNetworkError`
- `OpenBoxInsecureURLError`
- `GovernanceAPIError`

Governance and approval:

- `GovernanceHaltError`
- `GuardrailsValidationError`
- `ApprovalPendingError`
- `ApprovalRejectedError`
- `ApprovalExpiredError`

## Governance Module

The `governance` entrypoint exists in the export map for completeness, but the primary public integration surface is the root package plus the `mastra`, `client`, `config`, `otel`, `span`, and `types` exports documented above.

For normal integrations, prefer importing from the root package unless you need a narrower subpath import.
