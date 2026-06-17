import { listPriceBook } from "@/lib/price-book-queries";
import { PriceBookClient } from "./PriceBookClient";

export const dynamic = "force-dynamic";

export default async function PriceBookPage() {
  const items = await listPriceBook();
  return (
    <div className="space-y-6">
      <PriceBookClient items={items} />
    </div>
  );
}
