# Configuration

This document covers:

- `OpenBoxConfigInput`
- environment variable mapping
- runtime defaults
- telemetry-specific options used by manual setup
- production recommendations

## `OpenBoxConfigInput`

The SDK parses configuration through `parseOpenBoxConfig()` and `withOpenBox()`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiUrl` | `string` | required | OpenBox Core base URL |
| `apiKey` | `string` | required | OpenBox API key |
| `evaluateMaxRetries` | `number` | `2` | Retries for `evaluate()` on retryable API failures |
| `evaluateRetryBaseDelayMs` | `number` | `150` | Exponential backoff base delay for evaluate retries |
| `governanceTimeout` | `number` | `30` | Request timeout in seconds for OpenBox API calls |
| `hitlEnabled` | `boolean` | `true` | Enables approval polling / suspension behavior |
| `httpCapture` | `boolean` | `true` | Capture text-like HTTP bodies and headers |
| `instrumentDatabases` | `boolean` | `true` | Enable supported DB instrumentation |
| `instrumentFileIo` | `boolean` | `false` | Enable file operation spans |
| `maxEvaluatePayloadBytes` | `number` | `256000` | Soft payload budget used by compact fallback logic |
| `onApiError` | `"fail_open" \| "fail_closed"` | `"fail_open"` | Continue or halt when OpenBox API calls fail |
| `sendActivityStartEvent` | `boolean` | `true` | Emit boundary `ActivityStarted` events |
| `sendStartEvent` | `boolean` | `true` | Emit boundary `WorkflowStarted` events |
| `skipActivityTypes` | `Iterable<string>` | `["send_governance_event"]` | Skip matching governed activity types |
| `skipHitlActivityTypes` | `Iterable<string>` | `["send_governance_event"]` | Parsed and stored for compatibility; not currently enforced by wrappers |
| `skipSignals` | `Iterable<string>` | `[]` | Skip matching signal names |
| `skipWorkflowTypes` | `Iterable<string>` | `[]` | Skip matching workflow or agent workflow types |
| `validate` | `boolean` | `true` | Validate API key during startup |

## Environment Variables

These environment variables are read by `parseOpenBoxConfig()`:

| Environment variable | Maps to | Default |
| --- | --- | --- |
| `OPENBOX_URL` | `apiUrl` | required |
| `OPENBOX_API_KEY` | `apiKey` | required |
| `OPENBOX_EVALUATE_MAX_RETRIES` | `evaluateMaxRetries` | `2` |
| `OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS` | `evaluateRetryBaseDelayMs` | `150` |
| `OPENBOX_GOVERNANCE_TIMEOUT` | `governanceTimeout` | `30` |
| `OPENBOX_HITL_ENABLED` | `hitlEnabled` | `true` |
| `OPENBOX_HTTP_CAPTURE` | `httpCapture` | `true` |
| `OPENBOX_INSTRUMENT_DATABASES` | `instrumentDatabases` | `true` |
| `OPENBOX_INSTRUMENT_FILE_IO` | `instrumentFileIo` | `false` |
| `OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES` | `maxEvaluatePayloadBytes` | `256000` |
| `OPENBOX_GOVERNANCE_POLICY` | `onApiError` | `"fail_open"` |
| `OPENBOX_SEND_ACTIVITY_START_EVENT` | `sendActivityStartEvent` | `true` |
| `OPENBOX_SEND_START_EVENT` | `sendStartEvent` | `true` |
| `OPENBOX_SKIP_ACTIVITY_TYPES` | `skipActivityTypes` | `send_governance_event` |
| `OPENBOX_SKIP_HITL_ACTIVITY_TYPES` | `skipHitlActivityTypes` | `send_governance_event` |
| `OPENBOX_SKIP_SIGNALS` | `skipSignals` | empty |
| `OPENBOX_SKIP_WORKFLOW_TYPES` | `skipWorkflowTypes` | empty |
| `OPENBOX_VALIDATE` | `validate` | `true` |

Additional environment variables used outside config parsing:

| Environment variable | Purpose |
| --- | --- |
| `OPENBOX_DEBUG` | Enables summarized debug logs for evaluate requests, approval polling, and retries |
| `OPENBOX_AGENT_GOAL` | Overrides inferred agent goal used in signal and workflow payloads |

## Activity Type Matching

`skipActivityTypes` is matched against normalized activity types.

The runtime converts activity names to camelCase. Examples:

| Input | Emitted `activity_type` |
| --- | --- |
| `writeFile` | `writeFile` |
| `Write File` | `writeFile` |
| `search_crypto_coins` | `searchCryptoCoins` |
| `Search crypto coins` | `searchCryptoCoins` |

Use the normalized form in `skipActivityTypes`.

## Signal Names You Can Skip

Signals emitted by the SDK include:

| Signal | Source |
| --- | --- |
| `user_input` | `wrapAgent().generate()` and `wrapAgent().stream()` |
| `resume` | workflow resumes and agent resume paths |
| `agent_output` | agent completion signal carrying output and agent LLM spans |

Use `skipSignals` to suppress any of them.

## `onApiError`

`onApiError` controls how the SDK reacts when the OpenBox API is unavailable.

### `fail_open`

Behavior:

- governance API failures are treated as non-blocking
- execution continues where possible
- useful when availability is more important than strict enforcement

### `fail_closed`

Behavior:

- governance API failures are converted into blocking behavior
- wrapped activities or workflows may halt instead of continuing
- appropriate for environments where governance must be enforced strictly

## Human Approval

`hitlEnabled` controls approval handling for `REQUIRE_APPROVAL` verdicts.

When `hitlEnabled` is `true`:

- workflow-backed tool and step execution can suspend via Mastra workflow suspend/resume
- non-workflow executions fall back to inline approval polling
- agents poll approval status when resuming governed runs

When `hitlEnabled` is `false`:

- the SDK does not run human approval flow logic
- the boundary completed event still carries completion metadata, but approval handling is not performed

## Telemetry Options For Manual Wiring

If you use `setupOpenBoxOpenTelemetry()` directly, these options apply:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `spanProcessor` | `OpenBoxSpanProcessor` | required | Active span processor used by the SDK |
| `governanceClient` | `OpenBoxClient` | unset | Enables hook-triggered governance evaluation for captured spans |
| `captureHttpBodies` | `boolean` | `true` | Capture text HTTP bodies and headers |
| `dbLibraries` | `ReadonlySet<string>` | all supported | Limit DB instrumentation to selected libraries |
| `ignoredUrls` | `string[]` | `[]` | Prevent telemetry capture for matching URL prefixes |
| `instrumentDatabases` | `boolean` | `true` | Enable DB instrumentation |
| `instrumentFileIo` | `boolean` | `false` | Enable file instrumentation |
| `fileSkipPatterns` | `string[]` | built-in defaults | Skip matching file paths |
| `onHookApiError` | `"fail_open" \| "fail_closed"` | client default | Error policy for hook-triggered evaluate calls |

## Production Recommendations

Recommended baseline:

| Setting | Recommended value | Why |
| --- | --- | --- |
| `validate` | `true` | Catch invalid URL or API key at startup |
| `onApiError` | depends on environment | `fail_open` for availability-first, `fail_closed` for strict governance |
| `httpCapture` | `true` unless payloads are highly sensitive | Required for rich policy and debugging context |
| `instrumentDatabases` | `true` | Low-cost visibility for DB access patterns |
| `instrumentFileIo` | `false` unless needed | File telemetry can be noisy and should be intentional |
| `maxEvaluatePayloadBytes` | keep default initially | The SDK already compacts agent completion payloads when needed |
| `skipSignals` | avoid skipping `agent_output` unless intentional | Agent LLM spans are delivered through this signal |

## Compatibility Note: `skipHitlActivityTypes`

`skipHitlActivityTypes` is parsed into config and preserved in runtime state, but current Mastra wrappers do not consult it when deciding whether to enter approval handling.

Today, if you need to change approval behavior for specific operations, use:

- OpenBox policy rules
- `skipActivityTypes` if you want to suppress those activities entirely
- `skipSignals` for signal-level suppression

## Example

```ts
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

await withOpenBox(mastra, {
  apiKey: process.env.OPENBOX_API_KEY,
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
  skipWorkflowTypes: [],
  validate: true
});
```
