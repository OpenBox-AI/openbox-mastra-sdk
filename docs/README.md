# OpenBox Mastra SDK Documentation

This directory contains the production-facing documentation for `@openbox-ai/openbox-mastra-sdk`.

The SDK has three major responsibilities:

1. wrap Mastra tools, workflows, and agents with OpenBox governance
2. capture operational spans with OpenTelemetry
3. translate OpenBox verdicts into runtime behavior such as allow, halt, redact, or approval

## Recommended Reading Order

If you are integrating the SDK for the first time, read in this order:

1. [installation.md](./installation.md)
2. [configuration.md](./configuration.md)
3. [integration-patterns.md](./integration-patterns.md)
4. [event-model.md](./event-model.md)
5. [approvals-and-guardrails.md](./approvals-and-guardrails.md)
6. [telemetry.md](./telemetry.md)
7. [security-and-privacy.md](./security-and-privacy.md)
8. [troubleshooting.md](./troubleshooting.md)
9. [api-reference.md](./api-reference.md)

## Documentation Map

| Document | Purpose |
| --- | --- |
| [installation.md](./installation.md) | Runtime requirements, package installation, environment variables, and first startup |
| [configuration.md](./configuration.md) | Complete configuration surface, defaults, env var mapping, and production recommendations |
| [integration-patterns.md](./integration-patterns.md) | Zero-code and manual integration patterns for Mastra |
| [architecture.md](./architecture.md) | Internal architecture, data flow, and lifecycle responsibilities |
| [event-model.md](./event-model.md) | Governance event types, activity naming, signals, hook semantics, and agent behavior |
| [telemetry.md](./telemetry.md) | HTTP, database, file, and traced function capture |
| [approvals-and-guardrails.md](./approvals-and-guardrails.md) | Verdict handling, approval flows, guardrails, and runtime errors |
| [security-and-privacy.md](./security-and-privacy.md) | HTTPS enforcement, capture boundaries, privacy defaults, and operational hardening |
| [troubleshooting.md](./troubleshooting.md) | Common misconfigurations and debugging guidance |
| [api-reference.md](./api-reference.md) | Public export inventory and behavior summary |

## Support Matrix

| Dependency | Requirement |
| --- | --- |
| Node.js | `24.10.0` |
| Mastra | `@mastra/core ^1.8.0` |
| Module format | ESM |
| OpenBox Core | Reachable over HTTPS except localhost development |

## Concepts Used Throughout The Docs

| Term | Meaning |
| --- | --- |
| Workflow boundary event | `WorkflowStarted`, `WorkflowCompleted`, or `WorkflowFailed` |
| Activity boundary event | `ActivityStarted` or `ActivityCompleted` emitted for tools and non-tool workflow steps |
| Signal event | `SignalReceived` emitted for workflow resumes and agent lifecycle signals |
| Hook telemetry | Internal governance payload carrying one operational span such as HTTP, DB, file, or function activity |
| Governed activity | A tool execution or workflow step execution evaluated against OpenBox policy |
| Agent output signal | The `SignalReceived` event with `signal_name: "agent_output"` used to carry agent output plus agent LLM spans |

## Choosing An Integration Strategy

Use [integration-patterns.md](./integration-patterns.md) to choose between:

- `withOpenBox()` for standard application wiring
- manual wrappers for selective adoption
- telemetry-only installation for custom orchestration