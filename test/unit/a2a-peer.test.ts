import {
  buildOpenBoxA2AOutboundContext,
  parseOpenBoxA2AInboundMetadata
} from "../../src/index.js";

describe("OpenBox A2A peer metadata", () => {
  it("builds outbound headers and metadata for peer requests", () => {
    const context = buildOpenBoxA2AOutboundContext({
      requestId: "req-123",
      source: {
        agentDid: "did:aip:source",
        agentId: "gateway-agent-01"
      },
      target: {
        agentId: "summarizer-agent-01",
        agentType: "summarizer"
      }
    });

    expect(context.requestId).toBe("req-123");
    expect(context.headers).toMatchObject({
      "x-openbox-a2a-protocol": "a2a",
      "x-openbox-a2a-request-id": "req-123",
      "x-openbox-a2a-source-agent-did": "did:aip:source",
      "x-openbox-a2a-source-agent-id": "gateway-agent-01",
      "x-openbox-a2a-target-agent-id": "summarizer-agent-01",
      "x-openbox-a2a-target-agent-type": "summarizer",
      "x-openbox-a2a-transport": "http"
    });
    expect(context.metadata).toEqual({
      peer_request: {
        direction: "outbound",
        protocol: "a2a",
        request_id: "req-123",
        source: {
          agent_did: "did:aip:source",
          agent_id: "gateway-agent-01"
        },
        target: {
          agent_id: "summarizer-agent-01",
          agent_type: "summarizer"
        },
        transport: "http"
      }
    });
  });

  it("parses inbound peer metadata from propagated headers", () => {
    const metadata = parseOpenBoxA2AInboundMetadata(
      {
        "x-openbox-a2a-protocol": "a2a",
        "x-openbox-a2a-request-id": "req-123",
        "x-openbox-a2a-source-agent-did": "did:aip:source",
        "x-openbox-a2a-source-agent-id": "gateway-agent-01",
        "x-openbox-a2a-target-agent-id": "summarizer-agent-01",
        "x-openbox-a2a-target-agent-type": "summarizer",
        "x-openbox-a2a-transport": "http"
      },
      {
        fallbackSourceAgentId: "fallback-agent",
        target: {
          agentId: "summarizer-agent-01",
          agentType: "summarizer"
        }
      }
    );

    expect(metadata).toEqual({
      peer_request: {
        direction: "inbound",
        protocol: "a2a",
        request_id: "req-123",
        source: {
          agent_did: "did:aip:source",
          agent_id: "gateway-agent-01"
        },
        target: {
          agent_id: "summarizer-agent-01",
          agent_type: "summarizer"
        },
        transport: "http"
      }
    });
  });
});
