import { createServer } from "node:http";

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { trace } from "@opentelemetry/api";
import { z } from "zod";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  WorkflowSpanBuffer,
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
      "SignalReceived",
      "SignalReceived",
      "WorkflowCompleted",
      "WorkflowStarted",
      "SignalReceived",
      "SignalReceived",
      "WorkflowCompleted"
    ]);

    const signalEvents = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(body => body.event_type === "SignalReceived");
    const inputSignals = signalEvents.filter(
      body => body.signal_name === "user_input"
    );
    const outputSignals = signalEvents.filter(
      body => body.signal_name === "agent_output"
    );

    expect(inputSignals).toHaveLength(2);
    expect(inputSignals[0]).toMatchObject({
      event_type: "SignalReceived",
      run_id: "agent-generate-run",
      signal_args: ["hello", { goal: "hello", prompt: "hello" }],
      signal_name: "user_input",
      workflow_id: "agent:assistant-agent",
      workflow_type: "assistant-agent"
    });
    expect(inputSignals[1]).toMatchObject({
      event_type: "SignalReceived",
      run_id: "agent-stream-run",
      signal_args: ["hello", { goal: "hello", prompt: "hello" }],
      signal_name: "user_input",
      workflow_id: "agent:assistant-agent",
      workflow_type: "assistant-agent"
    });
    expect(outputSignals).toHaveLength(2);
    expect(outputSignals[0]).toMatchObject({
      event_type: "SignalReceived",
      run_id: "agent-generate-run",
      signal_name: "agent_output",
      workflow_id: "agent:assistant-agent",
      workflow_type: "assistant-agent"
    });
    expect(outputSignals[1]).toMatchObject({
      event_type: "SignalReceived",
      run_id: "agent-stream-run",
      signal_name: "agent_output",
      workflow_id: "agent:assistant-agent",
      workflow_type: "assistant-agent"
    });
  });

  it("normalizes chat message arrays to latest user prompt in SignalReceived", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent_signal_prompt",
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
        id: "assistant-agent-signal-prompt",
        instructions: "Be concise.",
        model: createMockModel({
          mockText: "ready",
          version: "v2"
        }) as never,
        name: "Assistant Agent Signal Prompt"
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    await agent.generate(
      [
        {
          content: "earlier question",
          role: "user"
        },
        {
          content: "assistant response",
          role: "assistant"
        },
        {
          parts: [
            {
              text: "latest question",
              type: "text"
            }
          ],
          role: "user"
        }
      ] as never,
      {
        runId: "agent-signal-prompt-run"
      }
    );

    await server.close();

    const signalEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(
        body =>
          body.event_type === "SignalReceived" &&
          body.signal_name === "user_input"
      );

    expect(signalEvent).toBeDefined();
    expect(signalEvent).toMatchObject({
      event_type: "SignalReceived",
      run_id: "agent-signal-prompt-run",
      signal_args: [
        "latest question",
        { goal: "latest question", prompt: "latest question" }
      ],
      signal_name: "user_input",
      workflow_id: "agent:assistant-agent-signal-prompt",
      workflow_type: "assistant-agent-signal-prompt"
    });
  });

  it("extracts latest user prompt from JSON-encoded structured content in SignalReceived", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent_signal_json_prompt",
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
        id: "assistant-agent-signal-json-prompt",
        instructions: "Be concise.",
        model: createMockModel({
          mockText: "ready",
          version: "v2"
        }) as never,
        name: "Assistant Agent Signal JSON Prompt"
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    await agent.generate(
      [
        {
          content: [
            {
              text: '[{"type":"text","text":"Create hello world file"}]',
              type: "text"
            }
          ],
          role: "user"
        }
      ] as never,
      {
        runId: "agent-signal-json-prompt-run"
      }
    );

    await server.close();

    const signalEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(
        body =>
          body.event_type === "SignalReceived" &&
          body.signal_name === "user_input"
      );

    expect(signalEvent).toBeDefined();
    expect(signalEvent).toMatchObject({
      event_type: "SignalReceived",
      run_id: "agent-signal-json-prompt-run",
      signal_args: [
        "Create hello world file",
        { goal: "Create hello world file", prompt: "Create hello world file" }
      ],
      signal_name: "user_input",
      workflow_id: "agent:assistant-agent-signal-json-prompt",
      workflow_type: "assistant-agent-signal-json-prompt"
    });
  });

  it("attaches started and completed LLM spans to agent_output SignalReceived events", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent_output_signal_spans",
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
    const runId = "agent-output-signal-spans-run";
    const workflowType = "assistant-agent-output-signal-spans";
    const workflowId = `agent:${workflowType}`;

    spanProcessor.registerWorkflow(
      workflowId,
      new WorkflowSpanBuffer({
        runId,
        taskQueue: "mastra",
        workflowId,
        workflowType
      })
    );

    spanProcessor.getBuffer(workflowId, runId)?.spans.push({
      attributes: {
        "http.method": "POST",
        "http.url": "https://api.openai.com/v1/responses"
      },
      durationNs: 100_000,
      endTime: 2_000_000,
      events: [],
      kind: "CLIENT",
      name: "agent.openai.call",
      requestBody: JSON.stringify({
        input: "hello",
        model: "gpt-4.1"
      }),
      responseBody: JSON.stringify({
        model: "gpt-4.1",
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      }),
      semanticType: "llm_completion",
      spanId: "1111111111111111",
      startTime: 1_900_000,
      status: {
        code: "OK"
      },
      traceId: "22222222222222222222222222222222"
    } as Record<string, unknown>);

    const agent = wrapAgent(
      new Agent({
        id: workflowType,
        instructions: "Be concise.",
        model: createMockModel({
          mockText: "done",
          version: "v2"
        }) as never,
        name: "Assistant Agent Output Signal Spans"
      }),
      {
        client,
        config,
        spanProcessor
      }
    );

    await agent.generate("hello", { runId });
    await server.close();

    const outputSignal = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(
        body =>
          body.event_type === "SignalReceived" &&
          body.signal_name === "agent_output" &&
          body.run_id === runId
      );

    expect(outputSignal).toBeDefined();
    expect(outputSignal).toMatchObject({
      event_type: "SignalReceived",
      run_id: runId,
      signal_name: "agent_output",
      span_count: 2,
      workflow_id: workflowId,
      workflow_type: workflowType
    });

    const spans = (outputSignal?.spans as Array<Record<string, unknown>> | undefined) ?? [];
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      name: "agent.openai.call",
      request_body: JSON.stringify({
        input: "hello",
        model: "gpt-4.1"
      }),
      semantic_type: "llm_completion",
      stage: "started"
    });
    expect(spans[1]).toMatchObject({
      name: "agent.openai.call",
      request_body: JSON.stringify({
        input: "hello",
        model: "gpt-4.1"
      }),
      response_body: JSON.stringify({
        model: "gpt-4.1",
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      }),
      semantic_type: "llm_completion",
      stage: "completed"
    });
    expect(spans[0]?.span_id).toBe(spans[1]?.span_id);
    expect(spans[0]).not.toHaveProperty("response_body");
  });

  it("derives governance goal from latest user prompt for agent lifecycle events", async () => {
    const previousGoal = process.env.OPENBOX_AGENT_GOAL;
    delete process.env.OPENBOX_AGENT_GOAL;

    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_agent_goal_from_prompt",
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
        id: "assistant-agent-goal-from-prompt",
        instructions: "You are a generic assistant.",
        model: createMockModel({
          mockText: "done",
          version: "v2"
        }) as never,
        name: "Assistant Agent Goal From Prompt"
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    try {
      await agent.generate(
        [
          { content: "Ignore this previous request", role: "user" },
          { content: "ack", role: "assistant" },
          { content: "Build a calculator app", role: "user" }
        ] as never,
        {
          runId: "agent-goal-from-prompt-run"
        }
      );
    } finally {
      await server.close();
      if (previousGoal === undefined) {
        delete process.env.OPENBOX_AGENT_GOAL;
      } else {
        process.env.OPENBOX_AGENT_GOAL = previousGoal;
      }
    }

    const lifecycleEvents = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(
        body =>
          body.event_type === "WorkflowStarted" ||
          body.event_type === "SignalReceived" ||
          body.event_type === "WorkflowCompleted"
      );

    expect(lifecycleEvents).toHaveLength(4);
    expect(lifecycleEvents[0]).toMatchObject({
      event_type: "WorkflowStarted",
      goal: "Build a calculator app",
      run_id: "agent-goal-from-prompt-run",
      workflow_id: "agent:assistant-agent-goal-from-prompt",
      workflow_type: "assistant-agent-goal-from-prompt"
    });
    expect(lifecycleEvents[1]).toMatchObject({
      event_type: "SignalReceived",
      goal: "Build a calculator app",
      run_id: "agent-goal-from-prompt-run",
      signal_args: [
        "Build a calculator app",
        { goal: "Build a calculator app", prompt: "Build a calculator app" }
      ],
      signal_name: "user_input"
    });
    expect(lifecycleEvents[2]).toMatchObject({
      event_type: "SignalReceived",
      goal: "Build a calculator app",
      run_id: "agent-goal-from-prompt-run",
      signal_name: "agent_output"
    });
    expect(lifecycleEvents[3]).toMatchObject({
      event_type: "WorkflowCompleted",
      goal: "Build a calculator app",
      run_id: "agent-goal-from-prompt-run"
    });
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
      "SignalReceived",
      "ActivityStarted",
      "ActivityCompleted",
      "SignalReceived",
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
    expect(completedEvent).toHaveProperty("start_time");
    expect(
      typeof (completedEvent as { duration_ms?: unknown }).duration_ms
    ).toBe("number");
    expect(typeof (completedEvent as { start_time?: unknown }).start_time).toBe("number");
    expect(typeof (completedEvent as { end_time?: unknown }).end_time).toBe("number");

    // Per-call llm_call activities now carry LLM evidence; WorkflowCompleted
    // no longer rolls up a synthetic openai.com span. Token + model identity
    // remain at the top level for workflow-level reporting.
    const spans = (completedEvent as { spans?: Array<Record<string, unknown>> }).spans ?? [];
    const syntheticUsageSpan = spans.find(span => {
      const attributes =
        span.attributes && typeof span.attributes === "object"
          ? (span.attributes as Record<string, unknown>)
          : undefined;
      return attributes?.["http.url"] === "https://api.openai.com/v1/responses";
    });
    expect(syntheticUsageSpan).toBeUndefined();
    expect(completedEvent).not.toHaveProperty("synthetic_model_usage_span");
    expect(completedEvent).not.toHaveProperty("workflow_model_id");
    expect(completedEvent).not.toHaveProperty("workflow_model_provider");
  });


  it("falls back to compact workflow completion payload when telemetry schema is rejected", async () => {
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
    expect(completedRequests[1]).toMatchObject({
      event_type: "WorkflowCompleted",
      input_tokens: 1,
      model_id: "gpt-4o-mini",
      output_tokens: 1,
      run_id: "agent-telemetry-fallback-run",
      workflow_id: "agent:telemetry-fallback-agent",
      workflow_type: "telemetry-fallback-agent"
    });
    // Compact fallback payload no longer carries a synthetic LLM rollup span;
    // per-call llm_call activities own LLM evidence. The compact tier sends an
    // empty spans array (or omits it) with span_count: 0.
    const fallbackSpans = (completedRequests[1]?.spans ?? []) as Array<Record<string, unknown>>;
    expect(fallbackSpans).toEqual([]);
    expect(completedRequests[1]?.span_count).toBe(0);
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

    // Size-safe fallback tier mirrors the compact tier: no synthetic LLM
    // rollup; spans omitted/empty with span_count: 0. Per-call llm_call
    // activities carry the LLM evidence.
    const secondSpans = (completedRequests[1]?.spans ?? []) as Array<Record<string, unknown>>;
    expect(secondSpans).toEqual([]);
    expect(completedRequests[1]?.span_count).toBe(0);
  });

  it("falls back to an ultra-minimal workflow completion payload after compact fallback timeout", async () => {
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

          if (workflowCompletedAttempts === 2) {
            return {
              body: {
                code: 500,
                message:
                  "failed to evaluate event: failed to start workflow: context deadline exceeded"
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
        id: "telemetry-ultra-minimal-fallback-agent",
        name: "Telemetry Ultra Minimal Fallback Agent",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return {
            finishReason: "stop",
            modelId: "gpt-4o-mini",
            text: "x".repeat(200_000),
            usage: {
              inputTokens: 200,
              outputTokens: 40,
              totalTokens: 240
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

    await expect(
      agent.generate("hello", {
        runId: "agent-ultra-minimal-fallback-run"
      })
    ).resolves.toMatchObject({
      finishReason: "stop"
    });

    await server.close();

    const completedRequests = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(body => body.event_type === "WorkflowCompleted");

    expect(workflowCompletedAttempts).toBe(3);
    expect(completedRequests.length).toBe(3);
    expect(completedRequests[2]).toMatchObject({
      event_type: "WorkflowCompleted",
      input_tokens: 200,
      output_tokens: 40,
      run_id: "agent-ultra-minimal-fallback-run",
      workflow_id: "agent:telemetry-ultra-minimal-fallback-agent",
      workflow_type: "telemetry-ultra-minimal-fallback-agent"
    });
    expect(completedRequests[2]).not.toHaveProperty("spans");
    expect(completedRequests[2]).not.toHaveProperty("workflow_output");
  });

  it("skips oversized completion payload tiers using byte budget preflight", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig(
      {
        apiKey: "obx_test_agent",
        apiUrl: server.url,
        validate: false
      },
      {
        OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES: "300"
      } as NodeJS.ProcessEnv
    );
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const agent = wrapAgent(
      {
        id: "telemetry-byte-budget-agent",
        name: "Telemetry Byte Budget Agent",
        async generate(
          _messages?: unknown,
          _executionOptions?: Record<string, unknown>
        ) {
          return {
            finishReason: "stop",
            modelId: "gpt-4o-mini",
            text: "x".repeat(50_000),
            usage: {
              inputTokens: 50,
              outputTokens: 10,
              totalTokens: 60
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
      runId: "agent-byte-budget-run"
    });

    await server.close();

    const completedRequests = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(body => body.event_type === "WorkflowCompleted");

    expect(completedRequests.length).toBe(1);
    expect(completedRequests[0]).toMatchObject({
      event_type: "WorkflowCompleted",
      input_tokens: 50,
      output_tokens: 10,
      run_id: "agent-byte-budget-run",
      workflow_id: "agent:telemetry-byte-budget-agent",
      workflow_type: "telemetry-byte-budget-agent"
    });
    expect(completedRequests[0]).not.toHaveProperty("spans");
    expect(completedRequests[0]).not.toHaveProperty("workflow_output");
  });

  it("isolates completion spans by run id for concurrent agent runs", async () => {
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
        id: "concurrent-span-agent",
        name: "Concurrent Span Agent",
        async generate(
          _messages?: unknown,
          executionOptions?: Record<string, unknown>
        ) {
          const candidateRunId = executionOptions?.runId;
          const runId =
            typeof candidateRunId === "string" && candidateRunId.length > 0
              ? candidateRunId
              : "unknown-run";

          return trace
            .getTracer("openbox.test")
            .startActiveSpan(`agent.run.${runId}`, async span => {
              if (runId === "run-a") {
                await new Promise(resolve => setTimeout(resolve, 25));
              } else {
                await new Promise(resolve => setTimeout(resolve, 5));
              }

              span.end();

              return {
                finishReason: "stop",
                modelId: "gpt-4o-mini",
                text: runId,
                usage: {
                  inputTokens: 5,
                  outputTokens: 2,
                  totalTokens: 7
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

    await Promise.all([
      fakeAgent.generate("hello", {
        runId: "run-a"
      }),
      fakeAgent.generate("hello", {
        runId: "run-b"
      })
    ]);

    await telemetry.shutdown();
    await server.close();

    const completedRequests = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(body => body.event_type === "WorkflowCompleted");

    const runAEvent = completedRequests.find(body => body.run_id === "run-a") as
      | { spans?: Array<Record<string, unknown>> }
      | undefined;
    const runBEvent = completedRequests.find(body => body.run_id === "run-b") as
      | { spans?: Array<Record<string, unknown>> }
      | undefined;

    expect(runAEvent).toBeDefined();
    expect(runBEvent).toBeDefined();
    expect(runAEvent?.spans?.some(span => span.name === "agent.run.run-a")).toBe(true);
    expect(runAEvent?.spans?.some(span => span.name === "agent.run.run-b")).toBe(false);
    expect(runBEvent?.spans?.some(span => span.name === "agent.run.run-b")).toBe(true);
    expect(runBEvent?.spans?.some(span => span.name === "agent.run.run-a")).toBe(false);
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

    expect(preCompletionEvents).toEqual(["WorkflowStarted", "SignalReceived"]);

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
