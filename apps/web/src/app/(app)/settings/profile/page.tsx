import { withTenant, user, eq } from "@savvy/db";
import { getCurrentUser } from "@/lib/current-user";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { formatPhoneDisplay } from "@savvy/core";
import { ProfileForm } from "./ProfileForm";

export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const { tenantId, userId } = await getCurrentUser();
  // Best-effort read of the current value: a failed lookup (e.g. TEST_MODE's
  // synthetic non-uuid user id) must not block the form — you can still set a
  // new number. The save action does the authoritative write.
  let phone = "";
  try {
    const [me] = await withTenant(tenantId, (tx) =>
      tx.select({ phone: user.phone }).from(user).where(eq(user.id, userId)),
    );
    if (me?.phone) phone = formatPhoneDisplay(me.phone);
  } catch {
    phone = "";
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Your profile" />
      <ProfileForm phone={phone} />
    </div>
  );
}
