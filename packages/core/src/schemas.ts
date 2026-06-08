import { z } from "zod";

// E.164 phone validation
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164 (+1...)");

export const leadIntakeSchema = z.object({
  name: z.string().min(1).max(120),
  phone,
  address: z.string().min(3).max(240),
  source: z.string().min(1).max(60).default("web"),
});
export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>;
