import { z } from "zod";
import { leadIntakeObject } from "./schemas";

// Signed-contract intake from the canvass (door-knocking) field app.
// POST /api/canvass/contract — see apps/web/src/app/api/canvass/contract/route.ts.
//
// customer reuses the lead-intake shape (same phone/email normalization);
// `source` is omitted because the route sets it to "door-knocking" server-side.
export const canvassCustomerObject = leadIntakeObject.omit({ source: true });

export const CANVASS_CONTRACT_KINDS = ["insurance", "retail"] as const;

export const canvassContractObject = z.object({
  customer: canvassCustomerObject,
  contract: z.object({
    kind: z.enum(CANVASS_CONTRACT_KINDS),
    document: z.string().min(1).max(160),
    // All filled contract fields, keyed by their label ("Claim #", "Deductible ($)", ...).
    fields: z.record(z.string().max(80), z.string().max(2000)).default({}),
    scopeItems: z.array(z.string().max(120)).max(50).default([]),
    rep: z.string().min(1).max(120),
    signedAt: z.string().datetime({ offset: true }),
    // Legal gate: the homeowner must have checked the e-records consent box.
    consentElectronic: z.literal(true),
    // SHA-256 over contract body + fields at signing; drives idempotent storage.
    integrityHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    signaturePng: z.string().startsWith("data:image/png;base64,").max(2_000_000),
  }),
});

export type CanvassContractInput = z.infer<typeof canvassContractObject>;
export type CanvassContract = CanvassContractInput["contract"];

// The field app is hosted on a separate origin, so /api/canvass/contract is
// CORS-enabled. CANVASS_ALLOWED_ORIGINS is a comma-separated allowlist; when
// unset (or containing "*") any origin is echoed back — the tenant key + rate
// limit are the real gate, and CORS never restricts non-browser clients.
// Returns the value for Access-Control-Allow-Origin, or null to deny.
export function allowedCanvassOrigin(
  origin: string | null | undefined,
  allowlist: string | null | undefined,
): string | null {
  const list = (allowlist ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.includes("*")) return origin ?? "*";
  return origin && list.includes(origin) ? origin : null;
}

// ── Rep auth (Slice 1: field-app name + PIN login) ───────────────────────
// PIN is 4–6 digits; hashed server-side with scrypt (@savvy/core hashPin).
export const canvassPinSchema = z.string().regex(/^\d{4,6}$/);

// Manager creates a rep (POST /api/canvass/reps). photoUrl may be a hosted URL
// or a small data: URL (avatar); capped so it can live in a text column.
export const canvassRepCreateObject = z.object({
  name: z.string().min(1).max(80),
  pin: canvassPinSchema,
  photoUrl: z.string().max(300_000).optional(),
});

// Rep logs in (POST /api/canvass/login): taps their name + enters their PIN.
export const canvassLoginObject = z.object({
  name: z.string().min(1).max(80),
  pin: canvassPinSchema,
});

export type CanvassRepCreateInput = z.infer<typeof canvassRepCreateObject>;
export type CanvassLoginInput = z.infer<typeof canvassLoginObject>;
