import { randomUUID } from "node:crypto";

import { trace } from "@opentelemetry/api";

import {
  clearPendingApproval,
  getPendingApproval
} from "../governance/approval-registry.js";
import {
  normalizeSpansForGovernance,
  serializeValue
} from "../governance/activity-runtime.js";
import { runWithOpenBoxExecutionContext } from "../governance/context.js";
import type { GovernanceVerdictResponse } from "../types/index.js";
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
  GovernanceAPIError,
  GovernanceHaltError,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "../types/index.js";
import type { WrapToolOptions } from "./wrap-tool.js";

const OPENBOX_WRAPPED_AGENT = Symbol.for("openbox.mastra.wrapAgent");
const OPENBOX_AGENT_STREAM_META = Symbol.for("openbox.mastra.wrapAgent.streamMeta");

interface AgentStreamMeta {
  startTimeMs: number;
}

export function wrapAgent<TAgent>(agent: TAgent, options: WrapToolOptions): TAgent {
  const baseAgent = agent as Record<PropertyKey, unknown> & {
    generate?: (messages: unknown, options?: Record<string, unknown>) => Promise<any>;
    id?: string;
    name?: string;
    resumeGenerate?: (
      resumeData: unknown,
      options?: Record<string, unknown>
    ) => Promise<any>;
    resumeStream?: (
      resumeData: unknown,
      options?: Record<string, unknown>
    ) => Promise<any>;
    stream?: (messages: unknown, options?: Record<string, unknown>) => Promise<any>;
  };

  if (baseAgent[OPENBOX_WRAPPED_AGENT]) {
    return agent;
  }

  const workflowType = String(baseAgent.id ?? baseAgent.name ?? "agent");
  const workflowId = `agent:${workflowType}`;
  const originalGenerate = baseAgent.generate?.bind(baseAgent);
  const originalStream = baseAgent.stream?.bind(baseAgent);
  const originalResumeGenerate = baseAgent.resumeGenerate?.bind(baseAgent);
  const originalResumeStream = baseAgent.resumeStream?.bind(baseAgent);

  if (originalGenerate) {
    baseAgent.generate = async (messages, executionOptions = {}) => {
      const runId = String(executionOptions.runId ?? randomUUID());
      const nextOptions = {
        ...executionOptions,
        runId
      };

      return executeAgentLifecycle(
        {
          messages,
          operation: () => originalGenerate(messages, nextOptions),
          options,
          phase: "start",
          runId,
          workflowId,
          workflowType
        }
      );
    };
  }

  if (originalStream) {
    baseAgent.stream = async (messages, executionOptions = {}) => {
      const runId = String(executionOptions.runId ?? randomUUID());
      const nextOptions = {
        ...executionOptions,
        runId
      };
      const output = await executeAgentLifecycle(
        {
          messages,
          operation: () => originalStream(messages, nextOptions),
          options,
          phase: "start",
          runId,
          workflowId,
          workflowType
        }
      );

      if (output && typeof output === "object") {
        const streamMeta = getAgentStreamMeta(output);
        attachStreamLifecycleHandlers(output, {
          onFailure: async error => {
            await sendAgentFailure(
              options,
              runId,
              workflowId,
              workflowType,
              error,
              streamMeta
            );
          },
          onSuccess: async fullOutput => {
            await finalizeAgentSuccess(
              options,
              runId,
              workflowId,
              workflowType,
              fullOutput,
              streamMeta
            );
          }
        });
      }

      return output;
    };
  }

  if (originalResumeGenerate) {
    baseAgent.resumeGenerate = async (resumeData, executionOptions = {}) => {
      const runId = executionOptions.runId ? String(executionOptions.runId) : undefined;

      await handleAgentResume(
        options,
        runId,
        workflowId,
        workflowType,
        resumeData
      );

      return executeAgentLifecycle({
        operation: () => originalResumeGenerate(resumeData, executionOptions),
        options,
        phase: "resume",
        runId: runId ?? randomUUID(),
        workflowId,
        workflowType
      });
    };
  }

  if (originalResumeStream) {
    baseAgent.resumeStream = async (resumeData, executionOptions = {}) => {
      const runId = executionOptions.runId ? String(executionOptions.runId) : undefined;

      await handleAgentResume(
        options,
        runId,
        workflowId,
        workflowType,
        resumeData
      );

      const output = await executeAgentLifecycle({
        operation: () => originalResumeStream(resumeData, executionOptions),
        options,
        phase: "resume",
        runId: runId ?? randomUUID(),
        workflowId,
        workflowType
      });

      if (output && typeof output === "object") {
        const resolvedRunId = runId ?? randomUUID();
        const streamMeta = getAgentStreamMeta(output);
        attachStreamLifecycleHandlers(output, {
          onFailure: async error => {
            await sendAgentFailure(
              options,
              resolvedRunId,
              workflowId,
              workflowType,
              error,
              streamMeta
            );
          },
          onSuccess: async fullOutput => {
            await finalizeAgentSuccess(
              options,
              resolvedRunId,
              workflowId,
              workflowType,
              fullOutput,
              streamMeta
            );
          }
        });
      }

      return output;
    };
  }

  Object.defineProperty(baseAgent, OPENBOX_WRAPPED_AGENT, {
    enumerable: false,
    value: true
  });

  return agent;
}

