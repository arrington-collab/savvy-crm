import "server-only";
import { withTenant, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";

// Manager auth for canvass mutations (reps, territories). This app has no
// Clerk, so only path (1) from apps/web's version exists: a canvass bearer
// token whose rep has the server-side manager flag. The Savvy web app's
// org-admin path still works against ITS copy of these routes.
export async function canvassManagerTenantId(req: Request): Promise<string | null> {
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return null;
  const ok = await withTenant(sess.tenantId, (tx) => isCanvassManager(tx, sess.tenantId, sess.repId));
  return ok ? sess.tenantId : null;
}
