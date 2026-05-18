import {
  createHash,
  generateKeyPairSync,
  verify
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  buildAgentIdentityCanonicalRequest,
  createAgentIdentityHeaders,
  validateAgentIdentityConfig
} from "../../src/identity/index.js";

const ED25519_PKCS8_SEED_PREFIX = "302e020100300506032b657004220420";

function createTestIdentity(): {
  did: string;
  privateKey: string;
  publicKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = privateKeyDer.subarray(
    Buffer.from(ED25519_PKCS8_SEED_PREFIX, "hex").length
  );

  return {
    did: "did:aip:550e8400-e29b-41d4-a716-446655440000",
    privateKey: seed.toString("base64"),
    publicKey
  };
}

describe("buildAgentIdentityCanonicalRequest", () => {
  it("matches the OpenBox Core canonical request format", () => {
    expect(
      buildAgentIdentityCanonicalRequest({
        bodySHA256: "abc123",
        method: "post",
        nonce: "nonce-1",
        pathname: "/api/v1/governance/evaluate",
        timestamp: "2026-04-20T12:34:56.789Z"
      })
    ).toBe(
      [
        "POST",
        "/api/v1/governance/evaluate",
        "2026-04-20T12:34:56.789Z",
        "nonce-1",
        "abc123"
      ].join("\n")
    );
  });
});

describe("validateAgentIdentityConfig", () => {
  it("accepts a DID and base64 raw Ed25519 seed", () => {
    const identity = createTestIdentity();

    expect(() => {
      validateAgentIdentityConfig(identity);
    }).not.toThrow();
  });

  it("rejects invalid DID values", () => {
    const identity = createTestIdentity();

    expect(() => {
      validateAgentIdentityConfig({
        ...identity,
        did: "did:web:agent"
      });
    }).toThrow("Invalid OpenBox agent DID");
  });

  it("rejects private keys that are not 32-byte base64 Ed25519 seeds", () => {
    const identity = createTestIdentity();

    expect(() => {
      validateAgentIdentityConfig({
        ...identity,
        privateKey: Buffer.from("not-a-seed").toString("base64")
      });
    }).toThrow("Invalid OpenBox agent private key");
  });
});

describe("createAgentIdentityHeaders", () => {
  it("creates verifiable DID headers for the exact request body", () => {
    const identity = createTestIdentity();
    const body = JSON.stringify({
      event_type: "WorkflowStarted",
      workflow_id: "wf-123"
    });

    const headers = createAgentIdentityHeaders({
      body,
      did: identity.did,
      method: "POST",
      nonce: "nonce-1",
      pathname: "/api/v1/governance/evaluate",
      privateKey: identity.privateKey,
      timestamp: "2026-04-20T12:34:56.789Z"
    });

    expect(headers["X-OpenBox-Agent-DID"]).toBe(identity.did);
    expect(headers["X-OpenBox-Agent-Timestamp"]).toBe(
      "2026-04-20T12:34:56.789Z"
    );
    expect(headers["X-OpenBox-Agent-Nonce"]).toBe("nonce-1");
    expect(headers["X-OpenBox-Body-SHA256"]).toBe(
      createHash("sha256").update(body).digest("hex")
    );

    const canonical = buildAgentIdentityCanonicalRequest({
      bodySHA256: headers["X-OpenBox-Body-SHA256"],
      method: "POST",
      nonce: headers["X-OpenBox-Agent-Nonce"],
      pathname: "/api/v1/governance/evaluate",
      timestamp: headers["X-OpenBox-Agent-Timestamp"]
    });

    expect(
      verify(
        null,
        Buffer.from(canonical),
        identity.publicKey,
        Buffer.from(headers["X-OpenBox-Agent-Signature"], "base64")
      )
    ).toBe(true);
  });
});
