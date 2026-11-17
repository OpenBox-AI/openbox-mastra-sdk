import { createPublicKey, verify } from "node:crypto";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { FakeCore } from "@openbox-ai/openbox-sdk/conformance";

import {
  GovernanceAPIError,
  OpenBoxClient,
  OpenBoxWorkloadAuthError,
  parseOpenBoxConfig
} from "../../src/index.js";
import {
  generateWorkloadPem,
  json,
  WorkloadCoreFake,
  WORKLOAD_API_KEY,
  WORKLOAD_API_URL
} from "../helpers/workload-core.js";

const PEM = generateWorkloadPem();
const OTHER_PEM = generateWorkloadPem();
const connection = { apiUrl: WORKLOAD_API_URL, apiKey: WORKLOAD_API_KEY };
const approval = { workflowId: "wf", runId: "run", activityId: "act" };
const event = {
  event_type: "ActivityStarted",
  workflow_id: "wf",
  run_id: "run",
  activity_id: "act"
};

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(core: WorkloadCoreFake) {
  return OpenBoxClient.fromConfig(
    parseOpenBoxConfig(
      {
        ...connection,
        identityMethod: "keycloak_workload",
        workloadPrivateKey: PEM,
        evaluateRetryBaseDelayMs: 0
      },
      {}
    ),
    { fetch: core.fetchImpl }
  );
}

describe("identity configuration", () => {
  it("resolves explicit, prefixed, and global inputs with blank-env fallback", () => {
    const env = {
      OPENBOX_MASTRA_API_URL: WORKLOAD_API_URL,
      OPENBOX_MASTRA_API_KEY: WORKLOAD_API_KEY,
      OPENBOX_MASTRA_AGENT_IDENTITY_METHOD: "keycloak_workload",
      OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY: PEM,
      OPENBOX_WORKLOAD_PRIVATE_KEY: OTHER_PEM
    };
    expect(parseOpenBoxConfig({}, env).workloadPrivateKey).toBe(PEM);
    expect(
      parseOpenBoxConfig({ workloadPrivateKey: OTHER_PEM }, env)
        .workloadPrivateKey
    ).toBe(OTHER_PEM);
    expect(
      parseOpenBoxConfig(
        {},
        { ...env, OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY: " \n " }
      ).workloadPrivateKey
    ).toBe(OTHER_PEM);
    expect(
      parseOpenBoxConfig(
        {},
        { ...env, OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY: "" }
      ).identityMethod
    ).toBe("keycloak_workload");
    expect(
      parseOpenBoxConfig(
        { envPrefix: "MY_AGENT" },
        {
          MY_AGENT_API_URL: WORKLOAD_API_URL,
          MY_AGENT_API_KEY: WORKLOAD_API_KEY,
          MY_AGENT_WORKLOAD_PRIVATE_KEY: PEM
        }
      ).workloadPrivateKey
    ).toBe(PEM);
  });

  it("preserves OPENBOX_URL while accepting the standard API_URL variables", () => {
    const env = {
      OPENBOX_API_KEY: WORKLOAD_API_KEY,
      OPENBOX_URL: "https://legacy.test",
      OPENBOX_API_URL: "https://global.test"
    };
    expect(parseOpenBoxConfig({}, env).apiUrl).toBe("https://legacy.test");
    expect(parseOpenBoxConfig({}, { ...env, OPENBOX_URL: "" }).apiUrl).toBe(
      "https://global.test"
    );
    expect(
      parseOpenBoxConfig(
        {},
        { ...env, OPENBOX_MASTRA_API_URL: WORKLOAD_API_URL }
      ).apiUrl
    ).toBe(WORKLOAD_API_URL);
    expect(
      parseOpenBoxConfig({ apiUrl: "https://explicit.test" }, env).apiUrl
    ).toBe("https://explicit.test");
  });

  it("rejects missing keys and mixed identity methods before sending requests", () => {
    expect(() =>
      parseOpenBoxConfig(
        { ...connection, identityMethod: "keycloak_workload" },
        {}
      )
    ).toThrow(/no workload private key/);
    expect(() =>
      parseOpenBoxConfig(
        {
          ...connection,
          workloadPrivateKey: PEM,
          oktaAgentPrivateKey: OTHER_PEM
        },
        {}
      )
    ).toThrow(/workloadPrivateKey/);
    expect(() =>
      parseOpenBoxConfig(
        {
          ...connection,
          workloadPrivateKey: PEM,
          agentDid: "did:aip:550e8400-e29b-41d4-a716-446655440000",
          agentPrivateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        },
        {}
      )
    ).toThrow();
    expect(
      () => new OpenBoxClient({ ...connection, workloadPrivateKey: "invalid" })
    ).toThrow();
  });

  it("supports the explicit workload migration alias for an Okta private key", async () => {
    const core = new WorkloadCoreFake();
    const config = parseOpenBoxConfig(
      {
        ...connection,
        identityMethod: "keycloak_workload",
        oktaAgentPrivateKey: PEM
      },
      {}
    );
    const client = OpenBoxClient.fromConfig(config, { fetch: core.fetchImpl });
    await client.validateApiKey();
    expect(core.tokenCalls).toHaveLength(1);
    expect(core.legacyCalls).toHaveLength(0);
    client.close();
  });

  it("redacts config and client secrets in JSON and Node inspection", async () => {
    const core = new WorkloadCoreFake();
    const config = parseOpenBoxConfig(
      { ...connection, workloadPrivateKey: PEM },
      {}
    );
    const client = OpenBoxClient.fromConfig(config, { fetch: core.fetchImpl });
    await client.validateApiKey();
    for (const output of [
      JSON.stringify(config),
      inspect(config),
      JSON.stringify(client),
      inspect(client)
    ]) {
      expect(output).not.toContain(WORKLOAD_API_KEY);
      expect(output).not.toContain("PRIVATE KEY");
      expect(output).not.toContain("mastra-access-token");
    }
    client.close();
  });
});

