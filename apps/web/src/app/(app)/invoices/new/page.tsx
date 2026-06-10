import { NewInvoiceForm } from "./NewInvoiceForm";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const { jobId } = await searchParams;

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-semibold">New Invoice</h1>
      <NewInvoiceForm defaultJobId={jobId ?? ""} />
    </div>
  );
}
