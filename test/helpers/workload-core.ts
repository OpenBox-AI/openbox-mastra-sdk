// IAM v3 test double for the Mastra suite: OpenBox Core's v3 routes plus a
// Keycloak token endpoint behind one fetch implementation, with request capture
// and per-route scripting. Non-production keys only; no network.

import { generateKeyPairSync } from "node:crypto";

export const WORKLOAD_API_URL = "https://core.workload.test";
export const WORKLOAD_API_KEY = "obx_test_mastra_workload";
export const WORKLOAD_ISSUER = "https://identity.workload.test/realms/openbox";
export const WORKLOAD_TOKEN_ENDPOINT = `${WORKLOAD_ISSUER}/protocol/openid-connect/token`;
const CORE_ORIGIN = new URL(WORKLOAD_API_URL).origin;
const TOKEN_URL = new URL(WORKLOAD_TOKEN_ENDPOINT);

export function generateWorkloadPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

export function workloadBootstrapDocument(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    bootstrap_version: 3,
    contract_version: 3,
    token_endpoint: WORKLOAD_TOKEN_ENDPOINT,
    issuer: WORKLOAD_ISSUER,
    audience: "openbox-core",
    client_id: "mastra-workload-client",
    service_account_id: "11111111-1111-4111-8111-111111111111",
    activation_version: "22222222-2222-4222-8222-222222222222",
    identity_source: "okta",
    kid: "mastra-workload-kid",
    ...overrides
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export interface WorkloadCall {
  readonly url: string;
  readonly origin: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
  readonly redirect: RequestInit["redirect"];
}

type Responder = (call: WorkloadCall) => Response | Promise<Response>;

function isTokenCall(call: WorkloadCall): boolean {
  return call.origin === TOKEN_URL.origin && call.path === TOKEN_URL.pathname;
}

function readBody(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf-8");
  return "";
}

/**
 * Core v3 + Keycloak double. `evaluate` receives each governance body (route
 * by `event_type`/`activity_type`); every token exchange mints a numbered
 * token; approval answers `allow` unless scripted.
 */
export class WorkloadCoreFake {
  readonly calls: WorkloadCall[] = [];
  private tokens = 0;

  bootstrap: Responder = () => json(200, workloadBootstrapDocument());
  token: Responder = () => {
    this.tokens += 1;
    return json(200, {
      access_token: `mastra-access-token-${this.tokens}`,
      token_type: "Bearer",
      expires_in: 300
    });
  };
  transitionBootstrap: Responder = (call) =>
    json(
      200,
      workloadBootstrapDocument({
        transition_id: new URL(call.url).searchParams.get("transition_id"),
        expires_at: new Date(Date.now() + 60_000).toISOString()
      })
    );
  transitionProof: Responder = () => json(200, { proof_verified: true });
  validate: Responder = () => json(200, { valid: true });
  evaluate: Responder = () => json(200, { verdict: "allow" });
  approval: Responder = () => json(200, { action: "allow" });

  readonly fetchImpl: typeof fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = readBody(init?.body);
    let body: Record<string, unknown> = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const parsedUrl = new URL(url);
    const call: WorkloadCall = {
      url,
      origin: parsedUrl.origin,
      path: parsedUrl.pathname,
      headers,
      body,
      rawBody,
      redirect: init?.redirect
    };
    this.calls.push(call);
    if (isTokenCall(call)) return Promise.resolve(this.token(call));
    if (call.origin !== CORE_ORIGIN)
      return Promise.resolve(json(404, { code: 404 }));
    switch (call.path) {
      case "/api/v3/auth/bootstrap":
        return Promise.resolve(this.bootstrap(call));
      case "/api/v3/auth/workload-transition/bootstrap":
        return Promise.resolve(this.transitionBootstrap(call));
      case "/api/v3/auth/workload-transition/proof":
        return Promise.resolve(this.transitionProof(call));
      case "/api/v3/auth/validate":
        return Promise.resolve(this.validate(call));
      case "/api/v3/governance/evaluate":
        return Promise.resolve(this.evaluate(call));
      case "/api/v3/governance/approval":
        return Promise.resolve(this.approval(call));
      default:
        return Promise.resolve(json(404, { code: 404 }));
    }
  };

  get bootstrapCalls(): WorkloadCall[] {
    return this.calls.filter(
      (c) => c.origin === CORE_ORIGIN && c.path === "/api/v3/auth/bootstrap"
    );
  }

  get tokenCalls(): WorkloadCall[] {
    return this.calls.filter(isTokenCall);
  }

  get evaluateCalls(): WorkloadCall[] {
    return this.calls.filter(
      (c) => c.origin === CORE_ORIGIN && c.path === "/api/v3/governance/evaluate"
    );
  }

  /** Every Core request except bootstrap (which is API-key-only by design). */
  get governedCalls(): WorkloadCall[] {
    return this.calls.filter(
      (c) =>
        c.origin === CORE_ORIGIN &&
        c.path !== "/api/v3/auth/bootstrap"
    );
  }

  /** Requests to v1/v2 routes — must stay empty for a workload client. */
  get legacyCalls(): WorkloadCall[] {
    return this.calls.filter((c) => /^\/api\/v[12]\//.test(c.path));
  }
}
