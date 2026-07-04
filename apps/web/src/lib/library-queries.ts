import "server-only";
import { adminDb, taskRegistry, count } from "@savvy/db";
import { listPriceBook } from "./price-book-queries";
import { getTenantIdentity } from "./today-queries";

export type LibraryData = {
  taskCount: number;
  priceBookCount: number;
  tenantName: string;
  timezone: string;
};

/** Light counts for the Library "source of the business" cards. */
export async function getLibraryData(): Promise<LibraryData> {
  const [reg, priceBook, identity] = await Promise.all([
    adminDb.select({ n: count() }).from(taskRegistry), // global registry
    listPriceBook(),
    getTenantIdentity(),
  ]);
  return {
    taskCount: Number(reg[0]?.n ?? 0),
    priceBookCount: priceBook.length,
    tenantName: identity.name,
    timezone: identity.timezone,
  };
}
