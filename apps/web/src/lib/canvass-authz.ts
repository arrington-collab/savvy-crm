import "server-only";
import { withTenant, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { getTenantId } from "@/lib/tenant";
import { canManageSettingsNow } from "@/lib/authz";

// Manager auth for canvass mutations (reps, territories), from either side:
//  1. a canvass bearer token whose rep has the server-side manager flag —
//     the field app's path (it can never carry a cross-origin Clerk cookie), or
//  2. a Savvy owner/admin session — the Savvy web app's path (S6 matrix).
// Returns the tenantId to operate on, or null (caller replies 401/403).
export async function canvassManagerTenantId(req: Request): Promise<string | null> {
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (sess) {
    const ok = await withTenant(sess.tenantId, (tx) => isCanvassManager(tx, sess.tenantId, sess.repId));
    return ok ? sess.tenantId : null;
  }
  try {
    const tenantId = await getTenantId();
    return (await canManageSettingsNow()) ? tenantId : null;
  } catch {
    return null;
  }
}
