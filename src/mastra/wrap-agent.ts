import { randomUUID } from "node:crypto";

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
  WorkflowEventType
} from "../types/index.js";
import type { WrapToolOptions } from "./wrap-tool.js";

const OPENBOX_WRAPPED_AGENT = Symbol.for("openbox.mastra.wrapAgent");

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

      if (output && typeof output.getFullOutput === "function") {
        const originalGetFullOutput = output.getFullOutput.bind(output);

        output.getFullOutput = async () => {
          try {
            const fullOutput = await originalGetFullOutput();

            await finalizeAgentSuccess(
              options,
              runId,
              workflowId,
              workflowType,
              fullOutput
            );

            return fullOutput;
          } catch (error) {
            await sendAgentFailure(options, runId, workflowId, workflowType, error);
            throw error;
          }
        };
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

      if (output && typeof output.getFullOutput === "function") {
        const resolvedRunId = runId ?? randomUUID();
        const originalGetFullOutput = output.getFullOutput.bind(output);

        output.getFullOutput = async () => {
          try {
            const fullOutput = await originalGetFullOutput();

            await finalizeAgentSuccess(
              options,
              resolvedRunId,
              workflowId,
              workflowType,
              fullOutput
            );

            return fullOutput;
          } catch (error) {
            await sendAgentFailure(
              options,
              resolvedRunId,
              workflowId,
              workflowType,
              error
            );
            throw error;
          }
        };
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
        const result = await operation();
        const isStreamResult =
          result != null &&
          typeof result === "object" &&
          "getFullOutput" in (result as Record<string, unknown>);
        const finishReason =
          result != null && typeof result === "object"
            ? (result as { finishReason?: unknown }).finishReason
            : undefined;

        if (
          !isStreamResult &&
          finishReason !== "suspended"
        ) {
          await finalizeAgentSuccess(
            options,
            runId,
            workflowId,
            workflowType,
            result
          );
        }

        return result;
      } catch (error) {
        await sendAgentFailure(options, runId, workflowId, workflowType, error);
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
  output: unknown
): Promise<void> {
  if (options.config.skipWorkflowTypes.has(workflowType)) {
    return;
  }

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
  error: unknown
): Promise<void> {
  if (options.config.skipWorkflowTypes.has(workflowType)) {
    return;
  }

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
