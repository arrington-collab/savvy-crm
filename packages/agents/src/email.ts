import { isDemoTenant } from "@savvy/db";
import { getEmailSender, type EmailSender } from "@savvy/integrations";
import { makeMockEmail } from "./mock-comms";

/** Tenant-aware email resolver mirroring getTenantSms. Demo tenants get a mock
 *  sender (logs a mock communication row, never hits Resend/Gmail). */
export async function getTenantEmail(
  tenantId: string,
  opts: { gmailConnectionId?: string | null },
): Promise<EmailSender> {
  if (await isDemoTenant(tenantId)) return makeMockEmail(tenantId);
  return getEmailSender(opts);
}
