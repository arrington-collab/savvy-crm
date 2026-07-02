"use client";
import { useState, useTransition } from "react";
import { confirmSlot } from "@/lib/booking-action";
import { Button } from "@/components/ui/button";

export function SlotPicker({
  token,
  slots,
}: {
  token: string;
  // `label` is formatted on the server (tenant tz) so this client component
  // renders a stable string — no new Date()/toLocale* that would mismatch on
  // hydration and reset the email field mid-typing.
  slots: { startsAt: string; endsAt: string; label: string }[];
}) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [pending, start] = useTransition();

  if (done)
    return (
      <p className="rounded-md bg-green-50 p-4 text-green-800">
        You&apos;re booked! See you then.
      </p>
    );

  return (
    <div className="space-y-2">
      {error === "slot_taken" && (
        <p className="text-sm text-red-600">That time was just taken — pick another.</p>
      )}
      {slots.length === 0 && (
        <p>No open times in the next two weeks. Please contact us.</p>
      )}
      {slots.length > 0 && (
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Email (optional — for your confirmation)</span>
          <input
            type="email"
            data-testid="booking-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-md border px-3 py-2"
          />
        </label>
      )}
      {slots.map((s) => (
        <Button
          key={s.startsAt}
          variant="outline"
          className="w-full justify-start"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await confirmSlot(token, s.startsAt, s.endsAt, email);
              if ("ok" in r) setDone(true);
              else setError(r.error);
            })
          }
        >
          {s.label}
        </Button>
      ))}
    </div>
  );
}
