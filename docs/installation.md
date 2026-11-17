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

If the OpenBox agent requires DID signing, also set the identity values returned by OpenBox during agent registration or rotation:

```bash
export OPENBOX_AGENT_DID="did:aip:your-agent-did"
export OPENBOX_AGENT_PRIVATE_KEY="base64_raw_ed25519_seed"
```

Validation enforced by the SDK:

- `OPENBOX_API_KEY` must match `obx_live_*` or `obx_test_*`
- `OPENBOX_URL` must use HTTPS unless the host is `localhost`, `127.0.0.1`, or `::1`
- `OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY` must be provided together when either is set

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

Startup authentication is mandatory for `withOpenBox()` and `initializeOpenBox()`.
Tests and local mock servers must answer the selected `/api/v1/auth/validate`,
`/api/v2/auth/validate`, or `/api/v3/auth/validate` route; v3 also needs bootstrap
and token endpoints. Inject `fetch` or a prebuilt `client` for offline fixtures.
`parseOpenBoxConfig()` itself performs no network calls. The bundled quickstart
includes a validation endpoint and works without a real Core deployment.

## Shutdown

Telemetry installed by the SDK is process-wide. Runtime shutdown also closes the client and clears its token cache, including an injected client. Shut it down on process exit or when you intentionally want to tear the integration down:

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
2. Confirm startup authentication succeeds before the runtime is installed.
3. Trigger a governed tool or workflow and verify events appear in OpenBox.
4. If you are intentionally consuming a local SDK checkout instead of npm, make sure the consuming service is running the rebuilt package output.

## Next Step

Continue with [configuration.md](./configuration.md) for the complete runtime configuration surface.
