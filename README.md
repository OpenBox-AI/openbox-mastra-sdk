# OpenBox Mastra SDK

`@openbox-ai/openbox-mastra-sdk` adds OpenBox governance, approvals, guardrails, and privacy-aware observability to Mastra tools, workflows, and agents.

## What It Covers

- Governance verdict mappings: `ALLOW`, `CONSTRAIN`, `REQUIRE_APPROVAL`, `BLOCK`, `HALT`
- Human approval flows using Mastra suspend/resume
- Guardrail redaction and validation for inputs and outputs
- OpenTelemetry span buffering with HTTP, database, and opt-in file I/O capture
- Workflow, activity, and resume event emission with skip filters and start-event toggles
- Zero-code wiring with `withOpenBox()` plus manual wiring APIs

## Install

```bash
npm install @openbox-ai/openbox-mastra-sdk @mastra/core
```

Required environment variables:

```bash
export OPENBOX_URL="https://your-openbox-core.example"
export OPENBOX_API_KEY="obx_live_your_key"
```

## Quick Start

```ts
import { Mastra } from "@mastra/core/mastra";
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

const mastra = new Mastra({
  agents: {
    // your agents
  },
  tools: {
    // your tools
  },
  workflows: {
    // your workflows
  }
});

const governedMastra = await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
  apiUrl: process.env.OPENBOX_URL
});
```

`withOpenBox()` does three things in one call:

- validates and normalizes OpenBox config
- installs OpenTelemetry instrumentation
- wraps current and future Mastra tools, workflows, and agents in place

If you need shutdown control, use `getOpenBoxRuntime()`:

```ts
import { getOpenBoxRuntime } from "@openbox-ai/openbox-mastra-sdk";

await getOpenBoxRuntime(governedMastra)?.shutdown();
```

## Public API

Zero-code:

- `withOpenBox(target, options)`
- `getOpenBoxRuntime(target)`

Manual wiring:

- `initializeOpenBox(config)`
- `OpenBoxClient`
- `OpenBoxSpanProcessor`
- `setupOpenBoxOpenTelemetry(options)`
- `wrapTool(tool, options)`
- `wrapWorkflow(workflow, options)`
- `wrapAgent(agent, options)`

## Configuration

Supported config inputs:

- `apiUrl` or `OPENBOX_URL`
- `apiKey` or `OPENBOX_API_KEY`
- `governanceTimeout`
- `onApiError` as `fail_open` or `fail_closed`
- `hitlEnabled`
- `sendStartEvent`
- `sendActivityStartEvent`
- `skipWorkflowTypes`
- `skipActivityTypes`
- `skipSignals`
- `httpCapture`
- `instrumentDatabases`
- `instrumentFileIo`
- `validate`

Security defaults:

- non-localhost HTTP endpoints are rejected
- HTTP bodies and headers are not stored in OTel span attributes
- file I/O instrumentation is off by default
- database instrumentation is on by default

## Example

Run the self-contained quickstart:

```bash
npm run example:quickstart
```

The example in `examples/quickstart` starts a mock OpenBox server, runs a governed workflow, suspends on `REQUIRE_APPROVAL`, resumes, then completes a tool call and agent summary.

## Fixtures

Representative golden payloads live under `test/fixtures`:

- `test/fixtures/events`
- `test/fixtures/approvals`
- `test/fixtures/guardrails`

## Docs

- `docs/PARITY_SPEC.md`
- `docs/ADVANCED.md`
- `docs/SECURITY.md`
- `docs/CHANGELOG.md`

## Standalone SDK

This package is standalone and self-sufficient for Mastra integrations.
No additional SDKs or runtime dependencies are required beyond the documented Node/Mastra/OpenBox setup.
