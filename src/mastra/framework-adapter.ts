/**
 * `MastraFrameworkAdapter` — Mastra's implementation of the base SDK's
 * `FrameworkAdapter` (`@openbox-ai/openbox-sdk/adapters`), the "ONE seam
 * where governance verdicts become framework-native effects" (base's own
 * doc comment). Mapping BLOCK/HALT/approval verdicts to Mastra-native error
 * classes lives HERE, not scattered across `wrap-*.ts`/`activity-runtime.ts`.
 *
 * Verdict -> error mapping is deliberately COARSER than base's default
 * `CoreAdapter`: base distinguishes BLOCK (`GovernanceBlockedError`) from
 * HALT (`GovernanceHaltError`); every existing Mastra call site has always
 * thrown `GovernanceHaltError` for BOTH (via `Verdict.shouldStop()`), and
 * consumers catch-by-class on it. Introducing a second, distinct error type
 * for BLOCK here would be an undocumented, unnecessary public API break, so
 * both verdicts map to `GovernanceHaltError` — see migration-notes.md.
 *
 * `waitForApproval` is the concrete "wire wrappers to base runtime" seam for
 * phase-06: it is the poll-until-decided implementation used both by
 * `handleApproval` (the base `FrameworkAdapter` contract: called BEFORE the
 * real operation runs, resolve = approved) AND by
 * `governance/activity-runtime.ts`'s inline-wait fallback (still local, but
 * no longer duplicating the loop) for Mastra's own completed-hook/approval
 * flow, which additionally needs `workflow.suspend()` context this generic
 * interface does not carry.
 */
import type { ActivityContext, EvaluationResult } from "@openbox-ai/openbox-sdk";
import type { FrameworkAdapter } from "@openbox-ai/openbox-sdk/adapters";

import { parseApprovalDecision, type OpenBoxClient } from "../client/index.js";
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceHaltError,
  Verdict
} from "../types/index.js";

export interface MastraApprovalWaitOptions {
  backoffMultiplier?: number;
  initialPollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
}

export interface MastraFrameworkAdapterOptions {
  /** Default poll options `handleApproval` uses (the `FrameworkAdapter` interface method takes no options of its own). */
  approvalWaitOptions?: MastraApprovalWaitOptions;
  client: OpenBoxClient;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_INITIAL_POLL_INTERVAL_MS = 2_500;
const DEFAULT_MAX_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

export class MastraFrameworkAdapter implements FrameworkAdapter {
  public readonly name = "mastra";
  readonly #client: OpenBoxClient;
  readonly #approvalWaitOptions: MastraApprovalWaitOptions;

  public constructor({ approvalWaitOptions, client }: MastraFrameworkAdapterOptions) {
    this.#client = client;
    this.#approvalWaitOptions = approvalWaitOptions ?? {};
  }

  public async handleApproval(
    result: EvaluationResult,
    context?: ActivityContext | null
  ): Promise<void> {
    // Core's evaluate response does NOT echo the workflow/run/activity IDs, so
    // the base runtime threads the originating context in. `result.raw` is only
    // a fallback for an older base runtime that predates the context argument.
    const workflowId = context?.workflowId || readRawString(result.raw, "workflow_id");
    const runId = context?.runId || readRawString(result.raw, "run_id");
    const activityId = context?.activityId || readRawString(result.raw, "activity_id");

    await this.waitForApproval(
      workflowId,
      runId,
      activityId,
      result.reason ?? undefined,
      this.#approvalWaitOptions
    );
  }

  public raiseLifecycleBlocked(result: EvaluationResult): never {
    throw new GovernanceHaltError(
      `Governance blocked: ${result.reason ?? "No reason provided"}`
    );
  }

  public raiseHookBlocked(result: EvaluationResult): never {
    throw new GovernanceHaltError(
      `Governance blocked: ${result.reason ?? "No reason provided"}`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional no-op; params kept to match the FrameworkAdapter call signature
  public onCompletedHookResult(_result: EvaluationResult, _context?: ActivityContext | null): void {
    // Mastra's completed-hook handling drives its OWN approval-suspend flow
    // (workflow.suspend / setPendingApproval) inline in
    // governance/activity-runtime.ts and otel/setup-openbox-opentelemetry.ts,
    // because it needs Mastra's workflow-suspend context, which this generic
    // seam does not carry. No-op here, matching base's default `CoreAdapter`.
  }

  /**
   * Poll until the approval is decided (allow-shaped -> resolve; rejected ->
   * `ApprovalRejectedError`; expired -> `ApprovalExpiredError`) or the wait
   * budget is exhausted (`ApprovalPendingError`). Uses strict decision
   * parsing (`parseApprovalDecision`) at this human-approval trust boundary.
   */
  public async waitForApproval(
    workflowId: string,
    runId: string,
    activityId: string,
    pendingReason?: string,
    options: MastraApprovalWaitOptions = {}
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    let pollIntervalMs = options.initialPollIntervalMs ?? DEFAULT_INITIAL_POLL_INTERVAL_MS;
    const timeoutAt = Date.now() + timeoutMs;

    while (Date.now() < timeoutAt) {
      await delay(pollIntervalMs);

      if (Date.now() >= timeoutAt) {
        break;
      }

      const approval = await this.#client.pollApproval({
        activityId,
        runId,
        workflowId
      });

      if (!approval) {
        pollIntervalMs = Math.min(
          maxPollIntervalMs,
          Math.ceil(pollIntervalMs * backoffMultiplier)
        );
        continue;
      }

      if (approval.expired) {
        throw new ApprovalExpiredError(`Approval expired for activity ${activityId}`);
      }

      const verdict = parseApprovalDecision(approval);

      if (verdict === Verdict.ALLOW) {
        return;
      }

      if (verdict !== null && Verdict.shouldStop(verdict)) {
        throw new ApprovalRejectedError(
          `Activity rejected: ${String(approval.reason ?? "Activity rejected")}`
        );
      }

      pollIntervalMs = Math.min(
        maxPollIntervalMs,
        Math.ceil(pollIntervalMs * backoffMultiplier)
      );
    }

    throw new ApprovalPendingError(
      pendingReason ?? `Awaiting approval for activity ${activityId}`
    );
  }
}

function readRawString(raw: Readonly<Record<string, unknown>>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
