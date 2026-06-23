import { z } from "zod";
import { normalizePhone } from "./phone";

// Re-export zod so cross-package consumers (the Next.js app) use THIS package's
// single zod instance — extending leadIntakeSchema with the app's own zod would
// produce a duplicate-instance type mismatch (same pattern as @savvy/db operators).
export { z };

// Accept any common format; normalize to E.164. Adds an issue if unparseable.
const phone = z.string().transform((v, ctx) => {
  const n = normalizePhone(v);
  if (!n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid phone number" });
    return z.NEVER;
  }
  return n;
});

const roofType = z.enum(["asphalt_shingle", "tile", "metal", "flat_foam", "other"]);

export const leadIntakeSchema = z.object({
  name: z.string().min(1).max(120),
  phone,
  address: z.string().min(3).max(240),
  source: z.string().min(1).max(60).default("web"),
  // optional structured address (Google Places) + optional roof/year
  city: z.string().max(120).optional(),
  state: z.string().max(40).optional(),
  zip: z.string().max(12).optional(),
  county: z.string().max(120).optional(),
  line1: z.string().max(200).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  roofType: roofType.optional(),
  yearBuilt: z.number().int().min(1850).max(new Date().getFullYear()).optional(),
});
export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>;
