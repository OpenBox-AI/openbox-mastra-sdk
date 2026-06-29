# Changelog

## 0.2.1 - 2026-06-30

### Changed

- Added Mastra multi-agent session grouping for governed agent, workflow, and tool events. When enabled, the SDK emits `multi_agent_session_id` across evaluation payloads so related child-agent runs can be grouped in OpenBox.
- Added `multiAgent` configuration with `OPENBOX_MULTI_AGENT_ENABLED`, `OPENBOX_MULTI_AGENT_SESSION_ID`, and custom resolver support. If enabled without an explicit session id, the SDK defaults to `mas:<runId>`.

### Notes

- Added unit coverage for multi-agent configuration and resolver behavior.
- Refreshed release-adjacent lockfile and security workflow maintenance from the previous development changes.
