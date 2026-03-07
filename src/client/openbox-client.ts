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
  public readonly onApiError: OpenBoxApiErrorPolicy;
  public readonly timeoutSeconds: number;

  readonly #fetch: typeof fetch;
  readonly #debugEnabled: boolean;

  public constructor({
    apiKey,
    apiUrl,
    fetch: customFetch,
    onApiError = "fail_open",
    timeoutSeconds = 30
  }: OpenBoxClientOptions) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
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
    return this.#withApiPolicy(async () => {
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
    });
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
            "User-Agent": USER_AGENT
          },
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutSeconds * 1000)
        }
      );

      if (response.status !== 200) {
        if (this.#debugEnabled) {
          console.error("[openbox-sdk] approval.response", {
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
  return {
    activity_type: payload.activity_type,
    event_type: payload.event_type,
    has_activity_input: Object.hasOwn(payload, "activity_input"),
    has_activity_output: Object.hasOwn(payload, "activity_output"),
    has_error: Object.hasOwn(payload, "error"),
    has_signal_args: Object.hasOwn(payload, "signal_args"),
    has_workflow_input: Object.hasOwn(payload, "workflow_input"),
    has_workflow_output: Object.hasOwn(payload, "workflow_output"),
    run_id: payload.run_id,
    workflow_id: payload.workflow_id,
    workflow_type: payload.workflow_type
  };
}

function parseApprovalExpiration(value: string): Date | null {
  const normalized = value.replace(" ", "T").replace(/Z$/, "+00:00");
  const withTimezone = /([+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = new Date(withTimezone);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
