# AGENTS.md

Guidance for coding agents working in `@openbox-ai/openbox-mastra-sdk`, the OpenBox
governance SDK for [Mastra](https://mastra.ai). Read this before changing code.

## What this package does

`withOpenBox(mastra)` wraps a Mastra instance so every tool call, workflow step, agent run and
the HTTP / database / file calls made inside them are evaluated by OpenBox Core before they run.
A verdict can allow, constrain, require approval, block or halt the operation.

The SDK is a thin Mastra adapter over the base SDK `@openbox-ai/openbox-sdk-ts` (installed
as `@openbox-ai/openbox-sdk`). Identity, signing, transport, token refresh and verdict
contracts live in the base SDK. This package maps Mastra's lifecycle onto them.

## Commands

```bash
npm ci                 # Node >= 24.10 (package engines; CI uses 24.10)
npm run lint
npm run typecheck
npm test               # vitest with coverage; thresholds are enforced
npm run build          # tsup -> dist/
npm run pack:check     # what would be published
npm run ci:check       # lint + typecheck + test + build, as CI runs them
```

Run a single file: `npx vitest run test/contract/wrap-tool.test.ts`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/mastra/with-openbox.ts` | `withOpenBox()`, the main entry point: config, client, telemetry, wrapping |
| `src/mastra/wrap-tool.ts`, `wrap-workflow.ts`, `wrap-agent.ts` | how each Mastra primitive is governed |
| `src/governance/activity-runtime.ts` | the activity lifecycle: ActivityStarted / ActivityCompleted, approvals, verdict handling |
| `src/client/openbox-client.ts` | Mastra's client, built on the base SDK client (`OpenBoxClient.fromConfig`) |
| `src/config/` | config parsing (`OPENBOX_*` variables), identity options, secret redaction |
| `src/otel/`, `src/span/` | OpenTelemetry setup and the span processor that turns HTTP/DB/file spans into hook events |
| `src/types/` | verdicts, event types, errors |
| `src/version.ts` | `SDK_VERSION`, sent to Core in the User-Agent |
| `test/unit`, `test/contract`, `test/integration`, `test/conformance`, `test/privacy` | tests; contract tests run against the fake Core in `test/helpers` |
| `docs/` | user-facing documentation |

## Rules that must hold

These are what make the SDK safe. A change that breaks one is a bug, however small.

1. **Fail closed on auth.** At a gating point (anything that decides whether the real operation
   runs: ActivityStarted, WorkflowStarted, hook preflight, resume), rethrow `OpenBoxAuthError`
   (including `OpenBoxSigningError`), `GovernanceAPIError` and `ContractError`. Only a network /
   outage error may fail open under `onApiError: "fail_open"`. Never write
   `try { ... } catch { return ALLOW }` around an evaluation. See the base SDK's
   `docs/framework-adapter-guide.md`.
2. **After the operation, evaluation is telemetry.** ActivityCompleted and other post-operation
   events may log and swallow errors. They can never undo work that already ran.
3. **Let the base SDK own identity.** Build the client with `OpenBoxClient.fromConfig`. Never mint
   tokens or assertions here, and never add a `validate` / observe-only toggle around the
   always-strict validation gate.
4. **Redact before signing.** Privacy redaction happens before a request is signed and sent.
5. **Keep secrets out of output.** Secret config fields (`apiKey`, private keys) are
   non-enumerable (`redactConfig`). Read them as properties and pass them on explicitly, and never
   log a config or a request with credentials in it.

## How Core sees events (learned the hard way)

- **A run needs a session.** Core opens a session on `WorkflowStarted` and rejects activity
  events for a run without one (`SessionNotReady`, HTTP 500). A tool called outside any workflow
  or agent therefore gets a run of its own (`WorkflowStarted` / `WorkflowCompleted` on
  `tool:<id>`). Keep that when touching `executeGovernedActivity`.
- **`activity_type` is camelCase by default.** A tool `issue_refund` is sent as `issueRefund`, and
  policies match on that. `activityTypeFormat: "original"` sends ids unchanged. Changing the
  default breaks existing policies.
- **Both activity events carry `activity_type`** (from 2.0.1; 2.0.0 left it off ActivityCompleted
  when human-in-the-loop was on). The dashboard labels rows with it. A
  REQUIRE_APPROVAL returned on ActivityCompleted is logged and the output kept, because the tool
  already ran. Start-stage approvals suspend (in a workflow) or wait inline.
- **Parallel tool calls interleave.** Two tools from one model turn run concurrently, so their
  Started/Completed events interleave. Each pair is linked by `activity_id`.

## Tests

- Add or update a test with every behaviour change. Contract tests (`test/contract`) spin up the
  fake Core from `test/helpers/openbox-server`; assert on the events it received.
- Don't hard-code the SDK version in tests; import `SDK_VERSION` from `src/version.ts`.
- Coverage thresholds are enforced in `vitest.config.ts`; don't lower them to make a change pass.

## Versions and the changelog

- `version` in `package.json` and `SDK_VERSION` in `src/version.ts` must match. Core identifies
  the SDK by it.
- Record user-visible changes in `CHANGELOG.md` (Keep a Changelog), under the version they ship
  in. Breaking changes go under **Breaking** with what to do about them.
- The supported Mastra range is the `@mastra/core` peer dependency (currently `^1.8.0`).

## Branches, commits and PRs

- Branch names: `<type>/<short-description>`, where type is `feat`, `fix`, `hotfix`, `chore`,
  `docs`, `refactor`, `test`, `ci`, `build` or `release` (checked by `pr-governance.yml`).
- PR titles follow Conventional Commits: `fix(scope): ...`, `feat!: ...` (also checked).
- Put the Jira key (`PROD-<n>`) in every commit message. In the PR title it goes after the
  Conventional Commits prefix, since the title must start with the type.
- Commit messages, PR titles and PR descriptions describe the change in plain language and carry
  no tool or assistant attribution.
- `main` requires one approving review from someone other than the PR's author.

## Releasing

Pushing a version tag (`2.0.1`, no `v`) on `main` runs `release.yml`: governance, quality,
security and SonarQube gates, then publish to npm with provenance from the `release`
environment. The tag must match `package.json`'s version. Publishing needs npm trusted
publishing for this workflow, or an `NPM_TOKEN` that can publish under the org's 2FA rule.

## Local gotchas

- npm 11's peer-dependency resolver can crash on Mastra trees (`Cannot read properties of null
  (reading 'edgesOut')`). Retry with `--legacy-peer-deps`.
- In zsh, don't name a shell variable `path`. It is tied to `PATH`.
- Scripts that call the management API (`api.openbox.ai`) from a server are stopped by a
  Cloudflare challenge. Core (`core.openbox.ai`) accepts authenticated API traffic.
