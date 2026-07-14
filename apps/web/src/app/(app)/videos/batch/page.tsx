import { videoBatchQueue } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { BatchRecorder } from "./BatchRecorder";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

// Slice 5b: the owner's recording queue — yesterday's sent estimates, ten
// videos in twenty minutes, zero lookup.
export default async function VideoBatchPage() {
  const tenantId = await getTenantId();
  const queue = await videoBatchQueue(tenantId);
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Today" title="Day-after videos" />
      {queue.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="video-queue-empty">
          Nothing to record — every recent estimate already has its video (or nothing went out yesterday).
        </p>
      ) : (
        <BatchRecorder queue={queue} />
      )}
    </div>
  );
}
