# Changelog

All notable changes to `@openbox-ai/openbox-mastra-sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-06

### Breaking

- Remove `validate` and `OPENBOX_VALIDATE`. `withOpenBox()` and
  `initializeOpenBox()` now always authenticate before returning; mock Core
  servers must implement authentication.
- Delegate runtime authentication and errors to base SDK `^2.1.0`.
  Unsigned runtime auth rejections now raise `GovernanceAPIError`; signed and
  workload errors retain their specialized base SDK types. Approval auth
  failures throw instead of being returned as a pending `null` response.
- Use base SDK headers branded `openbox-mastra-typescript-v<version>`.
  Runtime shutdown closes injected clients as well as owned clients.

### Added

- IAM v3 `keycloak_workload` identity, `workloadPrivateKey`, and Okta v2 options,
  with explicit / `OPENBOX_MASTRA_*` / global environment precedence and blank
  environment fallback. `OPENBOX_URL` remains supported.
- One base client and token cache for startup, gates, approvals, hooks, and
  telemetry; metadata, refresh, transition-proof, and close helpers.
- `OpenBoxWorkloadAuthError` and related public identity/workload types.

### Security

- Fail closed at instrumentation gates on authentication/contract errors under
  `fail_open`; workload authentication never downgrades or replays a rejection.
- Exclude internal Core/Keycloak HTTP traffic from capture and recursion, and
  redact credentials in config/client JSON and Node inspection.
- Update OpenTelemetry and locked dependencies to patched releases, and move
  the test runner to Vitest 4 to remove the vulnerable Tinypool dependency.

## [1.0.0] - 2026-07-20

First stable release. Mastra's governance internals now delegate to the shared
`@openbox-ai/openbox-sdk` base SDK; this package keeps only its Mastra lifecycle
mapping and public API. The public export surface is **additive** (81 → 91
symbols, no removals or renames), but governance now **fails closed** in cases
where it previously failed open — see Security.

### Security

- **Fail closed on auth/signing rejection at the pre-operation governance gate.**
  A persistent `401`/`403` from `/governance/evaluate` was treated as an ordinary
  API failure and, under the default `fail_open` policy, silently returned no
  verdict — a governance bypass. Auth and signing errors now always throw
  (`OpenBoxAuthError` / `OpenBoxSigningError`) and are never subject to
  `fail_open`, regardless of the `onApiError` setting; they remain non-retryable.
  Completed-event telemetry stays fail-open (unchanged).

### Added

- `MastraFrameworkAdapter` — implements the base SDK's `FrameworkAdapter` seam —
  plus `MastraApprovalWaitOptions` / `MastraFrameworkAdapterOptions`.
- `parseApprovalDecision` client helper (strict approval-decision parsing).
- Six error classes/functions re-exported from base, not previously exposed:
  `ContractError`, `OpenBoxSigningError`, `GovernanceBlockedError`,
  `ApprovalTimeoutError`, `mapSigningError`, `extractGovernanceError`.
- `GovernanceVerdictResponse#toEvaluationResult()` instance method.
- The base SDK conformance kit now runs in-suite against the real
  `MastraFrameworkAdapter`.

### Changed

- **Delegate shared governance behavior to `@openbox-ai/openbox-sdk`:** Ed25519
  signing, canonical-string + identity-header construction, verdict/result
  parsing, the error hierarchy, config validation, and event-type wire strings
  are now sourced from the base SDK.
- `Verdict` and `WorkflowEventType` are now compatibility wrappers over base's
  verdict helpers and `EventType` (same values and byte-identical wire strings).
- Identity validation messages now come from base (same error *type*, new text):
  `"Invalid agent DID format…"` (was `"Invalid OpenBox agent DID…"`) and
  `"Invalid agent private key…"` (was `"Invalid OpenBox agent private key…"`).
- `workflow-span-buffer.ts` repoints its `Verdict` type import directly to base
  (type-only; not externally observable).

### Fixed

- **Empty-string verdict no longer resolves to `ALLOW`.** A response like
  `{ verdict: "", action: "stop" }` previously resolved to `ALLOW` because `??`
  did not fall through on the empty string. Parsing now delegates to base's
  `EvaluationResult.fromDict`, which prefers a non-empty `action`.
- **Strict approval-decision parsing at the human-approval trust boundary.**
  Polled approval decisions that are unknown or empty now map to *pending* and
  never to an implicit `ALLOW`, at all three poll call sites and inside the
  adapter.
- **Approval polling now carries the originating workflow/run/activity IDs.**
  Core's evaluate response does not echo these IDs; approval handling now threads
  the originating `ActivityContext` through instead of falling back to
  `result.raw`, which could poll with empty IDs.

### Notes

- Base SDK dependency is now installed from npm
  (`@openbox-ai/openbox-sdk-ts@^1.0.1`, aliased to the `@openbox-ai/openbox-sdk`
  import name); the previous local `file:` path is gone.
- Test suite grew to 195 tests (+48). See
  [`docs/migration-notes-base-sdk-delegation.md`](docs/migration-notes-base-sdk-delegation.md)
  for what moved, what stayed local, and per-surface rollback notes.

## [0.2.1] - 2026-06-30

### Changed

- Mastra multi-agent session grouping for governed agent, workflow, and tool
  events. When enabled, the SDK emits `multi_agent_session_id` across evaluation
  payloads so related child-agent runs group together in OpenBox.
- `multiAgent` configuration via `OPENBOX_MULTI_AGENT_ENABLED`,
  `OPENBOX_MULTI_AGENT_SESSION_ID`, and custom resolver support; when enabled
  without an explicit session id, the SDK defaults to `mas:<runId>`.

### Notes

- Added unit coverage for multi-agent configuration and resolver behavior.

## [0.2.0] - 2026-05-19

### Added

- **Agent DID identity:** Ed25519 request signing and identity headers on
  governance calls; the agent, tool, and workflow wrappers emit signed requests.
- Workflow wrapping support and a runnable quickstart example.

### Changed

- Refreshed dependencies for security scanning.

## [0.1.0] - 2026-03-29

Initial release — the OpenBox governance and observability SDK for Mastra.

### Added

- OpenTelemetry-based observability: buffered span capture, agent-run OTel
  correlation, and model / token / latency telemetry with normalized model IDs.
- Hook-level governance aligned with the OpenBox core flow (agent LLM hooks
  routed to spans; function-level hook governance).
- Human-in-the-loop (HITL) approvals with duplicate-approval prevention that
  preserves `ActivityCompleted` lifecycle events.
- Agent, activity, and workflow observability payloads; a guardrail-friendly
  activity input shape.
- Production hardening for long-running sessions.

[2.0.0]: https://github.com/OpenBox-AI/openbox-mastra-sdk/compare/1.0.0...v2.0.0
[1.0.0]: https://github.com/OpenBox-AI/openbox-mastra-sdk/compare/0.2.1...1.0.0
[0.2.1]: https://github.com/OpenBox-AI/openbox-mastra-sdk/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/OpenBox-AI/openbox-mastra-sdk/compare/v0.1.0...0.2.0
[0.1.0]: https://github.com/OpenBox-AI/openbox-mastra-sdk/releases/tag/v0.1.0
