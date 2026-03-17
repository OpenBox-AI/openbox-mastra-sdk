# Security And Privacy

This SDK is built for governance-sensitive workloads. The defaults are intentionally conservative in the places that matter most.

## URL Security Enforcement

The SDK rejects insecure non-localhost OpenBox URLs.

Allowed:

- `https://openbox.example.com`
- `http://localhost:8086`
- `http://127.0.0.1:8086`
- `http://[::1]:8086`

Rejected:

- `http://openbox.example.com`

Reason:

- API keys must not be sent over plaintext HTTP outside local development

## API Key Validation

API keys must match:

- `obx_live_*`
- `obx_test_*`

When `validate` is `true`, startup also verifies the key against OpenBox Core using `/api/v1/auth/validate`.

Use `validate: false` only for:

- tests
- mock servers
- deliberately offline local development

## Body And Header Capture Model

The SDK can capture request and response bodies for HTTP telemetry, but it does so carefully.

Key properties:

- HTTP bodies are not stored as normal OTel span attributes
- bodies and headers are buffered inside the SDK span processor
- the data is merged into governance payloads only when needed

This prevents accidental leakage of full request/response bodies through generic OTel exporters.

## Default Capture Posture

Default settings:

| Setting | Default | Rationale |
| --- | --- | --- |
| `httpCapture` | `true` | useful governance and debugging context |
| `instrumentDatabases` | `true` | low-friction visibility into data access |
| `instrumentFileIo` | `false` | file telemetry can be noisy and sensitive |

If your environment is highly sensitive:

- consider disabling `httpCapture`
- enable it selectively in lower environments first
- tune OpenBox policies to minimize retained sensitive content

## Text-Only HTTP Body Capture

The SDK only treats text-like content as body-capturable text.

Examples:

- `text/*`
- `application/json`
- `application/xml`
- `application/javascript`
- `application/x-www-form-urlencoded`

This helps avoid nonsensical capture of binary payloads.

## File I/O Is Opt-In

File instrumentation is disabled by default.

When enabled, the SDK still skips common system and binary paths using default patterns such as:

- `/dev/`
- `/proc/`
- `/sys/`
- `__pycache__`
- `.so`
- `.dylib`

Do not enable file telemetry broadly unless you actually need policy or UI visibility into file operations.

## Ignore Internal URLs

Always ignore service URLs that should not be governed.

Minimum recommendation:

- ignore your OpenBox Core URL

Why:

- prevents the SDK from tracing and governing its own API calls
- reduces noise
- avoids governance loops

`withOpenBox()` already adds `apiUrl` to the ignored URL set.

## API Failure Policy

`onApiError` controls what happens if OpenBox cannot be reached.

### `fail_open`

Use when:

- system availability is more important than strict governance enforcement
- governance outages must not stop production traffic

Tradeoff:

- requests can continue without a live policy decision

### `fail_closed`

Use when:

- governance enforcement is mandatory
- ungoverned execution is unacceptable

Tradeoff:

- OpenBox outages become execution blockers

## Payload Size And Data Minimization

The SDK limits large governance payloads through `maxEvaluatePayloadBytes`.

When agent completion payloads are too large:

- the SDK retries with a compact version
- then retries with an ultra-minimal version if needed

This preserves governance continuity without requiring unbounded payload growth.

## Debug Logging

`OPENBOX_DEBUG=true` enables summarized request and response logging.

What it logs:

- event type
- activity/workflow identity
- presence of inputs, outputs, spans, and errors
- retry attempts
- verdict metadata summary

What it does not try to do:

- print entire raw governance payloads by default

Recommendation:

- enable in development, staging, and incident debugging
- disable by default in normal production operations unless your logging posture allows it

## Production Hardening Checklist

1. Use HTTPS for OpenBox Core.
2. Keep `validate` enabled in production.
3. Keep OpenBox URL ignored in telemetry.
4. Decide explicitly between `fail_open` and `fail_closed`.
5. Enable file I/O capture only if you actually need it.
6. Review policies so hook-triggered telemetry is not mistakenly treated as a second user action.
7. Use OpenBox guardrails for redaction when handling sensitive prompts or outputs.
