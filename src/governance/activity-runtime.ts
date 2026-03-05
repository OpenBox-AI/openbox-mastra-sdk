import { randomUUID } from "node:crypto";

import { trace } from "@opentelemetry/api";
import type { ToolExecutionContext } from "@mastra/core/tools";

import type { OpenBoxClient } from "../client/index.js";
import type { OpenBoxConfig } from "../config/index.js";
import type { OpenBoxSpanProcessor } from "../span/index.js";
import {
  ApprovalPendingError,
  GovernanceVerdictResponse,
  GovernanceHaltError,
  GuardrailsValidationError,
  Verdict,
  WorkflowEventType,
  WorkflowSpanBuffer
} from "../types/index.js";
import {
  getOpenBoxExecutionContext,
  runWithOpenBoxExecutionContext
} from "./context.js";
import { setPendingApproval } from "./approval-registry.js";

export interface WorkflowSuspendContext {
  runId: string;
  setState: (state: unknown) => void | Promise<void>;
  state: unknown;
  suspend: (
    payload: unknown,
    options?: Record<string, unknown>
  ) => unknown | Promise<unknown>;
  workflowId: string;
}

export interface ToolExecutionContextLike {
  agent?: ToolExecutionContext["agent"];
  requestContext?: ToolExecutionContext["requestContext"];
  workflow?: WorkflowSuspendContext | undefined;
}

export interface ActivityRuntimeDependencies {
  client: OpenBoxClient;
  config: OpenBoxConfig;
  spanProcessor: OpenBoxSpanProcessor;
}

export interface GovernedActivityOptions<TInput, TOutput> {
  dependencies: ActivityRuntimeDependencies;
  execute: (input: TInput) => Promise<TOutput>;
  input: TInput;
  runtimeContext: ToolExecutionContextLike;
  type: string;
}

