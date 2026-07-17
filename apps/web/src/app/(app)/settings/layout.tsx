import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { canManageSettingsNow } from "@/lib/authz";

// Phase 26 S6 matrix: /settings/* is owner/admin only (Savvy role — the Clerk
// org role diverges; see the S6a audit). Server actions under settings carry
// their own guards; this layout is the route-level gate.
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  if (!(await canManageSettingsNow())) redirect("/today");
  return <>{children}</>;
}
