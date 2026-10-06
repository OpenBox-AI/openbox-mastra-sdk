# Configuration

This document covers runtime options, environment variables, parsing rules, defaults, and production recommendations.

## How Configuration Is Resolved

Configuration is resolved in this order:

1. explicit options passed to `withOpenBox()` or `parseOpenBoxConfig()`
2. SDK-specific `OPENBOX_MASTRA_*` variables for API URL, API key, and identity fields
3. global `OPENBOX_*` variables
4. SDK defaults for optional fields

Blank environment values count as unset. `envPrefix` can replace `OPENBOX_MASTRA`.
For URLs, `OPENBOX_URL` remains a global alias ahead of `OPENBOX_API_URL`; both
are below the SDK-specific `OPENBOX_MASTRA_API_URL`. Mastra behavior settings
such as retries and capture continue to use the global variables listed below.

`apiUrl` and `apiKey` are always required from either code or environment.

## `OpenBoxConfigInput`

The SDK parses configuration through `parseOpenBoxConfig()` and `withOpenBox()`.

| Option | Type | Default | Use it to |
| --- | --- | --- | --- |
| `apiUrl` | `string` | required | point the SDK at OpenBox Core |
| `apiKey` | `string` | required | authenticate evaluate and approval calls |
| `agentDid` | `string` | unset | identify the agent for DID-signed OpenBox requests |
| `agentPrivateKey` | `string` | unset | sign OpenBox requests for agents with signing required |
| `evaluateMaxRetries` | `number` | `2` | retry transient evaluate failures |
| `evaluateRetryBaseDelayMs` | `number` | `150` | control exponential retry backoff |
| `governanceTimeout` | `number` | `30` | set request timeout in seconds |
| `hitlEnabled` | `boolean` | `true` | enable approval suspension and polling behavior |
| `httpCapture` | `boolean` | `true` | capture text HTTP bodies and headers |
| `instrumentDatabases` | `boolean` | `true` | enable supported database instrumentations |
| `instrumentFileIo` | `boolean` | `false` | enable file operation telemetry |
| `maxEvaluatePayloadBytes` | `number` | `256000` | cap payload size before compact fallback logic applies |
| `onApiError` | `"fail_open" \| "fail_closed"` | `"fail_open"` | decide whether OpenBox outages should halt execution |
| `sendActivityStartEvent` | `boolean` | `true` | emit `ActivityStarted` |
| `sendStartEvent` | `boolean` | `true` | emit `WorkflowStarted` |
| `skipActivityTypes` | `Iterable<string>` | `["send_governance_event"]` | suppress matching activity types entirely |
| `skipHitlActivityTypes` | `Iterable<string>` | `["send_governance_event"]` | retained for compatibility but not currently enforced by wrappers |
| `skipSignals` | `Iterable<string>` | `[]` | suppress matching signal names |
| `skipWorkflowTypes` | `Iterable<string>` | `[]` | suppress matching workflow or agent workflow types |
| `envPrefix` | `string` | `OPENBOX_MASTRA` | choose the connection/identity environment prefix |
| `identityMethod` | `AgentIdentityMethod` | inferred | select `openbox_did`, `okta_ai_agent`, or `keycloak_workload` |
| `workloadPrivateKey` | `string \| null` | unset | PKCS8 PEM RSA private key of the active workload service account |
| `agentId`, `organizationId`, `deploymentId` | `string` | unset | explicit Okta v2 identity bindings |
| `agentProofAudience` | `string` | unset | Okta proof audience, `urn:openbox:<deployment-id>:core` |
| `oktaAgentId`, `oktaAgentKeyId` | `string` | unset | Okta external agent ID and credential key ID |
| `oktaAgentPrivateKey` | `string` | unset | PKCS8 PEM RSA key for explicit Okta identity or v2 bootstrap |
| `oktaAgentAlgorithm` | `string` | unset | explicit Okta algorithm (`RS256`) |

## Environment Variables