async function executeAgentLifecycle<T>({
  messages,
  operation,
  options,
  phase,
  runId,
  workflowId,
  workflowType
}: {
  messages?: unknown;
  operation: () => Promise<T>;
  options: WrapToolOptions;
  phase: "resume" | "start";
  runId: string;
  workflowId: string;
  workflowType: string;
}): Promise<T> {
  if (
    phase === "start" &&
    !options.config.skipWorkflowTypes.has(workflowType) &&
    options.config.sendStartEvent
  ) {
    const verdict = await evaluateAgentEvent(options, {
      event_type: WorkflowEventType.WORKFLOW_STARTED,
      run_id: runId,
      task_queue: "mastra",
      workflow_id: workflowId,
      workflow_input: serializeValue(messages),
      workflow_type: workflowType
    });

    if (verdict && Verdict.shouldStop(verdict.verdict)) {
      throw new GovernanceHaltError(
        verdict.reason ?? "Agent blocked by governance"
      );
    }
  }

  ensureAgentSpanBuffer(options, runId, workflowId, workflowType);
  const startTimeMs = Date.now();

  return runWithOpenBoxExecutionContext(
    {
      agentId: workflowType,
      runId,
      source: "agent",
      taskQueue: "mastra",
      workflowId,
      workflowType
    },
    async () => {
      try {
        const result = await trace
          .getTracer("openbox.mastra")
          .startActiveSpan(`agent.${phase}.${workflowType}`, async activeSpan => {
            activeSpan.setAttribute("openbox.workflow_id", workflowId);
            activeSpan.setAttribute("openbox.activity_id", `agent:${workflowType}:${phase}`);
            options.spanProcessor.registerTrace(
              activeSpan.spanContext().traceId,
              workflowId,
              `agent:${workflowType}:${phase}`
            );

            try {
              return await operation();
            } finally {
              activeSpan.end();
            }
          });
        const isStreamResult =
          result != null &&
          typeof result === "object" &&
          ("getFullOutput" in (result as Record<string, unknown>) ||
            "fullStream" in (result as Record<string, unknown>));

        if (
          !isStreamResult
        ) {
          const finishReason =
            result != null && typeof result === "object"
              ? (result as { finishReason?: unknown }).finishReason
              : undefined;

          if (finishReason === "suspended") {
            return result;
          }

          await finalizeAgentSuccess(
            options,
            runId,
            workflowId,
            workflowType,
            result,
            {
              startTimeMs
            }
          );
        }

        if (isStreamResult) {
          setAgentStreamMeta(result as Record<PropertyKey, unknown>, {
            startTimeMs
          });
        }

        return result;
      } catch (error) {
        await sendAgentFailure(options, runId, workflowId, workflowType, error, {
          startTimeMs
        });
        throw error;
      }
    }
  );
}

