# Migration Notes: `openbox-mastra-sdk` → `@openbox-ai/openbox-sdk` Delegation

> Historical record of the 1.0 migration. IAM v3 now supersedes the client and
> dependency decisions below: the published base SDK dependency is `^2.1.0`,
> and Mastra wraps `OpenBoxClient.fromConfig` for all authentication modes.
> Responses are adapted from the base result's `raw` data, preserving Mastra's
> shape. SDK branding now identifies `openbox-mastra-typescript-v<version>`.
> Startup validation is mandatory. See [configuration.md](./configuration.md)
> and the [2.0.0 changelog](../CHANGELOG.md#200---2026-10-06) for current behavior.

Records the base-SDK delegation migration: what moved, what stayed local (and
why), the 5 flagged-surface re-verifications, and rollback notes. Written
during implementation; consult git history for the exact diffs referenced
below.

## Base dependency

`package.json` — `@openbox-ai/openbox-sdk` added as a dev `file:` dependency
pointing at a packed tarball of `openbox-sdk-ts` (dev resolution). Release
must swap this to the published npm version before shipping — no sibling/tarball
path may reach a release artifact.

Base symbols/subpaths imported by this package:

- Root (`@openbox-ai/openbox-sdk`): `Verdict`, `verdictFromString`,
  `verdictPriority`, `highestPriorityVerdict`, `verdictShouldStop`,
  `verdictRequiresApproval`, `EvaluationResult`, `EventType`, all re-exported
  error classes (`OpenBoxError`, `OpenBoxConfigError`, `OpenBoxAuthError`,
  `OpenBoxNetworkError`, `OpenBoxInsecureURLError`, `OpenBoxSigningError`,
  `ContractError`, `GovernanceBlockedError`, `GovernanceHaltError`,
  `GovernanceAPIError`, `GuardrailsValidationError`, `ApprovalExpiredError`,
  `ApprovalRejectedError`, `ApprovalTimeoutError`, `mapSigningError`,
  `extractGovernanceError`), `ActivityContext` (type, test-only usage).
- `@openbox-ai/openbox-sdk/config`: `OpenBoxConfig` (base's class, used
  internally by `parseOpenBoxConfig` for validation — not re-exported).
- `@openbox-ai/openbox-sdk/identity`: `AgentIdentity`, `buildCanonicalString`,
  `generateNonce`, `validateAgentDid`, `HEADER_DID`, `HEADER_TIMESTAMP`,
  `HEADER_NONCE`, `HEADER_SIGNATURE`, `HEADER_BODY_SHA256`.
- `@openbox-ai/openbox-sdk/adapters`: `FrameworkAdapter` (type, implemented by
  `MastraFrameworkAdapter`).
- `@openbox-ai/openbox-sdk/conformance` (test-only): `FakeCore`,
  `buildConformanceRuntime`, `assertHookWireShape`, `APPROVAL_SCENARIOS`,
  `CONFORMANCE_ACTIVITY_CONTEXT`, `CONFORMANCE_HOOK_TYPE_SCENARIOS`.
- `@openbox-ai/openbox-sdk/runtime` (test-only, type import): `OpenBoxRuntime`.

Not imported (no gap hit — nothing needed that base doesn't export):
`client`, `context`, `approvals`, `instrumentation` subpaths were read/
evaluated but not wired in (see "Kept local" below for why).

## Symbol-level contract diff

Enumerated every export reachable from `src/index.ts`'s 8 barrels
(`client, config, governance, identity, mastra, otel, span, types`).
Pre-migration count (git history): 81 exported symbols across the 8 barrels
(`governance/index.ts` was, and remains, `export {}` — `approval-registry.ts`
and `context.ts` are internal-only, never part of the public surface). The
phase file's "98" estimate does not match a fresh grep of this repo's actual
barrel exports; 81 is the verified count. Net after migration: 81 − 0 removed
+ 10 added = 91 (6 new error re-exports beyond the original 11, 1 new client
helper, 3 new `MastraFrameworkAdapter`-related exports; `toEvaluationResult()`
is a new instance method, not a new top-level export, so not counted here).

| Module | Symbols | Disposition |
|---|---|---|
| `client` | `OpenBoxApiErrorPolicy`, `OpenBoxClientOptions`, `ApprovalPollRequest`, `ApprovalPollResponse`, `OpenBoxClient` | **Stays local**, surgically patched (see "Client" below). Signing delegates to base transitively via `identity`. |
| `client` | `parseApprovalDecision` | **New** — strict approval-decision helper (base wins on approval wire format). |
| `config` | `API_KEY_PATTERN`, `OpenBoxMultiAgentSessionContext`, `OpenBoxMultiAgentSessionIdResolver`, `OpenBoxMultiAgentInput`, `OpenBoxMultiAgentConfig`, `OpenBoxConfigInput`, `OpenBoxConfig`, `validateApiKeyFormat`, `validateUrlSecurity`, `resolveOpenBoxMultiAgentSessionId`, `initializeOpenBox`, `getOpenBoxConfig`, `setOpenBoxConfig` | **Stays local** (shape unchanged — Mastra's config has 11 fields with no base equivalent: `evaluateMaxRetries`, `instrumentDatabases`, `hitlEnabled`, `skip*Types`, etc.). |
| `config` | `parseOpenBoxConfig` | **Delegates to base** — routes apiUrl/apiKey/agentDid/agentPrivateKey validation through `BaseOpenBoxConfig.resolve()` + `.loadIdentity()`; Mastra's own env-var names (`OPENBOX_URL` etc.) resolved locally first. |
| `governance` | *(none — `export {}`)* | N/A |
| `identity` | `OPENBOX_AGENT_*_HEADER` (×5), `AgentIdentityConfig`, `BuildAgentIdentityCanonicalRequestInput`, `CreateAgentIdentityHeadersInput`, `AgentIdentityHeaders`, `buildAgentIdentityCanonicalRequest`, `validateAgentIdentityConfig`, `createAgentIdentityHeaders` | **Delegates to base** — DID validation, Ed25519 signing, canonical string, header constant values all sourced from `@openbox-ai/openbox-sdk/identity`. Names/shapes unchanged. |
| `mastra` | `OpenBoxA2APeerAgent`, `Build/ParseOpenBoxA2A*` (×3), `buildOpenBoxA2AOutboundContext`, `parseOpenBoxA2AInboundMetadata`, `OpenBoxActivityMetadataResolver`, `withOpenBoxActivityMetadata`, `resolveOpenBoxActivityMetadata`, `runWithOpenBoxEventMetadata`, `WrapToolOptions`, `wrapTool`, `wrapAgent`, `wrapWorkflow`, `WithOpenBoxOptions`, `OpenBoxRuntime` (Mastra's own interface — **name collision with base's `OpenBoxRuntime` class**, see below), `withOpenBox`, `getOpenBoxRuntime` | **Stays local** (Mastra lifecycle mapping — explicit non-goal to rewrite). |
| `mastra` | `MastraApprovalWaitOptions`, `MastraFrameworkAdapterOptions`, `MastraFrameworkAdapter` | **New** — implements base's `FrameworkAdapter`; wired into `governance/activity-runtime.ts`'s inline approval wait. |
| `otel` | `OpenBoxTelemetryOptions`, `OpenBoxTelemetryController`, `OpenBoxTracedOptions`, `setupOpenBoxOpenTelemetry`, `traced` | **Stays local**, unmodified. |
| `span` | `StoredSpanBody`, `StoredTraceBody`, `StoredWorkflowVerdict`, `OpenBoxSpanData`, `OpenBoxSpanProcessorOptions`, `OpenBoxSpanProcessor`, `WorkflowSpanProcessor` | **Stays local**, unmodified. |
| `types` | `GuardrailReason`, `GuardrailsCheckResultInit`, `GuardrailsCheckResult` | **Stays local** (evaluated for delegation; kept — see "Guardrails" below). |
| `types` | `Verdict` | **Delegates to base** — compat wrapper over `verdictFromString`/`verdictPriority`/etc. Same values/API. |
| `types` | `WorkflowEventType` | **Delegates to base** — compat const object sourced from base's `EventType` values (verified byte-identical wire strings). |
| `types` | `GovernanceVerdictResponseInit`, `GovernanceVerdictResponse` | **Delegates to base** — `fromObject` parses via `EvaluationResult.fromDict`; class shape/constructor unchanged; `+toEvaluationResult()` new method. |
| `types` | `OpenBoxError`, `OpenBoxConfigError`, `OpenBoxAuthError`, `OpenBoxNetworkError`, `OpenBoxInsecureURLError`, `GovernanceAPIError`, `GovernanceHaltError`, `GuardrailsValidationError`, `ApprovalRejectedError`, `ApprovalExpiredError` | **Delegates to base** — direct re-export, same names. |
| `types` | `ApprovalPendingError` | **Stays local** (no base equivalent — Mastra-only "still waiting" control-flow signal). |
| `types` | `ContractError`, `OpenBoxSigningError`, `GovernanceBlockedError`, `ApprovalTimeoutError`, `mapSigningError`, `extractGovernanceError` | **New** re-exports (additive — base's fuller error hierarchy, not previously exposed by Mastra). |
| `types` | `WorkflowSpanBufferInit`, `WorkflowSpanBuffer` | **Stays local** (public export preserved per phase requirement). Its `Verdict` **type** import repointed to `@openbox-ai/openbox-sdk` directly (see below) — not observable externally. |

**Name-collision note:** Mastra's `mastra/with-openbox.ts` exports an
interface named `OpenBoxRuntime` (its own internal runtime-handle shape,
unrelated to base's `OpenBoxRuntime` class). Mastra's `src/index.ts` never
re-exports anything from `@openbox-ai/openbox-sdk` directly, so there is no
actual collision in the shipped package today. Flagged for whoever next wires
Mastra's `withOpenBox()` to construct a real base `OpenBoxRuntime` internally
— that work will need an aliased import (e.g. `import { OpenBoxRuntime as
BaseOpenBoxRuntime } ...`).

## `workflow-span-buffer.ts` — `Verdict` type repoint

Repointed exactly as the phase spec's cross-boundary note requires: `import
type { Verdict } from "@openbox-ai/openbox-sdk";` (was `./verdict.js`). This
file only uses `Verdict` as a type annotation (never calls
`.fromString`/`.shouldStop`), so a type-only import straight from base is
exact — the base `Verdict` type and Mastra's compat-wrapper `Verdict` type are
the same string union, so this is safe regardless of which other files still
import the value-level `Verdict` object from `types/verdict.ts` for its
`.fromString`/`.shouldStop`/etc. helper methods.

## Deviations from the phase file's literal "delegate" list (with rationale)

1. **`types/guardrails.ts` — evaluated, kept local (not delegated).** Base's
   `GuardrailsResult` defaults absent fields to `null`
   (`rawLogs: Dict | null = null`); Mastra's `GuardrailsCheckResult` has
   always defaulted them to `undefined`
   (`test/unit/types.test.ts` asserts `result.rawLogs` `.toBeUndefined()`).
   Subclassing base's class hits a real TS field-type conflict
   (`Dict | null` vs `Record<string,unknown> | undefined` are not mutually
   assignable) for zero behavioral gain — `getReasonStrings()` logic is
   already byte-identical in both. The actually-meaningful behavior (verdict
   priority + the empty-vs-present guardrails-result parsing nuance) IS
   delegated, one layer up, in `GovernanceVerdictResponse.fromObject` via
   `EvaluationResult.fromDict`.
2. **`governance/{approval-registry,context}.ts` — evaluated, kept local (not
   delegated).** Neither file is part of the public API (`governance/index.ts`
   is `export {}`). `approval-registry.ts`'s pending-approval registry (keyed
   passive lookup for workflow-suspend coordination) has no base equivalent —
   base only has a blocking `ApprovalPoller`, no "suspend now, check later"
   concept. `context.ts`'s `OpenBoxExecutionContext` carries Mastra-specific
   fields (`goal`, `attempt`, `source: "agent"|"tool"|"workflow"`) absent from
   base's generic, immutable `ActivityContext`, and progressively merges
   metadata across nested scopes — a usage pattern base's snapshot-per-call
   `ActivityContext` doesn't model. Re-verified `context.ts`'s
   `AsyncLocalStorage` usage against Decision 13 (base wins if wrong): it
   already uses `.run(ctx, cb)`, never `enterWith`/a `bind`/`reset(token)`
   pattern — no defect found, no change needed.
3. **`client/openbox-client.ts` — surgically patched, not fully rewritten
   around base's `OpenBoxClient` instance.** A full wrap was attempted in
   design and rejected: base's `OpenBoxClient` produces a different
   `User-Agent` format (`OpenBox-SDK/openbox-{engine}-{language}-v{version}`
   vs Mastra's `OpenBox-SDK/1.0`, asserted exactly by
   `test/contract/openbox-client.test.ts`) and an always-fully-populated
   `ApprovalResult` (conflicting with 2 existing `pollApproval` tests that
   assert exact `toEqual` shapes matching raw server passthrough — `toEqual`
   ignores `undefined` keys but NOT `false`/`null` keys, so an
   always-populated `expired: false` would break exact-shape assertions).
   Signing and verdict-parsing already delegate to base transitively
   (`identity`, `GovernanceVerdictResponse`); the client file itself only
   needed the auth-fail-never-fail-open fix (below), applied as a targeted
   patch to `#evaluateOnce`/`#withApiPolicy`. Base's real `OpenBoxClient`
   remains available at `@openbox-ai/openbox-sdk/client` for a future
   consumer once Mastra's wire-shape tests are ready to accept the new
   formats.
4. **No runtime base-vs-legacy feature flag.** The phase asks for "a way to
   toggle base-vs-legacy per surface for rollback." This migration
   implements rollback via **per-file git revert**, not a runtime flag: every
   delegated surface is an isolated file (`types/verdict.ts`,
   `types/errors.ts`, `types/governance-verdict-response.ts`,
   `types/workflow-event-type.ts`, `identity/agent-identity.ts`, the
   `parseOpenBoxConfig` validation block, the 2 `client/openbox-client.ts`
   hunks), so any surface can be reverted independently without touching the
   others. A runtime flag would require maintaining two parallel
   implementations per surface indefinitely — disproportionate to the actual
   risk here (small, independently-revertable diffs) and against YAGNI.

## Re-verification of the 5 flagged surfaces (base wins on conflict)

1. **Error retry / fail-open.** Real bug found and fixed: Mastra's
   `#withApiPolicy` treated a 401/403 from `/governance/evaluate` as an
   ordinary API failure and applied `fail_open` → silently returned `null`
   (no verdict) on a persistent auth/signing break — exactly the "silent
   governance bypass" the plan's Critical Finding #4 describes. Fixed:
   `#evaluateOnce` now throws `OpenBoxAuthError`/`OpenBoxSigningError` on
   401/403 (mirroring base's `extractReasonCode`), and `#withApiPolicy` never
   fail-opens on `instanceof OpenBoxAuthError` — always rethrows, regardless
   of `onApiError`. Retry loop (`evaluateMaxRetries`/backoff) is Mastra-only
   (base has none) and is preserved unchanged; auth errors are non-retryable
   already (401 doesn't match the retryable-error regex). New tests:
   `test/contract/openbox-client.test.ts` "never fail-opens on a %s auth
   rejection" and "does not retry a 401/403 auth rejection".
2. **Verdict priority + application.** Real bug found and fixed: the old
   `GovernanceVerdictResponse.fromObject` computed
   `Verdict.fromString(data.verdict ?? data.action ?? "continue")` — `??`
   does not fall through on an empty string, so `{verdict:"", action:"stop"}`
   incorrectly resolved to ALLOW. Base's `EvaluationResult.fromDict` checks
   `verdict.trim()` before preferring it over `action`. Fixed by delegating
   `fromObject`'s parsing to `EvaluationResult.fromDict` entirely. Priority
   ordering itself (`ALLOW<CONSTRAIN<REQUIRE_APPROVAL<BLOCK<HALT`) was already
   correct and is now base-sourced via the `Verdict` compat wrapper.
3. **Config defaults.** Compared field-by-field: API key pattern (`\w` ==
   `[A-Za-z0-9_]`), `onApiError` default (`fail_open`), timeout default
   (`30`), and the URL-security algorithm (WHATWG `URL`, bracket-stripped
   hostname, exact-match localhost set, identical message text) are all
   **already identical** between Mastra and base — no behavior change; base's
   validation is now the authoritative path via `BaseOpenBoxConfig.resolve()`
   inside `parseOpenBoxConfig`, confirming rather than changing these values.
4. **Approval wire format.** Real bug found and fixed: 3 call sites
   (`governance/activity-runtime.ts` `waitForApprovalInline`,
   `mastra/wrap-agent.ts` `handleAgentResume`, `mastra/wrap-workflow.ts`
   `pollPendingApproval`) parsed a polled approval's decision with the
   LENIENT evaluate-path parser (`Verdict.fromString`, which defaults an
   unrecognized string to ALLOW) at the human-approval trust boundary, where
   Decision 6 requires STRICT parsing (unknown/empty → pending, never
   implicit allow). Fixed via a new `parseApprovalDecision` helper
   (`client/openbox-client.ts`) mirroring base's `ApprovalResult` decision
   vocabulary, used at all 3 call sites and inside the new
   `MastraFrameworkAdapter.waitForApproval`. The wire RESPONSE SHAPE itself
   (`ApprovalPollResponse`, raw passthrough + conditional `expired` overlay)
   is unchanged — see deviation #3 above for why.
5. **Guardrails redaction.** No behavior gap found beyond the verdict-parsing
   fix in #2 above (which also governs whether/how a guardrails-carrying
   response is parsed). `GuardrailsCheckResult`/`getReasonStrings()` logic
   verified byte-identical to base's equivalent; kept local per deviation #1.

## Public API

Additive only — no removed or renamed exports. New: `parseApprovalDecision`
(client), `MastraFrameworkAdapter` + its option types (mastra), 6 error
classes/functions re-exported from base that Mastra didn't previously expose
(types), `GovernanceVerdictResponse#toEvaluationResult()` (instance method).

Two intentional, low-risk **message-text** changes (same error TYPE, `.message`
content differs) from delegating to base's validators:
`validateAgentIdentityConfig`'s DID-format error now reads "Invalid agent DID
format..." (was "Invalid OpenBox agent DID..."); its private-key-format error
now reads "Invalid agent private key..." (was "Invalid OpenBox agent private
key..."). `test/unit/agent-identity.test.ts` updated to match (both assertions
were substring `.toThrow(string)` checks, not exact-message).

## pg double-governance invariant

No base pg wrapper was enabled (the `instrumentation` subpath was not touched
or wired in at all this phase). Mastra's existing OTel-pg hook governance in
`otel/setup-openbox-opentelemetry.ts` is unmodified. Strengthened
`test/unit/otel-setup.test.ts`'s existing db-query hook test with an exact-count
assertion (`toBe(1)` for both the started and completed hook event, not
`toBeGreaterThanOrEqual`) so a future regression that accidentally enables a
second pg governance path for the same query fails loudly.

## Base conformance kit

`test/conformance/base-sdk-conformance-kit.test.ts` imports
`@openbox-ai/openbox-sdk/conformance` and runs it against a real
`MastraFrameworkAdapter` (backed by Mastra's own `OpenBoxClient`, itself
pointed at the same `FakeCore` the base runtime's internal client uses).
Covers: default-allow lifecycle, HALT and BLOCK verdicts both mapping to
`GovernanceHaltError`, all 3 `APPROVAL_SCENARIOS` (approved/rejected/expired)
driven through `handleApproval`, and `assertHookWireShape` for all 4
`CONFORMANCE_HOOK_TYPE_SCENARIOS` hook types via `runtime.preflight()`.
