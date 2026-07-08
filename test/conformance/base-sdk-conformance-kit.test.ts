/**
 * Runs the base SDK's own conformance kit (`@openbox-ai/openbox-sdk/conformance`)
 * inside Mastra, wired through `MastraFrameworkAdapter` (phase-06 requirement:
 * "run the base conformance kit inside a Mastra test"). This proves two
 * things at once:
 *  1. The base package's subpath exports resolve and run correctly from
 *     Mastra's own build/test toolchain (dependency wiring).
 *  2. `MastraFrameworkAdapter` (src/mastra/framework-adapter.ts) is a real,
 *     behaviorally-correct `FrameworkAdapter` — exercised against base's own
 *     `OpenBoxRuntime`/`HookEvaluator`/gate, not just type-checked.
 */
import {
  COMMON_SPAN_DEFAULTS,
  STAGE_STARTED,
  workflowStarted,
  type SpanRecord
} from "@openbox-ai/openbox-sdk";
import {
  APPROVAL_SCENARIOS,
  CONFORMANCE_ACTIVITY_CONTEXT,
  CONFORMANCE_HOOK_TYPE_SCENARIOS,
  FakeCore,
  assertHookWireShape,
  buildConformanceRuntime
} from "@openbox-ai/openbox-sdk/conformance";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk/runtime";

import { OpenBoxClient } from "../../src/client/index.js";
import { MastraFrameworkAdapter } from "../../src/mastra/framework-adapter.js";
import { GovernanceHaltError } from "../../src/types/index.js";

/** Wire base's conformance runtime to a real `MastraFrameworkAdapter`, backed by Mastra's own client pointed at the same `FakeCore`. */
function buildMastraAdapterRuntime(fakeCore: FakeCore): OpenBoxRuntime {
  const mastraClient = new OpenBoxClient({
    apiKey: "obx_test_conformance",
    apiUrl: "https://core.test",
    // Mastra's client accepts an injectable `fetch` — point it at the same
    // FakeCore the base runtime's own internal client uses, so both sides of
    // the adapter seam (evaluate via base's client, approval-poll via
    // Mastra's client) observe the same scripted backend.
    fetch: fakeCore.fetchImpl as unknown as typeof fetch
  });
  const adapter = new MastraFrameworkAdapter({
    approvalWaitOptions: {
      initialPollIntervalMs: 5,
      maxPollIntervalMs: 20,
      timeoutMs: 500
    },
    client: mastraClient
  });

  return buildConformanceRuntime(fakeCore, { adapter });
}

describe("base SDK conformance kit (inside Mastra)", () => {
  it("allows a lifecycle event with no scripted response (FakeCore defaults to allow)", async () => {
    const fakeCore = new FakeCore();
    const runtime = buildMastraAdapterRuntime(fakeCore);

    const result = await runtime.evaluateLifecycle(
      workflowStarted({
        runId: "run-1",
        workflowId: "wf-1",
        workflowType: "ConformanceWorkflow"
      })
    );

    expect(result.verdict).toBe("allow");
    expect(fakeCore.lifecycleRequests).toHaveLength(1);
    runtime.close();
  });

  it("maps a HALT lifecycle verdict to Mastra's GovernanceHaltError via MastraFrameworkAdapter", async () => {
    const fakeCore = new FakeCore();
    fakeCore.queueEvaluate({ body: { reason: "conformance halt", verdict: "halt" } });
    const runtime = buildMastraAdapterRuntime(fakeCore);

    await expect(
      runtime.evaluateLifecycle(
        workflowStarted({
          runId: "run-2",
          workflowId: "wf-2",
          workflowType: "ConformanceWorkflow"
        })
      )
    ).rejects.toBeInstanceOf(GovernanceHaltError);
    runtime.close();
  });

  it("maps a BLOCK lifecycle verdict to Mastra's GovernanceHaltError too (coarser than base's default CoreAdapter — see migration-notes.md)", async () => {
    const fakeCore = new FakeCore();
    fakeCore.queueEvaluate({ body: { reason: "conformance block", verdict: "block" } });
    const runtime = buildMastraAdapterRuntime(fakeCore);

    await expect(
      runtime.evaluateLifecycle(
        workflowStarted({
          runId: "run-3",
          workflowId: "wf-3",
          workflowType: "ConformanceWorkflow"
        })
      )
    ).rejects.toBeInstanceOf(GovernanceHaltError);
    runtime.close();
  });

  it.each(APPROVAL_SCENARIOS)(
    "drives the $name approval scenario through MastraFrameworkAdapter.handleApproval",
    async scenario => {
      const fakeCore = new FakeCore();
      fakeCore.queueEvaluate({ body: scenario.evaluateResponse });
      fakeCore.queueApproval(...scenario.pollResponses.map(body => ({ body })));
      const runtime = buildMastraAdapterRuntime(fakeCore);

      const promise = runtime.evaluateLifecycle(
        workflowStarted({
          runId: `run-${scenario.name}`,
          workflowId: `wf-${scenario.name}`,
          workflowType: "ConformanceWorkflow"
        })
      );

      if (scenario.expected === "approved") {
        await expect(promise).resolves.toBeDefined();
      } else {
        await expect(promise).rejects.toBeInstanceOf(Error);
      }

      expect(fakeCore.approvalRequests.length).toBeGreaterThan(0);
      runtime.close();
    }
  );

  it.each(CONFORMANCE_HOOK_TYPE_SCENARIOS)(
    "sends a wire-conformant $hookType started-hook payload (assertHookWireShape)",
    async ({ hookType, sampleFields }) => {
      const fakeCore = new FakeCore();
      const runtime = buildMastraAdapterRuntime(fakeCore);
      const span: SpanRecord = {
        ...COMMON_SPAN_DEFAULTS,
        ...sampleFields,
        hook_type: hookType,
        stage: STAGE_STARTED
      };

      await runtime.contextStore.activityScope(CONFORMANCE_ACTIVITY_CONTEXT, async () => {
        await runtime.preflight({ spans: [span] });
      });

      expect(fakeCore.evaluateRequests).toHaveLength(1);
      const payload = fakeCore.evaluateRequests[0]?.bodyJson as Record<string, unknown>;

      expect(() => {
        assertHookWireShape(payload);
      }).not.toThrow();
      runtime.close();
    }
  );
});
