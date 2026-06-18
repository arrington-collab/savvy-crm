import Link from "next/link";
import { PageHeader } from "@/components/cockpit/PageHeader";

const SECTIONS: { href: string; label: string; desc: string }[] = [
  { href: "/settings/team", label: "Team", desc: "Invite teammates, manage roles, add crew." },
  { href: "/settings/payments", label: "Payments", desc: "Connect Stripe to collect payments." },
  { href: "/settings/quickbooks", label: "QuickBooks", desc: "Sync invoices and payments." },
  { href: "/settings/crew", label: "Crew & CompanyCam", desc: "Crew PINs and CompanyCam photo sync." },
  { href: "/settings/scheduling", label: "Scheduling", desc: "Business hours and appointment defaults." },
  { href: "/settings/price-book", label: "Price Book", desc: "Estimate line items and pricing rules." },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Configuration" title="Settings" />
      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-lg border border-border p-4 transition-colors hover:bg-muted"
          >
            <div className="font-semibold">{s.label}</div>
            <div className="mt-1 text-sm text-muted-foreground">{s.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
