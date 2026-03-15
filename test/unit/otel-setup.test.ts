import { createServer } from "node:http";

import { context, trace } from "@opentelemetry/api";

import {
  ApprovalPendingError,
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
  traced
} from "../../src/index.js";
import {
  clearActivityApproval,
  markActivityApproved
} from "../../src/governance/approval-registry.js";
import { runWithOpenBoxExecutionContext } from "../../src/governance/context.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

describe("setupOpenBoxOpenTelemetry", () => {
  it("respects instrumentation toggles", async () => {
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const names = controller.instrumentations.map(
      instrumentation => instrumentation.instrumentationName
    );

    expect(names).not.toContain("@opentelemetry/instrumentation-fs");
    expect(names).not.toContain("@opentelemetry/instrumentation-pg");
    expect(names).not.toContain("@opentelemetry/instrumentation-http");

    await controller.shutdown();
  });

  it("selects only requested database instrumentations", async () => {
    const controller = setupOpenBoxOpenTelemetry({
      dbLibraries: new Set(["pg", "redis"]),
      instrumentDatabases: true,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const names = controller.instrumentations.map(
      instrumentation => instrumentation.instrumentationName
    );

    expect(names).toContain("@opentelemetry/instrumentation-http");
    expect(names).toContain("@opentelemetry/instrumentation-undici");
    expect(names).toContain("@opentelemetry/instrumentation-pg");
    expect(names).toContain("@opentelemetry/instrumentation-redis");
    expect(names).not.toContain("@opentelemetry/instrumentation-mysql");

    await controller.shutdown();
  });

  it("emits started/completed hook governance events for HTTP requests", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      let body = "";

      request.setEncoding("utf8");
      request.on("data", chunk => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ echoed: body }));
      });
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("activity.searchCryptoCoins", {
      attributes: {
        "openbox.activity_id": "act-123",
        "openbox.run_id": "run-123",
        "openbox.workflow_id": "wf-123"
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-123",
      "act-123",
      "run-123"
    );
    spanProcessor.setActivityContext("wf-123", "act-123", {
      activity_id: "act-123",
      activity_input: [
        {
          keyword: "bitcoin"
        }
      ],
      activity_type: "searchCryptoCoins",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });

    await runWithOpenBoxExecutionContext(
      {
        activityId: "act-123",
        activityType: "searchCryptoCoins",
        attempt: 1,
        runId: "run-123",
        source: "tool",
        taskQueue: "mastra",
        workflowId: "wf-123",
        workflowType: "crypto-agent"
      },
      async () => {
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
          const response = await fetch(downstreamUrl, {
            body: JSON.stringify({
              model: "gpt-4o-mini"
            }),
            headers: {
              "content-type": "application/json"
            },
            method: "POST"
          });

          await response.text();
        });
      }
    );

    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(payload => payload.hook_trigger !== undefined);

    expect(hookEvents).toHaveLength(2);

    const started = hookEvents.find(
      payload =>
        payload.event_type === "ActivityStarted" &&
        payload.hook_trigger &&
        (payload.hook_trigger as Record<string, unknown>).stage === "started"
    );
    const completed = hookEvents.find(
      payload =>
        payload.event_type === "ActivityCompleted" &&
        payload.hook_trigger &&
        (payload.hook_trigger as Record<string, unknown>).stage === "completed"
    );

    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(started?.hook_trigger).toMatchObject({
      attribute_key_identifiers: ["http.method", "http.url"],
      method: "POST",
      type: "http_request",
      url: downstreamUrl
    });
    expect(completed?.hook_trigger).toMatchObject({
      attribute_key_identifiers: ["http.method", "http.url"],
      method: "POST",
      type: "http_request",
      url: downstreamUrl
    });
    expect(started).toMatchObject({
      activity_id: "act-123::hook:http_request:started",
      activity_input: [
        {
          keyword: "bitcoin"
        }
      ],
      activity_type: "searchCryptoCoins",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });
    expect(completed).toMatchObject({
      activity_id: "act-123::hook:http_request:completed",
      activity_input: [
        {
          keyword: "bitcoin"
        }
      ],
      activity_type: "searchCryptoCoins",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });
    const startedSpan = (
      started as { spans?: Array<Record<string, unknown>> } | undefined
    )?.spans?.[0];
    const completedSpan = (
      completed as { spans?: Array<Record<string, unknown>> } | undefined
    )?.spans?.[0];

    expect(startedSpan).toMatchObject({
      stage: "started"
    });
    expect(completedSpan).toMatchObject({
      stage: "completed"
    });
  });

  it("emits hook governance events for agent context without tool activity context", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      let body = "";

      request.setEncoding("utf8");
      request.on("data", chunk => {
        body += chunk;
      });
      request.on("end", () => {
        let model = "gpt-4.1";

        try {
          const parsed = JSON.parse(body) as { model?: unknown };

          if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
            model = parsed.model;
          }
        } catch {
          // Ignore malformed request body in test fixture.
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model,
            usage: {
              input_tokens: 42,
              output_tokens: 7,
              total_tokens: 49
            }
          })
        );
      });
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events_agent_context",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("agent.run");

    await runWithOpenBoxExecutionContext(
      {
        runId: "run-agent-1",
        source: "agent",
        taskQueue: "mastra",
        workflowId: "wf-agent-1",
        workflowType: "coding-agent"
      },
      async () => {
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
          const response = await fetch(downstreamUrl, {
            body: JSON.stringify({
              model: "gpt-4.1"
            }),
            headers: {
              "content-type": "application/json"
            },
            method: "POST"
          });

          await response.text();
        });
      }
    );

    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(payload => payload.hook_trigger !== undefined);

    expect(hookEvents).toHaveLength(2);

    const started = hookEvents.find(
      payload =>
        payload.event_type === "ActivityStarted" &&
        payload.hook_trigger &&
        (payload.hook_trigger as Record<string, unknown>).stage === "started"
    );
    const completed = hookEvents.find(
      payload =>
        payload.event_type === "ActivityCompleted" &&
        payload.hook_trigger &&
        (payload.hook_trigger as Record<string, unknown>).stage === "completed"
    );

    expect(started).toMatchObject({
      activity_id:
        "wf-agent-1::agent-llm::run-agent-1::hook:http_request:started",
      activity_type: "agentLlmCompletion",
      model: "gpt-4-1",
      model_id: "gpt-4.1",
      model_provider: "openai",
      provider: "openai",
      run_id: "run-agent-1",
      workflow_id: "wf-agent-1",
      workflow_type: "coding-agent"
    });
    expect(completed).toMatchObject({
      activity_id:
        "wf-agent-1::agent-llm::run-agent-1::hook:http_request:completed",
      activity_type: "agentLlmCompletion",
      input_tokens: 42,
      model: "gpt-4-1",
      model_id: "gpt-4.1",
      model_provider: "openai",
      output_tokens: 7,
      provider: "openai",
      run_id: "run-agent-1",
      total_tokens: 49,
      workflow_id: "wf-agent-1",
      workflow_type: "coding-agent"
    });
    expect((started as Record<string, unknown>)?.activity_input).toMatchObject([
      {
        model: "gpt-4-1",
        model_id: "gpt-4.1"
      }
    ]);
    expect((completed as Record<string, unknown>)?.activity_input).toMatchObject([
      {
        model: "gpt-4-1",
        model_id: "gpt-4.1"
      }
    ]);
    expect((completed as Record<string, unknown>)?.activity_output).toMatchObject({
      model: "gpt-4-1",
      model_id: "gpt-4.1",
      usage: {
        input_tokens: 42,
        output_tokens: 7,
        total_tokens: 49
      }
    });
    const startedSpan = (
      started as { spans?: Array<Record<string, unknown>> } | undefined
    )?.spans?.[0];
    const completedSpan = (
      completed as { spans?: Array<Record<string, unknown>> } | undefined
    )?.spans?.[0];
    const startedRequestBody = (
      startedSpan as { request_body?: unknown } | undefined
    )?.request_body;
    const completedResponseBody = (
      completedSpan as { response_body?: unknown } | undefined
    )?.response_body;

    expect(typeof startedRequestBody).toBe("string");
    expect(typeof completedResponseBody).toBe("string");

    const parsedStartedRequest = JSON.parse(startedRequestBody as string) as {
      model?: string;
      model_id?: string;
    };
    const parsedCompletedResponse = JSON.parse(
      completedResponseBody as string
    ) as {
      model?: string;
      model_id?: string;
    };

    expect(parsedStartedRequest.model).toBe("gpt-4-1");
    expect(parsedStartedRequest.model_id).toBe("gpt-4.1");
    expect(parsedCompletedResponse.model).toBe("gpt-4-1");
    expect(parsedCompletedResponse.model_id).toBe("gpt-4.1");
  });

  it("raises ApprovalPendingError when hook-level governance returns REQUIRE_APPROVAL", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate(body) {
        if (
          body.hook_trigger &&
          (body.hook_trigger as Record<string, unknown>).stage === "started"
        ) {
          return {
            reason: "Hook-level approval required",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("activity.searchCryptoCoins", {
      attributes: {
        "openbox.activity_id": "act-approval-123",
        "openbox.run_id": "run-approval-123",
        "openbox.workflow_id": "wf-approval-123"
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-approval-123",
      "act-approval-123",
      "run-approval-123"
    );

    await expect(
      runWithOpenBoxExecutionContext(
        {
          activityId: "act-approval-123",
          activityType: "searchCryptoCoins",
          attempt: 1,
          runId: "run-approval-123",
          source: "tool",
          taskQueue: "mastra",
          workflowId: "wf-approval-123",
          workflowType: "crypto-agent"
        },
        async () => {
          return context.with(trace.setSpan(context.active(), rootSpan), async () => {
            await fetch(downstreamUrl, {
              body: JSON.stringify({
                symbol: "btc"
              }),
              headers: {
                "content-type": "application/json"
              },
              method: "POST"
            });
          });
        }
      )
    ).rejects.toBeInstanceOf(ApprovalPendingError);

    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();
  });

  it("allows approved activities to continue when nested hook requests approval", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate(body) {
        if (
          body.hook_trigger &&
          (body.hook_trigger as Record<string, unknown>).stage === "started"
        ) {
          return {
            reason: "Hook-level approval required",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval_already_granted",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("activity.createSandbox", {
      attributes: {
        "openbox.activity_id": "act-approved-123",
        "openbox.run_id": "run-approved-123",
        "openbox.workflow_id": "wf-approved-123"
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-approved-123",
      "act-approved-123",
      "run-approved-123"
    );
    markActivityApproved("run-approved-123", "act-approved-123");

    await expect(
      runWithOpenBoxExecutionContext(
        {
          activityId: "act-approved-123",
          activityType: "createSandbox",
          attempt: 1,
          runId: "run-approved-123",
          source: "tool",
          taskQueue: "mastra",
          workflowId: "wf-approved-123",
          workflowType: "coding-agent"
        },
        async () => {
          return context.with(trace.setSpan(context.active(), rootSpan), async () => {
            const response = await fetch(downstreamUrl, {
              body: JSON.stringify({
                action: "create-sandbox"
              }),
              headers: {
                "content-type": "application/json"
              },
              method: "POST"
            });

            await response.text();
          });
        }
      )
    ).resolves.toBeUndefined();

    clearActivityApproval("run-approved-123", "act-approved-123");
    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();
  });

  it("emits started/completed hook governance events for traced function calls", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events_function",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracedFn = traced(
      async (a: number, b: number) => a + b,
      {
        captureArgs: true,
        captureResult: true,
        module: "math",
        name: "sum"
      }
    );

    const result = await runWithOpenBoxExecutionContext(
      {
        activityId: "act-fn-123",
        activityType: "calculateTotals",
        attempt: 1,
        runId: "run-fn-123",
        source: "tool",
        taskQueue: "mastra",
        workflowId: "wf-fn-123",
        workflowType: "crypto-agent"
      },
      async () => tracedFn(2, 3)
    );

    await controller.shutdown();
    await openBoxServer.close();

    expect(result).toBe(5);

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(
        payload =>
          payload.hook_trigger !== undefined &&
          (payload.hook_trigger as Record<string, unknown>).type ===
            "function_call"
      );

    expect(hookEvents).toHaveLength(2);
    const started = hookEvents.find(
      payload =>
        (payload.hook_trigger as Record<string, unknown>).stage === "started"
    );
    const completed = hookEvents.find(
      payload =>
        (payload.hook_trigger as Record<string, unknown>).stage === "completed"
    );

    expect(started?.hook_trigger).toMatchObject({
      attribute_key_identifiers: ["code.function", "code.namespace"],
      args: [2, 3],
      function: "sum",
      module: "math",
      type: "function_call"
    });
    expect(completed?.hook_trigger).toMatchObject({
      attribute_key_identifiers: ["code.function", "code.namespace"],
      function: "sum",
      module: "math",
      result: 5,
      type: "function_call"
    });
  });

  it("raises ApprovalPendingError for traced function calls when governance requires approval", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate(body) {
        if (
          body.hook_trigger &&
          (body.hook_trigger as Record<string, unknown>).type ===
            "function_call" &&
          (body.hook_trigger as Record<string, unknown>).stage === "started"
        ) {
          return {
            reason: "Function execution requires approval",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval_function",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracedFn = traced(
      async () => 42,
      {
        module: "math",
        name: "constant"
      }
    );

    await expect(
      runWithOpenBoxExecutionContext(
        {
          activityId: "act-fn-approval-123",
          activityType: "calculateTotals",
          attempt: 1,
          runId: "run-fn-approval-123",
          source: "tool",
          taskQueue: "mastra",
          workflowId: "wf-fn-approval-123",
          workflowType: "crypto-agent"
        },
        async () => tracedFn()
      )
    ).rejects.toBeInstanceOf(ApprovalPendingError);

    await controller.shutdown();
    await openBoxServer.close();
  });

  it("emits started/completed hook governance events for database queries", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events_db",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      dbLibraries: new Set(["pg"]),
      governanceClient: client,
      instrumentDatabases: true,
      instrumentFileIo: false,
      spanProcessor
    });
    const pgInstrumentation = controller.instrumentations.find(
      instrumentation =>
        instrumentation.instrumentationName ===
        "@opentelemetry/instrumentation-pg"
    );

    expect(pgInstrumentation).toBeDefined();

    const pgConfig = (
      pgInstrumentation as {
        getConfig: () => {
          requestHook?: (
            span: unknown,
            info: {
              connection?: {
                database?: string;
                host?: string;
                port?: number;
              };
              query?: {
                text?: string;
              };
            }
          ) => void;
          responseHook?: (span: unknown) => void;
        };
      }
    ).getConfig();
    const requestHook = pgConfig.requestHook;
    const responseHook = pgConfig.responseHook;

    expect(requestHook).toBeTypeOf("function");
    expect(responseHook).toBeTypeOf("function");

    const tracer = trace.getTracer("openbox-test-db");
    const rootSpan = tracer.startSpan("activity.getCryptoPrice", {
      attributes: {
        "openbox.activity_id": "act-db-123",
        "openbox.run_id": "run-db-123",
        "openbox.workflow_id": "wf-db-123"
      }
    });
    const dbSpan = tracer.startSpan("SELECT bitcoin", {
      attributes: {
        "db.name": "crypto",
        "db.operation": "SELECT",
        "db.statement": "select * from coins where id = $1",
        "db.system": "postgresql",
        "server.address": "127.0.0.1",
        "server.port": 5432
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-db-123",
      "act-db-123",
      "run-db-123"
    );

    await runWithOpenBoxExecutionContext(
      {
        activityId: "act-db-123",
        activityType: "getCryptoPrice",
        attempt: 1,
        runId: "run-db-123",
        source: "tool",
        taskQueue: "mastra",
        workflowId: "wf-db-123",
        workflowType: "crypto-agent"
      },
      async () => {
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
          requestHook?.(dbSpan as never, {
            connection: {
              database: "crypto",
              host: "127.0.0.1",
              port: 5432
            },
            query: {
              text: "select * from coins where id = $1"
            }
          });
          responseHook?.(dbSpan as never);
        });
      }
    );

    dbSpan.end();
    rootSpan.end();
    await waitFor(
      () =>
        openBoxServer.requests
          .filter(request => request.pathname === "/api/v1/governance/evaluate")
          .map(request => request.body)
          .filter(
            payload =>
              payload.hook_trigger !== undefined &&
              (payload.hook_trigger as Record<string, unknown>).type ===
                "db_query"
          ).length >= 2,
      2000
    );
    await controller.shutdown();
    await openBoxServer.close();

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(
        payload =>
          payload.hook_trigger !== undefined &&
          (payload.hook_trigger as Record<string, unknown>).type === "db_query"
      );

    expect(hookEvents).toHaveLength(2);

    const started = hookEvents.find(
      payload =>
        (payload.hook_trigger as Record<string, unknown>).stage === "started"
    );
    const completed = hookEvents.find(
      payload =>
        (payload.hook_trigger as Record<string, unknown>).stage === "completed"
    );

    expect(started?.hook_trigger).toMatchObject({
      attribute_key_identifiers: ["db.system", "db.operation", "db.statement"],
      db_name: "crypto",
      db_operation: "SELECT",
      db_system: "postgresql",
      type: "db_query"
    });
    expect(completed?.hook_trigger).toMatchObject({
      attribute_key_identifiers: ["db.system", "db.operation", "db.statement"],
      db_name: "crypto",
      db_operation: "SELECT",
      db_system: "postgresql",
      type: "db_query"
    });
    expect((completed?.hook_trigger as Record<string, unknown>).duration_ms).toEqual(
      expect.any(Number)
    );
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}
