import Link from "next/link";
import { PageHeader } from "@/components/cockpit/PageHeader";

const SECTIONS: { href: string; label: string; desc: string }[] = [
  { href: "/settings/profile", label: "Your profile", desc: "Set your mobile number for instant new-lead text alerts." },
  { href: "/settings/team", label: "Team", desc: "Invite teammates, manage roles, add crew." },
  { href: "/settings/payments", label: "Payments", desc: "Connect Stripe to collect payments." },
  { href: "/settings/quickbooks", label: "QuickBooks", desc: "Sync invoices and payments." },
  { href: "/settings/crew", label: "Crew & CompanyCam", desc: "Crew PINs and CompanyCam photo sync." },
  { href: "/settings/crews", label: "Install crews", desc: "Define crews and assign members for installs." },
  { href: "/settings/scheduling", label: "Scheduling", desc: "Business hours and appointment defaults." },
  { href: "/settings/price-book", label: "Price Book", desc: "Estimate line items and pricing rules." },
  { href: "/settings/assignment", label: "Lead Assignment", desc: "Auto-route new leads to reps by round-robin, load, territory, or score." },
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
