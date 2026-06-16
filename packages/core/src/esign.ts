import { z } from "./schemas";

export const ESIGN_DOC_TYPE = ["lien_waiver", "cert"] as const;
export type EsignDocType = (typeof ESIGN_DOC_TYPE)[number];

const esignSchema = z.object({
  templates: z
    .object({
      lien_waiver: z.string().trim().default(""),
      cert: z.string().trim().default(""),
    })
    .default({}),
});

export type EsignConfig = z.infer<typeof esignSchema>;

export function parseEsignConfig(raw: unknown): EsignConfig {
  return esignSchema.parse(raw ?? {});
}

/** The configured template id wins; otherwise the env-supplied Savvy standard id. */
export function resolveEsignTemplate(cfg: EsignConfig, docType: EsignDocType, fallback: string): string {
  const id = cfg.templates[docType];
  return id.length > 0 ? id : fallback;
}

export type EsignPrefillCtx = {
  customerName: string;
  propertyAddress: string;
  date: string;
  amount?: string;
};

/** DocuSeal prefill shape: [{ name, default_value }]. lien_waiver also carries amount. */
export function buildEsignPrefill(docType: EsignDocType, ctx: EsignPrefillCtx): { name: string; default_value: string }[] {
  const fields = [
    { name: "customer_name", default_value: ctx.customerName },
    { name: "property_address", default_value: ctx.propertyAddress },
    { name: "date", default_value: ctx.date },
  ];
  if (docType === "lien_waiver") {
    fields.push({ name: "amount", default_value: ctx.amount ?? "" });
  }
  return fields;
}
