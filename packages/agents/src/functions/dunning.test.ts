import { describe, it, expect } from "vitest";
import { dunningSchedule } from "@savvy/core";

describe("dunning sequencing", () => {
  it("schedule is ascending and ends on the SMS escalation day", () => {
    const steps = dunningSchedule({ smsEscalationDay: 21 });
    const offsets = steps.map((s) => s.dayOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets); // already ascending
    const last = steps.at(-1);
    expect(last?.channel).toBe("sms");
    expect(last?.dayOffset).toBe(21);
    expect(last?.flipsOverdue).toBe(true);
  });

  it("only the final step escalates to SMS / flips overdue", () => {
    const steps = dunningSchedule({ smsEscalationDay: 30 });
    const emailSteps = steps.slice(0, -1);
    expect(emailSteps.every((s) => s.channel === "email" && !s.flipsOverdue)).toBe(true);
  });
});
