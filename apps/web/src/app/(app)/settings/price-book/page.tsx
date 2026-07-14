import { listPriceBook, getPriceBookMeta } from "@/lib/price-book-queries";
import { PriceBookClient } from "./PriceBookClient";
import {
  NeedsCostsBanner,
  TierProductsSection,
  SheetParseSection,
  DriftSection,
  VersionsSection,
} from "./TierPricingSections";

export const dynamic = "force-dynamic";

export default async function PriceBookPage() {
  const [items, meta] = await Promise.all([listPriceBook(), getPriceBookMeta()]);
  return (
    <div className="space-y-6">
      <NeedsCostsBanner needs={meta.needsCosts} />
      <TierProductsSection tiers={meta.tiers} />
      <DriftSection drift={meta.drift} />
      <SheetParseSection />
      <PriceBookClient items={items} />
      <VersionsSection versions={meta.versions} />
    </div>
  );
}
