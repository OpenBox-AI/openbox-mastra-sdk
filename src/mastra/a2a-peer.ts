import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";

import type { OpenBoxEventMetadata } from "../governance/context.js";

const A2A_REQUEST_ID_HEADER = "x-openbox-a2a-request-id";
const A2A_SOURCE_AGENT_ID_HEADER = "x-openbox-a2a-source-agent-id";
const A2A_SOURCE_AGENT_DID_HEADER = "x-openbox-a2a-source-agent-did";
const A2A_SOURCE_AGENT_TYPE_HEADER = "x-openbox-a2a-source-agent-type";
const A2A_TARGET_AGENT_ID_HEADER = "x-openbox-a2a-target-agent-id";
const A2A_TARGET_AGENT_TYPE_HEADER = "x-openbox-a2a-target-agent-type";
const A2A_PROTOCOL_HEADER = "x-openbox-a2a-protocol";
const A2A_TRANSPORT_HEADER = "x-openbox-a2a-transport";

export interface OpenBoxA2APeerAgent {
  agentDid?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
}

export interface BuildOpenBoxA2AOutboundContextInput {
  requestId?: string | undefined;
  source?: OpenBoxA2APeerAgent | undefined;
  target: OpenBoxA2APeerAgent;
  transport?: string | undefined;
}

export interface BuildOpenBoxA2AOutboundContextOutput {
  headers: Record<string, string>;
  metadata: OpenBoxEventMetadata;
  requestId: string;
}

export interface ParseOpenBoxA2AInboundMetadataOptions {
  fallbackSourceAgentId?: string | undefined;
  target: OpenBoxA2APeerAgent;
  transport?: string | undefined;
}

export function buildOpenBoxA2AOutboundContext({
  requestId = randomUUID(),
  source,
  target,
  transport = "http"
}: BuildOpenBoxA2AOutboundContextInput): BuildOpenBoxA2AOutboundContextOutput {
  const sourceAgentId =
    source?.agentId ?? process.env.AGENT_ID ?? "unknown-agent";
  const sourceAgentDid = source?.agentDid ?? process.env.OPENBOX_AGENT_DID;
  const metadata = buildPeerRequestMetadata({
    direction: "outbound",
    protocol: "a2a",
    requestId,
    source: {
      agentDid: sourceAgentDid,
      agentId: sourceAgentId,
      agentType: source?.agentType
    },
    target,
    transport
  });

  return {
    headers: compactHeaders({
      [A2A_REQUEST_ID_HEADER]: requestId,
      [A2A_SOURCE_AGENT_ID_HEADER]: sourceAgentId,
      [A2A_SOURCE_AGENT_DID_HEADER]: sourceAgentDid,
      [A2A_SOURCE_AGENT_TYPE_HEADER]: source?.agentType,
      [A2A_TARGET_AGENT_ID_HEADER]: target.agentId,
      [A2A_TARGET_AGENT_TYPE_HEADER]: target.agentType,
      [A2A_PROTOCOL_HEADER]: "a2a",
      [A2A_TRANSPORT_HEADER]: transport
    }),
    metadata,
    requestId
  };
}

export function parseOpenBoxA2AInboundMetadata(
  headers: Headers | IncomingHttpHeaders | Record<string, unknown>,
  options: ParseOpenBoxA2AInboundMetadataOptions
): OpenBoxEventMetadata {
  const requestId = getHeader(headers, A2A_REQUEST_ID_HEADER) ?? randomUUID();
  const sourceAgentId =
    getHeader(headers, A2A_SOURCE_AGENT_ID_HEADER) ??
    options.fallbackSourceAgentId ??
    "unknown-agent";
  const sourceAgentDid = getHeader(headers, A2A_SOURCE_AGENT_DID_HEADER);
  const sourceAgentType = getHeader(headers, A2A_SOURCE_AGENT_TYPE_HEADER);
  const targetAgentId =
    getHeader(headers, A2A_TARGET_AGENT_ID_HEADER) ?? options.target.agentId;
  const targetAgentType =
    getHeader(headers, A2A_TARGET_AGENT_TYPE_HEADER) ?? options.target.agentType;
  const protocol = getHeader(headers, A2A_PROTOCOL_HEADER) ?? "a2a";
  const transport =
    getHeader(headers, A2A_TRANSPORT_HEADER) ?? options.transport ?? "http";

  return buildPeerRequestMetadata({
    direction: "inbound",
    protocol,
    requestId,
    source: {
      agentDid: sourceAgentDid,
      agentId: sourceAgentId,
      agentType: sourceAgentType
    },
    target: {
      agentDid: options.target.agentDid,
      agentId: targetAgentId,
      agentType: targetAgentType
    },
    transport
  });
}

function buildPeerRequestMetadata({
  direction,
  protocol,
  requestId,
  source,
  target,
  transport
}: {
  direction: "inbound" | "outbound";
  protocol: string;
  requestId: string;
  source: OpenBoxA2APeerAgent;
  target: OpenBoxA2APeerAgent;
  transport: string;
}): OpenBoxEventMetadata {
  return {
    peer_request: {
      direction,
      protocol,
      request_id: requestId,
      source: compactObject({
        agent_did: source.agentDid,
        agent_id: source.agentId,
        agent_type: source.agentType
      }),
      target: compactObject({
        agent_did: target.agentDid,
        agent_id: target.agentId,
        agent_type: target.agentType
      }),
      transport
    }
  };
}

function compactHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] =>
      Boolean(entry[1])
    )
  );
}

function compactObject(
  value: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      Boolean(entry[1])
    )
  );
}

function getHeader(
  headers: Headers | IncomingHttpHeaders | Record<string, unknown>,
  name: string
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name] ?? headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    const values: unknown[] = value;
    const firstValue = values[0];
    return typeof firstValue === "string" && firstValue.trim()
      ? firstValue
      : undefined;
  }

  return typeof value === "string" && value.trim() ? value : undefined;
}
