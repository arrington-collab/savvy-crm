import { getSupplierAllowlist } from "@/lib/supplier-allowlist-queries";
import { SuppliersClient } from "./SuppliersClient";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const rows = await getSupplierAllowlist();
  return (
    <div className="space-y-6">
      <SuppliersClient rows={rows} />
    </div>
  );
}
