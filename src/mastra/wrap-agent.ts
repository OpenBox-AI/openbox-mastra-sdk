import { randomUUID } from "node:crypto";

import { trace } from "@opentelemetry/api";

import {
  clearPendingApproval,
  getPendingApproval
} from "../governance/approval-registry.js";
import { serializeValue } from "../governance/activity-runtime.js";
import { runWithOpenBoxExecutionContext } from "../governance/context.js";
import type { GovernanceVerdictResponse } from "../types/index.js";
import {
  ApprovalExpiredError,
  ApprovalPendingError,
  ApprovalRejectedError,
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
  void streamMeta;

  const verdict = await evaluateAgentEvent(options, {
    event_type: WorkflowEventType.WORKFLOW_COMPLETED,
    run_id: runId,
    workflow_id: workflowId,
    workflow_output: serializeValue(output),
    workflow_type: workflowType
  });

  if (verdict && Verdict.shouldStop(verdict.verdict)) {
    throw new GovernanceHaltError(
      verdict.reason ?? "Agent blocked by governance"
    );
  }
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
  payload: Record<string, unknown> & { event_type: WorkflowEventType }
): Promise<GovernanceVerdictResponse | null> {
  try {
    return await options.client.evaluate({
      source: "workflow-telemetry",
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (error) {
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
          error instanceof Error ? error.message : String(error)
        }`,
        riskScore: 0,
        trustTier: undefined,
        verdict: Verdict.HALT
      } as GovernanceVerdictResponse;
    }

    return null;
  }
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
