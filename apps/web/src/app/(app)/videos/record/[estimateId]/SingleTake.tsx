"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { TakeRecorder } from "@/components/video/TakeRecorder";

export function SingleTake({ estimateId, customerName }: { estimateId: string; customerName: string }) {
  const [done, setDone] = useState(false);
  const router = useRouter();
  if (done) {
    return (
      <Card className="p-6 text-center">
        <p className="font-semibold" style={{ color: "var(--text-body)" }}>Attached — it renders above their tier options. 🎬</p>
      </Card>
    );
  }
  return (
    <TakeRecorder
      estimateId={estimateId}
      role="rep"
      overlay={{
        headline: `For ${customerName}`,
        lines: ["30–60 seconds: what you found, what it means, why the fix.", "Warm, specific, no jargon."],
      }}
      onDone={() => {
        setDone(true);
        setTimeout(() => router.back(), 1500);
      }}
    />
  );
}
