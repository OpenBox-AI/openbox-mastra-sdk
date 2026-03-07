import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import {
  GuardrailsValidationError,
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  wrapTool
} from "../../src/index.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

describe("wrapTool", () => {
  it("sends activity events and applies guardrail redaction before and after execution", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            guardrails_result: {
              input_type: "activity_input",
              redacted_input: [
                {
                  prompt: "[redacted]"
                }
              ],
              validation_passed: true
            },
            verdict: "allow"
          };
        }

        if (body.event_type === "ActivityCompleted") {
          return {
            guardrails_result: {
              input_type: "activity_output",
              redacted_input: {
                result: "safe-output"
              },
              validation_passed: true
            },
            verdict: "allow"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const receivedInputs: Array<Record<string, unknown>> = [];
    const tool = createTool({
      description: "Process a prompt",
      id: "process-prompt",
      inputSchema: z.object({
        prompt: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      async execute(input) {
        receivedInputs.push({ ...input });

        return {
          result: `processed:${input.prompt}`
        };
      }
    });
    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor
    });

    const result = await wrapped.execute?.(
      { prompt: "secret prompt" },
      {
        workflow: {
          runId: "run-123",
          setState: vi.fn(),
          state: {},
          suspend: vi.fn(async () => undefined),
          workflowId: "wf-123"
        }
      }
    );

    await server.close();

    expect(receivedInputs).toEqual([{ prompt: "[redacted]" }]);
    expect(result).toEqual({ result: "safe-output" });
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual(["ActivityStarted", "ActivityCompleted"]);

    const [startedEvent, completedEvent] = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body);

    expect(startedEvent).toMatchObject({
      activity_input: [
        {
          prompt: "secret prompt"
        }
      ],
      activity_type: "process-prompt",
      event_type: "ActivityStarted",
      run_id: "run-123",
      workflow_id: "wf-123"
    });
    expect(completedEvent).toMatchObject({
      activity_input: [
        {
          prompt: "[redacted]"
        }
      ],
      activity_output: {
        result: "processed:[redacted]"
      },
      activity_type: "process-prompt",
      event_type: "ActivityCompleted",
      run_id: "run-123",
      status: "completed",
      workflow_id: "wf-123"
    });
    expect(completedEvent).toHaveProperty("spans");
    const spans = (completedEvent as { spans?: Array<Record<string, unknown>> }).spans ?? [];
    if (spans.length > 0) {
      expect(spans[0]).toHaveProperty("span_id");
      expect(spans[0]).toHaveProperty("trace_id");
      expect(spans[0]).toHaveProperty("start_time");
      expect(spans[0]).toHaveProperty("end_time");
      expect(spans[0]).not.toHaveProperty("spanId");
      expect(spans[0]).not.toHaveProperty("traceId");
      expect(spans[0]).not.toHaveProperty("startTime");
      expect(spans[0]).not.toHaveProperty("endTime");
    }
  });

  it("suspends execution when governance requires approval", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            approval_id: "approval-123",
            reason: "Needs human review",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const execute = vi.fn(async () => ({ result: "should-not-run" }));
    const suspend = vi.fn(async () => undefined);
    const tool = createTool({
      description: "Delete a record",
      id: "delete-record",
      inputSchema: z.object({
        id: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      execute
    });
    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const result = await wrapped.execute?.(
      { id: "rec-1" },
      {
        workflow: {
          runId: "run-approve",
          setState: vi.fn(),
          state: {},
          suspend,
          workflowId: "wf-approve"
        }
      }
    );

    await server.close();

    expect(result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledTimes(1);
    const suspendCall = suspend.mock.calls.at(0);

    expect(suspendCall).toBeDefined();

    const suspendPayload = suspendCall
      ? (suspendCall as unknown[])[0]
      : undefined;

    expect(suspendPayload).toMatchObject({
      openbox: {
        activityId: "wf-approve:delete-record",
        activityType: "delete-record",
        approvalId: "approval-123",
        reason: "Needs human review",
        runId: "run-approve",
        workflowId: "wf-approve"
      }
    });
  });

  it("fails closed when guardrails validation rejects tool input", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            guardrails_result: {
              input_type: "activity_input",
              reasons: [{ reason: "prompt contains secrets" }],
              redacted_input: {
                prompt: "[blocked]"
              },
              validation_passed: false
            },
            verdict: "allow"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const tool = createTool({
      description: "Process prompt",
      id: "guarded-tool",
      inputSchema: z.object({
        prompt: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      async execute(input) {
        return {
          result: input.prompt
        };
      }
    });
    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    await expect(
      wrapped.execute?.(
        { prompt: "secret prompt" },
        {
          workflow: {
            runId: "run-guardrails",
            setState: vi.fn(),
            state: {},
            suspend: vi.fn(async () => undefined),
            workflowId: "wf-guardrails"
          }
        }
      )
    ).rejects.toBeInstanceOf(GuardrailsValidationError);

    await server.close();
  });
});