async function handleAgentResume(
  options: WrapToolOptions,
  runId: string | undefined,
  workflowId: string,
  workflowType: string,
  resumeData: unknown
): Promise<void> {
  if (!runId) {
    return;
  }

  if (
    !options.config.skipWorkflowTypes.has(workflowType) &&
    !options.config.skipSignals.has("resume")
  ) {
    const verdict = await evaluateAgentEvent(options, {
      event_type: WorkflowEventType.SIGNAL_RECEIVED,
      run_id: runId,
      signal_args: serializeValue(resumeData),
      signal_name: "resume",
      task_queue: "mastra",
      workflow_id: workflowId,
      workflow_type: workflowType
    });

    if (verdict && Verdict.shouldStop(verdict.verdict)) {
      throw new GovernanceHaltError(
        verdict.reason ?? "Agent blocked by governance"
      );
    }
  }

  const pending = getPendingApproval(runId);

  if (!pending) {
    return;
  }

  const approval = await options.client.pollApproval({
    activityId: pending.activityId,
    runId: pending.runId,
    workflowId: pending.workflowId
  });

  if (!approval) {
    throw new ApprovalPendingError("Failed to check approval status, retrying...");
  }

  if (approval.expired) {
    clearPendingApproval(runId);
    throw new ApprovalExpiredError(
      `Approval expired for activity ${pending.activityType}`
    );
  }

  const verdict = Verdict.fromString(
    (approval.verdict as string | undefined) ??
      (approval.action as string | undefined)
  );

  if (verdict === Verdict.ALLOW) {
    clearPendingApproval(runId);
    return;
  }

  if (Verdict.shouldStop(verdict)) {
    clearPendingApproval(runId);
    throw new ApprovalRejectedError(
      `Activity rejected: ${String(approval.reason ?? "Activity rejected")}`
    );
  }

  throw new ApprovalPendingError(
    `Awaiting approval for activity ${pending.activityType}`
  );
}

async function finalizeAgentSuccess(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string,
  output: unknown,
  streamMeta?: AgentStreamMeta
): Promise<void> {
  if (options.config.skipWorkflowTypes.has(workflowType)) {
    return;
  }
  const workflowOutput = serializeValue(output);
  const minimalPayload = {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED,
    run_id: runId,
    workflow_id: workflowId,
    workflow_output: workflowOutput,
    workflow_type: workflowType
  } as const;
  const telemetryPayload = buildWorkflowCompletedTelemetryPayload(
    options,
    workflowId,
    minimalPayload,
    output,
    streamMeta
  );

  const verdict = await evaluateAgentEvent(options, telemetryPayload, minimalPayload);

  if (verdict && Verdict.shouldStop(verdict.verdict)) {
    throw new GovernanceHaltError(
      verdict.reason ?? "Agent blocked by governance"
    );
  }
}

