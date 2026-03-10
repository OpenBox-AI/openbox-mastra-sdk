import { createServer } from "node:http";

import { context, trace } from "@opentelemetry/api";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry
} from "../../src/index.js";
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
      activity_id: "act-123",
      activity_type: "searchCryptoCoins",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });
    expect(completed).toMatchObject({
      activity_id: "act-123",
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
    await new Promise(resolve => setTimeout(resolve, 25));
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
