import { withTenant, user, eq, listRepBlocks } from "@savvy/db";
import { getCurrentUser } from "@/lib/current-user";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { formatPhoneDisplay } from "@savvy/core";
import { ProfileForm } from "./ProfileForm";
import { RepBlocks, type RepBlockView } from "./RepBlocks";

export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const { tenantId, userId } = await getCurrentUser();
  // Best-effort reads: a failed lookup (e.g. TEST_MODE's synthetic non-uuid user
  // id) must not block the forms — the save/add actions do the authoritative writes.
  let phone = "";
  let blocks: RepBlockView[] = [];
  try {
    const [me] = await withTenant(tenantId, (tx) =>
      tx.select({ phone: user.phone }).from(user).where(eq(user.id, userId)),
    );
    if (me?.phone) phone = formatPhoneDisplay(me.phone);
  } catch {
    phone = "";
  }
  try {
    const rows = await listRepBlocks(tenantId, userId);
    blocks = rows.map((b) => ({ id: b.id, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), reason: b.reason }));
  } catch {
    blocks = [];
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Your profile" />
      <ProfileForm phone={phone} />
      <RepBlocks blocks={blocks} />
    </div>
  );
}
