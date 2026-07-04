import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { getLibraryData } from "@/lib/library-queries";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

export default async function LibraryPage() {
  const lib = await getLibraryData();

  const cards = [
    {
      href: "/command-center", title: "Task Registry", meta: `${lib.taskCount} tasks · the scoreboard's source`,
      body: "Each task: trigger, owning agent, verification tier, evidence query, mode (auto/assisted/manual). The Coverage Map shows where each stands.",
    },
    {
      href: "/settings", title: "Policies", meta: "approval limits · collections ladder",
      body: "Approval limit, collections ladder (30d auto → 60d owner call → 75d lien), appended-email = transactional-only, attempt caps & backoff windows.",
    },
    {
      href: "/settings", title: "Claims Playbooks", meta: "per-peril · per-tenant",
      body: "Front-Range hail vs wind + monsoon hail — different carrier mix, code items and deadlines. SCOUT executes whichever the tenant + storm event selects.",
    },
    {
      href: "/settings/price-book", title: "Price Book", meta: `${lib.priceBookCount} items · margin floors`,
      body: "Line items, assemblies, margin floors. VERA prices from it; the nightly invariant proves every invoice still matches it.",
    },
    {
      href: "/comms", title: "Comms Templates & Drips", meta: "templates · drips · tone rubric",
      body: "SMS/email templates, drip definitions (2/5/10d), the tone rubric NOVA is audited against, short-link domain config.",
    },
    {
      href: "/settings", title: "Tenant Settings", meta: lib.tenantName,
      body: `Timezone ${lib.timezone} — drives crons, customer-facing times, business hours. Telephony numbers, team & crew, CompanyCam / QuickBooks connections.`,
    },
  ];

  return (
    <div className="space-y-5" data-testid="library-page">
      <PageHeader eyebrow="Library · Source code of the business" title="Library" />
      <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
        Everything the agents read from — policies, playbooks, the price book, templates and tenant settings.
        <b style={{ color: "var(--accent-gold)", fontWeight: 500 }}> Change a policy here, change behavior everywhere.</b>
      </p>

      <div className="grid gap-3 sm:grid-cols-2" data-testid="library-grid">
        {cards.map((c) => (
          <Link key={c.title} href={c.href} data-testid="library-card">
            <Card className="h-full p-4 transition-colors hover:border-[var(--accent-040)]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{c.title}</span>
                <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>{c.meta}</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>{c.body}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
