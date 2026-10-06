import { OpenBoxClient as BaseOpenBoxClient } from "@openbox-ai/openbox-sdk/client";
import type { JsonValue } from "@openbox-ai/openbox-sdk";
import type { OpenBoxConfig as BaseOpenBoxConfig } from "@openbox-ai/openbox-sdk/config";

import {
  GovernanceAPIError,
  GovernanceVerdictResponse,
  OpenBoxAuthError,
  Verdict
} from "../types/index.js";
import {
  resolveBaseOpenBoxConfig,
  type OpenBoxIdentityOptions
} from "../config/base-config.js";
import type { OpenBoxConfig } from "../config/openbox-config.js";

export type {
  WorkloadBootstrapDocument,
  WorkloadIdentitySource,
  WorkloadTransitionProofOptions,
  WorkloadTransitionProofResult
} from "@openbox-ai/openbox-sdk/client";

export type OpenBoxApiErrorPolicy = "fail_open" | "fail_closed";

export interface OpenBoxClientOptions extends OpenBoxIdentityOptions {
  apiKey: string;
  apiUrl: string;
  evaluateMaxRetries?: number | undefined;
  evaluateRetryBaseDelayMs?: number | undefined;
  fetch?: typeof fetch;
  onApiError?: OpenBoxApiErrorPolicy | undefined;
  timeoutSeconds?: number | undefined;
}

export interface ApprovalPollRequest {
  activityId: string;
  runId: string;
  workflowId: string;
}

export interface ApprovalPollResponse {
  action?: string | undefined;
  approval_expiration_time?: string | null | undefined;
  expired?: boolean | undefined;
  reason?: string | undefined;
  verdict?: string | undefined;
  [key: string]: unknown;
}

/** Mastra response/payload compatibility over one base client and token cache. */
export class OpenBoxClient {
  public readonly agentDid: string | undefined;
  public readonly agentPrivateKey: string | undefined;
  public readonly apiKey: string;
  public readonly apiUrl: string;
  public readonly evaluateMaxRetries: number;
  public readonly evaluateRetryBaseDelayMs: number;
  public readonly onApiError: OpenBoxApiErrorPolicy;
  public readonly timeoutSeconds: number;
  /** Resolved connection identity; an injected client remains authoritative. */
  public readonly config: BaseOpenBoxConfig;

  readonly #client: BaseOpenBoxClient;
  readonly #debugEnabled = isOpenBoxDebugEnabled();

