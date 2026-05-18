import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign
} from "node:crypto";

import { OpenBoxConfigError } from "../types/index.js";

export const OPENBOX_AGENT_DID_HEADER = "X-OpenBox-Agent-DID";
export const OPENBOX_AGENT_TIMESTAMP_HEADER = "X-OpenBox-Agent-Timestamp";
export const OPENBOX_AGENT_NONCE_HEADER = "X-OpenBox-Agent-Nonce";
export const OPENBOX_BODY_SHA256_HEADER = "X-OpenBox-Body-SHA256";
export const OPENBOX_AGENT_SIGNATURE_HEADER = "X-OpenBox-Agent-Signature";

const DID_PATTERN =
  /^did:aip:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SEED_BYTE_LENGTH = 32;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

export interface AgentIdentityConfig {
  did: string;
  privateKey: string;
}

export interface BuildAgentIdentityCanonicalRequestInput {
  bodySHA256: string;
  method: string;
  nonce: string;
  pathname: string;
  timestamp: string;
}

export interface CreateAgentIdentityHeadersInput extends AgentIdentityConfig {
  body?: string | Uint8Array | undefined;
  method: string;
  nonce?: string | undefined;
  pathname: string;
  timestamp?: string | undefined;
}

export type AgentIdentityHeaders = {
  [OPENBOX_AGENT_DID_HEADER]: string;
  [OPENBOX_AGENT_TIMESTAMP_HEADER]: string;
  [OPENBOX_AGENT_NONCE_HEADER]: string;
  [OPENBOX_BODY_SHA256_HEADER]: string;
  [OPENBOX_AGENT_SIGNATURE_HEADER]: string;
};

export function buildAgentIdentityCanonicalRequest({
  bodySHA256,
  method,
  nonce,
  pathname,
  timestamp
}: BuildAgentIdentityCanonicalRequestInput): string {
  return [
    method.toUpperCase(),
    pathname,
    timestamp,
    nonce,
    bodySHA256
  ].join("\n");
}

export function validateAgentIdentityConfig(
  config: AgentIdentityConfig
): AgentIdentityConfig {
  const did = config.did.trim();
  const privateKey = config.privateKey.trim();

  if (!DID_PATTERN.test(did)) {
    throw new OpenBoxConfigError(
      "Invalid OpenBox agent DID. Expected format 'did:aip:<uuid>'."
    );
  }

  const privateKeySeed = decodePrivateKeySeed(privateKey);

  return {
    did,
    privateKey: privateKeySeed.toString("base64")
  };
}

export function createAgentIdentityHeaders({
  body,
  did,
  method,
  nonce = randomUUID(),
  pathname,
  privateKey,
  timestamp = new Date().toISOString()
}: CreateAgentIdentityHeadersInput): AgentIdentityHeaders {
  const identity = validateAgentIdentityConfig({ did, privateKey });
  const bodyBytes = bodyToBuffer(body);
  const bodySHA256 = createHash("sha256").update(bodyBytes).digest("hex");
  const canonical = buildAgentIdentityCanonicalRequest({
    bodySHA256,
    method,
    nonce,
    pathname,
    timestamp
  });
  const signingKey = createPrivateKey({
    format: "der",
    key: Buffer.concat([
      ED25519_PKCS8_SEED_PREFIX,
      decodePrivateKeySeed(identity.privateKey)
    ]),
    type: "pkcs8"
  });
  const signature = sign(null, Buffer.from(canonical), signingKey);

  return {
    [OPENBOX_AGENT_DID_HEADER]: identity.did,
    [OPENBOX_AGENT_TIMESTAMP_HEADER]: timestamp,
    [OPENBOX_AGENT_NONCE_HEADER]: nonce,
    [OPENBOX_BODY_SHA256_HEADER]: bodySHA256,
    [OPENBOX_AGENT_SIGNATURE_HEADER]: signature.toString("base64")
  };
}

function bodyToBuffer(body: string | Uint8Array | undefined): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  return Buffer.alloc(0);
}

function decodePrivateKeySeed(privateKey: string): Buffer {
  if (!BASE64_PATTERN.test(privateKey)) {
    throw new OpenBoxConfigError(
      "Invalid OpenBox agent private key. Expected a base64 raw 32-byte Ed25519 seed."
    );
  }

  const decoded = Buffer.from(privateKey, "base64");
  if (
    decoded.length !== ED25519_SEED_BYTE_LENGTH ||
    decoded.toString("base64") !== privateKey
  ) {
    throw new OpenBoxConfigError(
      "Invalid OpenBox agent private key. Expected a base64 raw 32-byte Ed25519 seed."
    );
  }

  return decoded;
}
