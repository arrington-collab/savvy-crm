import Link from "next/link";
import { Card } from "@/components/ui/card";
import { videoBatchQueue } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

// Slice 5b: the daily recording queue, surfaced where the owner already looks.
export async function VideoBatchCard() {
  const tenantId = await getTenantId();
  const queue = await videoBatchQueue(tenantId).catch(() => []);
  if (queue.length === 0) return null;
  return (
    <Link href="/videos/batch" data-testid="video-batch-card">
      <Card className="p-4 transition hover:opacity-90">
        <p className="font-medium" style={{ color: "var(--text-body)" }}>
          🎥 {queue.length} estimate video{queue.length === 1 ? "" : "s"} to record
        </p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Yesterday&apos;s estimates — about {Math.max(2, queue.length * 2)} minutes, everything on the card.
        </p>
      </Card>
    </Link>
  );
}
