import {
  GovernanceAPIError,
  GovernanceVerdictResponse,
  OpenBoxAuthError,
  OpenBoxNetworkError
} from "../types/index.js";

export type OpenBoxApiErrorPolicy = "fail_open" | "fail_closed";

export interface OpenBoxClientOptions {
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

const USER_AGENT = "OpenBox-SDK/1.0";

export class OpenBoxClient {
  public readonly apiKey: string;
  public readonly apiUrl: string;
  public readonly evaluateMaxRetries: number;
  public readonly evaluateRetryBaseDelayMs: number;
  public readonly onApiError: OpenBoxApiErrorPolicy;
  public readonly timeoutSeconds: number;

  readonly #fetch: typeof fetch;
  readonly #debugEnabled: boolean;

  public constructor({
    apiKey,
    apiUrl,
    evaluateMaxRetries = 0,
    evaluateRetryBaseDelayMs = 150,
    fetch: customFetch,
    onApiError = "fail_open",
    timeoutSeconds = 30
  }: OpenBoxClientOptions) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.evaluateMaxRetries = Math.max(0, Math.floor(evaluateMaxRetries));
    this.evaluateRetryBaseDelayMs = Math.max(0, Math.floor(evaluateRetryBaseDelayMs));
    this.onApiError = onApiError;
    this.timeoutSeconds = timeoutSeconds;
    this.#fetch = customFetch ?? fetch;
    this.#debugEnabled = isOpenBoxDebugEnabled();
  }

