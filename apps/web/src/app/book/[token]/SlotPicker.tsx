"use client";
import { useState, useTransition } from "react";
import { confirmSlot } from "@/lib/booking-action";
import { Button } from "@/components/ui/button";

export function SlotPicker({
  token,
  slots,
}: {
  token: string;
  slots: { startsAt: string; endsAt: string }[];
}) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      {slots.map((s) => (
        <Button
          key={s.startsAt}
          variant="outline"
          className="w-full justify-start"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await confirmSlot(token, s.startsAt, s.endsAt);
              if ("ok" in r) setDone(true);
              else setError(r.error);
            })
          }
        >
          {new Date(s.startsAt).toLocaleString()}
        </Button>
      ))}
    </div>
  );
}
