"use client";

import { useState, useTransition } from "react";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

interface ScanFormProps {
  repId: string;
  company: string;
  repName: string;
  hasPixel: boolean;
}

export function ScanForm({ repId, company, repName, hasPixel }: ScanFormProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [ack, setAck] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!name.trim() && !phone.trim()) {
      setHint("Enter your name or phone number.");
      return;
    }
    setHint(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/canvass/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repId, name, phone, ack }),
        });
        if (res.ok) {
          if (hasPixel && typeof window.fbq === "function") {
            window.fbq("track", "Lead");
          }
          setDone(true);
          return;
        }
        setError("Couldn't submit — try again in a minute.");
      } catch {
        setError("Couldn't submit — try again in a minute.");
      }
    });
  }

  if (done) {
    return (
      <div className="mt-4 rounded-2xl border bg-white p-6 text-center shadow-sm">
        <p className="text-sm font-semibold text-gray-900">You&apos;re covered — {repName} is verified and insured.</p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border bg-white p-6 shadow-sm">
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-2 w-full rounded-lg border px-3 py-2 text-sm"
      />
      <input
        type="tel"
        placeholder="Phone (optional)"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm"
      />
      <label className="mb-3 flex items-start gap-2 text-xs text-gray-500">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        <span>I confirm {company} has my permission to access my property, including the roof, for inspection.</span>
      </label>
      {hint ? <p className="mb-2 text-xs text-red-600">{hint}</p> : null}
      {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}
