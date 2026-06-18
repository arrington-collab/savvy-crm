"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { crewCheckIn, crewCheckOut, crewPresignPhoto, crewRecordPhoto } from "@/lib/crew-actions";

function getCoords(): Promise<{ lat: number | null; lng: number | null }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { timeout: 5000 },
    );
  });
}

export function CrewJobClient({ jobId, initiallyCheckedIn }: { jobId: string; initiallyCheckedIn: boolean }) {
  const router = useRouter();
  const [checkedIn, setCheckedIn] = useState(initiallyCheckedIn);
  const [label, setLabel] = useState("before");
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      const { lat, lng } = await getCoords();
      const r = checkedIn ? await crewCheckOut(jobId, lat, lng) : await crewCheckIn(jobId, lat, lng);
      if ("error" in r) { toast.error(r.error); return; }
      setCheckedIn(!checkedIn);
      toast.success(checkedIn ? "Checked out" : "Checked in");
      router.refresh();
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    start(async () => {
      const pre = await crewPresignPhoto(jobId, { filename: file.name, contentType: file.type || "image/jpeg" });
      if ("error" in pre) { toast.error(pre.error); return; }
      const put = await fetch(pre.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type || "image/jpeg" } });
      if (!put.ok) { toast.error("upload failed"); return; }
      const rec = await crewRecordPhoto(jobId, { r2Key: pre.r2Key, label, filename: file.name, mime: file.type || "image/jpeg", sizeBytes: file.size });
      if ("error" in rec) { toast.error(rec.error); return; }
      toast.success("Photo uploaded");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Button onClick={toggle} disabled={pending} data-testid="crew-checkin-toggle" className="w-full">
        {checkedIn ? "Check out" : "Check in"}
      </Button>

      <div className="space-y-2 rounded-lg border border-white/10 p-3">
        <label className="block text-sm font-medium">Add photo</label>
        <select value={label} onChange={(e) => setLabel(e.target.value)} data-testid="crew-photo-label"
          className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm">
          <option value="before">before</option>
          <option value="after">after</option>
          <option value="other">other</option>
        </select>
        <input type="file" accept="image/*" capture="environment" onChange={onFile} disabled={pending} data-testid="crew-photo-input" />
      </div>
    </div>
  );
}
