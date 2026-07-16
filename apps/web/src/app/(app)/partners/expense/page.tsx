import { ExpenseQuickLog } from "./ExpenseQuickLog";

// Partner Ledger slice 2: the phone-friendly expense quick-log (lunches, gifts,
// sponsorships). A log, not accounting — QuickBooks stays the books. The weekly
// sum rides the owner digest; entries land in the partner's ledger for slice 3.
export default function PartnerExpensePage() {
  return (
    <div className="mx-auto max-w-md space-y-4" data-testid="partner-expense-page">
      <div>
        <div className="eyebrow">Partners</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Log a partner expense</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Lunch, gift, sponsorship — anything spent on the relationship. It lands in the partner’s ledger.
        </p>
      </div>
      <ExpenseQuickLog />
    </div>
  );
}
