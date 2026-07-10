import { describe, it, expect } from "vitest";
import { referralFeeOnPaid } from "./functions/referral-fee";
import { functions } from "./index";

/**
 * The codebase does not unit-test Inngest handlers directly (see commissionOnPaid,
 * which has no handler test) — InngestFunction's execution machinery (steps,
 * memoization, checkpointing) is internal and not designed for direct invocation
 * outside the Inngest runtime/dev server. The handler here is a thin wrapper
 * around the already-tested `recordReferralPayment` (see
 * packages/db/tests/referral-payment.test.ts), so the behavior under test is the
 * wiring: the function is registered with the app and triggers on the right event.
 */
describe("referralFeeOnPaid", () => {
  it("is registered in the exported functions array", () => {
    expect(functions).toContain(referralFeeOnPaid);
  });

  it("triggers on invoice/paid", () => {
    expect(referralFeeOnPaid.id()).toBe("referral-fee-on-paid");
    expect((referralFeeOnPaid.opts as unknown as { triggers: unknown[] }).triggers).toEqual([{ event: "invoice/paid" }]);
  });
});