function buildWorkflowCompletedTelemetryPayload(
  options: WrapToolOptions,
  workflowId: string,
  basePayload: {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED;
    run_id: string;
    workflow_id: string;
    workflow_output: unknown;
    workflow_type: string;
  },
  output: unknown,
  streamMeta?: AgentStreamMeta
): Record<string, unknown> & { event_type: WorkflowEventType } {
  const endTimeMs = Date.now();
  const startTimeMs = streamMeta?.startTimeMs;
  const durationMs =
    typeof startTimeMs === "number" ? Math.max(0, endTimeMs - startTimeMs) : undefined;
  const usage = extractUsageMetrics(output);
  const modelInfo = extractModelInfo(output);
  const spans = buildWorkflowTelemetrySpans(
    normalizeSpansForGovernance(options.spanProcessor.getBuffer(workflowId)?.spans ?? []),
    modelInfo,
    usage,
    endTimeMs
  );

  return {
    ...basePayload,
    ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}),
    ...(typeof startTimeMs === "number" ? { start_time: startTimeMs } : {}),
    end_time: endTimeMs,
    ...(typeof usage.inputTokens === "number"
      ? { input_tokens: usage.inputTokens }
      : {}),
    ...(typeof usage.outputTokens === "number"
      ? { output_tokens: usage.outputTokens }
      : {}),
    ...(typeof usage.totalTokens === "number"
      ? { total_tokens: usage.totalTokens }
      : {}),
    ...(modelInfo.modelId ? { model_id: modelInfo.modelId } : {}),
    span_count: spans.length,
    spans
  };
}

function extractUsageMetrics(output: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const outputRecord =
    output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  const usageCandidates = [
    outputRecord?.usage,
    outputRecord?.totalUsage,
    outputRecord?.output,
    outputRecord?.stepResult
  ];

  for (const candidate of usageCandidates) {
    const usage = extractUsageRecord(candidate);

    if (usage) {
      return usage;
    }
  }

  return {};
}

function extractUsageRecord(value: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usage = "usage" in record && record.usage && typeof record.usage === "object"
    ? (record.usage as Record<string, unknown>)
    : record;
  const inputTokens = toNumber(usage.inputTokens);
  const outputTokens = toNumber(usage.outputTokens);
  const totalTokens = toNumber(usage.totalTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractModelInfo(output: unknown): {
  modelId?: string;
  provider?: string;
} {
  if (!output || typeof output !== "object") {
    return {};
  }

  const record = output as Record<string, unknown>;
  const response =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const modelMetadata =
    response?.modelMetadata && typeof response.modelMetadata === "object"
      ? (response.modelMetadata as Record<string, unknown>)
      : undefined;
  const modelIdCandidates = [
    response?.modelId,
    modelMetadata?.modelId,
    record.modelId
  ];
  const providerCandidates = [
    modelMetadata?.provider,
    response?.provider,
    record.provider
  ];

  let modelId: string | undefined;
  let provider: string | undefined;

  for (const candidate of modelIdCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      modelId = candidate;
      break;
    }
  }

  for (const candidate of providerCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      provider = candidate;
      break;
    }
  }

  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {})
  };
}

