import { z } from "zod";
import { normalizePhone } from "./phone";
import { LEAD_SOURCE_VALUES, leadSourceDetailSchema } from "./lead-sources";
import { inlinePartnerSchema, isPartnerSource, hasPartnerRef, partnerRefIssue } from "./partner";

// Re-export zod so cross-package consumers (the Next.js app) use THIS package's
// single zod instance — extending leadIntakeSchema with the app's own zod would
// produce a duplicate-instance type mismatch (same pattern as @savvy/db operators).
export { z };

// phone: optional now (was required). Normalizes to E.164 when present; blank -> undefined.
const phoneOptional = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid phone number" });
      return z.NEVER;
    }
    return n;
  });

// email: optional, trimmed + lowercased, format-validated; blank -> undefined.
// preprocess normalizes first so an empty string isn't treated as an invalid email.
const emailOptional = z.preprocess(
  (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
  z.string().email("Enter a valid email").optional(),
);

export const ROOF_TYPE_VALUES = ["asphalt_shingle", "tile", "metal", "flat_foam", "other"] as const;
const roofType = z.enum(ROOF_TYPE_VALUES);

// The plain object (no refinement). A refined schema is a ZodEffects and loses
// `.extend()`, which /api/leads needs to add its `key`. Export the object so
// consumers can extend it, then re-apply the refinement themselves.
export const leadIntakeObject = z.object({
  name: z.string().min(1).max(120),
  phone: phoneOptional,
  email: emailOptional,
  address: z.string().min(3).max(240),
  source: z.enum(LEAD_SOURCE_VALUES),
  sourceDetail: z.unknown().optional(),
  // Partner attribution (Partner Ledger slice 1): partner-class sources carry
  // a picked partner id OR an inline create-once payload — never free text.
  partnerId: z.string().uuid().optional(),
  partner: inlinePartnerSchema.optional(),
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

// Require at least one contact method. Exported so consumers that .extend()
// leadIntakeObject (e.g. /api/leads) can re-apply the same rule.
export const hasContactMethod = (d: { phone?: string; email?: string }): boolean =>
  Boolean(d.phone || d.email);

export const contactMethodIssue: { message: string; path: (string | number)[] } = {
  message: "Add a phone or email",
  path: ["phone"],
};

// Partner-class sources: the partner record is the attribution truth;
// source_detail becomes optional legacy color (validated when present).
// Exported so consumers that .extend() leadIntakeObject re-apply the same rule.
export const hasValidSourceDetail = (d: { source: string; sourceDetail?: unknown }): boolean => {
  const detail = d.sourceDetail ?? (d.source === "other" ? {} : null);
  if (isPartnerSource(d.source) && detail == null) return true;
  return leadSourceDetailSchema(d.source).safeParse(detail).success;
};

export const sourceDetailIssue: { message: string; path: (string | number)[] } = {
  message: "Fill in the required details for this source",
  path: ["sourceDetail"],
};

export const leadIntakeSchema = leadIntakeObject
  .refine(hasContactMethod, contactMethodIssue)
  .refine(hasValidSourceDetail, sourceDetailIssue)
  .refine(hasPartnerRef, partnerRefIssue);
export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>;
