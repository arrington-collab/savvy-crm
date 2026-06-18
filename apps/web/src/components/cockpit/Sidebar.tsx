"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/command-center", label: "Command Center" },
  { href: "/jobs", label: "Jobs" },
  { href: "/leads", label: "Leads" },
  { href: "/comms", label: "Comms" },
  { href: "/schedule", label: "Schedule" },
  { href: "/invoices", label: "Invoices" },
  { href: "/commissions", label: "Commissions" },
  { href: "/billing", label: "Billing" },
  { href: "/settings/payments", label: "Payments" },
  { href: "/settings/quickbooks", label: "QuickBooks" },
  { href: "/settings/price-book", label: "Price Book" },
  { href: "/settings/team", label: "Team" },
];

export function Sidebar() {
  const pathname = usePathname() ?? "";
  return (
    <aside className="w-56 shrink-0 space-y-1 p-4" style={{ borderRight: "1px solid var(--border-panel)" }}>
      <div className="mb-5 flex items-center gap-2 px-2">
        <span className="text-accent-gold" style={{ fontSize: 18, lineHeight: 1 }}>✦</span>
        <span className="font-semibold tracking-tight text-accent-gold">Savvy</span>
      </div>
      {NAV.map((n) => {
        const active = pathname === n.href || pathname.startsWith(n.href + "/");
        return (
          <Link
            key={n.href}
            href={n.href}
            className={
              "mono block rounded-md px-2.5 py-1.5 text-[13px] tracking-wide transition-colors " +
              (active
                ? "border border-[var(--accent-040)] bg-[var(--accent-010)] text-[var(--text-primary)] shadow-[0_0_18px_var(--accent-016)]"
                : "border border-transparent text-[var(--text-muted)] hover:bg-[var(--accent-006)] hover:text-[var(--text-body)]")
            }
          >
            {n.label}
          </Link>
        );
      })}
    </aside>
  );
}
