# Installation

## Requirements

The package currently targets the following runtime:

- Node.js `24.10.0`
- `@mastra/core` `^1.8.0`
- an OpenBox Core deployment reachable from your application runtime

This package is ESM-only. Your runtime and build system must support ESM imports.

## Install The Package

```bash
npm install @openbox-ai/openbox-mastra-sdk @mastra/core
```

## Required Environment Variables

```bash
export OPENBOX_URL="https://your-openbox-core.example"
export OPENBOX_API_KEY="obx_live_your_key"
```

Rules enforced by the SDK:

- `OPENBOX_API_KEY` must match `obx_live_*` or `obx_test_*`
- `OPENBOX_URL` must use HTTPS unless the host is `localhost`, `127.0.0.1`, or `::1`

If either required value is missing, the SDK throws an `OpenBoxConfigError` during config parsing.

## Minimal Startup With `withOpenBox()`

```ts
import { Mastra } from "@mastra/core/mastra";
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

const mastra = new Mastra({
  agents: {},
  tools: {},
  workflows: {}
});

await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});
```

By default, this will:

- validate your API key against OpenBox Core
- create a reusable OpenBox runtime
- enable HTTP and database telemetry
- keep file I/O telemetry disabled
- patch Mastra so existing and future components are wrapped

## Disabling Validation For Tests And Local Mocks

For integration tests, local demos, or mock OpenBox servers, you may want startup without credential validation:

```ts
await withOpenBox(mastra, {
  apiKey: "obx_test_local_mock",
  apiUrl: "http://127.0.0.1:8086",
  validate: false
});
```

Use `validate: false` only when:

- the server intentionally does not implement `/api/v1/auth/validate`
- you are running against a local mock
- you want deterministic tests without a real auth roundtrip

Do not disable validation in normal production environments unless startup validation is handled elsewhere.

## Shutdown

OpenTelemetry instrumentation is process-wide. Shut the runtime down when your process is terminating or when you intentionally want to tear down the SDK:

```ts
import { getOpenBoxRuntime } from "@openbox-ai/openbox-mastra-sdk";

await getOpenBoxRuntime(mastra)?.shutdown();
```

This:

- unregisters instrumentation installed by this SDK
- shuts down the tracer provider
- clears the active OpenBox telemetry controller

## Quick Verification Checklist

After startup, verify:

1. your application can reach `OPENBOX_URL`
2. `validateApiKey()` succeeds or `validate: false` is intentionally set
3. your first tool or workflow execution produces governance requests in OpenBox
4. your process uses the rebuilt local package if you are consuming the repo by path

## Next Step

Continue with [configuration.md](./configuration.md) for the full config surface and production defaults.
