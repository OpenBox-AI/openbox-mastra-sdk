import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry
} from "../../src/index.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

// Validates the post-restoration wire shape introduced when the
// syntheticAgentActivity suppression was revoked: every LLM HTTP call inside an
// agent context emits a per-call ActivityStarted{activity_type: "llm_call"} +
// ActivityCompleted{activity_type: "llm_call"} pair, mirroring the LangGraph
// adapter pattern verified against the openbox-core dump.
describe("llm_call activity emission", () => {
  const llmRequestUrl = "https://api.openai.com/v1/chat/completions";
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installLlmFetchMock(responseBody: () => string): {
    callCount: () => number;
  } {
    let calls = 0;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const request = new globalThis.Request(input, init);
      const url = request.url;

      if (url.startsWith("https://api.openai.com/")) {
        calls += 1;
        return new globalThis.Response(responseBody(), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }

      return originalFetch(request);
    }) as typeof fetch;

    return {
      callCount: () => calls
    };
  }

  it("buffers and emits per-LLM-call pair via patched fetch under runWithOpenBoxExecutionContext", async () => {
    // This focused test bypasses Mastra agent plumbing and drives the
    // patched fetch directly under an explicit agent-source execution
    // context — pinning the wire-shape contract without depending on the
    // Mastra/AI-SDK runtime.
    const { runWithOpenBoxExecutionContext } = await import(
      "../../src/governance/context.js"
    );
    const { trace } = await import("@opentelemetry/api");

    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    installLlmFetchMock(() =>
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "hi", role: "assistant" } }
        ],
        model: "gpt-4o-mini",
        usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 }
      })
    );

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_llm_call_emission_focused",
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
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });

    const tracer = trace.getTracer("openbox.test.llm-call");
    await tracer.startActiveSpan("agent.run", async span => {
      await runWithOpenBoxExecutionContext(
        {
          attempt: 1,
          runId: "llm-call-emission-focused-run",
          source: "agent",
          taskQueue: "mastra",
          workflowId: "agent:llm-call-emission-focused",
          workflowType: "llm-call-emission-focused"
        },
        async () => {
          await fetch(llmRequestUrl, {
            body: JSON.stringify({
              messages: [{ content: "hi", role: "user" }],
              model: "gpt-4o-mini"
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
          });
        }
      );
      span.end();
    });

    await telemetry.shutdown();
    await server.close();

    const payloads = server.requests
      .filter(req => req.pathname === "/api/v1/governance/evaluate")
      .map(req => req.body);

    const llmStarted = payloads.filter(
      body =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "llm_call"
    );
    const llmCompleted = payloads.filter(
      body =>
        body.event_type === "ActivityCompleted" &&
        body.activity_type === "llm_call"
    );

    // Emission is 4 events per LLM call (mirrors the openbox-core-renderable
    // tool path): one creation ActivityStarted, two hook_trigger ActivityStarted
    // updates (one span per stage), then one ActivityCompleted with -c suffix.
    expect(llmStarted).toHaveLength(3);
    expect(llmCompleted).toHaveLength(1);

    const initial = llmStarted.find(body => body.hook_trigger !== true);
    const startedHookUpdate = llmStarted.find(
      body => body.hook_trigger === true && body.span_count === 1
        && (body.spans as Array<Record<string, unknown>>)?.[0]?.stage === "started"
    );
    const completedHookUpdate = llmStarted.find(
      body => body.hook_trigger === true && body.span_count === 1
        && (body.spans as Array<Record<string, unknown>>)?.[0]?.stage === "completed"
    );

    expect(initial).toBeDefined();
    expect(startedHookUpdate).toBeDefined();
    expect(completedHookUpdate).toBeDefined();

    const activityId = initial?.activity_id as string;
    expect(typeof activityId).toBe("string");
    expect(activityId.length).toBeGreaterThan(0);
    expect(startedHookUpdate?.activity_id).toBe(activityId);
    expect(completedHookUpdate?.activity_id).toBe(activityId);
    expect(llmCompleted[0]?.activity_id).toBe(`${activityId}-c`);

    expect(initial).toMatchObject({
      activity_type: "llm_call",
      event_type: "ActivityStarted",
      run_id: "llm-call-emission-focused-run",
      source: "workflow-telemetry",
      span_count: 0,
      workflow_id: "agent:llm-call-emission-focused",
      workflow_type: "llm-call-emission-focused"
    });

    const startedHookSpan = (startedHookUpdate?.spans as Array<Record<string, unknown>>)[0];
    expect(
      (startedHookSpan?.attributes as Record<string, unknown> | undefined)?.["http.url"]
    ).toBe(llmRequestUrl);
    const completedHookSpan = (completedHookUpdate?.spans as Array<Record<string, unknown>>)[0];
    expect(
      (completedHookSpan?.attributes as Record<string, unknown> | undefined)?.["http.url"]
    ).toBe(llmRequestUrl);

    // Pin the model + usage projection on every emission — the whole point of
    // restoring per-call activities is to make LLM evidence visible. Values
    // come from the mock response body via extractModelUsageFromHookSpan.
    expect(initial?.model_id).toBe("gpt-4o-mini");
    expect(initial?.model_provider).toBe("openai");
    expect(initial?.input_tokens).toBe(5);
    expect(initial?.output_tokens).toBe(3);
    expect(initial?.total_tokens).toBe(8);

    // OpenBoxClient.normalizeEvaluatePayload strips the empty `spans` array
    // from ActivityCompleted payloads that are not hook_trigger updates;
    // span_count: 0 is the on-wire signal.
    expect(llmCompleted[0]).toMatchObject({
      activity_type: "llm_call",
      event_type: "ActivityCompleted",
      run_id: "llm-call-emission-focused-run",
      span_count: 0,
      workflow_id: "agent:llm-call-emission-focused"
    });
    expect(llmCompleted[0]?.model_id).toBe("gpt-4o-mini");
    expect(llmCompleted[0]?.total_tokens).toBe(8);
    expect(llmCompleted[0]).toHaveProperty("activity_output");
  });

  it("emits http_call (not llm_call) activities for non-LLM URLs in agent context", async () => {
    const { runWithOpenBoxExecutionContext } = await import(
      "../../src/governance/context.js"
    );
    const { trace } = await import("@opentelemetry/api");

    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    let nonLlmCalls = 0;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const request = new globalThis.Request(input, init);
      if (request.url.startsWith("https://api.example.com/")) {
        nonLlmCalls += 1;
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      return originalFetch(request);
    }) as typeof fetch;

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_llm_call_emission_non_llm",
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
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });

    const tracer = trace.getTracer("openbox.test.llm-call");
    await tracer.startActiveSpan("agent.run", async span => {
      await runWithOpenBoxExecutionContext(
        {
          attempt: 1,
          runId: "llm-call-emission-non-llm-run",
          source: "agent",
          taskQueue: "mastra",
          workflowId: "agent:llm-call-emission-non-llm",
          workflowType: "llm-call-emission-non-llm"
        },
        async () => {
          await fetch("https://api.example.com/v1/data", {
            method: "GET"
          });
        }
      );
      span.end();
    });

    await telemetry.shutdown();
    await server.close();

    expect(nonLlmCalls).toBe(1);

    const payloads = server.requests
      .filter(req => req.pathname === "/api/v1/governance/evaluate")
      .map(req => req.body);

    // No llm_call: the URL is not an LLM provider.
    const llmActivities = payloads.filter(
      body => body.activity_type === "llm_call"
    );
    expect(llmActivities).toHaveLength(0);

    // But it IS captured as a per-call http_call activity ("no blind spot"):
    // 1 creation ActivityStarted + 2 hook_trigger updates + 1 ActivityCompleted.
    const httpStarted = payloads.filter(
      body =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "http_call"
    );
    const httpCompleted = payloads.filter(
      body =>
        body.event_type === "ActivityCompleted" &&
        body.activity_type === "http_call"
    );
    expect(httpStarted).toHaveLength(3);
    expect(httpCompleted).toHaveLength(1);
    const initial = httpStarted.find(body => body.hook_trigger !== true);
    expect(initial?.activity_id).toBeDefined();
    expect(httpCompleted[0]?.activity_id).toBe(`${initial?.activity_id}-c`);
  });

  it("assigns distinct activity_ids to parallel LLM HTTP calls without buffer collision", async () => {
    const { runWithOpenBoxExecutionContext } = await import(
      "../../src/governance/context.js"
    );
    const { trace } = await import("@opentelemetry/api");

    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    installLlmFetchMock(() =>
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "ok", role: "assistant" } }
        ],
        model: "gpt-4o-mini",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
      })
    );

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_llm_call_emission_parallel",
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
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });

    const tracer = trace.getTracer("openbox.test.llm-call");
    await tracer.startActiveSpan("agent.run", async span => {
      await runWithOpenBoxExecutionContext(
        {
          attempt: 1,
          runId: "llm-call-emission-parallel-run",
          source: "agent",
          taskQueue: "mastra",
          workflowId: "agent:llm-call-emission-parallel",
          workflowType: "llm-call-emission-parallel"
        },
        async () => {
          await Promise.all([
            fetch(llmRequestUrl, {
              body: JSON.stringify({ messages: [{ content: "a", role: "user" }], model: "gpt-4o-mini" }),
              headers: { "content-type": "application/json" },
              method: "POST"
            }),
            fetch(llmRequestUrl, {
              body: JSON.stringify({ messages: [{ content: "b", role: "user" }], model: "gpt-4o-mini" }),
              headers: { "content-type": "application/json" },
              method: "POST"
            }),
            fetch(llmRequestUrl, {
              body: JSON.stringify({ messages: [{ content: "c", role: "user" }], model: "gpt-4o-mini" }),
              headers: { "content-type": "application/json" },
              method: "POST"
            })
          ]);
        }
      );
      span.end();
    });

    await telemetry.shutdown();
    await server.close();

    const payloads = server.requests
      .filter(req => req.pathname === "/api/v1/governance/evaluate")
      .map(req => req.body);

    const llmStarted = payloads.filter(
      body =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "llm_call"
    );
    const llmCompleted = payloads.filter(
      body =>
        body.event_type === "ActivityCompleted" &&
        body.activity_type === "llm_call"
    );

    // 3 LLM calls × 3 ActivityStarted events each (init + started-hook + completed-hook)
    // and 1 ActivityCompleted each.
    expect(llmStarted).toHaveLength(9);
    expect(llmCompleted).toHaveLength(3);

    const initialEvents = llmStarted.filter(body => body.hook_trigger !== true);
    expect(initialEvents).toHaveLength(3);
    const startedIds = initialEvents.map(body => body.activity_id as string);
    const completedIds = llmCompleted.map(body => body.activity_id as string);

    expect(new Set(startedIds).size).toBe(3);
    expect(new Set(completedIds).size).toBe(3);

    for (const startedId of startedIds) {
      expect(completedIds).toContain(`${startedId}-c`);
    }
  });

  it("classifies GET https://api.openai.com/v1/models as http_call (not llm_call): only POST to LLM hosts is llm_call", async () => {
    const { runWithOpenBoxExecutionContext } = await import(
      "../../src/governance/context.js"
    );
    const { trace } = await import("@opentelemetry/api");

    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const request = new globalThis.Request(input, init);
      if (request.url === "https://api.openai.com/v1/models") {
        return new globalThis.Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      return originalFetch(request);
    }) as typeof fetch;

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_llm_call_get_models",
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
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });

    const tracer = trace.getTracer("openbox.test.llm-call");
    await tracer.startActiveSpan("agent.run", async span => {
      await runWithOpenBoxExecutionContext(
        {
          attempt: 1,
          runId: "llm-call-emission-get-models-run",
          source: "agent",
          taskQueue: "mastra",
          workflowId: "agent:llm-call-emission-get-models",
          workflowType: "llm-call-emission-get-models"
        },
        async () => {
          await fetch("https://api.openai.com/v1/models", { method: "GET" });
        }
      );
      span.end();
    });

    await telemetry.shutdown();
    await server.close();

    const payloads = server.requests
      .filter(req => req.pathname === "/api/v1/governance/evaluate")
      .map(req => req.body);

    const llmActivities = payloads.filter(
      body => body.activity_type === "llm_call"
    );
    const httpActivities = payloads.filter(
      body => body.activity_type === "http_call"
    );
    expect(llmActivities).toHaveLength(0);
    expect(httpActivities.length).toBeGreaterThan(0);
  });

  it("captures HTTP outside any OpenBox execution context (runtime middleware) as http_call with runtime placeholders", async () => {
    const { trace } = await import("@opentelemetry/api");

    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const request = new globalThis.Request(input, init);
      if (request.url.startsWith("https://telemetry.example.com/")) {
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      return originalFetch(request);
    }) as typeof fetch;

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_runtime_http",
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
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });

    // No runWithOpenBoxExecutionContext wrap — simulates CopilotKit Runtime
    // middleware firing HTTP outside any wrapped agent's execution context.
    // The active OTel span is enough for patchedFetch to proceed.
    const tracer = trace.getTracer("openbox.test.runtime-http");
    await tracer.startActiveSpan("runtime.middleware", async span => {
      await fetch("https://telemetry.example.com/ingest", {
        body: JSON.stringify({ event: "ping" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      span.end();
    });

    await telemetry.shutdown();
    await server.close();

    const payloads = server.requests
      .filter(req => req.pathname === "/api/v1/governance/evaluate")
      .map(req => req.body);

    const httpStarted = payloads.filter(
      body =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "http_call"
    );
    const httpCompleted = payloads.filter(
      body =>
        body.event_type === "ActivityCompleted" &&
        body.activity_type === "http_call"
    );

    expect(httpStarted).toHaveLength(3);
    expect(httpCompleted).toHaveLength(1);

    const initial = httpStarted.find(body => body.hook_trigger !== true);
    expect(initial).toBeDefined();
    expect(initial?.workflow_id).toBe("runtime");
    expect(initial?.workflow_type).toBe("runtime");
    expect(typeof initial?.run_id).toBe("string");
    expect((initial?.run_id as string).startsWith("runtime:")).toBe(true);
    expect(httpCompleted[0]?.activity_id).toBe(`${initial?.activity_id}-c`);
  });

  it("preserves fail-open posture: openbox-server 500 on evaluate does not surface as fetch error", async () => {
    const { runWithOpenBoxExecutionContext } = await import(
      "../../src/governance/context.js"
    );
    const { trace } = await import("@opentelemetry/api");

    // openbox-server returns 500 on every evaluate; the SDK's fail-open
    // emission contract must swallow it so the wrapped fetch resolves
    // normally and the agent run is unaffected by a governance outage.
    const server = await startOpenBoxServer({
      evaluate() {
        return {
          body: { error: "internal" },
          statusCode: 500
        };
      }
    });

    installLlmFetchMock(() =>
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "ok", role: "assistant" } }
        ],
        model: "gpt-4o-mini",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
      })
    );

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_llm_call_fail_open",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: "fail_open",
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const telemetry = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });

    const tracer = trace.getTracer("openbox.test.llm-call");
    let llmResponseStatus: number | undefined;

    await tracer.startActiveSpan("agent.run", async span => {
      await runWithOpenBoxExecutionContext(
        {
          attempt: 1,
          runId: "llm-call-emission-fail-open-run",
          source: "agent",
          taskQueue: "mastra",
          workflowId: "agent:llm-call-emission-fail-open",
          workflowType: "llm-call-emission-fail-open"
        },
        async () => {
          // If emission throws, this await would reject. The contract is that
          // it must resolve with the mock LLM response.
          const response = await fetch(llmRequestUrl, {
            body: JSON.stringify({
              messages: [{ content: "hi", role: "user" }],
              model: "gpt-4o-mini"
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
          });
          llmResponseStatus = response.status;
        }
      );
      span.end();
    });

    await telemetry.shutdown();
    await server.close();

    expect(llmResponseStatus).toBe(200);
  });
});
