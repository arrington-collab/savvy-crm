import { withTenant, user, eq } from "@savvy/db";
import { getCurrentUser } from "@/lib/current-user";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { formatPhoneDisplay } from "@savvy/core";
import { SageVerifyForm } from "./SageVerifyForm";

export const dynamic = "force-dynamic";

export default async function SageSettingsPage() {
  const { tenantId, userId, role } = await getCurrentUser();
  let phone = "";
  let verified = false;
  try {
    const [me] = await withTenant(tenantId, (tx) =>
      tx.select({ phone: user.phone, phoneVerifiedAt: user.phoneVerifiedAt }).from(user).where(eq(user.id, userId)),
    );
    if (me?.phone) phone = formatPhoneDisplay(me.phone);
    verified = !!me?.phoneVerifiedAt;
  } catch {
    phone = "";
  }
  const isAdmin = role === "owner" || role === "admin";

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Sage by text" />
      <div className="max-w-prose space-y-3 text-sm text-muted-foreground">
        <p>
          Run your exception queue from your phone. Your twice-daily digest numbers each item — reply{" "}
          <span className="font-mono">1</span> to act, <span className="font-mono">1?</span> for detail, or ask a question
          like &ldquo;did we send the Hendricks estimate?&rdquo;. Money actions ask for a{" "}
          <span className="font-mono">YES</span> confirmation first.
        </p>
        <p>
          For security, actions are only accepted from a verified number{phone ? <> ({phone})</> : null}. Verify once below.
        </p>
      </div>
      <SageVerifyForm verified={verified} canVerify={isAdmin && !!phone} />
    </div>
  );
}
