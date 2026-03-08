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

  it("sends telemetry-rich workflow completion payload for agent runs", async () => {
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
                modelId: "gpt-4o-mini",
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
    expect(completedEvent).toHaveProperty("duration_ms");
    expect(completedEvent).toHaveProperty("end_time");
    expect(completedEvent).toHaveProperty("input_tokens", 10);
    expect(completedEvent).toHaveProperty("output_tokens", 4);
    expect(completedEvent).toHaveProperty("total_tokens", 14);
    expect(completedEvent).toHaveProperty("model_id", "gpt-4o-mini");
    expect(completedEvent).toHaveProperty("span_count");
    expect(completedEvent).toHaveProperty("spans");
    expect(completedEvent).toHaveProperty("start_time");
    expect(
      typeof (completedEvent as { duration_ms?: unknown }).duration_ms
    ).toBe("number");
    expect(
      (completedEvent as { span_count?: unknown }).span_count
    ).toSatisfy(value => typeof value === "number" && value > 0);
    expect(
      (completedEvent as { spans?: unknown }).spans
    ).toSatisfy(value => Array.isArray(value) && value.length > 0);
    const spans = (completedEvent as { spans?: Array<Record<string, unknown>> }).spans ?? [];
    expect(spans[0]).toHaveProperty("span_id");
    expect(spans[0]).toHaveProperty("trace_id");
    expect(spans[0]).toHaveProperty("start_time");
    expect(spans[0]).toHaveProperty("end_time");
    expect(spans[0]).not.toHaveProperty("spanId");
    expect(spans[0]).not.toHaveProperty("traceId");
    expect(spans[0]).not.toHaveProperty("startTime");
    expect(spans[0]).not.toHaveProperty("endTime");
    expect(typeof (completedEvent as { start_time?: unknown }).start_time).toBe("number");
    expect(typeof (completedEvent as { end_time?: unknown }).end_time).toBe("number");

    const syntheticUsageSpan = spans.find(span => {
      const attributes =
        span.attributes && typeof span.attributes === "object"
          ? (span.attributes as Record<string, unknown>)
          : undefined;
      return attributes?.["http.url"] === "https://api.openai.com/v1/responses";
    });
    expect(syntheticUsageSpan).toBeDefined();
    expect(syntheticUsageSpan).toHaveProperty("request_body");
    expect(syntheticUsageSpan).toHaveProperty("response_body");
    const responseBody = (syntheticUsageSpan as { response_body?: unknown })
      .response_body;
    expect(typeof responseBody).toBe("string");
    const parsedResponse = JSON.parse(responseBody as string) as {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    expect(parsedResponse.model).toBe("gpt-4o-mini");
    expect(parsedResponse.usage?.input_tokens).toBe(10);
    expect(parsedResponse.usage?.output_tokens).toBe(4);
  });

  it("emits synthetic usage span when usage is present but modelId is missing", async () => {
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
        id: "telemetry-agent-no-model",
        name: "Telemetry Agent No Model",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return trace
            .getTracer("openbox.test")
            .startActiveSpan(
              "agent.openai.call",
              {
                attributes: {
                  "http.method": "POST",
                  "http.url": "https://api.openai.com/v1/responses"
                }
              },
              async span => {
                span.end();

                return {
                  finishReason: "stop",
                  text: "ok",
                  usage: {
                    inputTokens: 8,
                    outputTokens: 3,
                    totalTokens: 11
                  }
                };
              }
            );
        }
      },
      {
        client,
        config,
        spanProcessor
      }
    );

    await fakeAgent.generate("hello", {
      runId: "agent-telemetry-no-model-run"
    });

    await telemetry.shutdown();
    await server.close();

    const completedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(body => body.event_type === "WorkflowCompleted");

    const spans = (completedEvent as { spans?: Array<Record<string, unknown>> }).spans ?? [];
    const syntheticUsageSpan = spans.find(span => {
      const attributes =
        span.attributes && typeof span.attributes === "object"
          ? (span.attributes as Record<string, unknown>)
          : undefined;
      return (
        attributes?.["http.url"] === "https://api.openai.com/v1/responses" &&
        span.name === "openbox.synthetic.model_usage"
      );
    });
    expect(syntheticUsageSpan).toBeDefined();
    const responseBody = (syntheticUsageSpan as { response_body?: unknown })
      .response_body;
    const parsedResponse = JSON.parse(responseBody as string) as {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    expect(parsedResponse.model).toBe("unknown-model");
    expect(parsedResponse.usage?.input_tokens).toBe(8);
    expect(parsedResponse.usage?.output_tokens).toBe(3);
  });

  it("emits synthetic usage span from provider metadata when model spans are missing", async () => {
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
    const fakeAgent = wrapAgent(
      {
        id: "telemetry-agent-provider-metadata",
        name: "Telemetry Agent Provider Metadata",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return {
            finishReason: "stop",
            text: "ok",
            toolCalls: [
              {
                payload: {
                  providerMetadata: {
                    openai: {
                      itemId: "fc_test"
                    }
                  }
                }
              }
            ],
            usage: {
              inputTokens: 12,
              outputTokens: 6,
              totalTokens: 18
            }
          };
        }
      },
      {
        client,
        config,
        spanProcessor
      }
    );

    await fakeAgent.generate("hello", {
      runId: "agent-telemetry-provider-metadata-run"
    });

    await server.close();

    const completedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(body => body.event_type === "WorkflowCompleted");
    const spans = (completedEvent as { spans?: Array<Record<string, unknown>> }).spans ?? [];
    const syntheticUsageSpan = spans.find(span => {
      const attributes =
        span.attributes && typeof span.attributes === "object"
          ? (span.attributes as Record<string, unknown>)
          : undefined;
      return attributes?.["http.url"] === "https://api.openai.com/v1/responses";
    });

    expect(syntheticUsageSpan).toBeDefined();
    const responseBody = (syntheticUsageSpan as { response_body?: unknown })
      .response_body;
    const parsedResponse = JSON.parse(responseBody as string) as {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    expect(parsedResponse.model).toBe("unknown-model");
    expect(parsedResponse.usage?.input_tokens).toBe(12);
    expect(parsedResponse.usage?.output_tokens).toBe(6);
  });

  it("falls back to minimal workflow completion payload when telemetry schema is rejected", async () => {
    let workflowCompletedAttempts = 0;
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "WorkflowCompleted") {
          workflowCompletedAttempts += 1;

          if (workflowCompletedAttempts === 1) {
            return {
              body: {
                code: 400,
                message: "invalid request body"
              },
              statusCode: 400
            };
          }
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
    const spanProcessor = new OpenBoxSpanProcessor();
    const agent = wrapAgent(
      {
        id: "telemetry-fallback-agent",
        name: "Telemetry Fallback Agent",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return {
            finishReason: "stop",
            modelId: "gpt-4o-mini",
            text: "ok",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2
            }
          };
        }
      },
      {
        client,
        config,
        spanProcessor
      }
    );

    await agent.generate("hello", {
      runId: "agent-telemetry-fallback-run"
    });

    await server.close();

    const completedRequests = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(body => body.event_type === "WorkflowCompleted");

    expect(completedRequests.length).toBe(2);
    expect(workflowCompletedAttempts).toBe(2);
    expect(completedRequests[1]).not.toHaveProperty("input_tokens");
    expect(completedRequests[1]).not.toHaveProperty("model_id");
    expect(completedRequests[1]).toMatchObject({
      event_type: "WorkflowCompleted",
      run_id: "agent-telemetry-fallback-run",
      workflow_id: "agent:telemetry-fallback-agent",
      workflow_type: "telemetry-fallback-agent"
    });
  });

  it("falls back to a size-safe workflow completion payload when event blob is too large", async () => {
    let workflowCompletedAttempts = 0;
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "WorkflowCompleted") {
          workflowCompletedAttempts += 1;

          if (workflowCompletedAttempts === 1) {
            return {
              body: {
                code: 500,
                message:
                  "failed to evaluate event: failed to start workflow: Blob data size exceeds limit."
              },
              statusCode: 500
            };
          }
        }

        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent",
      apiUrl: server.url,
      onApiError: "fail_closed",
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const agent = wrapAgent(
      {
        id: "telemetry-size-fallback-agent",
        name: "Telemetry Size Fallback Agent",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return {
            finishReason: "stop",
            modelId: "gpt-4o-mini",
            text: "x".repeat(200_000),
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120
            }
          };
        }
      },
      {
        client,
        config,
        spanProcessor
      }
    );

    await agent.generate("hello", {
      runId: "agent-telemetry-size-fallback-run"
    });

    await server.close();

    const completedRequests = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(body => body.event_type === "WorkflowCompleted");

    expect(workflowCompletedAttempts).toBe(2);
    expect(completedRequests.length).toBe(2);
    expect(completedRequests[1]).toMatchObject({
      event_type: "WorkflowCompleted",
      input_tokens: 100,
      model_id: "gpt-4o-mini",
      output_tokens: 20,
      run_id: "agent-telemetry-size-fallback-run",
      workflow_id: "agent:telemetry-size-fallback-agent",
      workflow_type: "telemetry-size-fallback-agent"
    });

    const secondSpans = completedRequests[1]?.spans as
      | Array<Record<string, unknown>>
      | undefined;
    expect(Array.isArray(secondSpans)).toBe(true);
    expect(secondSpans?.length).toBe(1);
    expect(secondSpans?.[0]?.name).toBe("openbox.synthetic.model_usage");
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