function buildWorkflowTelemetrySpans(
  spans: Array<Record<string, unknown>>,
  modelInfo: {
    modelId?: string;
    provider?: string;
  },
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  },
  endTimeMs: number
): Array<Record<string, unknown>> {
  if (!modelInfo.modelId) {
    return spans;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  if (inputTokens <= 0 && outputTokens <= 0) {
    return spans;
  }

  if (hasParseableModelUsageSpan(spans)) {
    return spans;
  }

  const providerUrl = resolveProviderUrl(modelInfo);

  if (!providerUrl) {
    return spans;
  }

  const traceId = getTraceIdCandidate(spans);

  return [
    ...spans,
    createSyntheticModelUsageSpan({
      endTimeMs,
      inputTokens,
      modelId: modelInfo.modelId,
      outputTokens,
      providerUrl,
      ...(traceId ? { traceId } : {})
    })
  ];
}

function hasParseableModelUsageSpan(
  spans: Array<Record<string, unknown>>
): boolean {
  return spans.some(span => {
    const attributes =
      span.attributes && typeof span.attributes === "object"
        ? (span.attributes as Record<string, unknown>)
        : {};
    const rawUrl = attributes["http.url"] ?? attributes["url.full"];
    const url = typeof rawUrl === "string" ? rawUrl : undefined;

    if (!url || !isLlmProviderUrl(url)) {
      return false;
    }

    const responseBody = getStringField(span, "response_body", "responseBody");

    if (!responseBody) {
      return false;
    }

    try {
      const parsed = JSON.parse(responseBody) as {
        model?: unknown;
        usage?: {
          completion_tokens?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
          prompt_tokens?: unknown;
        };
      };

      const modelPresent = typeof parsed.model === "string" && parsed.model.length > 0;
      const usage = parsed.usage;
      const hasPromptTokens =
        typeof usage?.prompt_tokens === "number" && usage.prompt_tokens > 0;
      const hasCompletionTokens =
        typeof usage?.completion_tokens === "number" && usage.completion_tokens > 0;
      const hasInputTokens =
        typeof usage?.input_tokens === "number" && usage.input_tokens > 0;
      const hasOutputTokens =
        typeof usage?.output_tokens === "number" && usage.output_tokens > 0;

      return (
        modelPresent ||
        hasPromptTokens ||
        hasCompletionTokens ||
        hasInputTokens ||
        hasOutputTokens
      );
    } catch {
      return false;
    }
  });
}

function createSyntheticModelUsageSpan({
  endTimeMs,
  inputTokens,
  modelId,
  outputTokens,
  providerUrl,
  traceId
}: {
  endTimeMs: number;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  providerUrl: string;
  traceId?: string;
}): Record<string, unknown> {
  const endTimeNs = Math.max(1, Math.floor(endTimeMs * 1_000_000));
  const startTimeNs = Math.max(0, endTimeNs - 1);
  const normalizedTraceId = normalizeHexId(traceId, 32);
  const spanId = normalizeHexId(undefined, 16);

  return {
    attributes: {
      "http.method": "POST",
      "http.url": providerUrl,
      "openbox.synthetic": true
    },
    duration_ns: 1,
    end_time: endTimeNs,
    events: [],
    kind: "CLIENT",
    name: "openbox.synthetic.model_usage",
    request_body: JSON.stringify({
      model: modelId
    }),
    response_body: JSON.stringify({
      model: modelId,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    }),
    semantic_type: "llm_completion",
    span_id: spanId,
    start_time: startTimeNs,
    status: {
      code: "OK"
    },
    trace_id: normalizedTraceId
  };
}

function resolveProviderUrl(modelInfo: {
  modelId?: string;
  provider?: string;
}): string | undefined {
  const provider = modelInfo.provider?.toLowerCase();
  const modelId = modelInfo.modelId?.toLowerCase();

  if (provider?.includes("openai")) {
    return "https://api.openai.com/v1/responses";
  }

  if (provider?.includes("anthropic")) {
    return "https://api.anthropic.com/v1/messages";
  }

  if (provider?.includes("google") || provider?.includes("gemini")) {
    return "https://generativelanguage.googleapis.com/v1beta/models";
  }

  if (!modelId) {
    return undefined;
  }

  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3")
  ) {
    return "https://api.openai.com/v1/responses";
  }

  if (modelId.startsWith("claude-")) {
    return "https://api.anthropic.com/v1/messages";
  }

  if (modelId.startsWith("gemini")) {
    return "https://generativelanguage.googleapis.com/v1beta/models";
  }

  return undefined;
}

function getTraceIdCandidate(
  spans: Array<Record<string, unknown>>
): string | undefined {
  for (const span of spans) {
    const traceId = getStringField(span, "trace_id", "traceId");

    if (traceId) {
      return traceId;
    }
  }

  return undefined;
}

function getStringField(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): string | undefined {
  const snake = record[snakeKey];

  if (typeof snake === "string") {
    return snake;
  }

  const camel = record[camelKey];

  if (typeof camel === "string") {
    return camel;
  }

  return undefined;
}

function isLlmProviderUrl(url: string): boolean {
  return (
    url.includes("api.openai.com") ||
    url.includes("api.anthropic.com") ||
    url.includes("generativelanguage.googleapis.com")
  );
}

