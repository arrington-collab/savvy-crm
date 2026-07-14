// Estimate Experience slice 5: the Why Us content block — tenant-branded,
// owner-editable Library config rendered on the estimate page (and the
// present-mode close). Content, not code.
import { z } from "zod";

const whyUsSchema = z.object({
  story: z.string().max(1200).default(""),
  yearsLine: z.string().max(120).default(""),
  workmanshipPromise: z.string().max(400).default(""),
  timeline: z.array(z.string().max(160)).max(8).default([]),
});

export type WhyUsConfig = z.infer<typeof whyUsSchema>;

export function parseWhyUsConfig(raw: unknown): WhyUsConfig {
  return whyUsSchema.parse(raw ?? {});
}

export function whyUsConfigured(cfg: WhyUsConfig): boolean {
  return Boolean(cfg.story || cfg.workmanshipPromise || cfg.timeline.length);
}
