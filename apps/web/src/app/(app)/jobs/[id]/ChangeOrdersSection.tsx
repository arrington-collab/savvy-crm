"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createChangeOrderAction } from "@/lib/change-order-actions";

export function ChangeOrdersSection({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function handleCreate() {
    start(async () => {
      const r = await createChangeOrderAction({ jobId, reason: "", lineItems: [] });
      if ("ok" in r) router.push(`/jobs/${jobId}/change-orders/${r.id}`);
    });
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={handleCreate} data-testid="create-change-order-btn">
      {pending ? "Creating…" : "+ Create change order"}
    </Button>
  );
}
