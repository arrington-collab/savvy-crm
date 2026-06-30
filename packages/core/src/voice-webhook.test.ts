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

  it("extracts callId from call.id", () => {
    const msg = parseVapiMessage({
      message: {
        type: "tool-calls",
        call: { id: "vapi-call-xyz", metadata: { leadId: "lead-1", tenantId: "tenant-1" } },
      },
    });
    expect(msg.callId).toBe("vapi-call-xyz");
  });

  it("returns null callId when call.id is missing", () => {
    const msg = parseVapiMessage({
      message: {
        type: "end-of-call-report",
        call: { metadata: { leadId: "lead-1" } },
      },
    });
    expect(msg.callId).toBeNull();
  });

  it("does not throw on hostile input and returns sane defaults", () => {
    // null input
    const fromNull = parseVapiMessage(null);
    expect(fromNull.type).toBe("");
    expect(Array.isArray(fromNull.toolCalls)).toBe(true);
    expect(fromNull.metadata).toEqual({});
    expect(fromNull.callId).toBeNull();

    // empty object
    const fromEmpty = parseVapiMessage({});
    expect(fromEmpty.type).toBe("");
    expect(Array.isArray(fromEmpty.toolCalls)).toBe(true);
    expect(fromEmpty.metadata).toEqual({});

    // non-JSON string as toolCalls[0].function.arguments
    const fromBadArgs = parseVapiMessage({
      message: {
        type: "tool-calls",
        toolCalls: [{ id: "tc1", function: { name: "doThing", arguments: "NOT JSON {{{{" } }],
        call: { metadata: {} },
      },
    });
    expect(fromBadArgs.type).toBe("tool-calls");
    expect(fromBadArgs.toolCalls[0]?.args).toEqual({});
  });

  it("surfaces assistantId and phoneNumberId from an inbound message", () => {
    const msg = parseVapiMessage({
      message: {
        type: "assistant-request",
        assistant: { id: "asst_byo_1" },
        phoneNumber: { id: "pn_byo_1", number: "+16025550000" },
        customer: { number: "+16025551111" },
      },
    });
    expect(msg.assistantId).toBe("asst_byo_1");
    expect(msg.phoneNumberId).toBe("pn_byo_1");
  });

  it("defaults assistantId/phoneNumberId to null on empty input", () => {
    const m = parseVapiMessage(null);
    expect(m.assistantId).toBeNull();
    expect(m.phoneNumberId).toBeNull();
  });

  it("toolResult wraps a result in Vapi's results shape", () => {
    expect(toolResult("tc1", { slots: [] })).toEqual({ results: [{ toolCallId: "tc1", result: { slots: [] } }] });
  });
});
