import { describe, it, expect } from "vitest";
import { parseVapiMessage, toolResult } from "./voice-webhook";

describe("parseVapiMessage", () => {
  it("extracts type + metadata (leadId/tenantId) from a tool-calls message", () => {
    const msg = parseVapiMessage({
      message: {
        type: "tool-calls",
        toolCalls: [{ id: "tc1", function: { name: "getRecommendedSlots", arguments: {} } }],
        call: { metadata: { leadId: "lead-1", tenantId: "tenant-1", direction: "outbound" } },
      },
    });
    expect(msg.type).toBe("tool-calls");
    expect(msg.metadata).toMatchObject({ leadId: "lead-1", tenantId: "tenant-1" });
    expect(msg.toolCalls[0]).toMatchObject({ id: "tc1", name: "getRecommendedSlots" });
  });

  it("parses an end-of-call-report with transcript + structured outcome + to-number", () => {
    const msg = parseVapiMessage({
      message: {
        type: "end-of-call-report",
        call: { metadata: { leadId: "lead-1" } },
        artifact: { transcript: "hello", recordingUrl: "https://r/1" },
        durationSeconds: 30,
        analysis: { structuredData: { outcome: "booked" } },
        phoneNumber: { number: "+16025559999" },
      },
    });
    expect(msg.type).toBe("end-of-call-report");
    expect(msg.transcript).toBe("hello");
    expect(msg.recordingUrl).toBe("https://r/1");
    expect(msg.durationSeconds).toBe(30);
    expect(msg.outcomeRaw).toBe("booked");
    expect(msg.toNumber).toBe("+16025559999");
  });

  it("toolResult wraps a result in Vapi's results shape", () => {
    expect(toolResult("tc1", { slots: [] })).toEqual({ results: [{ toolCallId: "tc1", result: { slots: [] } }] });
  });
});
