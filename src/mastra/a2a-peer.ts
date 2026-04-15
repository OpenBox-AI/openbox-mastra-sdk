import { randomUUID } from "node:crypto";

import { getOpenBoxExecutionContext } from "../governance/context.js";
import type { OpenBoxEventMetadata } from "../governance/context.js";

const OPENBOX_A2A_HEADER_PREFIX = "x-openbox-a2a";

export const OPENBOX_A2A_HEADERS = {
  requestId: `${OPENBOX_A2A_HEADER_PREFIX}-request-id`,
  sourceAgentDid: `${OPENBOX_A2A_HEADER_PREFIX}-source-agent-did`,
  sourceAgentId: `${OPENBOX_A2A_HEADER_PREFIX}-source-agent-id`,
  sourceRunId: `${OPENBOX_A2A_HEADER_PREFIX}-source-run-id`,
  sourceWorkflowId: `${OPENBOX_A2A_HEADER_PREFIX}-source-workflow-id`,
  targetAgentId: `${OPENBOX_A2A_HEADER_PREFIX}-target-agent-id`,
  targetAgentType: `${OPENBOX_A2A_HEADER_PREFIX}-target-agent-type`
} as const;

export interface OpenBoxA2APeerDescriptor {
  agentDid?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  runId?: string | undefined;
  workflowId?: string | undefined;
}

export interface BuildOpenBoxA2AOutboundContextOptions {
  requestId?: string | undefined;
  source?: OpenBoxA2APeerDescriptor | undefined;
  target?: OpenBoxA2APeerDescriptor | undefined;
}

export interface ParseOpenBoxA2AInboundMetadataOptions {
  fallbackSourceAgentId?: string | undefined;
  fallbackSourceAgentDid?: string | undefined;
  target?: OpenBoxA2APeerDescriptor | undefined;
}

type HeaderRecordValue = string | string[] | undefined;

type HeaderSource =
  | Headers
  | Record<string, HeaderRecordValue>;

export function buildOpenBoxA2AOutboundContext(
  options: BuildOpenBoxA2AOutboundContextOptions
): {
  headers: Record<string, string>;
  metadata: OpenBoxEventMetadata;
  requestId: string;
} {
  const executionContext = getOpenBoxExecutionContext();
  const requestId = options.requestId ?? randomUUID();
  const sourceAgentId =
    options.source?.agentId ??
    process.env.AGENT_ID;
  const sourceAgentDid =
    options.source?.agentDid ??
    process.env.OPENBOX_AGENT_DID;
  const sourceWorkflowId =
    options.source?.workflowId ??
    executionContext?.workflowId;
  const sourceRunId =
    options.source?.runId ??
    executionContext?.runId;
  const metadata = buildOpenBoxA2APeerMetadata({
    direction: "outbound",
    requestId,
    source: {
      agentDid: sourceAgentDid,
      agentId: sourceAgentId,
      runId: sourceRunId,
      workflowId: sourceWorkflowId
    },
    target: options.target
  });

  const headers: Record<string, string> = {
    [OPENBOX_A2A_HEADERS.requestId]: requestId
  };

  if (sourceAgentId) {
    headers[OPENBOX_A2A_HEADERS.sourceAgentId] = sourceAgentId;
  }
  if (sourceAgentDid) {
    headers[OPENBOX_A2A_HEADERS.sourceAgentDid] = sourceAgentDid;
  }
  if (sourceWorkflowId) {
    headers[OPENBOX_A2A_HEADERS.sourceWorkflowId] = sourceWorkflowId;
  }
  if (sourceRunId) {
    headers[OPENBOX_A2A_HEADERS.sourceRunId] = sourceRunId;
  }
  if (options.target?.agentId) {
    headers[OPENBOX_A2A_HEADERS.targetAgentId] = options.target.agentId;
  }
  if (options.target?.agentType) {
    headers[OPENBOX_A2A_HEADERS.targetAgentType] = options.target.agentType;
  }

  return {
    headers,
    metadata,
    requestId
  };
}

export function parseOpenBoxA2AInboundMetadata(
  headers: HeaderSource,
  options: ParseOpenBoxA2AInboundMetadataOptions = {}
): OpenBoxEventMetadata | undefined {
  const requestId = getHeaderValue(headers, OPENBOX_A2A_HEADERS.requestId);
  const sourceAgentId =
    getHeaderValue(headers, OPENBOX_A2A_HEADERS.sourceAgentId) ??
    options.fallbackSourceAgentId;
  const sourceAgentDid =
    getHeaderValue(headers, OPENBOX_A2A_HEADERS.sourceAgentDid) ??
    options.fallbackSourceAgentDid;
  const sourceWorkflowId = getHeaderValue(
    headers,
    OPENBOX_A2A_HEADERS.sourceWorkflowId
  );
  const sourceRunId = getHeaderValue(headers, OPENBOX_A2A_HEADERS.sourceRunId);
  const targetAgentId =
    options.target?.agentId ??
    getHeaderValue(headers, OPENBOX_A2A_HEADERS.targetAgentId);
  const targetAgentType =
    options.target?.agentType ??
    getHeaderValue(headers, OPENBOX_A2A_HEADERS.targetAgentType);
  const targetAgentDid = options.target?.agentDid;

  if (
    !requestId &&
    !sourceAgentId &&
    !sourceAgentDid &&
    !sourceWorkflowId &&
    !sourceRunId
  ) {
    return undefined;
  }

  return buildOpenBoxA2APeerMetadata({
    direction: "inbound",
    requestId: requestId ?? randomUUID(),
    source: {
      agentDid: sourceAgentDid,
      agentId: sourceAgentId,
      runId: sourceRunId,
      workflowId: sourceWorkflowId
    },
    target: {
      agentDid: targetAgentDid,
      agentId: targetAgentId,
      agentType: targetAgentType
    }
  });
}

function buildOpenBoxA2APeerMetadata(input: {
  direction: "inbound" | "outbound";
  requestId: string;
  source?: OpenBoxA2APeerDescriptor | undefined;
  target?: OpenBoxA2APeerDescriptor | undefined;
}): OpenBoxEventMetadata {
  return {
    peer_request: {
      direction: input.direction,
      identity_scope: "claimed",
      protocol: "a2a",
      request_id: input.requestId,
      source: compactPeerDescriptor(input.source),
      target: compactPeerDescriptor(input.target),
      transport: "http"
    }
  };
}

function compactPeerDescriptor(
  descriptor: OpenBoxA2APeerDescriptor | undefined
): Record<string, string> | undefined {
  if (!descriptor) {
    return undefined;
  }

  const compacted: Record<string, string> = {};

  if (descriptor.agentDid) {
    compacted.agent_did = descriptor.agentDid;
  }
  if (descriptor.agentId) {
    compacted.agent_id = descriptor.agentId;
  }
  if (descriptor.agentType) {
    compacted.agent_type = descriptor.agentType;
  }
  if (descriptor.runId) {
    compacted.run_id = descriptor.runId;
  }
  if (descriptor.workflowId) {
    compacted.workflow_id = descriptor.workflowId;
  }

  return Object.keys(compacted).length > 0
    ? compacted
    : undefined;
}

function getHeaderValue(
  headers: HeaderSource,
  name: string
): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name);
    return value ?? undefined;
  }

  const matchedKey = Object.keys(headers).find(
    headerName => headerName.toLowerCase() === name.toLowerCase()
  );

  if (!matchedKey) {
    return undefined;
  }

  const value = (headers as Record<string, HeaderRecordValue>)[matchedKey];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
