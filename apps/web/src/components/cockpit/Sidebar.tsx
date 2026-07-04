"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Operator Console: 13 legacy items collapse into 5 sections. Each old route
// 301-redirects to its new home (see the section pages + redirects). Pipeline,
// Money, Agents and Library are the destinations; lead/job/invoice/etc. pages
// live on as sub-views reachable from their section.
const NAV: { href: string; label: string; home?: boolean }[] = [
  { href: "/today", label: "Today", home: true },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/money", label: "Money" },
  { href: "/agents", label: "Agents" },
  { href: "/library", label: "Library" },
];

export function Sidebar({ decisionCount = 0 }: { decisionCount?: number }) {
  const pathname = usePathname() ?? "";
  return (
    <aside className="flex w-56 shrink-0 flex-col p-4" style={{ borderRight: "1px solid var(--border-panel)" }} data-testid="sidebar">
      <div className="mb-5 flex items-center gap-2 px-2">
        <span className="text-accent-gold" style={{ fontSize: 18, lineHeight: 1 }}>✦</span>
        <span className="font-semibold tracking-tight text-accent-gold">Savvy</span>
      </div>
      <nav className="space-y-1">
        {NAV.map((n) => {
          const active = pathname === n.href || pathname.startsWith(n.href + "/");
          return (
            <Link
              key={n.href}
              href={n.href}
              data-testid={`nav-${n.label.toLowerCase()}`}
              aria-current={active ? "page" : undefined}
              className={
                "mono flex items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] tracking-wide transition-colors " +
                (active
                  ? "border border-[var(--accent-040)] bg-[var(--accent-010)] text-[var(--text-primary)] shadow-[0_0_18px_var(--accent-016)]"
                  : "border border-transparent text-[var(--text-muted)] hover:bg-[var(--accent-006)] hover:text-[var(--text-body)]")
              }
            >
              <span>{n.label}</span>
              {n.home && decisionCount > 0 ? (
                <span
                  className="mono rounded-full px-1.5 text-[10px]"
                  style={{ background: "var(--accent-020, rgba(216,168,95,0.2))", color: "var(--accent-gold)" }}
                  data-testid="nav-decision-count"
                >
                  {decisionCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 border-t pt-3" style={{ borderColor: "var(--border-panel)" }}>
        <div className="eyebrow" style={{ fontSize: "0.5rem" }}>Collapsed from 13 items</div>
        <p className="mono mt-1.5 text-[10px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
          Pipeline ← Jobs + Leads<br />
          Money ← Invoices · Payments · Billing · Commissions · QuickBooks<br />
          Agents ← Command Center + Comms<br />
          Library ← Price Book · Team · Schedule · Settings
        </p>
      </div>
    </aside>
  );
}
