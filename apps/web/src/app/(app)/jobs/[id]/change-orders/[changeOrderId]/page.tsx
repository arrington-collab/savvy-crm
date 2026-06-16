import { notFound } from "next/navigation";
import { getChangeOrder } from "@/lib/change-order-queries";
import { ChangeOrderEditor } from "./ChangeOrderEditor";

export default async function ChangeOrderPage({ params }: { params: Promise<{ id: string; changeOrderId: string }> }) {
  const { id, changeOrderId } = await params;
  const co = await getChangeOrder(changeOrderId);
  if (!co) notFound();
  return (
    <div className="mx-auto max-w-3xl p-6">
      <ChangeOrderEditor changeOrder={co} jobId={id} />
    </div>
  );
}
