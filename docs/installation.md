# Installation

This document covers package installation, startup requirements, validation behavior, and shutdown.

## Requirements

The package currently targets:

- Node.js `>=24.10.0`
- `@mastra/core` `^1.8.0`
- an OpenBox Core deployment reachable from the application runtime
- ESM-compatible application code

## Install The Package

The standard production path is the published npm package:

```bash
npm install @openbox-ai/openbox-mastra-sdk @mastra/core
```

Clone the repository only if you want to run the bundled quickstart example or work on the SDK itself.

If you want a fuller runnable demo application, use the Mastra coding-agent POC:

- `https://github.com/OpenBox-AI/poc-mastra-coding-agent/tree/dev`

That demo installs `@openbox-ai/openbox-mastra-sdk` from npm. You do not need a sibling checkout of this repository to run it.

## Required Environment Variables

```bash
export OPENBOX_URL="https://your-openbox-core.example"
export OPENBOX_API_KEY="obx_live_your_key"
```

Validation enforced by the SDK:

- `OPENBOX_API_KEY` must match `obx_live_*` or `obx_test_*`
- `OPENBOX_URL` must use HTTPS unless the host is `localhost`, `127.0.0.1`, or `::1`

If either required value is missing, the SDK throws an `OpenBoxConfigError` during startup.

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

- validate the API key against OpenBox Core
- create a reusable OpenBox runtime
- install process-wide telemetry
- enable HTTP and database capture
- keep file I/O capture disabled
- wrap current and future Mastra tools, workflows, and agents

## Validation And Local Development

For tests, local demos, or mock OpenBox servers, you may want startup without API key validation:

```ts
await withOpenBox(mastra, {
  apiKey: "obx_test_local_mock",
  apiUrl: "http://127.0.0.1:8086",
  validate: false
});
```

Use `validate: false` only when:

- the target server does not implement `/api/v1/auth/validate`
- you are running against a local mock or fixture server
- you need deterministic tests without a real auth roundtrip

Do not disable validation in normal production environments unless credential validation is handled elsewhere in your platform.

## Shutdown

Telemetry installed by the SDK is process-wide. Shut it down on process exit or when you intentionally want to tear the integration down:

```ts
import { getOpenBoxRuntime } from "@openbox-ai/openbox-mastra-sdk";

await getOpenBoxRuntime(mastra)?.shutdown();
```

Shutdown:

- unregisters instrumentations installed by this SDK
- shuts down the tracer provider
- clears the active telemetry controller managed by the SDK

## First-Run Checklist

Before declaring the integration healthy:

1. Confirm the application can reach `OPENBOX_URL`.
2. Confirm startup validation succeeds, or `validate: false` is intentionally set.
3. Trigger a governed tool or workflow and verify events appear in OpenBox.
4. If you are intentionally consuming a local SDK checkout instead of npm, make sure the consuming service is running the rebuilt package output.

## Next Step

Continue with [configuration.md](./configuration.md) for the complete runtime configuration surface.
