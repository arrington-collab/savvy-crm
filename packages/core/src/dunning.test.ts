import { describe, it, expect } from "vitest";
import { dunningSchedule, dunningEmail, dunningSms } from "./dunning";

describe("dunning schedule", () => {
  it("produces 4 steps with the SMS step last, at smsEscalationDay", () => {
    const steps = dunningSchedule({ smsEscalationDay: 30 });
    expect(steps.map((s) => s.dayOffset)).toEqual([3, 7, 14, 30]);
    expect(steps.map((s) => s.channel)).toEqual(["email", "email", "email", "sms"]);
    expect(steps[3].flipsOverdue).toBe(true);
  });

  it("email copy includes number + pay link, escalating tone", () => {
    const gentle = dunningEmail({
      tone: "gentle",
      number: "INV-000007",
      payUrl: "https://pay",
      amountCents: 250000,
    });
    expect(gentle.subject).toContain("INV-000007");
    expect(gentle.html).toContain("https://pay");
    expect(gentle.html).toContain("$2,500.00");
    expect(
      dunningEmail({
        tone: "final",
        number: "INV-000007",
        payUrl: "https://pay",
        amountCents: 250000,
      }).subject
    ).not.toBe(gentle.subject);
  });

  it("sms copy is short and includes the pay link", () => {
    const sms = dunningSms({ number: "INV-000007", payUrl: "https://pay" });
    expect(sms).toContain("INV-000007");
    expect(sms).toContain("https://pay");
    expect(sms.length).toBeLessThan(320);
  });
});