describe("shared workload client", () => {
  it("shares one acquisition across concurrent validate, evaluate, and approval requests", async () => {
    const core = new WorkloadCoreFake();
    const client = makeClient(core);
    await Promise.all([
      client.validateApiKey(),
      client.evaluate(event),
      client.pollApproval(approval)
    ]);
    expect(core.bootstrapCalls).toHaveLength(1);
    expect(core.tokenCalls).toHaveLength(1);
    expect(core.legacyCalls).toHaveLength(0);
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version: string };
    for (const call of core.governedCalls) {
      expect(call.redirect).toBe("manual");
      expect(call.headers["authorization"]).toBe(`Bearer ${WORKLOAD_API_KEY}`);
      expect(call.headers["x-openbox-workload-token"]).toBe(
        "mastra-access-token-1"
      );
      expect(call.headers["x-openbox-sdk-version"]).toBe(
        `openbox-mastra-typescript-v${pkg.version}`
      );
      expect(call.headers["x-openbox-agent-assertion"]).toBeUndefined();
      expect(call.headers["x-openbox-agent-signature"]).toBeUndefined();
    }
    expect(core.tokenCalls[0]?.headers["content-type"]).toContain(
      "application/x-www-form-urlencoded"
    );
    expect(client.workloadIdentityMetadata()?.identitySource).toBe("okta");
    client.close();
    expect(client.workloadIdentityMetadata()).toBeNull();
    await expect(client.evaluate(event)).rejects.toThrow(/closed/);
  });

  it("renews an expired token and supports explicit refresh on the same client", async () => {
    const core = new WorkloadCoreFake();
    const client = makeClient(core);
    await client.validateApiKey();
    const later = performance.now() + 301_000;
    vi.spyOn(performance, "now").mockReturnValue(later);
    await client.evaluate(event);
    expect(core.tokenCalls).toHaveLength(2);
    expect(core.evaluateCalls[0]?.headers["x-openbox-workload-token"]).toBe(
      "mastra-access-token-2"
    );
    await client.refreshWorkloadIdentity();
    await client.pollApproval(approval);
    expect(core.tokenCalls).toHaveLength(3);
    expect(core.governedCalls.at(-1)?.headers["x-openbox-workload-token"]).toBe(
      "mastra-access-token-3"
    );
    expect(core.legacyCalls).toHaveLength(0);
    client.close();
  });

  it.each(["evaluate", "approval"])(
    "throws on %s auth rejection without replay and invalidates only the rejected token",
    async (route) => {
      const core = new WorkloadCoreFake();
      const client = makeClient(core);
      await client.validateApiKey();
      core[route as "evaluate" | "approval"] = () =>
        json(401, { reason_code: "invalid_token" });
      await expect(
        route === "evaluate"
          ? client.evaluate(event)
          : client.pollApproval(approval)
      ).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
      expect(core.governedCalls).toHaveLength(2);
      expect(client.workloadIdentityMetadata()).toBeNull();
      core.evaluate = () => json(200, { verdict: "allow" });
      await client.evaluate(event);
      expect(core.tokenCalls).toHaveLength(2);
      expect(core.legacyCalls).toHaveLength(0);
      client.close();
    }
  );

  it.each(["bootstrap", "token"])(
    "never fail-opens or retries a %s acquisition failure",
    async (route) => {
      const core = new WorkloadCoreFake();
      core[route as "bootstrap" | "token"] = () =>
        json(503, { error: "server_error", secret: PEM });
      const client = makeClient(core);
      const error = await client
        .evaluate(event)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(OpenBoxWorkloadAuthError);
      expect(String(error)).not.toContain("PRIVATE KEY");
      expect(core.bootstrapCalls).toHaveLength(1);
      expect(core.governedCalls).toHaveLength(0);
      expect(core.legacyCalls).toHaveLength(0);
      client.close();
    }
  );

  it.each([302, 400, 404, 409, 422])(
    "does not turn a v3 HTTP %s contract failure into ALLOW or replay it",
    async (status) => {
      const core = new WorkloadCoreFake();
      core.evaluate = () => json(status, { reason_code: "invalid_contract" });
      const client = makeClient(core);
      await expect(client.evaluate(event)).rejects.toBeInstanceOf(
        GovernanceAPIError
      );
      expect(core.evaluateCalls).toHaveLength(1);
      expect(core.legacyCalls).toHaveLength(0);
      client.close();
    }
  );

  it("proves a candidate key without exchanging a token or replacing active identity", async () => {
    const core = new WorkloadCoreFake();
    const client = makeClient(core);
    await client.validateApiKey();
    const metadata = client.workloadIdentityMetadata();
    const transitionId = "33333333-3333-4333-8333-333333333333";
    await expect(
      client.proveWorkloadIdentityTransition({
        transitionId,
        candidatePrivateKey: OTHER_PEM
      })
    ).resolves.toEqual({ proofVerified: true });
    const proof = core.calls.find((call) =>
      call.path.endsWith("/workload-transition/proof")
    )!;
    const assertion = proof.body.client_assertion as string;
    const [header, claims, signature] = assertion.split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        createPublicKey(OTHER_PEM),
        Buffer.from(signature!, "base64url")
      )
    ).toBe(true);
    expect(proof.body.transition_id).toBe(transitionId);
    expect(proof.headers["x-openbox-workload-token"]).toBeUndefined();
    expect(core.tokenCalls).toHaveLength(1);
    expect(client.workloadIdentityMetadata()).toEqual(metadata);
    await client.evaluate(event);
    expect(core.evaluateCalls[0]?.headers["x-openbox-workload-token"]).toBe(
      "mastra-access-token-1"
    );
    client.close();
  });

  it("preserves a server BLOCK even when its response carries fallback_used", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = () =>
      json(200, {
        verdict: "block",
        fallback_used: true,
        reason: "Policy denied"
      });
    const client = makeClient(core);
    await expect(client.evaluate(event)).resolves.toMatchObject({
      verdict: "block",
      reason: "Policy denied"
    });
    expect(core.evaluateCalls).toHaveLength(1);
    client.close();
  });

  it("keeps bounded outage retries and null fallback under fail_open", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = () => json(503, {});
    const client = makeClient(core);
    await expect(client.evaluate(event)).resolves.toBeNull();
    expect(core.evaluateCalls).toHaveLength(3);
    expect(core.tokenCalls).toHaveLength(1);
    client.close();
  });
});