These environment variables are read during config parsing:

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `OPENBOX_URL` | OpenBox Core base URL | required |
| `OPENBOX_API_KEY` | OpenBox API key | required |
| `OPENBOX_AGENT_DID` | DID assigned to this OpenBox agent | unset |
| `OPENBOX_AGENT_PRIVATE_KEY` | base64 raw Ed25519 seed returned by OpenBox during registration or rotation | unset |
| `OPENBOX_EVALUATE_MAX_RETRIES` | evaluate retry count | `2` |
| `OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS` | evaluate retry base delay in milliseconds | `150` |
| `OPENBOX_GOVERNANCE_TIMEOUT` | OpenBox API timeout in seconds | `30` |
| `OPENBOX_HITL_ENABLED` | enable approval handling | `true` |
| `OPENBOX_HTTP_CAPTURE` | capture text HTTP bodies and headers | `true` |
| `OPENBOX_INSTRUMENT_DATABASES` | enable supported database instrumentation | `true` |
| `OPENBOX_INSTRUMENT_FILE_IO` | enable file instrumentation | `false` |
| `OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES` | payload budget before compaction | `256000` |
| `OPENBOX_GOVERNANCE_POLICY` | API failure policy: `fail_open` or `fail_closed` | `"fail_open"` |
| `OPENBOX_SEND_ACTIVITY_START_EVENT` | emit `ActivityStarted` | `true` |
| `OPENBOX_SEND_START_EVENT` | emit `WorkflowStarted` | `true` |
| `OPENBOX_SKIP_ACTIVITY_TYPES` | comma-separated list of skipped activity types | `send_governance_event` |
| `OPENBOX_SKIP_HITL_ACTIVITY_TYPES` | compatibility field for skipped approval activity types | `send_governance_event` |
| `OPENBOX_SKIP_SIGNALS` | comma-separated list of skipped signals | empty |
| `OPENBOX_SKIP_WORKFLOW_TYPES` | comma-separated list of skipped workflow types | empty |
| `OPENBOX_API_URL` | standard Core URL (fallback after `OPENBOX_URL`) | required unless another URL is set |
| `OPENBOX_AGENT_IDENTITY_METHOD` | explicit identity method | inferred |
| `OPENBOX_WORKLOAD_PRIVATE_KEY` | PKCS8 PEM RSA workload key | unset |
| `OPENBOX_AGENT_ID`, `OPENBOX_ORGANIZATION_ID`, `OPENBOX_DEPLOYMENT_ID` | explicit Okta bindings | unset |
| `OPENBOX_AGENT_PROOF_AUDIENCE` | explicit Okta proof audience | unset |
| `OPENBOX_OKTA_AGENT_ID`, `OPENBOX_OKTA_AGENT_KEY_ID` | Okta external ID and key ID | unset |
| `OPENBOX_OKTA_AGENT_PRIVATE_KEY`, `OPENBOX_OKTA_AGENT_ALGORITHM` | Okta signing configuration | unset |

Additional runtime flags used outside config parsing:

| Environment variable | Purpose |
| --- | --- |
| `OPENBOX_DEBUG` | enable summarized debug logs for evaluate requests, retries, and approval polling |
| `OPENBOX_AGENT_GOAL` | override the inferred agent goal included in agent payloads |

## Parsing Rules

Boolean environment variables accept:

- `true`, `1`, `yes`
- `false`, `0`, `no`

CSV environment variables such as `OPENBOX_SKIP_ACTIVITY_TYPES` accept comma-separated values with surrounding whitespace trimmed.

Example:

```bash
export OPENBOX_SKIP_ACTIVITY_TYPES="send_governance_event, healthCheck"
```

## IAM v3 and identity selection

`identityMethod: "keycloak_workload"` requires a workload key; it never silently
creates an unsigned client when that key is missing. A workload key alone also
selects v3. Core supplies the token endpoint, issuer, audience, service account,
activation version, identity source, and key ID. The SDK acquires and caches the
short-lived token, shares acquisition across concurrent requests, and renews it
before expiry. No token or private key is included in config/client JSON or
Node inspection, and internal auth traffic bypasses telemetry capture.

DID, Okta, and workload inputs are mutually exclusive. For an Okta-sourced agent
migrating to workload auth, `oktaAgentPrivateKey` is accepted as the workload key
only with explicit `identityMethod: "keycloak_workload"`. Without that override,
an Okta key alone selects `/api/v2/auth/bootstrap`; it never becomes unsigned v1.
Explicit Okta metadata uses `/api/v2/*` and the base SDK's signed assertion.

`withOpenBox()` and `initializeOpenBox()` always authenticate against Core before
returning. In v3 this includes initial token acquisition. `validate` and
`OPENBOX_VALIDATE` no longer bypass startup. `parseOpenBoxConfig()` remains an
offline parser. An injected `client` supplies its own resolved identity and
connection options, while Mastra event/capture settings still come from config.

## Agent DID Identity

OpenBox can require cryptographic agent identity on agent-facing Core endpoints. When enabled for an agent, the SDK signs requests to:

- `/api/v1/auth/validate`
- `/api/v1/governance/evaluate`
- `/api/v1/governance/approval`

Set both identity values together:

```bash
export OPENBOX_AGENT_DID="did:aip:550e8400-e29b-41d4-a716-446655440000"
export OPENBOX_AGENT_PRIVATE_KEY="base64_raw_ed25519_seed"
```

Parsing rules:

- `OPENBOX_AGENT_DID` must use the `did:aip:<uuid>` format.
- `OPENBOX_AGENT_PRIVATE_KEY` must be the base64 raw 32-byte Ed25519 seed returned by OpenBox.
- setting only one of the two values fails config parsing.
- the SDK never logs the private key.

The private key is returned only when an agent identity is provisioned or rotated. Store it as a secret and rotate it from OpenBox if it is exposed.

## Activity Type Matching

`skipActivityTypes` is matched against normalized activity types. The runtime converts names to camelCase before sending them to OpenBox.

