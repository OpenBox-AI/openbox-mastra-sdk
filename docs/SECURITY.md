# Security Policy

## Privacy Defaults

- HTTP request and response bodies are captured separately from OTel span attributes.
- HTTP headers are captured separately from OTel span attributes.
- File I/O instrumentation is opt-in.
- System paths are skipped during file I/O instrumentation.
- OpenBox governance payloads receive redacted inputs and outputs after guardrail processing.

## Transport Safety

- `https://` is required for non-localhost OpenBox URLs.
- `http://localhost`, `http://127.0.0.1`, and `http://::1` are allowed for local development.
- API keys are validated against `GET /api/v1/auth/validate` when `validate` is enabled.

## Failure Policy

- `fail_open` allows execution when OpenBox is unavailable.
- `fail_closed` converts OpenBox failures into halting governance behavior.

Choose `fail_closed` for production systems where governance availability is mandatory.

## Sensitive Data Handling

- Do not attach raw secrets to tool inputs, workflow state, or agent prompts unless guardrails or application redaction removes them first.
- Do not log API keys or approval payloads outside your own secured logging pipeline.
- Review `skipWorkflowTypes`, `skipActivityTypes`, and `skipSignals` carefully so you do not create blind spots unintentionally.

## Reporting

Report security issues privately to the OpenBox maintainers through the project’s standard disclosure channel. Do not open public issues for active vulnerabilities.
