import { listAppointments } from "@/lib/scheduling-queries";
import { ScheduleClient } from "./ScheduleClient";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const appts = await listAppointments();

  // Group by UTC date string, then sort ascending
  const groupMap = new Map<string, typeof appts>();
  for (const a of appts) {
    const day = a.startsAt.toISOString().slice(0, 10);
    if (!groupMap.has(day)) groupMap.set(day, []);
    groupMap.get(day)!.push(a);
  }

  const days = [...groupMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, items]) => ({
      day,
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        status: i.status,
        startsAt: i.startsAt.toISOString(),
        endsAt: i.endsAt ? i.endsAt.toISOString() : null,
        assigneeUserId: i.assigneeUserId,
        customerName: i.customerName,
        address: i.address,
      })),
    }));

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Dispatch" title="Schedule" />
      <ScheduleClient days={days} />
    </div>
  );
}
