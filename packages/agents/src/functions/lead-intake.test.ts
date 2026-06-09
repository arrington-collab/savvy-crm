import { describe, it, expect, vi } from "vitest";
import { qualifyLead, buildBookingSms } from "./lead-intake";

describe("lead.intake pure steps", () => {
  it("qualifyLead returns score + reason + model from the gateway", async () => {
    const fakeAi = {
      completeObject: vi.fn().mockResolvedValue({ object: { score: 82, reason: "storm zone, owner" }, model: "gemini-flash" }),
    };
    const res = await qualifyLead({ name: "Jane", address: "123 Main", source: "web" }, fakeAi as never);
    expect(res.score).toBe(82);
    expect(res.reason).toBe("storm zone, owner");
    expect(res.model).toBe("gemini-flash");
    expect(fakeAi.completeObject).toHaveBeenCalledOnce();
  });

  it("buildBookingSms includes the booking link and name", () => {
    const body = buildBookingSms({ name: "Jane", bookingUrl: "https://x/book/123" });
    expect(body).toContain("https://x/book/123");
    expect(body).toMatch(/Jane/);
  });
});
