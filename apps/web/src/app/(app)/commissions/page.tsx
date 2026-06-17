import { listCommissions } from "@/lib/commission-queries";
import { CommissionsClient } from "./CommissionsClient";

export const dynamic = "force-dynamic";

export default async function CommissionsPage() {
  const rows = await listCommissions();
  return (
    <div className="space-y-6">
      <CommissionsClient rows={rows} />
    </div>
  );
}