describe("Okta identity forwarding", () => {
  it("uses v2 bootstrap for key-only configuration", async () => {
    const core = new WorkloadCoreFake();
    const client = new OpenBoxClient({
      ...connection,
      oktaAgentPrivateKey: PEM,
      fetch: core.fetchImpl
    });
    await expect(client.evaluate(event)).rejects.toThrow(
      /does not support Okta identity bootstrap/
    );
    expect(core.calls.map((call) => call.path)).toEqual([
      "/api/v2/auth/bootstrap"
    ]);
    client.close();
  });

  it("forwards explicit Okta metadata through the base signer", async () => {
    const core = new FakeCore();
    const client = new OpenBoxClient({
      ...connection,
      identityMethod: "okta_ai_agent",
      agentId: "agent-1234",
      organizationId: "org-5678",
      deploymentId: "prod-us",
      agentProofAudience: "urn:openbox:prod-us:core",
      oktaAgentId: "okta-agent",
      oktaAgentKeyId: "credential-1",
      oktaAgentAlgorithm: "RS256",
      oktaAgentPrivateKey: PEM,
      fetch: core.fetchImpl
    });
    await client.evaluate(event);
    const request = core.evaluateRequests[0]!;
    expect(request.path).toBe("/api/v2/governance/evaluate");
    expect(request.headers["x-openbox-agent-signature"]).toBeUndefined();
    const assertion = request.headers["x-openbox-agent-assertion"]!;
    const claims: unknown = JSON.parse(
      Buffer.from(assertion.split(".")[1]!, "base64url").toString()
    );
    expect(claims).toMatchObject({
      obx_agent_id: "agent-1234",
      obx_organization_id: "org-5678",
      aud: "urn:openbox:prod-us:core"
    });
    client.close();
  });
});
