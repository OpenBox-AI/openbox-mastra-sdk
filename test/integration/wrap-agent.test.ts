import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { trace } from "@opentelemetry/api";
import { z } from "zod";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
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

  it("sends parity-safe workflow completion payload for agent runs", async () => {
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
    const spanProcessor = new OpenBoxSpanProcessor();
    const telemetry = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const fakeAgent = wrapAgent(
      {
        id: "telemetry-agent",
        name: "Telemetry Agent",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return trace
            .getTracer("openbox.test")
            .startActiveSpan("agent.child.operation", async span => {
              span.setAttribute("test.attr", "value");
              span.end();

              return {
                finishReason: "stop",
                text: "ok",
                usage: {
                  inputTokens: 10,
                  outputTokens: 4,
                  totalTokens: 14
                }
              };
            });
        }
      },
      {
        client,
        config,
        spanProcessor
      }
    );

    await fakeAgent.generate("hello", {
      runId: "agent-telemetry-run"
    });

    await telemetry.shutdown();
    await server.close();

    const completedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(body => body.event_type === "WorkflowCompleted");

    expect(completedEvent).toBeDefined();
    expect(completedEvent).toMatchObject({
      event_type: "WorkflowCompleted",
      run_id: "agent-telemetry-run",
      workflow_id: "agent:telemetry-agent",
      workflow_type: "telemetry-agent"
    });
    expect(completedEvent).not.toHaveProperty("duration_ms");
    expect(completedEvent).not.toHaveProperty("end_time");
    expect(completedEvent).not.toHaveProperty("input_tokens");
    expect(completedEvent).not.toHaveProperty("model_id");
    expect(completedEvent).not.toHaveProperty("span_count");
    expect(completedEvent).not.toHaveProperty("spans");
    expect(completedEvent).not.toHaveProperty("start_time");
  });

  it("emits workflow completion when stream is consumed without getFullOutput", async () => {
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
        id: "consume-stream-agent",
        instructions: "Be concise.",
        model: createMockModel({
          mockText: "stream response",
          version: "v2"
        }) as never,
        name: "Consume Stream Agent"
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const stream = await agent.stream("hello", {
      runId: "agent-consume-stream-run"
    });

    await stream.consumeStream();

    const deadline = Date.now() + 1_000;

    while (
      Date.now() < deadline &&
      !server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
        .includes("WorkflowCompleted")
    ) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    await server.close();

    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toContain("WorkflowCompleted");
  });

  it("does not finalize stream early when finishReason is not promise-like", async () => {
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

    const streamObject = {
      finishReason: undefined,
      status: "streaming",
      _getImmediateFinishReason: () => undefined,
      _getImmediateText: () => "",
      _getImmediateToolCalls: () => [],
      _getImmediateToolResults: () => [],
      _getImmediateUsage: () => undefined,
      _getImmediateWarnings: () => [],
      async getFullOutput() {
        return {
          finishReason: "stop",
          text: "final output"
        };
      }
    };

    const agent = wrapAgent(
      {
        id: "non-thenable-finish-reason-agent",
        name: "Non-Thenable Finish Agent",
        async stream() {
          return streamObject;
        }
      },
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const typedAgent = agent as {
      stream: (
        message: string,
        options?: Record<string, unknown>
      ) => Promise<{
        getFullOutput: () => Promise<{ text: string }>;
      }>;
    };

    const stream = await typedAgent.stream("hello", {
      runId: "agent-non-thenable-run"
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    const preCompletionEvents = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body.event_type);

    expect(preCompletionEvents).toEqual(["WorkflowStarted"]);

    const fullOutput = await stream.getFullOutput();
    expect(fullOutput).toMatchObject({
      text: "final output"
    });

    const completedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(body => body.event_type === "WorkflowCompleted");

    await server.close();

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.workflow_output).toMatchObject({
      text: "final output"
    });
  });

  it("finalizes stream on consumeStream when finishReason is not promise-like", async () => {
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

    const streamObject = {
      finishReason: undefined,
      status: "completed",
      _getImmediateFinishReason: () => "stop",
      _getImmediateText: () => "stream consumed output",
      _getImmediateToolCalls: () => [],
      _getImmediateToolResults: () => [],
      _getImmediateUsage: () => ({ totalTokens: 1 }),
      _getImmediateWarnings: () => [],
      async consumeStream() {
        return;
      },
      async getFullOutput() {
        return {
          finishReason: "stop",
          text: "unused"
        };
      }
    };

    const agent = wrapAgent(
      {
        id: "consume-stream-finalize-agent",
        name: "Consume Stream Finalize Agent",
        async stream() {
          return streamObject;
        }
      },
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const typedAgent = agent as {
      stream: (
        message: string,
        options?: Record<string, unknown>
      ) => Promise<{
        consumeStream: () => Promise<void>;
      }>;
    };

    const stream = await typedAgent.stream("hello", {
      runId: "agent-consume-finalize-run"
    });

    await stream.consumeStream();

    const completedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(body => body.event_type === "WorkflowCompleted");

    await server.close();

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.workflow_output).toMatchObject({
      text: "stream consumed output"
    });
  });

  it("finalizes on fullStream completion without touching finishReason", async () => {
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

    const streamObject = {
      get finishReason() {
        throw new Error("finishReason should not be read");
      },
      status: "streaming",
      _getImmediateFinishReason: () => "stop",
      _getImmediateText: () => "from fullStream",
      _getImmediateToolCalls: () => [],
      _getImmediateToolResults: () => [],
      _getImmediateUsage: () => ({ totalTokens: 2 }),
      _getImmediateWarnings: () => [],
      fullStream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "text-delta",
            payload: { text: "hello" }
          });
          controller.close();
        }
      })
    };

    const agent = wrapAgent(
      {
        id: "fullstream-finalize-agent",
        name: "FullStream Finalize Agent",
        async stream() {
          return streamObject;
        }
      },
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const typedAgent = agent as {
      stream: (
        message: string,
        options?: Record<string, unknown>
      ) => Promise<{
        fullStream: ReadableStream<unknown>;
      }>;
    };

    const stream = await typedAgent.stream("hello", {
      runId: "agent-fullstream-finalize-run"
    });

    const reader = stream.fullStream.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
    }
    reader.releaseLock();

    const completedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(body => body.event_type === "WorkflowCompleted");

    await server.close();

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.workflow_output).toMatchObject({
      text: "from fullStream"
    });
  });

  it("does not break stream text delivery while emitting completion events", async () => {
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
        id: "stream-text-agent",
        instructions: "Be concise.",
        model: createMockModel({
          mockText: "stream text intact",
          version: "v2"
        }) as never,
        name: "Stream Text Agent"
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    const stream = await agent.stream("hello", {
      runId: "agent-stream-text-run"
    });
    let received = "";

    for await (const part of stream.textStream) {
      received += part;
    }

    await stream.consumeStream();

    const deadline = Date.now() + 1_000;

    while (
      Date.now() < deadline &&
      !server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
        .includes("WorkflowCompleted")
    ) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    await server.close();

    expect(received).toContain("stream text intact");
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toContain("WorkflowCompleted");
  });
});
