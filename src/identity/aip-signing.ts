import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";

export const OPENBOX_AGENT_DID_HEADER = "X-OpenBox-Agent-DID";
export const OPENBOX_AGENT_NONCE_HEADER = "X-OpenBox-Agent-Nonce";
export const OPENBOX_AGENT_SIGNATURE_HEADER = "X-OpenBox-Agent-Signature";
export const OPENBOX_AGENT_TIMESTAMP_HEADER = "X-OpenBox-Agent-Timestamp";
export const OPENBOX_BODY_SHA256_HEADER = "X-OpenBox-Body-SHA256";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

export interface OpenBoxAgentIdentity {
  did: string;
  privateKey: string;
}

export interface SignedRequestInput {
  body?: string | undefined;
  identity: OpenBoxAgentIdentity;
  method: string;
  pathname: string;
}

export function buildSignedIdentityHeaders({
  body = "",
  identity,
  method,
  pathname
}: SignedRequestInput): Record<string, string> {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const bodySHA256 = sha256Hex(body);
  const canonicalRequest = buildCanonicalIdentityRequest({
    bodySHA256,
    method,
    nonce,
    pathname,
    timestamp
  });

  return {
    [OPENBOX_AGENT_DID_HEADER]: identity.did,
    [OPENBOX_AGENT_NONCE_HEADER]: nonce,
    [OPENBOX_AGENT_SIGNATURE_HEADER]: signCanonicalRequest(
      canonicalRequest,
      identity.privateKey
    ),
    [OPENBOX_AGENT_TIMESTAMP_HEADER]: timestamp,
    [OPENBOX_BODY_SHA256_HEADER]: bodySHA256
  };
}

export function buildCanonicalIdentityRequest({
  bodySHA256,
  method,
  nonce,
  pathname,
  timestamp
}: {
  bodySHA256: string;
  method: string;
  nonce: string;
  pathname: string;
  timestamp: string;
}): string {
  return [method.toUpperCase(), pathname, timestamp, nonce, bodySHA256].join(
    "\n"
  );
}

export function validateAgentDID(did: string): boolean {
  return /^did:aip:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    did
  );
}

export function validateEd25519PrivateKey(privateKey: string): boolean {
  return Buffer.from(privateKey, "base64").length === 32;
}

function signCanonicalRequest(
  canonicalRequest: string,
  privateKey: string
): string {
  const key = createPrivateKey({
    format: "der",
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      Buffer.from(privateKey, "base64")
    ]),
    type: "pkcs8"
  });

  return sign(null, Buffer.from(canonicalRequest, "utf8"), key).toString(
    "base64"
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
