/**
 * Delegated to the base SDK (`@openbox-ai/openbox-sdk/identity`): DID
 * validation, Ed25519 signing (PKCS8 seed wrapping), the canonical signing
 * string, and the AIP header names are all base behavior now — base wins on
 * conflict.
 *
 * Two things are re-verified/fixed by this delegation (documented in
 * migration-notes.md):
 *  - The old local default `timestamp = new Date().toISOString()` produced a
 *    `Z`-suffixed, millisecond-precision timestamp — WRONG for signing (the
 *    canonical string requires a `+00:00` offset, never `Z`; see plan.md
 *    Decision 2). `signingTimestampNow()` below reproduces base's exact
 *    recipe (`toISOString().replace("Z", "000+00:00")`); base does not export
 *    this one-line helper standalone, so it is duplicated here verbatim
 *    rather than forking a new public export for it.
 *  - `nonce` now defaults to base's `generateNonce()` (CSPRNG, 24 random
 *    bytes) instead of `randomUUID()` — both are CSPRNG-backed, so this is a
 *    format change only, not a security fix.
 *
 * Header constant NAMES (`OPENBOX_AGENT_DID_HEADER`, ...) are kept for public
 * API stability; their VALUES are re-exported from base's header constants
 * (verified byte-identical strings).
 */
import { createHash } from "node:crypto";

import {
  AgentIdentity,
  buildCanonicalString,
  generateNonce,
  HEADER_BODY_SHA256,
  HEADER_DID,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  validateAgentDid
} from "@openbox-ai/openbox-sdk/identity";

import { OpenBoxConfigError } from "../types/index.js";

export const OPENBOX_AGENT_DID_HEADER = HEADER_DID;
export const OPENBOX_AGENT_TIMESTAMP_HEADER = HEADER_TIMESTAMP;
export const OPENBOX_AGENT_NONCE_HEADER = HEADER_NONCE;
export const OPENBOX_BODY_SHA256_HEADER = HEADER_BODY_SHA256;
export const OPENBOX_AGENT_SIGNATURE_HEADER = HEADER_SIGNATURE;

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

/** Re-exported for compat; identical join order/logic to base's `buildCanonicalString`. */
export function buildAgentIdentityCanonicalRequest({
  bodySHA256,
  method,
  nonce,
  pathname,
  timestamp
}: BuildAgentIdentityCanonicalRequestInput): string {
  return buildCanonicalString(method, pathname, timestamp, nonce, bodySHA256);
}

/**
 * Validate a DID + private key via base's validators. Base throws
 * `OpenBoxConfigError` (re-exported, same class) on malformed input; on
 * success this returns the trimmed DID and the original (already-validated,
 * base64-canonical) private key string.
 */
export function validateAgentIdentityConfig(
  config: AgentIdentityConfig
): AgentIdentityConfig {
  const did = config.did.trim();
  const privateKey = config.privateKey.trim();

  validateAgentDid(did);
  // Loads (and discards) the key purely to validate format/length/decodability
  // — mirrors the old function's contract of "throw on invalid, else return".
  AgentIdentity.fromPrivateKey(did, privateKey);

  return { did, privateKey };
}

export function createAgentIdentityHeaders({
  body,
  did,
  method,
  nonce = generateNonce(),
  pathname,
  privateKey,
  timestamp = signingTimestampNow()
}: CreateAgentIdentityHeadersInput): AgentIdentityHeaders {
  if (!did.trim() || !privateKey.trim()) {
    throw new OpenBoxConfigError(
      "Both agentDid and agentPrivateKey are required to sign a request."
    );
  }

  const identity = AgentIdentity.fromPrivateKey(did, privateKey);
  const bodyBytes = bodyToBuffer(body);
  const bodySHA256 = createHash("sha256").update(bodyBytes).digest("hex");
  const canonical = buildCanonicalString(method, pathname, timestamp, nonce, bodySHA256);
  const signature = identity.sign(canonical);

  return {
    [OPENBOX_AGENT_DID_HEADER]: identity.agentDid,
    [OPENBOX_AGENT_TIMESTAMP_HEADER]: timestamp,
    [OPENBOX_AGENT_NONCE_HEADER]: nonce,
    [OPENBOX_BODY_SHA256_HEADER]: bodySHA256,
    [OPENBOX_AGENT_SIGNATURE_HEADER]: signature
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

/** `+00:00` offset, never `Z` — matches base's private `signingTimestampNow` (not exported standalone). */
function signingTimestampNow(): string {
  return new Date().toISOString().replace("Z", "000+00:00");
}
