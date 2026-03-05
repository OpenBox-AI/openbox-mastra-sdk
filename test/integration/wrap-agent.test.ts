import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { z } from "zod";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  wrapAgent,
  wrapTool
} from "../../src/index.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

describe("wrapAgent", () => {
  it("emits workflow lifecycle events for generate and stream", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const agent = wrapAgent(
      new Agent({
        id: "assistant-agent",
        instructions: "Be concise.",
        model: createMockModel({
          mockText: "hello from agent",
          version: "v2"
        }) as never,
        name: "Assistant Agent"
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const generated = await agent.generate("hello", {
      runId: "agent-generate-run"
    });
    const streamed = await agent.stream("hello", {
      runId: "agent-stream-run"
    });
    const streamedResult = await streamed.getFullOutput();

    await server.close();

    expect(generated.text).toBe("hello from agent");
    expect(streamedResult.text).toBe("hello from agent");
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual([
      "WorkflowStarted",
      "WorkflowCompleted",
      "WorkflowStarted",
      "WorkflowCompleted"
    ]);
  });

  it("polls OpenBox approval before resuming agent execution", async () => {
    let startedCount = 0;
    const server = await startOpenBoxServer({
      approval(body) {
        expect(body).toMatchObject({
          activity_id: "tool-call-1",
          run_id: "agent-approval-run",
          workflow_id: "agent:agent-approval"
        });

        return { verdict: "allow" };
      },
      evaluate(body) {
        if (body.event_type === "ActivityStarted" && startedCount === 0) {
          startedCount += 1;

          return {
            approval_id: "approval-123",
            reason: "Needs review",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const tool = wrapTool(
      createTool({
        description: "Dangerous action",
        id: "dangerous-action",
        inputSchema: z.object({
          id: z.string()
        }),
        outputSchema: z.object({
          ok: z.boolean()
        }),
        async execute() {
          return { ok: true };
        }
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );
    const resumeGenerate = vi.fn(
      async (_resumeData: unknown, _options?: Record<string, unknown>) => ({
      error: undefined,
      files: [],
      finishReason: "stop",
      messages: [],
      object: undefined,
      providerMetadata: undefined,
      reasoning: [],
      reasoningText: undefined,
      rememberedMessages: [],
      request: {},
      response: {},
      runId: "agent-approval-run",
      sources: [],
      steps: [],
      suspendPayload: undefined,
      text: "approved",
      toolCalls: [],
      toolResults: [],
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      traceId: undefined,
      tripwire: undefined,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      warnings: []
      })
    );
    const fakeAgent = wrapAgent(
      {
        id: "agent-approval",
        name: "Approval Agent",
        async generate(_messages: unknown, executionOptions?: Record<string, unknown>) {
          const suspendPayload = await tool.execute?.(
            { id: "record-1" },
            {
              agent: {
                suspend: async (payload: unknown) => payload,
                toolCallId: "tool-call-1"
              }
            } as never
          );

          return {
            error: undefined,
            files: [],
            finishReason: "suspended",
            messages: [],
            object: undefined,
            providerMetadata: undefined,
            reasoning: [],
            reasoningText: undefined,
            rememberedMessages: [],
            request: {},
            response: {},
            runId: executionOptions?.runId,
            sources: [],
            steps: [],
            suspendPayload,
            text: "",
            toolCalls: [],
            toolResults: [],
            totalUsage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            },
            traceId: undefined,
            tripwire: undefined,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            },
            warnings: []
          };
        },
        resumeGenerate
      },
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const firstResult = await fakeAgent.generate("run it", {
      runId: "agent-approval-run"
    });
    const resumed = await fakeAgent.resumeGenerate?.(
      { approved: true },
      {
        runId: "agent-approval-run"
      }
    );

    await server.close();

    expect(firstResult.finishReason).toBe("suspended");
    expect(resumeGenerate).toHaveBeenCalledTimes(1);
    expect(resumed?.text).toBe("approved");
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual([
      "WorkflowStarted",
      "ActivityStarted",
      "SignalReceived",
      "WorkflowCompleted"
    ]);
  });
});
