"use server";
import { randomUUID } from "node:crypto";
import { r2Storage } from "@savvy/integrations";
import { withTenant, document, estimate, eq, attachEstimateVideo } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

/** Slice 5b: presign a direct-to-R2 upload for a recorded take. */
export async function presignVideoUpload(input: { estimateId: string; contentType: string }) {
  const tenantId = await getTenantId();
  const r2Key = `videos/${tenantId}/${input.estimateId}/${randomUUID()}.webm`;
  const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
  return { url, r2Key };
}

/** Record the take: document row (kind=video) + estimate linkage; approved =
 *  the recorder's approve tap. Emits the processing-seam event. */
export async function recordEstimateVideoAction(input: {
  estimateId: string;
  role: "rep" | "owner";
  r2Key: string;
  sizeBytes: number;
  approved: boolean;
}) {
  const tenantId = await getTenantId();
  const doc = await withTenant(tenantId, async (tx) => {
    const [est] = await tx.select({ leadId: estimate.leadId, jobId: estimate.jobId }).from(estimate).where(eq(estimate.id, input.estimateId));
    const [d] = await tx
      .insert(document)
      .values({
        tenantId,
        kind: "video",
        label: input.role === "owner" ? "Owner day-after video" : "Rep post-inspection video",
        leadId: est?.leadId ?? null,
        jobId: est?.jobId ?? null,
        r2Key: input.r2Key,
        mime: "video/webm",
        sizeBytes: input.sizeBytes,
        source: "savvy",
      })
      .returning({ id: document.id });
    return d!;
  });
  const { id } = await attachEstimateVideo({
    tenantId,
    estimateId: input.estimateId,
    role: input.role,
    documentId: doc.id,
    approved: input.approved,
  });
  try {
    await inngest.send({ name: "estimate/video.recorded", data: { tenantId, estimateId: input.estimateId, estimateVideoId: id } });
  } catch {
    /* processing seam is best-effort; the take is already stored */
  }
  return { documentId: doc.id, estimateVideoId: id };
}
