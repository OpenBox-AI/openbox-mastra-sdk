# OpenBox Mastra SDK

`@openbox-ai/openbox-mastra-sdk` adds OpenBox governance, approvals, guardrails, and OpenTelemetry-backed operational telemetry to Mastra tools, workflows, and agents.

It is designed for production Mastra applications that need:

- boundary governance on tools, workflow steps, workflows, and agents
- human approval flows backed by OpenBox verdicts
- input/output guardrail validation and redaction
- HTTP, database, file, and traced function span capture
- policy-relevant telemetry without building a custom instrumentation layer

## Requirements

- Node.js `24.10.0`
- `@mastra/core` `^1.8.0`
- An OpenBox Core deployment reachable from your Mastra runtime

## Installation

```bash
npm install @openbox-ai/openbox-mastra-sdk @mastra/core
```

Required environment variables:

```bash
export OPENBOX_URL="https://your-openbox-core.example"
export OPENBOX_API_KEY="obx_live_your_key"
```

For local development against a mock or non-validating server, pass `validate: false`.

## Quick Start

```ts
import { Mastra } from "@mastra/core/mastra";
import { withOpenBox, getOpenBoxRuntime } from "@openbox-ai/openbox-mastra-sdk";

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

// Later, during process shutdown:
await getOpenBoxRuntime(governedMastra)?.shutdown();
```

`withOpenBox()` is the recommended production entrypoint. It:

1. parses and validates OpenBox configuration
2. creates an `OpenBoxClient`
3. installs OpenTelemetry instrumentation for the current process
4. wraps existing Mastra tools, workflows, and agents
5. patches future `addTool()`, `addWorkflow()`, and `addAgent()` registrations

## What The SDK Emits

Primary governance events:

| Event | Where it comes from |
| --- | --- |
| `WorkflowStarted` | Wrapped workflows and agents at run start |
| `WorkflowCompleted` | Wrapped workflows and agents on successful completion |
| `WorkflowFailed` | Wrapped workflows and agents on failure |
| `SignalReceived` | Workflow resumes, agent `user_input`, agent `resume`, agent `agent_output` |
| `ActivityStarted` | Wrapped tools and non-tool workflow steps |
| `ActivityCompleted` | Wrapped tools and non-tool workflow steps |

Operational spans captured by telemetry:

- HTTP request spans
- database query spans
- file operation spans when file I/O instrumentation is enabled
- traced function spans from `traced()`

Agent-specific note:

- agent LLM activity is represented as telemetry spans on `SignalReceived` (`agent_output`) and `WorkflowCompleted`
- agent-only LLM completions are not intended to appear as standalone business activities

## Integration Modes

Recommended:

- `withOpenBox()` for zero-code process wiring

Manual:

- `OpenBoxClient`
- `OpenBoxSpanProcessor`
- `setupOpenBoxOpenTelemetry()`
- `wrapTool()`
- `wrapWorkflow()`
- `wrapAgent()`
- `traced()`

Use manual wiring when you need to:

- reuse an existing OpenBox client instance
- control telemetry bootstrap order
- wrap only selected Mastra components
- install telemetry outside `withOpenBox()`

## Core Configuration

Most-used options:

| Option | Default | Purpose |
| --- | --- | --- |
| `apiUrl` | required | OpenBox Core base URL |
| `apiKey` | required | OpenBox API key |
| `validate` | `true` | Validate API key at startup |
| `onApiError` | `"fail_open"` | Continue or halt when OpenBox cannot be reached |
| `hitlEnabled` | `true` | Enable approval polling / resume handling |
| `sendStartEvent` | `true` | Emit `WorkflowStarted` |
| `sendActivityStartEvent` | `true` | Emit `ActivityStarted` |
| `httpCapture` | `true` | Capture text HTTP bodies and headers for governance payloads |
| `instrumentDatabases` | `true` | Enable supported database instrumentations |
| `instrumentFileIo` | `false` | Enable file I/O span capture |
| `skipWorkflowTypes` | empty | Skip workflow/agent lifecycle events for matching workflow types |
| `skipActivityTypes` | `["send_governance_event"]` | Skip matching activity types |
| `skipSignals` | empty | Skip matching signal names |
| `maxEvaluatePayloadBytes` | `256000` | Payload budget before compact fallback logic is applied |

