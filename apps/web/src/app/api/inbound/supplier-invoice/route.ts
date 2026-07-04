import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { r2Storage, makeFakeStorage } from "@savvy/integrations";
import { ingestSupplierInvoice, type InboundBody } from "@/lib/supplier-invoice-ingest";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// Provider-agnostic inbound supplier-invoice email webhook. A Cloudflare Email
// Routing Worker (or Resend Inbound) POSTs the forwarded email here; the shared
// secret + tenant-token resolution + storage all live in the testable lib.
export async function POST(req: Request): Promise<NextResponse> {
  const secret = req.headers.get("x-inbound-secret") ?? "";
  let body: InboundBody;
  try { body = (await req.json()) as InboundBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }

  // R2 is a commodity we don't e2e-test (unit tests cover the pipeline with a
  // fake); under TEST_MODE the PDF store is a no-op so the route stays exercisable.
  const storage = process.env.TEST_MODE === "1" ? makeFakeStorage() : r2Storage;

  const res = await ingestSupplierInvoice(body, secret, {
    expectedSecret: process.env.INBOUND_EMAIL_SECRET ?? "",
    storage,
    emit: (e) => inngest.send({ name: "supplier-invoice/received", data: e }).then(() => undefined),
  });
  if (res.status >= 500) log.error("supplier-invoice ingest failed", { route: "/api/inbound/supplier-invoice", status: res.status });
  return NextResponse.json(res.body, { status: res.status });
}