function normalizeHexId(
  candidate: string | undefined,
  width: number
): string {
  const source = (candidate ?? randomUUID().replaceAll("-", "")).toLowerCase();
  const filtered = source.replace(/[^a-f0-9]/g, "");

  if (filtered.length >= width) {
    return filtered.slice(0, width);
  }

  return filtered.padEnd(width, "0");
}

async function sendAgentFailure(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string,
  error: unknown,
  streamMeta?: AgentStreamMeta
): Promise<void> {
  if (options.config.skipWorkflowTypes.has(workflowType)) {
    return;
  }
  void streamMeta;

  await evaluateAgentEvent(options, {
    error: serializeError(error),
    event_type: WorkflowEventType.WORKFLOW_FAILED,
    run_id: runId,
    workflow_id: workflowId,
    workflow_type: workflowType
  });
}

async function evaluateAgentEvent(
  options: WrapToolOptions,
  payload: Record<string, unknown> & { event_type: WorkflowEventType },
  fallbackPayload?: Record<string, unknown> & { event_type: WorkflowEventType }
): Promise<GovernanceVerdictResponse | null> {
  try {
    const primaryResult = await options.client.evaluate({
      source: "workflow-telemetry",
      timestamp: new Date().toISOString(),
      ...payload
    });

    if (primaryResult !== null || !fallbackPayload) {
      return primaryResult;
    }

    return await options.client.evaluate({
      source: "workflow-telemetry",
      timestamp: new Date().toISOString(),
      ...fallbackPayload
    });
  } catch (initialError) {
    let resolvedError: unknown = initialError;

    if (fallbackPayload && isBadRequestSchemaError(initialError)) {
      try {
        return await options.client.evaluate({
          source: "workflow-telemetry",
          timestamp: new Date().toISOString(),
          ...fallbackPayload
        });
      } catch (fallbackError) {
        resolvedError = fallbackError;
      }
    }

    if (options.config.onApiError === "fail_closed") {
      return {
        action: "stop",
        alignmentScore: undefined,
        approvalId: undefined,
        behavioralViolations: undefined,
        constraints: undefined,
        governanceEventId: undefined,
        guardrailsResult: undefined,
        metadata: undefined,
        policyId: undefined,
        reason: `Governance API error: ${
          resolvedError instanceof Error
            ? resolvedError.message
            : String(resolvedError)
        }`,
        riskScore: 0,
        trustTier: undefined,
        verdict: Verdict.HALT
      } as GovernanceVerdictResponse;
    }

    return null;
  }
}

function isBadRequestSchemaError(error: unknown): boolean {
  return (
    error instanceof GovernanceAPIError &&
    /HTTP 400/i.test(error.message)
  );
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      type: error.name
    };
  }

  return {
    message: String(error),
    type: typeof error
  };
}

function ensureAgentSpanBuffer(
  options: WrapToolOptions,
  runId: string,
  workflowId: string,
  workflowType: string
): void {
  const existing = options.spanProcessor.getBuffer(workflowId);

  if (!existing || existing.runId !== runId) {
    options.spanProcessor.registerWorkflow(
      workflowId,
      new WorkflowSpanBuffer({
        runId,
        taskQueue: "mastra",
        workflowId,
        workflowType
      })
    );
  }
}

function getAgentStreamMeta(stream: unknown): AgentStreamMeta | undefined {
  if (!stream || typeof stream !== "object") {
    return undefined;
  }

  return (stream as Record<PropertyKey, unknown>)[
    OPENBOX_AGENT_STREAM_META
  ] as AgentStreamMeta | undefined;
}

function setAgentStreamMeta(
  stream: Record<PropertyKey, unknown>,
  meta: AgentStreamMeta
): void {
  Object.defineProperty(stream, OPENBOX_AGENT_STREAM_META, {
    configurable: true,
    enumerable: false,
    value: meta
  });
}

