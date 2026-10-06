import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { context, trace } from "@opentelemetry/api";
import { z } from "zod";

import {
  getOpenBoxRuntime,
  OpenBoxClient,
  OpenBoxWorkloadAuthError,
  traced,
  withOpenBox,
  wrapAgent,
  type OpenBoxRuntime
} from "../../src/index.js";
import { runWithOpenBoxExecutionContext } from "../../src/governance/context.js";
import {
  generateWorkloadPem,
  json,
  WorkloadCoreFake,
  WORKLOAD_API_KEY,
  WORKLOAD_API_URL
} from "../helpers/workload-core.js";

const PEM = generateWorkloadPem();
const active: OpenBoxRuntime[] = [];
const options = {
  apiUrl: WORKLOAD_API_URL,
  apiKey: WORKLOAD_API_KEY,
  identityMethod: "keycloak_workload" as const,
  workloadPrivateKey: PEM,
  httpCapture: false,
  instrumentDatabases: false
};

afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function start(core: WorkloadCoreFake, mastra = new Mastra({})) {
  await withOpenBox(mastra, { ...options, fetch: core.fetchImpl });
  const runtime = getOpenBoxRuntime(mastra)!;
  active.push(runtime);
  return { mastra, runtime };
}

describe("Mastra IAM v3 runtime", () => {
  it("validates once at startup and shares authentication with tools and workflows", async () => {
    const core = new WorkloadCoreFake();
    const toolExecute = vi.fn(async ({ value }: { value: string }) => ({
      value
    }));
    const tool = createTool({
      id: "echo",
      description: "Echo",
      inputSchema: z.object({ value: z.string() }),
      execute: toolExecute
    });
    const stepExecute = vi.fn(
      async ({ inputData }: { inputData: { value: string } }) => inputData
    );
    const workflow = createWorkflow({
      id: "echo-workflow",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() })
    })
      .then(
        createStep({
          id: "echo-step",
          inputSchema: z.object({ value: z.string() }),
          outputSchema: z.object({ value: z.string() }),
          execute: stepExecute
        })
      )
      .commit();
    const { mastra, runtime } = await start(
      core,
      new Mastra({
        tools: { echo: tool as never },
        workflows: { echo: workflow },
        storage: new InMemoryStore()
      })
    );
    expect(core.governedCalls.map((call) => call.path)).toEqual([
      "/api/v3/auth/validate"
    ]);
    const echo = mastra.getTool("echo") as typeof tool;
    await echo.execute?.(
      { value: "hello" },
      {
        workflow: {
          workflowId: "wf-tool",
          runId: "run-tool",
          state: {},
          setState: vi.fn(),
          suspend: vi.fn()
        }
      }
    );
    const run = await mastra.getWorkflow("echo").createRun();
    const result = await run.start({ inputData: { value: "workflow" } });
    expect(result.status).toBe("success");
    expect(toolExecute).toHaveBeenCalledOnce();
    expect(stepExecute).toHaveBeenCalledOnce();
    expect(core.tokenCalls).toHaveLength(1);
    expect(core.legacyCalls).toHaveLength(0);
    for (const call of core.governedCalls)
      expect(call.headers["x-openbox-workload-token"]).toBe(
        "mastra-access-token-1"
      );
    await runtime.shutdown();
    await runtime.shutdown();
    await expect(runtime.client.validateApiKey()).rejects.toThrow(/closed/);
  });

  it("an injected client's credentials win over conflicting options and environment", async () => {
    const core = new WorkloadCoreFake();
    const client = new OpenBoxClient({ ...options, fetch: core.fetchImpl });
    const ignoredFetch = vi.fn();
    vi.stubEnv("OPENBOX_AGENT_DID", "invalid-ignored-did");
    const mastra = new Mastra({});
    await withOpenBox(mastra, {
      client,
      identityMethod: "keycloak_workload",
      workloadPrivateKey: "invalid-ignored-key",
      apiKey: "invalid-ignored-key",
      fetch: ignoredFetch,
      httpCapture: false,
      instrumentDatabases: false
    });
    const runtime = getOpenBoxRuntime(mastra)!;
    active.push(runtime);
    expect(runtime.client).toBe(client);
    expect(runtime.config.apiKey).toBe(WORKLOAD_API_KEY);
    expect(ignoredFetch).not.toHaveBeenCalled();
    expect(core.governedCalls[0]?.path).toBe("/api/v3/auth/validate");
  });

  it("fails startup before patching Mastra when workload acquisition fails", async () => {
    const core = new WorkloadCoreFake();
    core.bootstrap = () =>
      json(409, { reason_code: "workload_identity_unavailable" });
    const mastra = new Mastra({});
    await expect(
      withOpenBox(mastra, { ...options, fetch: core.fetchImpl })
    ).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(getOpenBoxRuntime(mastra)).toBeUndefined();
    expect(core.governedCalls).toHaveLength(0);
    expect(core.legacyCalls).toHaveLength(0);
  });

  it.each(["auth rejection", "renewal failure"])(
    "stops the agent before execution on %s under fail_open",
    async (failure) => {
      const core = new WorkloadCoreFake();
      const { runtime } = await start(core);
      const generate = vi.fn(
        async (_messages?: unknown, _options?: unknown) => ({ text: "never" })
      );
      const agent = wrapAgent(
        { id: "agent", name: "Agent", generate },
        runtime
      );
      if (failure === "auth rejection") {
        core.evaluate = () => json(401, {});
      } else {
        const later = performance.now() + 301_000;
        vi.spyOn(performance, "now").mockReturnValue(later);
        core.token = () => json(503, { error: "server_error" });
      }
      await expect(
        agent.generate("hello", { runId: "run-agent" })
      ).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
      expect(generate).not.toHaveBeenCalled();
      expect(core.legacyCalls).toHaveLength(0);
    }
  );

  it("stops tools and workflow steps before execution on authentication rejection", async () => {
    const core = new WorkloadCoreFake();
    const execute = vi.fn(async () => ({ value: "never" }));
    const schema = z.object({ value: z.string() });
    const tool = createTool({
      id: "echo",
      description: "Echo",
      inputSchema: schema,
      execute
    });
    const workflow = createWorkflow({
      id: "wf",
      inputSchema: schema,
      outputSchema: schema
    })
      .then(
        createStep({
          id: "step",
          inputSchema: schema,
          outputSchema: schema,
          execute
        })
      )
      .commit();
    const { mastra } = await start(
      core,
      new Mastra({
        tools: { echo: tool as never },
        workflows: { echo: workflow },
        storage: new InMemoryStore()
      })
    );
    core.evaluate = () => json(403, {});
    const echo = mastra.getTool("echo") as typeof tool;
    await expect(
      echo.execute?.(
        { value: "hi" },
        {
          workflow: {
            workflowId: "wf",
            runId: "run",
            state: {},
            setState: vi.fn(),
            suspend: vi.fn()
          }
        }
      )
    ).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    const run = await mastra.getWorkflow("echo").createRun();
    await expect(
      run.start({ inputData: { value: "hi" } })
    ).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(execute).not.toHaveBeenCalled();
    expect(core.legacyCalls).toHaveLength(0);
  });

  it("does not swallow authentication errors at an instrumentation gate", async () => {
    const core = new WorkloadCoreFake();
    const { runtime } = await start(core);
    const execute = vi.fn(async () => "never");
    const operation = traced(execute, { name: "guarded-function" });
    core.evaluate = () => json(401, {});
    const span = trace.getTracer("iam-test").startSpan("activity");
    try {
      await expect(
        runWithOpenBoxExecutionContext(
          {
            workflowId: "wf",
            workflowType: "TestWorkflow",
            runId: "run",
            activityId: "act",
            activityType: "function",
            source: "tool",
            taskQueue: "mastra"
          },
          () => context.with(trace.setSpan(context.active(), span), operation)
        )
      ).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
      expect(execute).not.toHaveBeenCalled();
      expect(core.evaluateCalls[0]?.headers["x-openbox-workload-token"]).toBe(
        "mastra-access-token-1"
      );
    } finally {
      span.end();
      await runtime.shutdown();
    }
  });

  it("completion telemetry failures do not change an already completed agent result", async () => {
    const core = new WorkloadCoreFake();
    const { runtime } = await start(core);
    core.evaluate = (call) =>
      call.body.event_type === "WorkflowCompleted"
        ? json(401, {})
        : json(200, { verdict: "allow" });
    const generate = vi.fn(async (_messages?: unknown, _options?: unknown) => ({
      text: "done"
    }));
    const agent = wrapAgent({ id: "agent", name: "Agent", generate }, runtime);
    await expect(
      agent.generate("hello", { runId: "run-complete" })
    ).resolves.toMatchObject({ text: "done" });
    expect(generate).toHaveBeenCalledOnce();
    expect(runtime.client.workloadIdentityMetadata()).toBeNull();
  });
});