  public constructor(options: OpenBoxClientOptions) {
    // Direct construction is explicit-only; parseOpenBoxConfig resolves envs.
    this.config = resolveBaseOpenBoxConfig(options, {});
    this.agentDid = this.config.agentDid ?? undefined;
    this.agentPrivateKey = this.config.agentPrivateKey ?? undefined;
    this.apiKey = this.config.apiKey;
    this.apiUrl = this.config.apiUrl;
    this.evaluateMaxRetries = Math.max(
      0,
      Math.floor(options.evaluateMaxRetries ?? 0)
    );
    this.evaluateRetryBaseDelayMs = Math.max(
      0,
      Math.floor(options.evaluateRetryBaseDelayMs ?? 150)
    );
    this.onApiError = options.onApiError ?? "fail_open";
    this.timeoutSeconds = this.config.timeoutSeconds;
    const transport = options.fetch ?? globalThis.fetch;
    this.#client = BaseOpenBoxClient.fromConfig(this.config, {
      fetchImpl: (input, init) => {
        // Retain Mastra's JSON content type for unsigned Core requests. The
        // base SDK's token exchange already sets its form content type.
        const headers = new Headers(init?.headers);
        if (!headers.has("Content-Type"))
          headers.set("Content-Type", "application/json");
        return transport(input, { ...init, headers });
      }
    });
  }

  public static fromConfig(
    config: OpenBoxConfig,
    options: { fetch?: typeof fetch } = {}
  ): OpenBoxClient {
    return new OpenBoxClient({
      ...config,
      ...options,
      timeoutSeconds: config.governanceTimeout
    });
  }

  public async validateApiKey(): Promise<void> {
    await this.#client.validateApiKey();
  }

  public async evaluate(
    payload: Record<string, unknown>
  ): Promise<GovernanceVerdictResponse | null> {
    const normalized = normalizeEvaluatePayload(payload);
    if (this.#debugEnabled) {
      console.info(
        "[openbox-sdk] evaluate.request",
        summarizeEvaluatePayload(normalized)
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.#client.evaluate(normalized as JsonValue);
        // Keep Mastra's null-on-outage API. Retry by making a new base call so
        // each attempt prepares its own identity proof; never replay auth errors.
        // Only a locally synthesized outage result has no raw response. A
        // server verdict (including BLOCK) must survive its fallback flag.
        if (result.fallbackUsed && Object.keys(result.raw).length === 0) {
          if (
            attempt < this.evaluateMaxRetries &&
            isRetryableOutage(result.reason ?? "")
          ) {
            await this.#waitForRetry(attempt);
            continue;
          }
          return null;
        }
        if (this.#debugEnabled) {
          console.info("[openbox-sdk] evaluate.response", {
            event_type: normalized.event_type,
            verdict: result.verdict,
            action: result.action
          });
        }
        return GovernanceVerdictResponse.fromObject(result.raw);
      } catch (error) {
        if (
          attempt >= this.evaluateMaxRetries ||
          !isRetryableEvaluateError(error)
        )
          throw error;
        await this.#waitForRetry(attempt);
      }
    }
  }

  public async pollApproval(
    payload: ApprovalPollRequest
  ): Promise<ApprovalPollResponse | null> {
    if (this.#debugEnabled) {
      console.info("[openbox-sdk] approval.request", {
        activity_id: payload.activityId,
        run_id: payload.runId,
        workflow_id: payload.workflowId
      });
    }
    const result = await this.#client.pollApproval(
      payload.workflowId,
      payload.runId,
      payload.activityId
    );
    if (this.#debugEnabled) {
      console.info("[openbox-sdk] approval.response", {
        action: result?.action,
        verdict: result?.verdict,
        expired: result?.expired
      });
    }
    // Base checks expiry before recording raw; keep Mastra's passthrough shape.
    return result ? (result.raw as ApprovalPollResponse) : null;
  }

  async #waitForRetry(attempt: number): Promise<void> {
    const waitMs = this.evaluateRetryBaseDelayMs * 2 ** attempt;
    if (this.#debugEnabled) {
      console.warn("[openbox-sdk] evaluate.retry", {
        attempt: attempt + 1,
        wait_ms: waitMs
      });
    }
    await delay(waitMs);
  }

  public identityMetadata(): ReturnType<BaseOpenBoxClient["identityMetadata"]> {
    return this.#client.identityMetadata();
  }

  public refreshIdentityMetadata(): ReturnType<
    BaseOpenBoxClient["refreshIdentityMetadata"]
  > {
    return this.#client.refreshIdentityMetadata();
  }

  public workloadIdentityMetadata(): ReturnType<
    BaseOpenBoxClient["workloadIdentityMetadata"]
  > {
    return this.#client.workloadIdentityMetadata();
  }

  public refreshWorkloadIdentity(): ReturnType<
    BaseOpenBoxClient["refreshWorkloadIdentity"]
  > {
    return this.#client.refreshWorkloadIdentity();
  }

  public proveWorkloadIdentityTransition(
    options: Parameters<BaseOpenBoxClient["proveWorkloadIdentityTransition"]>[0]
  ): ReturnType<BaseOpenBoxClient["proveWorkloadIdentityTransition"]> {
    return this.#client.proveWorkloadIdentityTransition(options);
  }

  public close(): void {
    this.#client.close();
  }

  public toJSON(): Record<string, unknown> {
    return this.#client.toJSON();
  }

  public [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }
}

