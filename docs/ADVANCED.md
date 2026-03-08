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
4. Call `setupOpenBoxOpenTelemetry()`.
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

## App Targets

The zero-code entrypoint currently supports:

- a `Mastra` instance
- an app-like object shaped as `{ mastra: Mastra }`

If you need a server adapter or a more custom host object, pass the `Mastra` instance directly and retain the adapter separately.