Environment variables:

- `OPENBOX_URL`
- `OPENBOX_API_KEY`
- `OPENBOX_GOVERNANCE_TIMEOUT`
- `OPENBOX_GOVERNANCE_POLICY`
- `OPENBOX_EVALUATE_MAX_RETRIES`
- `OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS`
- `OPENBOX_HTTP_CAPTURE`
- `OPENBOX_INSTRUMENT_DATABASES`
- `OPENBOX_INSTRUMENT_FILE_IO`
- `OPENBOX_SEND_START_EVENT`
- `OPENBOX_SEND_ACTIVITY_START_EVENT`
- `OPENBOX_SKIP_WORKFLOW_TYPES`
- `OPENBOX_SKIP_ACTIVITY_TYPES`
- `OPENBOX_SKIP_HITL_ACTIVITY_TYPES`
- `OPENBOX_SKIP_SIGNALS`
- `OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES`
- `OPENBOX_VALIDATE`
- `OPENBOX_DEBUG`
- `OPENBOX_AGENT_GOAL`

The full configuration reference is in [docs/configuration.md](./docs/configuration.md).

## Production Behavior Highlights

- Non-localhost `http://` OpenBox URLs are rejected at config parse time.
- HTTP bodies are kept in the SDK span processor and merged into governance payloads; they are not stored as ordinary OTel span attributes.
- The SDK automatically ignores its own OpenBox API URL during telemetry setup to avoid governance loops.
- `withOpenBox()` is idempotent per Mastra instance and reuses the existing runtime when called again.
- `setupOpenBoxOpenTelemetry()` manages process-wide instrumentation. Initialize it once per process unless you intentionally want to replace the active controller.
- Agent `WorkflowCompleted` payloads automatically fall back to smaller payload shapes when they exceed the configured byte budget.

## Policy Design Guidance

Hook-triggered telemetry payloads are internal observability signals, not user-facing business activities. In practice, policy should usually treat payloads with `hook_trigger: true` or hook span content as internal telemetry and avoid requiring separate human approval for them.

If you approve on both boundary activities and internal hook telemetry, you can create duplicate or confusing approval flows.

## Documentation

- [docs/README.md](./docs/README.md): documentation index and recommended reading order
- [docs/installation.md](./docs/installation.md): installation, requirements, and first startup
- [docs/configuration.md](./docs/configuration.md): complete configuration and environment variable reference
- [docs/integration-patterns.md](./docs/integration-patterns.md): `withOpenBox()` and manual wiring patterns
- [docs/architecture.md](./docs/architecture.md): runtime architecture and component responsibilities
- [docs/event-model.md](./docs/event-model.md): event types, signals, activity naming, and agent semantics
- [docs/telemetry.md](./docs/telemetry.md): HTTP/DB/file/function span capture and payload behavior
- [docs/approvals-and-guardrails.md](./docs/approvals-and-guardrails.md): verdict handling, approvals, and redaction
- [docs/security-and-privacy.md](./docs/security-and-privacy.md): operational security and data-handling guidance
- [docs/troubleshooting.md](./docs/troubleshooting.md): common integration failures and diagnostics
- [docs/api-reference.md](./docs/api-reference.md): public API reference

## Public API Summary

Top-level exports:

- client: `OpenBoxClient`
- config: `parseOpenBoxConfig()`, `initializeOpenBox()`, `validateApiKeyFormat()`, `validateUrlSecurity()`
- Mastra integration: `withOpenBox()`, `getOpenBoxRuntime()`, `wrapTool()`, `wrapWorkflow()`, `wrapAgent()`
- telemetry: `setupOpenBoxOpenTelemetry()`, `traced()`
- span processing: `OpenBoxSpanProcessor`
- types: verdicts, errors, guardrail types, workflow event types

See [docs/api-reference.md](./docs/api-reference.md) for signatures and behavior.