/**
 * Strict HITL approval-decision parsing (migration-notes.md "approval wire
 * format" — base wins). Mirrors base's `ApprovalResult`-internal decision
 * vocabulary: an explicit, closed set of accepted decision strings; anything
 * outside it (garbled/unknown/missing) resolves to `null` (still pending) —
 * NEVER an implicit ALLOW. Call sites previously used the lenient
 * evaluate-path parser (`Verdict.fromString`, which defaults unknown -> ALLOW)
 * for this human-approval trust boundary; that was too loose (an unrecognized
 * decision string would silently approve).
 */
const APPROVAL_DECISION_VOCABULARY = new Set<string>([
  "allow",
  "constrain",
  "require_approval",
  "request_approval",
  "block",
  "halt",
  "continue",
  "stop"
]);

export function parseApprovalDecision(
  approval: Pick<ApprovalPollResponse, "action" | "verdict">
): Verdict | null {
  // Match base's `ApprovalResult.fromDict`: an empty/whitespace `action` is
  // ABSENT, not present-but-blank — it must fall through to `verdict` rather
  // than shadow it. `approval.action ?? approval.verdict` was wrong here
  // because `??` only falls through on null/undefined, not on `""`, so
  // `{action:"", verdict:"allow"}` resolved to `""` (pending) forever instead
  // of reading the `verdict` fallback.
  const action =
    typeof approval.action === "string" && approval.action.trim().length > 0
      ? approval.action
      : undefined;
  const raw = action !== undefined ? action : approval.verdict;

  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  const normalized = raw.trim().toLowerCase().replaceAll("-", "_");

  return APPROVAL_DECISION_VOCABULARY.has(normalized)
    ? Verdict.fromString(normalized)
    : null;
}

function isOpenBoxDebugEnabled(): boolean {
  const value = process.env.OPENBOX_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function summarizeEvaluatePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const spanSummary = summarizeSpans(payload.spans);

  return {
    activity_id: payload.activity_id,
    activity_type: payload.activity_type,
    event_type: payload.event_type,
    has_activity_input: payload.activity_input !== undefined,
    has_activity_output: payload.activity_output !== undefined,
    has_error: payload.error !== undefined,
    has_goal:
      typeof payload.goal === "string" && payload.goal.trim().length > 0,
    has_signal_args: payload.signal_args !== undefined,
    has_spans: spanSummary.hasSpans,
    has_workflow_input: payload.workflow_input !== undefined,
    has_workflow_output: payload.workflow_output !== undefined,
    hook_stage:
      payload.hook_trigger === true ? spanSummary.latestSpanStage : undefined,
    run_id: payload.run_id,
    span_count:
      typeof payload.span_count === "number"
        ? payload.span_count
        : spanSummary.detectedSpanCount,
    synthetic_model_usage_span: spanSummary.syntheticModelUsageSpan,
    workflow_model_id:
      typeof payload.model_id === "string" ? payload.model_id : undefined,
    workflow_model_provider:
      typeof payload.model_provider === "string"
        ? payload.model_provider
        : typeof payload.provider === "string"
          ? payload.provider
          : undefined,
    workflow_id: payload.workflow_id,
    workflow_type: payload.workflow_type
  };
}

function normalizeEvaluatePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...payload };
  const eventType =
    typeof normalized.event_type === "string"
      ? normalized.event_type
      : undefined;
  const legacyHookSpan = extractLegacyHookSpanFromTrigger(
    normalized.hook_trigger
  );
  const normalizedHookTrigger = normalizeHookTrigger(normalized.hook_trigger);

  if (normalizedHookTrigger !== undefined) {
    normalized.hook_trigger = normalizedHookTrigger;
  }

  if (eventType === "ActivityCompleted") {
    const normalizedSpans =
      normalizeSpansField(normalized.spans) ??
      (legacyHookSpan ? [legacyHookSpan] : undefined);

    if (normalizedHookTrigger === true || legacyHookSpan !== undefined) {
      normalized.hook_trigger = true;
      normalized.spans = normalizedSpans ?? [];
      normalized.span_count = (normalized.spans as unknown[]).length;
      return normalized;
    }

    delete normalized.spans;
    delete normalized.hook_trigger;
    normalized.span_count = 0;

    return normalized;
  }

  if (eventType === "ActivityStarted") {
    const normalizedSpans =
      normalizeSpansField(normalized.spans) ??
      (legacyHookSpan ? [legacyHookSpan] : undefined);

    if (normalizedSpans !== undefined) {
      normalized.spans = normalizedSpans;
      normalized.span_count = normalizedSpans.length;
      return normalized;
    }

    if (normalized.hook_trigger === true) {
      normalized.spans = [];
      normalized.span_count = 0;
    }
  }

  return normalized;
}

function normalizeHookTrigger(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }

    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off" ||
      normalized.length === 0
    ) {
      return false;
    }
  }

  if (typeof value === "object") {
    return value !== null;
  }

  return Boolean(value);
}

function extractLegacyHookSpanFromTrigger(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const hasHookShape =
    typeof record.type === "string" ||
    typeof record.hook_type === "string" ||
    typeof record.stage === "string" ||
    typeof record.method === "string" ||
    typeof record.url === "string" ||
    typeof record.http_method === "string" ||
    typeof record.http_url === "string" ||
    typeof record.db_operation === "string" ||
    typeof record.db_statement === "string" ||
    typeof record.file_operation === "string" ||
    typeof record.file_path === "string" ||
    typeof record.function === "string";

  if (!hasHookShape) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {
    ...record
  };

  if (
    typeof normalized.type === "string" &&
    typeof normalized.hook_type !== "string"
  ) {
    normalized.hook_type = normalized.type;
  }

  delete normalized.type;
  return normalized;
}

function normalizeSpansField(
  value: unknown
): Record<string, unknown>[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(
      (span) => span !== null && typeof span === "object"
    ) as Record<string, unknown>[];
  }

  if (value !== null && typeof value === "object") {
    return [value as Record<string, unknown>];
  }

  return [];
}

function summarizeSpans(spans: unknown): {
  detectedSpanCount: number;
  hasSpans: boolean;
  latestSpanStage: string | undefined;
  syntheticModelUsageSpan: boolean;
} {
  if (!Array.isArray(spans)) {
    return {
      detectedSpanCount: 0,
      hasSpans: false,
      latestSpanStage: undefined,
      syntheticModelUsageSpan: false
    };
  }

  const spanList = spans as unknown[];
  const latestSpan =
    spanList.length > 0 ? spanList[spanList.length - 1] : undefined;
  const latestSpanStage =
    latestSpan && typeof latestSpan === "object"
      ? (() => {
          const stage = (latestSpan as Record<string, unknown>).stage;

          return typeof stage === "string" ? stage : undefined;
        })()
      : undefined;

  return {
    detectedSpanCount: spanList.length,
    hasSpans: spanList.length > 0,
    latestSpanStage,
    syntheticModelUsageSpan: spanList.some((span) => {
      if (!span || typeof span !== "object") {
        return false;
      }

      return (
        (span as Record<string, unknown>).name ===
        "openbox.synthetic.model_usage"
      );
    })
  };
}

function isRetryableEvaluateError(error: unknown): boolean {
  // Workload acquisition errors inherit OpenBoxAuthError, even for outages.
  return (
    !(error instanceof OpenBoxAuthError) &&
    error instanceof GovernanceAPIError &&
    isRetryableOutage(error.message)
  );
}

function isRetryableOutage(message: string): boolean {
  return (
    /^Governance API unreachable:/.test(message) ||
    /^Governance API error: HTTP (408|425|429|5\d\d)\b/.test(message)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
