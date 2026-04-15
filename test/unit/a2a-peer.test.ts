import { describe, expect, it, vi } from "vitest";

import {
  buildOpenBoxA2AOutboundContext,
  OPENBOX_A2A_HEADERS,
  parseOpenBoxA2AInboundMetadata
} from "../../src/mastra/a2a-peer.js";

describe("A2A peer metadata helpers", () => {
  it("builds outbound headers and metadata from the active execution context", async () => {
    vi.stubEnv("AGENT_ID", "gateway-agent-01");
    vi.stubEnv("OPENBOX_AGENT_DID", "did:aip:gateway");

    const { runWithOpenBoxEventMetadata } = await import(
      "../../src/mastra/event-metadata.js"
    );

    const result = await runWithOpenBoxEventMetadata(
      {
        upstream: {
          request_id: "user-request-1"
        }
      },
      async () =>
        buildOpenBoxA2AOutboundContext({
          requestId: "peer-request-1",
          target: {
            agentId: "summarizer-agent-01",
            agentType: "summarizer"
          }
        })
    );

    expect(result.headers).toMatchObject({
      [OPENBOX_A2A_HEADERS.requestId]: "peer-request-1",
      [OPENBOX_A2A_HEADERS.sourceAgentDid]: "did:aip:gateway",
      [OPENBOX_A2A_HEADERS.sourceAgentId]: "gateway-agent-01",
      [OPENBOX_A2A_HEADERS.targetAgentId]: "summarizer-agent-01",
      [OPENBOX_A2A_HEADERS.targetAgentType]: "summarizer"
    });
    expect(result.metadata).toMatchObject({
      peer_request: {
        direction: "outbound",
        request_id: "peer-request-1",
        source: {
          agent_did: "did:aip:gateway",
          agent_id: "gateway-agent-01"
        },
        target: {
          agent_id: "summarizer-agent-01",
          agent_type: "summarizer"
        }
      }
    });
  });

  it("parses inbound A2A headers into peer metadata", () => {
    const metadata = parseOpenBoxA2AInboundMetadata(
      {
        [OPENBOX_A2A_HEADERS.requestId]: "peer-request-2",
        [OPENBOX_A2A_HEADERS.sourceAgentDid]: "did:aip:gateway",
        [OPENBOX_A2A_HEADERS.sourceAgentId]: "gateway-agent-01",
        [OPENBOX_A2A_HEADERS.sourceRunId]: "run-123",
        [OPENBOX_A2A_HEADERS.sourceWorkflowId]: "gateway-search-request-workflow"
      },
      {
        target: {
          agentId: "web-search-agent-01",
          agentType: "web-search"
        }
      }
    );

    expect(metadata).toMatchObject({
      peer_request: {
        direction: "inbound",
        identity_scope: "claimed",
        request_id: "peer-request-2",
        source: {
          agent_did: "did:aip:gateway",
          agent_id: "gateway-agent-01",
          run_id: "run-123",
          workflow_id: "gateway-search-request-workflow"
        },
        target: {
          agent_id: "web-search-agent-01",
          agent_type: "web-search"
        },
        transport: "http"
      }
    });
  });

  it("falls back to the request body sender when inbound headers are absent", () => {
    const metadata = parseOpenBoxA2AInboundMetadata(
      {},
      {
        fallbackSourceAgentId: "gateway-agent-01",
        target: {
          agentId: "data-processor-agent-01",
          agentType: "data-processor"
        }
      }
    );

    expect(metadata).toMatchObject({
      peer_request: {
        direction: "inbound",
        source: {
          agent_id: "gateway-agent-01"
        },
        target: {
          agent_id: "data-processor-agent-01",
          agent_type: "data-processor"
        }
      }
    });
  });
});