  public async validateApiKey(): Promise<void> {
    try {
      const response = await this.#fetch(
        this.#buildUrl("/api/v1/auth/validate"),
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT
          },
          method: "GET",
          signal: AbortSignal.timeout(this.timeoutSeconds * 1000)
        }
      );

      if (response.status === 200) {
        return;
      }

      if (response.status === 401 || response.status === 403) {
        throw new OpenBoxAuthError(
          "Invalid API key. Check your API key at dashboard.openbox.ai"
        );
      }

      throw new OpenBoxNetworkError(
        `Cannot reach OpenBox Core at ${this.apiUrl}: HTTP ${response.status}`
      );
    } catch (error) {
      if (error instanceof OpenBoxAuthError || error instanceof OpenBoxNetworkError) {
        throw error;
      }

      throw new OpenBoxNetworkError(
        `Cannot reach OpenBox Core at ${this.apiUrl}: ${this.#errorMessage(error)}`
      );
    }
  }

  public async evaluate(
    payload: Record<string, unknown>
  ): Promise<GovernanceVerdictResponse | null> {
    return this.#withApiPolicy(async () => this.#evaluateWithRetry(payload));
  }

  public async pollApproval(
    payload: ApprovalPollRequest
  ): Promise<ApprovalPollResponse | null> {
    try {
      if (this.#debugEnabled) {
        console.info("[openbox-sdk] approval.request", {
          activity_id: payload.activityId,
          run_id: payload.runId,
          workflow_id: payload.workflowId
        });
      }

      const response = await this.#fetch(
        this.#buildUrl("/api/v1/governance/approval"),
        {
          body: JSON.stringify({
            activity_id: payload.activityId,
            run_id: payload.runId,
            workflow_id: payload.workflowId
          }),
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT
          },
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutSeconds * 1000)
        }
      );

      if (response.status !== 200) {
        const body = await response.text().catch(() => "");
        if (this.#debugEnabled) {
          console.error("[openbox-sdk] approval.response", {
            reason: body,
            status: response.status
          });
        }

        return null;
      }

      const data = (await response.json()) as ApprovalPollResponse;
      if (this.#debugEnabled) {
        console.info("[openbox-sdk] approval.response", {
          action: data.action,
          status: response.status,
          verdict: data.verdict
        });
      }
      const expirationTime = data.approval_expiration_time;

      if (typeof expirationTime === "string") {
        const parsed = parseApprovalExpiration(expirationTime);

        if (parsed && Date.now() > parsed.getTime()) {
          return {
            ...data,
            expired: true
          };
        }
      }

      return data;
    } catch {
      return null;
    }
  }

  #buildUrl(pathname: string): string {
    return `${this.apiUrl}${pathname}`;
  }

  async #evaluateWithRetry(
    payload: Record<string, unknown>
  ): Promise<GovernanceVerdictResponse> {
    let attempt = 0;

    while (true) {
      try {
        return await this.#evaluateOnce(payload);
      } catch (error) {
        if (
          attempt >= this.evaluateMaxRetries ||
          !isRetryableEvaluateError(error)
        ) {
          throw error;
        }

        const waitMs = this.evaluateRetryBaseDelayMs * 2 ** attempt;

        if (this.#debugEnabled) {
          console.warn("[openbox-sdk] evaluate.retry", {
            attempt: attempt + 1,
            error:
              error instanceof Error ? error.message : String(error),
            wait_ms: waitMs
          });
        }

        attempt += 1;

        if (waitMs > 0) {
          await delay(waitMs);
        }
      }
    }
  }

  async #evaluateOnce(
    payload: Record<string, unknown>
  ): Promise<GovernanceVerdictResponse> {
    if (this.#debugEnabled) {
      console.info("[openbox-sdk] evaluate.request", summarizeEvaluatePayload(payload));
    }

    const response = await this.#fetch(
      this.#buildUrl("/api/v1/governance/evaluate"),
      {
        body: JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT
        },
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutSeconds * 1000)
      }
    );

    if (response.status !== 200) {
      const body = await response.text();

      if (this.#debugEnabled) {
        console.error("[openbox-sdk] evaluate.response", {
          event_type: payload.event_type,
          reason: body,
          status: response.status
        });
      }

      throw new GovernanceAPIError(
        `HTTP ${response.status}: ${body}`
      );
    }

    const parsed = (await response.json()) as Parameters<
      typeof GovernanceVerdictResponse.fromObject
    >[0];

    if (this.#debugEnabled) {
      console.info("[openbox-sdk] evaluate.response", {
        action: parsed.action,
        event_type: payload.event_type,
        status: response.status,
        verdict: parsed.verdict
      });
    }

    return GovernanceVerdictResponse.fromObject(parsed);
  }

  async #withApiPolicy<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      if (this.onApiError === "fail_open") {
        return null;
      }

      if (error instanceof GovernanceAPIError) {
        throw error;
      }

      throw new GovernanceAPIError(this.#errorMessage(error));
    }
  }

  #errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
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
    has_signal_args: payload.signal_args !== undefined,
    has_spans: spanSummary.hasSpans,
    has_workflow_input: payload.workflow_input !== undefined,
    has_workflow_output: payload.workflow_output !== undefined,
    hook_stage:
      payload.hook_trigger &&
      typeof payload.hook_trigger === "object" &&
      "stage" in payload.hook_trigger
        ? (payload.hook_trigger as Record<string, unknown>).stage
        : undefined,
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

function summarizeSpans(
  spans: unknown
): {
  detectedSpanCount: number;
  hasSpans: boolean;
  syntheticModelUsageSpan: boolean;
} {
  if (!Array.isArray(spans)) {
    return {
      detectedSpanCount: 0,
      hasSpans: false,
      syntheticModelUsageSpan: false
    };
  }

  return {
    detectedSpanCount: spans.length,
    hasSpans: spans.length > 0,
    syntheticModelUsageSpan: spans.some(span => {
      if (!span || typeof span !== "object") {
        return false;
      }

      return (
        (span as Record<string, unknown>).name === "openbox.synthetic.model_usage"
      );
    })
  };
}

function isRetryableEvaluateError(error: unknown): boolean {
  if (error instanceof GovernanceAPIError) {
    if (/HTTP\s(429|5\d\d)\b/i.test(error.message)) {
      return true;
    }

    return /(context deadline exceeded|temporarily unavailable|timeout|timed out|connection reset|econnreset|etimedout|upstream connect error)/i.test(
      error.message
    );
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  return /(fetch failed|network|econnreset|etimedout|connection reset)/i.test(
    error.message
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function parseApprovalExpiration(value: string): Date | null {
  const normalized = value.replace(" ", "T").replace(/Z$/, "+00:00");
  const withTimezone = /([+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = new Date(withTimezone);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
