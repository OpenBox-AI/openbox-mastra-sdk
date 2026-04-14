import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import {
  OPENBOX_AGENT_DID_HEADER,
  OPENBOX_AGENT_NONCE_HEADER,
  OPENBOX_AGENT_SIGNATURE_HEADER,
  OPENBOX_AGENT_TIMESTAMP_HEADER,
  OPENBOX_BODY_SHA256_HEADER,
  buildCanonicalIdentityRequest,
  buildSignedIdentityHeaders,
  validateAgentDID,
  validateEd25519PrivateKey
} from "../../src/identity/aip-signing.js";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

describe("AIP request signing", () => {
  it("builds verifiable Ed25519 request signature headers", () => {
    const keyPair = generateKeyPairSync("ed25519");
    const privateKeyDer = keyPair.privateKey.export({
      format: "der",
      type: "pkcs8"
    }) as Buffer;
    const publicKeyDer = keyPair.publicKey.export({
      format: "der",
      type: "spki"
    }) as Buffer;
    const privateKey = privateKeyDer
      .subarray(ED25519_PKCS8_PREFIX.length)
      .toString("base64");
    const publicKey = publicKeyDer.subarray(ED25519_SPKI_PREFIX.length);

    const headers = buildSignedIdentityHeaders({
      body: '{"event_type":"WorkflowStarted"}',
      identity: {
        did: "did:aip:123e4567-e89b-12d3-a456-426614174000",
        privateKey
      },
      method: "POST",
      pathname: "/api/v1/governance/evaluate"
    });
    const canonicalRequest = buildCanonicalIdentityRequest({
      bodySHA256: headers[OPENBOX_BODY_SHA256_HEADER]!,
      method: "POST",
      nonce: headers[OPENBOX_AGENT_NONCE_HEADER]!,
      pathname: "/api/v1/governance/evaluate",
      timestamp: headers[OPENBOX_AGENT_TIMESTAMP_HEADER]!
    });
    const publicKeyObject = createPublicKey({
      format: "der",
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      type: "spki"
    });

    expect(headers[OPENBOX_AGENT_DID_HEADER]).toBe(
      "did:aip:123e4567-e89b-12d3-a456-426614174000"
    );
    expect(headers[OPENBOX_BODY_SHA256_HEADER]).toHaveLength(64);
    expect(
      verify(
        null,
        Buffer.from(canonicalRequest, "utf8"),
        publicKeyObject,
        Buffer.from(headers[OPENBOX_AGENT_SIGNATURE_HEADER]!, "base64")
      )
    ).toBe(true);
  });

  it("validates supported DID and private key formats", () => {
    expect(
      validateAgentDID("did:aip:123e4567-e89b-12d3-a456-426614174000")
    ).toBe(true);
    expect(validateAgentDID("did:example:123")).toBe(false);
    expect(
      validateAgentDID("did:aip:------------------------------------")
    ).toBe(false);
    expect(validateEd25519PrivateKey(Buffer.alloc(32).toString("base64"))).toBe(
      true
    );
    expect(validateEd25519PrivateKey(Buffer.alloc(31).toString("base64"))).toBe(
      false
    );
  });
});
