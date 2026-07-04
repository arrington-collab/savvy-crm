import { SectionStub } from "@/components/cockpit/SectionStub";

// Interim landing — the headless money screen (KPIs + proof-of-correctness) lands in cell-5 slice 3.
export default function MoneyPage() {
  return (
    <SectionStub
      eyebrow="Money · Headless"
      title="Money"
      blurb="Agents calculate; invariants and reconciliation prove it. You see summaries and evidence — detail only when a check fails."
      links={[
        { href: "/invoices", label: "Invoices", desc: "Invoice list and detail." },
        { href: "/commissions", label: "Commissions", desc: "Accrued rep commissions." },
        { href: "/billing", label: "Billing", desc: "Your Savvy subscription and usage." },
        { href: "/settings/quickbooks", label: "QuickBooks", desc: "Accounting sync and reconciliation." },
      ]}
      upcoming="Full KPI grid, AR-aging ladder and nightly proof-of-correctness panel land in an upcoming slice."
    />
  );
}