export async function executeGovernedActivity<TInput, TOutput>({
  dependencies,
  execute,
  input,
  runtimeContext,
  type
}: GovernedActivityOptions<TInput, TOutput>): Promise<TOutput | undefined> {
  const descriptor = resolveActivityDescriptor(type, runtimeContext);
  const inputForEvent = serializeActivityInputForEvent(input);
  let inputForExecution = cloneValue(input);

  ensureSpanBuffer(descriptor, dependencies.spanProcessor);

  const startVerdict = dependencies.config.sendActivityStartEvent
    ? await evaluateActivityEvent(dependencies, {
        activity_input: inputForEvent,
        activity_type: descriptor.activityType,
        attempt: descriptor.attempt,
        event_type: WorkflowEventType.ACTIVITY_STARTED,
        run_id: descriptor.runId,
        task_queue: descriptor.taskQueue,
        workflow_id: descriptor.workflowId,
        workflow_type: descriptor.workflowType
      })
    : null;

  applyStopVerdict(startVerdict);
  assertGuardrailsValid(startVerdict, "Guardrails validation failed");

  if (
    startVerdict?.guardrailsResult?.inputType === "activity_input" &&
    startVerdict.guardrailsResult.redactedInput !== undefined
  ) {
    const normalizedRedactedInput = normalizeRedactedActivityInput(
      inputForExecution,
      startVerdict.guardrailsResult.redactedInput
    );
    inputForExecution = applyRedaction(
      inputForExecution,
      normalizedRedactedInput
    ) as TInput;
  }

  if (
    dependencies.config.hitlEnabled &&
    Verdict.requiresApproval(startVerdict?.verdict ?? Verdict.ALLOW)
  ) {
    const suspend = runtimeContext.workflow?.suspend ?? runtimeContext.agent?.suspend;

    if (!suspend) {
      throw new ApprovalPendingError(
        startVerdict?.reason ?? "Activity requires human approval"
      );
    }

    const approvalPayload = {
      openbox: {
        activityId: descriptor.activityId,
        activityType: descriptor.activityType,
        approvalId: startVerdict?.approvalId,
        reason: startVerdict?.reason,
        requestedAt: rfc3339Now(),
        runId: descriptor.runId,
        workflowId: descriptor.workflowId,
        workflowType: descriptor.workflowType
      }
    };

    setPendingApproval({
      activityId: descriptor.activityId,
      activityType: descriptor.activityType,
      approvalId: startVerdict?.approvalId,
      requestedAt: approvalPayload.openbox.requestedAt,
      runId: descriptor.runId,
      workflowId: descriptor.workflowId,
      workflowType: descriptor.workflowType
    });

    return (await suspend(approvalPayload)) as TOutput | undefined;
  }

  return runWithOpenBoxExecutionContext(
    {
      activityId: descriptor.activityId,
      activityType: descriptor.activityType,
      attempt: descriptor.attempt,
      runId: descriptor.runId,
      source: "tool",
      taskQueue: descriptor.taskQueue,
      workflowId: descriptor.workflowId,
      workflowType: descriptor.workflowType
    },
    async () => {
      let error: Record<string, unknown> | undefined;
      let output: TOutput | undefined;

      try {
        output = await trace
          .getTracer("openbox.mastra")
          .startActiveSpan(`activity.${descriptor.activityType}`, async activeSpan => {
            activeSpan.setAttribute("openbox.workflow_id", descriptor.workflowId);
            activeSpan.setAttribute("openbox.activity_id", descriptor.activityId);
            dependencies.spanProcessor.registerTrace(
              activeSpan.spanContext().traceId,
              descriptor.workflowId,
              descriptor.activityId
            );

            try {
              return await execute(inputForExecution);
            } finally {
              activeSpan.end();
            }
          });
      } catch (caughtError) {
        error = serializeError(caughtError);
        throw caughtError;
      } finally {
        const spans = collectActivitySpans(
          dependencies.spanProcessor,
          descriptor.workflowId,
          descriptor.activityId
        );
        const completedVerdict = await evaluateActivityEvent(dependencies, {
          activity_input: serializeActivityInputForEvent(inputForExecution),
          activity_output: serializeValue(output),
          activity_type: descriptor.activityType,
          attempt: descriptor.attempt,
          duration_ms: undefined,
          end_time: undefined,
          error,
          event_type: WorkflowEventType.ACTIVITY_COMPLETED,
          run_id: descriptor.runId,
          span_count: spans.length,
          spans,
          start_time: undefined,
          status: error ? "failed" : "completed",
          task_queue: descriptor.taskQueue,
          workflow_id: descriptor.workflowId,
          workflow_type: descriptor.workflowType
        });

        applyStopVerdict(completedVerdict);
        assertGuardrailsValid(
          completedVerdict,
          "Guardrails output validation failed"
        );

        if (
          completedVerdict?.guardrailsResult?.inputType === "activity_output" &&
          completedVerdict.guardrailsResult.redactedInput !== undefined
        ) {
          output = applyRedaction(
            output,
            completedVerdict.guardrailsResult.redactedInput
          ) as TOutput;
        }

        if (
          dependencies.config.hitlEnabled &&
          Verdict.requiresApproval(completedVerdict?.verdict ?? Verdict.ALLOW)
        ) {
          const suspend =
            runtimeContext.workflow?.suspend ?? runtimeContext.agent?.suspend;

          if (!suspend) {
            throw new ApprovalPendingError(
              completedVerdict?.reason ??
                "Activity output requires human approval"
            );
          }

          const approvalPayload = {
            openbox: {
              activityId: descriptor.activityId,
              activityType: descriptor.activityType,
              approvalId: completedVerdict?.approvalId,
              reason: completedVerdict?.reason,
              requestedAt: rfc3339Now(),
              runId: descriptor.runId,
              workflowId: descriptor.workflowId,
              workflowType: descriptor.workflowType
            }
          };

          setPendingApproval({
            activityId: descriptor.activityId,
            activityType: descriptor.activityType,
            approvalId: completedVerdict?.approvalId,
            requestedAt: approvalPayload.openbox.requestedAt,
            runId: descriptor.runId,
            workflowId: descriptor.workflowId,
            workflowType: descriptor.workflowType
          });

          output = (await suspend(approvalPayload)) as TOutput | undefined;
        }
      }

      return output;
    }
  );
}

export function serializeValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeValue(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        serializeValue(entry)
      ])
    );
  }

  return String(value);
}

function serializeActivityInputForEvent(value: unknown): unknown[] {
  const serialized = serializeValue(value);

  if (serialized == null) {
    return [];
  }

  return Array.isArray(serialized) ? serialized : [serialized];
}

function normalizeRedactedActivityInput(
  originalInput: unknown,
  redactedInput: unknown
): unknown {
  // Governance services may return activity_input redaction in list form.
  // For single-argument tools/steps, unwrap list->value so execution shape is preserved.
  if (!Array.isArray(originalInput) && Array.isArray(redactedInput)) {
    if (redactedInput.length === 0) {
      return redactedInput;
    }

    if (redactedInput.length === 1) {
      return redactedInput[0];
    }
  }

  return redactedInput;
}

