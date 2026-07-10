import { z } from "zod";

const referralSchema = z.object({
  // Referral fees at or below this auto-approve; above requires a human approval card.
  // null (default) = no gating — auto-approve every referral fee.
  approvalThresholdCents: z.number().int().min(0).nullable().default(null),
});
export type ReferralConfig = z.infer<typeof referralSchema>;

export function parseReferralConfig(raw: unknown): ReferralConfig {
  return referralSchema.parse(raw ?? {});
}

export function referralFeeRequiresApproval(feeCents: number, cfg: ReferralConfig): boolean {
  return cfg.approvalThresholdCents !== null && feeCents > cfg.approvalThresholdCents;
}
