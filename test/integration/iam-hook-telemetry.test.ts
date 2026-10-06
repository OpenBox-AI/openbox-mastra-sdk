import { context, trace } from "@opentelemetry/api";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  traced
} from "../../src/index.js";
import { runWithOpenBoxExecutionContext } from "../../src/governance/context.js";
import {
  generateWorkloadPem,
  WorkloadCoreFake,
  WORKLOAD_API_KEY,
  WORKLOAD_API_URL
} from "../helpers/workload-core.js";

const PEM = generateWorkloadPem();
const sse = (...records: Record<string, unknown>[]) =>
  records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

afterEach(() => {
  vi.unstubAllGlobals();
});

async function captureHooks(operation: () => Promise<unknown>) {
  const core = new WorkloadCoreFake();
  const client = new OpenBoxClient({
    apiUrl: WORKLOAD_API_URL,
    apiKey: WORKLOAD_API_KEY,
    workloadPrivateKey: PEM,
    fetch: core.fetchImpl
  });
  await client.validateApiKey();
  const controller = setupOpenBoxOpenTelemetry({
    governanceClient: client,
    spanProcessor: new OpenBoxSpanProcessor(),
    instrumentDatabases: false,
    instrumentFileIo: false
  });
  const span = trace.getTracer("iam-hook-telemetry").startSpan("llm-activity");
  try {
    await runWithOpenBoxExecutionContext(
      {
        workflowId: "agent-workflow",
        workflowType: "AgentWorkflow",
        runId: "agent-run",
        activityId: "llm-activity",
        activityType: "agentLlmCompletion",
        source: "agent"
      },
      () => context.with(trace.setSpan(context.active(), span), operation)
    );
    expect(core.tokenCalls).toHaveLength(1);
    expect(core.legacyCalls).toHaveLength(0);
    for (const call of core.evaluateCalls) {
      expect(call.headers["x-openbox-workload-token"]).toBe(
        "mastra-access-token-1"
      );
    }
    const events = core.evaluateCalls.map((call) => call.body);
    const byStage = (stage: string) =>
      events.find(
        (event) =>
          (event.spans as Record<string, unknown>[])[0]?.stage === stage
      );
    expect(events).toHaveLength(2);
    return { started: byStage("started")!, completed: byStage("completed")! };
  } finally {
    span.end();
    await controller.shutdown();
    client.close();
  }
}

describe("workload-authenticated hook telemetry", () => {
  it.each([
    {
      name: "structured prompts and completed SSE output with tool calls",
      request: JSON.stringify({
        model: "openai/gpt-4.1",
        input: [
          { role: "system", content: "Follow the instructions" },
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { role: "assistant", content: "old answer" }
        ],
        tools: [{ name: "search" }, { name: "lookup" }]
      }),
      response: sse(
        { type: "response.output_text.delta", delta: "draft" },
        { type: "response.output_text.done", text: "interim" },
        {
          type: "response.output_item.added",
          item: { type: "function_call", name: "search" }
        },
        {
          type: "response.completed",
          response: {
            model: "gpt-4.1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "final answer" }]
              },
              { type: "function_call", name: "search" },
              { type: "function_call", name: "lookup" }
            ],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
          }
        }
      ),
      input: [
        {
          model: "gpt-4-1",
          model_id: "gpt-4.1",
          prompt: "hello",
          tools_count: 2
        }
      ],
      output: {
        model: "gpt-4-1",
        model_id: "gpt-4.1",
        text: "final answer",
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        tool_calls: ["search", "lookup"],
        tool_call_count: 2
      }
    },
    {
      name: "messages containing JSON-encoded text and streamed deltas",
      request: JSON.stringify({
        messages: [
          { role: "user", content: '[{"type":"text","text":"nested prompt"}]' }
        ]
      }),
      response:
        sse(
          { type: "response.output_text.delta", delta: "hello " },
          { type: "response.output_text.delta", delta: "world" }
        ) + "data: [DONE]\n\n",
      input: [{ prompt: "nested prompt" }],
      output: { text: "hello world" }
    },
    {
      name: "prompt fallback and the final text event",
      request: JSON.stringify({
        input: [null, " ", { role: "assistant", content: "skip" }],
        prompt: "fallback prompt",
        tools: []
      }),
      response: sse({ type: "response.output_text.done", text: "done" }),
      input: [{ prompt: "fallback prompt", tools_count: 0 }],
      output: { text: "done" }
    },
    {
      name: "plain text bodies",
      request: "plain request",
      response: "plain response",
      input: ["plain request"],
      output: "plain response"
    },
    {
      name: "JSON arrays and primitive responses",
      request: '[1,"two"]',
      response: "true",
      input: [1, "two"],
      output: true
    },
    {
      name: "non-model JSON payloads",
      request: '{"lookup":{"id":123}}',
      response: '{"found":true}',
      input: [{ lookup: { id: 123 } }],
      output: { found: true }
    },
    {
      name: "empty bodies",
      request: "",
      response: "",
      input: undefined,
      output: undefined
    },
    {
      name: "malformed structured text remains readable",
      request: JSON.stringify({
        messages: [{ role: "user", content: "[unfinished" }]
      }),
      response: sse({
        type: "response.completed",
        response: { output_text: "readable" }
      }),
      input: [{ prompt: "[unfinished" }],
      output: { text: "readable" }
    },
    {
      name: "long prompts and responses are bounded",
      request: JSON.stringify({ prompt: "x".repeat(1_200) }),
      response: sse({
        type: "response.output_text.done",
        text: "y".repeat(2_200)
      }),
      input: [{ prompt: expect.stringContaining("...[truncated]") }],
      output: { text: expect.stringContaining("...[truncated]") }
    }
  ])("preserves $name", async ({ request, response, input, output }) => {
    const downstream = vi.fn<typeof fetch>(async () => new Response(response));
    vi.stubGlobal("fetch", downstream);
    const events = await captureHooks(async () => {
      const result = await fetch("https://model.test/respond", {
        method: "POST",
        body: request
      });
      expect(await result.text()).toBe(response);
    });
    expect(downstream).toHaveBeenCalledOnce();
    expect(events.started.activity_input).toEqual(input);
    expect(events.started.activity_output).toBeUndefined();
    expect(events.completed.activity_input).toEqual(input);
    expect(events.completed.activity_output).toEqual(output);
  });

  it("bounds function payloads without altering the operation's result", async () => {
    const result = { data: "x".repeat(20_000) };
    const operation = traced(
      async (input: string) => {
        expect(input).toBe("request");
        return result;
      },
      { name: "large-result", captureArgs: true, captureResult: true }
    );
    const events = await captureHooks(async () => {
      expect(await operation("request")).toBe(result);
    });
    expect(events.started.activity_input).toEqual(["request"]);
    expect(events.started.activity_output).toBeUndefined();
    expect(events.completed.activity_output).toEqual({
      preview: expect.stringContaining("...[truncated]"),
      truncated: true
    });
  });
});