Examples:

| Input | Emitted `activity_type` |
| --- | --- |
| `writeFile` | `writeFile` |
| `Write File` | `writeFile` |
| `search_crypto_coins` | `searchCryptoCoins` |
| `Search crypto coins` | `searchCryptoCoins` |

Use the emitted form in policy, UI filters, and skip lists.

## Signals You Can Skip

Signals emitted by the SDK include:

| Signal | Source |
| --- | --- |
| `user_input` | `wrapAgent().generate()` and `wrapAgent().stream()` |
| `resume` | workflow resumes and agent resume paths |
| `agent_output` | agent completion signal carrying output and agent LLM spans |

If you skip `agent_output`, you also suppress the main signal path used for agent-only LLM telemetry.

## `onApiError`

`onApiError` controls ordinary Core network/5xx outages. Authentication and
workload-acquisition errors always throw at enforcing gates, including approval
polling, under either policy. A rejected workload request is never replayed; its
token is invalidated and the next operation must acquire a fresh one. v3
redirects and non-retryable 4xx contract errors also always throw. Completion
telemetry remains best effort and cannot reopen a blocked gate.

### `fail_open`

Use this when service availability is more important than strict governance enforcement.

Behavior:

- retryable OpenBox failures are retried first
- once retries are exhausted, execution usually continues
- no live verdict is enforced for the failed request

### `fail_closed`

Use this when ungoverned execution is unacceptable.

Behavior:

- retryable OpenBox failures are retried first
- once retries are exhausted, execution is halted
- wrapped activities or workflows can fail even if the underlying tool would otherwise succeed

## Human Approval Behavior

`hitlEnabled` controls approval handling for `require_approval` verdicts.

When `hitlEnabled` is `true`:

- workflow-backed tools and steps can suspend through Mastra workflow resume paths
- non-workflow activity execution falls back to inline approval polling
- agent runs poll approval state when resuming governed flows

When `hitlEnabled` is `false`:

- the SDK does not run approval suspension or inline approval polling
- verdict handling still occurs, but approval-specific runtime behavior is disabled

## Telemetry Options For Manual Wiring

If you call `setupOpenBoxOpenTelemetry()` directly, these options apply:

| Option | Type | Default | Use it to |
| --- | --- | --- | --- |
| `spanProcessor` | `OpenBoxSpanProcessor` | required | provide the active span buffer |
| `governanceClient` | `OpenBoxClient` | unset | enable hook-triggered governance evaluation |
| `captureHttpBodies` | `boolean` | `true` | capture text HTTP bodies and headers |
| `dbLibraries` | `ReadonlySet<string>` | all supported | restrict DB instrumentation to selected libraries |
| `ignoredUrls` | `string[]` | `[]` | prevent capture for selected URL prefixes |
| `instrumentDatabases` | `boolean` | `true` | enable DB instrumentation |
| `instrumentFileIo` | `boolean` | `false` | enable file instrumentation |
| `fileSkipPatterns` | `string[]` | built-in defaults | skip selected file paths |
| `onHookApiError` | `"fail_open" \| "fail_closed"` | client default | set API failure policy for hook-triggered evaluate calls |

## Recommended Production Baseline

| Setting | Recommended value | Why |
| --- | --- | --- |
| `identityMethod` | explicit per agent | fail early when its required key is missing |
| `onApiError` | explicit per environment | avoid accidental fail-open or fail-closed behavior |
| `httpCapture` | `true` unless payload sensitivity is prohibitive | preserve request context for policy and troubleshooting |
| `instrumentDatabases` | `true` | low-friction visibility into database access |
| `instrumentFileIo` | `false` unless you need file telemetry | reduce noise and sensitive-path exposure |
| `maxEvaluatePayloadBytes` | default initially | agent payload compaction already uses this budget |
| `skipSignals` | do not skip `agent_output` unless intentional | that signal carries agent output and agent LLM spans |

## Known Limitation: `skipHitlActivityTypes`

`skipHitlActivityTypes` is parsed into config and stored in runtime state, but current Mastra wrappers do not consult it when deciding whether to enter approval handling.

Today, if you need to change approval behavior for a subset of operations, do it with:

- OpenBox policy
- `skipActivityTypes` if the activity should not be emitted at all
- `skipSignals` if the signal should not be emitted

## Example

```ts
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
  agentDid: process.env.OPENBOX_AGENT_DID,
  agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY,
  apiUrl: process.env.OPENBOX_URL,
  evaluateMaxRetries: 2,
  evaluateRetryBaseDelayMs: 150,
  governanceTimeout: 30,
  hitlEnabled: true,
  httpCapture: true,
  instrumentDatabases: true,
  instrumentFileIo: false,
  onApiError: "fail_open",
  sendStartEvent: true,
  sendActivityStartEvent: true,
  skipActivityTypes: ["send_governance_event"],
  skipSignals: [],
  skipWorkflowTypes: []
});
```
