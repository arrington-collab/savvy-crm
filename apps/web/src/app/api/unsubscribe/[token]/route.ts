import { NextResponse } from "next/server";
import { withTenant, adminDb, customer, eq, stopDripEnrollments } from "@savvy/db";
import { verifyUnsubToken, requireSecret } from "@savvy/core";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs";

// Public link from outbound emails: /api/unsubscribe/<signed customerId>.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const customerId = verifyUnsubToken(token, secret);
  if (!customerId) return new NextResponse("Invalid unsubscribe link", { status: 400 });

  // Resolve the tenant for this customer via the admin (RLS-bypass) connection,
  // then do the mutation tenant-scoped.
  const [c] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
  if (!c) return new NextResponse("Unknown contact", { status: 404 });

  await withTenant(c.tenantId, async (tx) => {
    await tx.update(customer).set({ emailOptOut: true }).where(eq(customer.id, customerId));
    await stopDripEnrollments(tx, { tenantId: c.tenantId, customerId, reason: "opted_out" });
  });
  await inngest.send({ name: "drip/stop", data: { tenantId: c.tenantId, customerId, reason: "opted_out" } });

  return new NextResponse("You've been unsubscribed from emails.", {
    status: 200, headers: { "content-type": "text/plain" },
  });
}
