import { createServer } from "node:http";
import { context, trace } from "@opentelemetry/api";

import {
  OpenBoxClient,
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  WorkflowSpanBuffer
} from "../../src/index.js";
import { runWithOpenBoxExecutionContext } from "../../src/governance/context.js";
import {
  generateWorkloadPem,
  workloadBootstrapDocument
} from "../helpers/workload-core.js";

it("excludes real workload bootstrap and token HTTP traffic from telemetry and recursive governance", async () => {
  const requests: string[] = [];
  let apiUrl = "";
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/v3/auth/bootstrap") {
        response.end(
          JSON.stringify(
            workloadBootstrapDocument({
              issuer: `${apiUrl}/realms/openbox`,
              token_endpoint: `${apiUrl}/realms/openbox/protocol/openid-connect/token`
            })
          )
        );
      } else if (request.url?.endsWith("/token")) {
        response.end(
          JSON.stringify({
            access_token: "secret-workload-token",
            token_type: "Bearer",
            expires_in: 300
          })
        );
      } else {
        response.end(JSON.stringify({ verdict: "allow" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a server address");
  apiUrl = `http://127.0.0.1:${address.port}`;
  const client = new OpenBoxClient({
    apiUrl,
    apiKey: "obx_test_private_traffic",
    workloadPrivateKey: generateWorkloadPem(),
    // Resolve fetch at send time to exercise the installed Mastra fetch patch.
    fetch: (input, init) => globalThis.fetch(input, init)
  });
  const processor = new OpenBoxSpanProcessor();
  const storeBody = vi.spyOn(processor, "storeTraceBody");
  const controller = setupOpenBoxOpenTelemetry({
    governanceClient: client,
    spanProcessor: processor,
    instrumentDatabases: false
  });
  const buffer = new WorkflowSpanBuffer({
    workflowId: "wf",
    runId: "run",
    workflowType: "PrivacyTest",
    taskQueue: "mastra"
  });
  processor.registerWorkflow("wf", buffer);
  const span = trace
    .getTracer("iam-privacy")
    .startSpan("activity", { attributes: { "openbox.workflow_id": "wf" } });
  try {
    await runWithOpenBoxExecutionContext(
      {
        workflowId: "wf",
        workflowType: "PrivacyTest",
        runId: "run",
        activityId: "act",
        activityType: "tool",
        source: "tool"
      },
      () =>
        context.with(trace.setSpan(context.active(), span), () =>
          client.evaluate({ event_type: "ActivityStarted" })
        )
    );
    expect(requests).toEqual([
      "/api/v3/auth/bootstrap",
      "/realms/openbox/protocol/openid-connect/token",
      "/api/v3/governance/evaluate"
    ]);
    expect(storeBody).not.toHaveBeenCalled();
    expect(JSON.stringify(buffer.spans)).not.toMatch(
      /client_assertion|secret-workload-token|private_traffic|openid-connect/
    );
  } finally {
    span.end();
    await controller.shutdown();
    client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    vi.restoreAllMocks();
  }
});
