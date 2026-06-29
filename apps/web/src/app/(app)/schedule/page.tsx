import { listAppointments, listUsers, getScheduleCities, getTenantTimezone, type ScheduleFilter } from "@/lib/scheduling-queries";
import { listActiveCrews } from "@/lib/crew-team-actions";
import { toCivilDate, type ScheduleAppt } from "@savvy/core";
import { ScheduleClient } from "./ScheduleClient";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

type SP = { view?: string; anchor?: string; crew?: string; type?: string; jobType?: string; city?: string };

export default async function SchedulePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const filter: ScheduleFilter = {
    assigneeUserId: sp.crew || undefined,
    type: sp.type || undefined,
    jobType: sp.jobType || undefined,
    city: sp.city || undefined,
  };
  const [rows, crew, cityOpts, tz, crews] = await Promise.all([
    listAppointments(filter), listUsers(), getScheduleCities(), getTenantTimezone(), listActiveCrews(),
  ]);
  const appts: ScheduleAppt[] = rows.map((r) => ({
    id: r.id, type: r.type, status: r.status,
    startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(),
    assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeName,
    customerName: r.customerName, address: r.address, jobId: r.jobId, jobType: r.jobType, city: r.city,
  }));
  const view = (sp.view === "month" || sp.view === "crew") ? sp.view : "week";
  const anchor = sp.anchor || toCivilDate(new Date().toISOString(), tz);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Dispatch" title="Schedule" />
      <ScheduleClient
        appts={appts}
        crew={crew}
        crews={crews}
        cityOptions={cityOpts}
        tz={tz}
        view={view}
        anchor={anchor}
        filters={{ crew: sp.crew ?? "", type: sp.type ?? "", jobType: sp.jobType ?? "", city: sp.city ?? "" }}
      />
    </div>
  );
}
