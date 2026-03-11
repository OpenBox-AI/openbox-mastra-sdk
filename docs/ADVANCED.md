# Advanced Usage

## Manual Wiring

Use the manual surface when you need to control initialization order, supply a custom client, or wrap only selected Mastra components.

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
```

Typical sequence:

1. Parse config with `parseOpenBoxConfig()` or initialize with `initializeOpenBox()`.
2. Construct `OpenBoxClient`.
3. Construct `OpenBoxSpanProcessor`.
4. Call `setupOpenBoxOpenTelemetry()` and pass `governanceClient` to enable hook-level evaluate events.
5. Wrap tools, workflows, and agents with the same `client/config/spanProcessor` tuple.

## Zero-Code Runtime Access

`withOpenBox()` attaches a runtime object to the Mastra instance, and to an app wrapper when the target shape is `{ mastra }`.

```ts
import { getOpenBoxRuntime, withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

const app = { mastra };
await withOpenBox(app, options);

const runtime = getOpenBoxRuntime(app);
await runtime?.shutdown();
```

## Custom Client Injection

`withOpenBox()` accepts a prebuilt `client` when you need a custom `fetch` implementation, custom retry behavior around the SDK surface, or shared client lifecycle management.

```ts
const client = new OpenBoxClient({
  apiKey,
  apiUrl,
  evaluateMaxRetries: 2,
  evaluateRetryBaseDelayMs: 200,
  fetch: customFetch,
  onApiError: "fail_closed",
  timeoutSeconds: 30
});

await withOpenBox(mastra, {
  apiKey,
  apiUrl,
  client,
  validate: false
});
```

## Production Hardening Controls

The SDK supports explicit controls for reliability under large or bursty workloads:

- `maxEvaluatePayloadBytes` / `OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES`
- `evaluateMaxRetries` / `OPENBOX_EVALUATE_MAX_RETRIES`
- `evaluateRetryBaseDelayMs` / `OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS`

`WorkflowCompleted` evaluate uses a tiered payload strategy:

1. Full telemetry payload
2. Compact payload (truncated output + synthetic model usage span)
3. Ultra-minimal payload (no spans, no workflow output, keep core identifiers and usage fields)

The payload preflight budget skips oversized tiers automatically and only sends payloads under budget, except the final ultra-minimal tier which is always attempted.

## Telemetry Controls

Advanced telemetry options accepted by `withOpenBox()`:

- `ignoredUrls`: extra URL prefixes to exclude from HTTP capture
- `dbLibraries`: allowlist for database instrumentations
- `fileSkipPatterns`: additional file path filters
- `spanProcessor`: prebuilt span processor instance

`withOpenBox()` always excludes the configured OpenBox API URL from HTTP body capture to avoid self-instrumenting governance requests.

For manual `setupOpenBoxOpenTelemetry()` wiring, hook-level governance controls are:

- `governanceClient`: `OpenBoxClient` used for hook-level `evaluate` calls
- `onHookApiError`: override hook error policy (`fail_open` or `fail_closed`)
- `traced(asyncFn, options)`: wraps async functions with hook-level `function_call` governance events

Current DB hook-level coverage:

- `@opentelemetry/instrumentation-pg`: started/completed hook dispatch via request/response hooks
- `@opentelemetry/instrumentation-oracledb`: started/completed hook dispatch via request/response hooks

## Traced Function Hooks

Use `traced()` for function-level hook governance:

```ts
import { traced } from "@openbox-ai/openbox-mastra-sdk";

const callModel = traced(
  async (prompt: string) => {
    return prompt.toUpperCase();
  },
  {
    captureArgs: true,
    captureResult: true,
    module: "demo",
    name: "callModel"
  }
);
```

When telemetry is initialized with a `governanceClient`, `traced()` emits `function_call` started/completed hook events.

## Activity Type Normalization

The SDK normalizes emitted `activity_type` values to camelCase for consistency across Mastra wrappers.

- `Search crypto coins` -> `searchCryptoCoins`
- `uppercase-step` -> `uppercaseStep`

Use normalized values when configuring `skipActivityTypes` and downstream governance filters.

## Agent Signal Emission

To align with governance systems that evaluate behavioral/goal checks on signal events:

- `wrapAgent().generate()` and `wrapAgent().stream()` emit `SignalReceived` with `signal_name: "user_input"` and `signal_args` from the provided messages.
- `wrapAgent().resumeGenerate()` and `wrapAgent().resumeStream()` emit `SignalReceived` with `signal_name: "resume"` and `signal_args` from resume data.

Use `skipSignals` to opt out per signal name.

## App Targets

The zero-code entrypoint currently supports:

- a `Mastra` instance
- an app-like object shaped as `{ mastra: Mastra }`

If you need a server adapter or a more custom host object, pass the `Mastra` instance directly and retain the adapter separately.
