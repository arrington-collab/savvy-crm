"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { logLeadContact } from "@/lib/lead-actions";
import { ago } from "@/lib/format";

export function LogContactButton({
  leadId,
  firstRepContactAt,
}: {
  leadId: string;
  firstRepContactAt: Date | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (firstRepContactAt) {
    return (
      <p
        className="text-sm"
        style={{ color: "var(--text-muted)" }}
        data-testid="log-contact"
      >
        Contacted ✓&nbsp;
        <span className="mono">{ago(firstRepContactAt)}</span>
      </p>
    );
  }

  function doLog() {
    start(async () => {
      const r = await logLeadContact(leadId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Contact logged");
      router.refresh();
    });
  }

  return (
    <Button
      onClick={doLog}
      disabled={pending}
      data-testid="log-contact"
      variant="outline"
    >
      Log contact
    </Button>
  );
}