function attachStreamLifecycleHandlers(
  stream: Record<PropertyKey, unknown>,
  handlers: {
    onFailure: (error: unknown) => Promise<void>;
    onSuccess: (fullOutput: unknown) => Promise<void>;
  }
): void {
  const streamLike = stream as Record<PropertyKey, unknown> & {
    consumeStream?: (...args: unknown[]) => Promise<unknown>;
    fullStream?: unknown;
    getFullOutput?: (...args: unknown[]) => Promise<unknown>;
    _getImmediateFinishReason?: (() => unknown) | undefined;
    _getImmediateText?: (() => unknown) | undefined;
    _getImmediateToolCalls?: (() => unknown) | undefined;
    _getImmediateToolResults?: (() => unknown) | undefined;
    _getImmediateUsage?: (() => unknown) | undefined;
    _getImmediateWarnings?: (() => unknown) | undefined;
    status?: unknown;
  };
  const originalGetFullOutput =
    typeof streamLike.getFullOutput === "function"
      ? streamLike.getFullOutput.bind(streamLike)
      : undefined;
  const originalConsumeStream =
    typeof streamLike.consumeStream === "function"
      ? streamLike.consumeStream.bind(streamLike)
      : undefined;

  if (!originalGetFullOutput && !originalConsumeStream && !isReadableStream(streamLike.fullStream)) {
    return;
  }

  let settled = false;
  let settledPromise: Promise<void> | undefined;

  const settleSuccess = (fullOutput: unknown): Promise<void> => {
    if (settledPromise) {
      return settledPromise;
    }

    settled = true;
    settledPromise = handlers.onSuccess(fullOutput);
    return settledPromise;
  };

  const settleFailure = (error: unknown): Promise<void> => {
    if (settledPromise) {
      return settledPromise;
    }

    settled = true;
    settledPromise = handlers.onFailure(error);
    return settledPromise;
  };

  if (originalGetFullOutput) {
    streamLike.getFullOutput = async (...args: unknown[]) => {
      try {
        const fullOutput = await originalGetFullOutput(...args);
        await settleSuccess(fullOutput);
        return fullOutput;
      } catch (error) {
        await settleFailure(error);
        throw error;
      }
    };
  }

  if (originalConsumeStream) {
    streamLike.consumeStream = async (...args: unknown[]) => {
      try {
        const consumed = await originalConsumeStream(...args);

        if (!settled) {
          const snapshot = buildStreamSnapshot(streamLike);
          await settleSuccess(snapshot).catch(() => {});
        }

        return consumed;
      } catch (error) {
        await settleFailure(error);
        throw error;
      }
    };
  }

  if (isReadableStream(streamLike.fullStream)) {
    const observedStream = streamLike.fullStream.pipeThrough(
      new TransformStream({
        flush() {
          if (settled) {
            return;
          }

          const snapshot = buildStreamSnapshot(streamLike);

          return settleSuccess(snapshot).catch(() => {});
        }
      })
    );

    Object.defineProperty(streamLike, "fullStream", {
      configurable: true,
      enumerable: false,
      value: observedStream,
      writable: true
    });
  }
}

function buildStreamSnapshot(
  stream: {
    _getImmediateFinishReason?: (() => unknown) | undefined;
    _getImmediateText?: (() => unknown) | undefined;
    _getImmediateToolCalls?: (() => unknown) | undefined;
    _getImmediateToolResults?: (() => unknown) | undefined;
    _getImmediateUsage?: (() => unknown) | undefined;
    _getImmediateWarnings?: (() => unknown) | undefined;
    status?: unknown;
  }
): Record<string, unknown> {
  return {
    finishReason: stream._getImmediateFinishReason?.(),
    status: stream.status,
    text: stream._getImmediateText?.(),
    toolCalls: stream._getImmediateToolCalls?.(),
    toolResults: stream._getImmediateToolResults?.(),
    usage: stream._getImmediateUsage?.(),
    warnings: stream._getImmediateWarnings?.()
  };
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipeThrough" in value &&
    typeof (value as { pipeThrough?: unknown }).pipeThrough === "function"
  );
}
