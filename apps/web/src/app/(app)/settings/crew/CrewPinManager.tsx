"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setCrewPin } from "@/lib/crew-admin-actions";

type Crew = { id: string; name: string; hasPin: boolean };

export function CrewPinManager({ crew }: { crew: Crew[] }) {
  const router = useRouter();
  const [pins, setPins] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  function save(userId: string) {
    const pin = pins[userId] ?? "";
    start(async () => {
      const r = await setCrewPin(userId, pin);
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("PIN set");
      setPins((p) => ({ ...p, [userId]: "" }));
      router.refresh();
    });
  }

  if (crew.length === 0) {
    return <p className="text-sm" style={{ color: "var(--text-faint)" }}>No crew users yet. Add users with role &quot;crew&quot;.</p>;
  }
  return (
    <Card className="divide-y divide-white/5 p-0">
      {crew.map((c) => (
        <div key={c.id} className="flex items-center gap-3 p-4" data-testid="crew-pin-row" data-user-id={c.id}>
          <div className="flex-1">
            <div className="font-medium">{c.name}</div>
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>{c.hasPin ? "PIN set" : "no PIN"}</div>
          </div>
          <Input
            inputMode="numeric"
            placeholder="new PIN"
            value={pins[c.id] ?? ""}
            onChange={(e) => setPins((p) => ({ ...p, [c.id]: e.target.value }))}
            className="w-28"
          />
          <Button onClick={() => save(c.id)} disabled={pending} data-testid="crew-pin-save">Set</Button>
        </div>
      ))}
    </Card>
  );
}
