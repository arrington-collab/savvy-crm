import { getCurrentBilling, listUsageSnapshots } from "@/lib/billing-queries";
import { BillingClient } from "./BillingClient";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped usage

export default async function BillingPage() {
  const [current, history] = await Promise.all([getCurrentBilling(), listUsageSnapshots()]);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <BillingClient current={current} history={history} />
    </div>
  );
}