export function applyRedaction(original: unknown, redacted: unknown): unknown {
  if (
    original &&
    redacted &&
    typeof original === "object" &&
    typeof redacted === "object" &&
    !Array.isArray(original) &&
    !Array.isArray(redacted)
  ) {
    const updated: Record<string, unknown> = {
      ...(original as Record<string, unknown>)
    };

    for (const [key, value] of Object.entries(redacted as Record<string, unknown>)) {
      updated[key] = applyRedaction(
        (original as Record<string, unknown>)[key],
        value
      );
    }

    return updated;
  }

  if (Array.isArray(redacted)) {
    return redacted.map((value, index) =>
      applyRedaction(Array.isArray(original) ? original[index] : undefined, value)
    );
  }

  return cloneValue(redacted);
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return structuredClone(value);
}

function rfc3339Now(): string {
  return new Date().toISOString();
}

function resolveActivityDescriptor(
  type: string,
  runtimeContext: ToolExecutionContextLike
): {
  activityId: string;
  activityType: string;
  attempt: number;
  runId: string;
  taskQueue: string;
  workflowId: string;
  workflowType: string;
} {
  const activeContext = getOpenBoxExecutionContext();
  const runId =
    runtimeContext.workflow?.runId ??
    activeContext?.runId ??
    runtimeContext.agent?.toolCallId ??
    randomUUID();
  const workflowId =
    runtimeContext.workflow?.workflowId ??
    activeContext?.workflowId ??
    `tool:${type}`;
  const workflowType = activeContext?.workflowType ?? workflowId;
  const activityId =
    runtimeContext.agent?.toolCallId ??
    activeContext?.activityId ??
    `${workflowId}:${type}`;

  return {
    activityId,
    activityType: type,
    attempt: activeContext?.attempt ?? 1,
    runId,
    taskQueue: activeContext?.taskQueue ?? "mastra",
    workflowId,
    workflowType
  };
}

async function evaluateActivityEvent(
  dependencies: ActivityRuntimeDependencies,
  payload: Record<string, unknown> & {
    event_type: WorkflowEventType;
  }
): Promise<GovernanceVerdictResponse | null> {
  const body = {
    source: "workflow-telemetry",
    timestamp: rfc3339Now(),
    ...payload
  };

  try {
    return await dependencies.client.evaluate(body);
  } catch (error) {
    if (dependencies.config.onApiError === "fail_closed") {
      return new GovernanceVerdictResponse({
        reason: `Governance API error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        verdict: Verdict.HALT
      });
    }

    return null;
  }
}

function applyStopVerdict(
  verdict: GovernanceVerdictResponse | null
): void {
  if (verdict && Verdict.shouldStop(verdict.verdict)) {
    throw new GovernanceHaltError(
      `Governance blocked: ${verdict.reason ?? "No reason provided"}`
    );
  }
}

function assertGuardrailsValid(
  verdict: GovernanceVerdictResponse | null,
  fallbackMessage: string
): void {
  if (!verdict?.guardrailsResult || verdict.guardrailsResult.validationPassed) {
    return;
  }

  const reasons = verdict.guardrailsResult.getReasonStrings();
  const reason = reasons.length > 0 ? reasons.join("; ") : fallbackMessage;

  throw new GuardrailsValidationError(reason);
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

function ensureSpanBuffer(
  descriptor: {
    runId: string;
    taskQueue: string;
    workflowId: string;
    workflowType: string;
  },
  spanProcessor: OpenBoxSpanProcessor
): void {
  const existing = spanProcessor.getBuffer(descriptor.workflowId);

  if (!existing || existing.runId !== descriptor.runId) {
    spanProcessor.registerWorkflow(
      descriptor.workflowId,
      new WorkflowSpanBuffer({
        runId: descriptor.runId,
        taskQueue: descriptor.taskQueue,
        workflowId: descriptor.workflowId,
        workflowType: descriptor.workflowType
      })
    );
  }
}

function collectActivitySpans(
  spanProcessor: OpenBoxSpanProcessor,
  workflowId: string,
  activityId: string
): Record<string, unknown>[] {
  const buffer = spanProcessor.getBuffer(workflowId);

  if (!buffer) {
    return [];
  }

  return buffer.spans.filter(span => {
    return (
      span.activityId === activityId ||
      (span.attributes as Record<string, unknown> | undefined)?.[
        "openbox.activity_id"
      ] === activityId
    );
  });
}
