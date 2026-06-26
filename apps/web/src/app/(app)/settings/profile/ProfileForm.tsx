"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveMyPhone } from "@/lib/profile-actions";

export function ProfileForm({ phone }: { phone: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(phone);

  function save() {
    start(async () => {
      const r = await saveMyPhone(value);
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Phone saved");
      router.refresh();
    });
  }

  return (
    <Card className="p-4">
      <div className="eyebrow mb-2">Mobile number</div>
      <p className="mb-3 text-sm" style={{ color: "var(--text-muted)" }}>
        Where we text you the instant a new lead is assigned to you — tap the link to call them back fast.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="tel" placeholder="(480) 555-1234" data-testid="profile-phone"
          value={value} onChange={(e) => setValue(e.target.value)} className="w-64" />
        <Button disabled={pending} data-testid="profile-phone-save" onClick={save}>Save</Button>
      </div>
    </Card>
  );
}
