# Integration Patterns

This SDK supports three integration patterns:

1. zero-code Mastra patching with `withOpenBox()`
2. selective wrapping with `wrapTool()`, `wrapWorkflow()`, and `wrapAgent()`
3. telemetry-only installation with `setupOpenBoxOpenTelemetry()` plus optional `traced()`

## 1. Recommended: `withOpenBox()`

Use `withOpenBox()` when you want the SDK to own runtime setup and patch the entire Mastra instance.

```ts
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

const governedMastra = await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});
```

### What `withOpenBox()` Wraps

At initialization time:

- current top-level tools returned by `mastra.listTools()`
- current workflows returned by `mastra.listWorkflows()`
- current agents returned by `mastra.listAgents()`

After initialization:

- future `mastra.addTool()` registrations
- future `mastra.addWorkflow()` registrations
- future `mastra.addAgent()` registrations
- agent-local tool and workflow registries where Mastra exposes them

### What `withOpenBox()` Creates

- `OpenBoxClient`
- parsed `OpenBoxConfig`
- `OpenBoxSpanProcessor`
- telemetry controller from `setupOpenBoxOpenTelemetry()`
- a reusable runtime object accessible through `getOpenBoxRuntime()`

### Idempotency

Calling `withOpenBox()` again on the same Mastra instance reuses the existing runtime instead of creating a second one.

## 2. Passing An App Object Instead Of A Raw Mastra Instance

`withOpenBox()` accepts either:

- a Mastra instance
- an object with a `.mastra` property

Example:

```ts
await withOpenBox({ mastra }, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});
```

## 3. Manual Wrapping

Use manual wiring when you need finer control over startup order or only want to govern selected components.

```ts
import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
  wrapAgent,
  wrapTool,
  wrapWorkflow
} from "@openbox-ai/openbox-mastra-sdk";

const config = parseOpenBoxConfig({
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});

const client = new OpenBoxClient({
  apiKey: config.apiKey,
  apiUrl: config.apiUrl,
  evaluateMaxRetries: config.evaluateMaxRetries,
  evaluateRetryBaseDelayMs: config.evaluateRetryBaseDelayMs,
  onApiError: config.onApiError,
  timeoutSeconds: config.governanceTimeout
});

const spanProcessor = new OpenBoxSpanProcessor({
  ignoredUrlPrefixes: [config.apiUrl]
});

const telemetry = setupOpenBoxOpenTelemetry({
  captureHttpBodies: config.httpCapture,
  governanceClient: client,
  ignoredUrls: [config.apiUrl],
  instrumentDatabases: config.instrumentDatabases,
  instrumentFileIo: config.instrumentFileIo,
  spanProcessor
});

const governedTool = wrapTool(tool, {
  client,
  config,
  spanProcessor
});

const governedWorkflow = wrapWorkflow(workflow, {
  client,
  config,
  spanProcessor
});

const governedAgent = wrapAgent(agent, {
  client,
  config,
  spanProcessor
});

// On shutdown:
await telemetry.shutdown();
```

## 4. Telemetry-Only Installation

If you want telemetry capture but not automatic Mastra patching, install the telemetry layer directly:

```ts
import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  traced
} from "@openbox-ai/openbox-mastra-sdk";

const client = new OpenBoxClient({
  apiKey: process.env.OPENBOX_API_KEY!,
  apiUrl: process.env.OPENBOX_URL!
});

const spanProcessor = new OpenBoxSpanProcessor({
  ignoredUrlPrefixes: [process.env.OPENBOX_URL!]
});

setupOpenBoxOpenTelemetry({
  governanceClient: client,
  spanProcessor
});

const governedFn = traced(async function sendEmail(input: { to: string }) {
  return { delivered: true, to: input.to };
}, {
  captureArgs: true,
  captureResult: true,
  module: "email"
});
```

This pattern is useful when:

- your orchestration layer is not entirely Mastra-managed
- you need custom lifecycle emission around wrappers
- you want function-level spans without full Mastra patching

## 5. Tools

`wrapTool()` wraps a Mastra tool so that:

- `ActivityStarted` is emitted before execution when enabled
- verdicts and guardrails are applied before the underlying tool runs
- HTTP/DB/file/function spans produced during execution are attached to the activity context
- `ActivityCompleted` is emitted with serialized output and runtime metadata
- `REQUIRE_APPROVAL` can suspend workflow-backed execution or poll inline

## 6. Workflows

`wrapWorkflow()` wraps:

- workflow lifecycle methods such as `start()`, `resume()`, `stream()`, and `resumeStream()`
- non-tool workflow steps

Behavior:

- emits `WorkflowStarted`, `WorkflowCompleted`, and `WorkflowFailed`
- emits `SignalReceived` on workflow resume
- wraps non-tool steps as governed activities
- does not double-wrap tool component steps, because those are expected to be governed via tool wrapping

## 7. Agents

`wrapAgent()` treats an agent run as a workflow-like governance unit.

Behavior:

- assigns `workflow_id` as `agent:<agentIdOrName>`
- emits `WorkflowStarted`, `WorkflowCompleted`, and `WorkflowFailed`
- emits `SignalReceived` for:
  - `user_input`
  - `resume`
  - `agent_output`
- routes agent-only LLM spans into `agent_output` telemetry rather than standalone business activity rows

## 8. Goal Propagation For Agents

The SDK includes `goal` on agent events when it can infer one.

Goal resolution order:

1. `OPENBOX_AGENT_GOAL`
2. goal already associated with the current run
3. the latest user prompt from the interaction payload
4. `agent.getInstructions()`

This matters if you rely on OpenBox goal alignment or drift monitoring.

## 9. Process-Wide Telemetry Ownership

`setupOpenBoxOpenTelemetry()` manages module-level global state for the SDK’s active telemetry controller. Re-initializing it replaces the previous active controller.

Operational recommendation:

- initialize telemetry once during process bootstrap
- reuse the resulting runtime for all governed components in that process

## 10. Shutdown Guidance

If you call `withOpenBox()`, use:

```ts
await getOpenBoxRuntime(mastra)?.shutdown();
```

If you call `setupOpenBoxOpenTelemetry()` directly, keep the returned controller and shut it down yourself:

```ts
const telemetry = setupOpenBoxOpenTelemetry({ ... });
await telemetry.shutdown();
```
