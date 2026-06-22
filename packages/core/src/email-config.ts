import { z } from "./schemas";

export type EmailConfig = { gmailConnectionId?: string };

const schema = z.object({
  gmailConnectionId: z.string().optional(),
});

/** Parse tenant.settings.email. Wrong types/unknown keys are dropped; defaults to {}. */
export function parseEmailConfig(raw: unknown): EmailConfig {
  const p = schema.safeParse(raw ?? {});
  if (!p.success) return {};
  return p.data.gmailConnectionId ? { gmailConnectionId: p.data.gmailConnectionId } : {};
}
