import type { ReactNode } from "react";
import Link from "next/link";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/jobs", label: "Jobs" },
  { href: "/leads", label: "Leads" },
  { href: "/comms", label: "Comms" },
  { href: "/schedule", label: "Schedule" },
  { href: "/billing", label: "Billing" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r p-4 space-y-1">
        <div className="font-semibold mb-4 px-2">Savvy</div>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="block rounded px-2 py-1.5 text-sm hover:bg-muted"
          >
            {n.label}
          </Link>
        ))}
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
