import { getSlotsForToken } from "@/lib/booking-action";
import { SlotPicker } from "./SlotPicker";

export const dynamic = "force-dynamic";

export default async function BookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await getSlotsForToken(token);
  if ("error" in res) {
    const msg =
      res.error === "invalid"
        ? "This booking link is invalid or expired."
        : "No one is available to book right now — please contact us.";
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">Booking unavailable</h1>
        <p className="mt-2 text-muted-foreground">{msg}</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold">Pick a time</h1>
      <p className="text-muted-foreground mb-4">Choose a slot for your appointment.</p>
      <SlotPicker token={token} slots={res.slots} />
    </main>
  );
}
