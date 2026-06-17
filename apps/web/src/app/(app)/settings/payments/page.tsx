import { getTenantId } from "@/lib/tenant";
import { getStripeConnection } from "@/lib/stripe-connection";
import { ConnectStripeButton } from "./ConnectStripeButton";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

export default async function PaymentsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const connectedFlag = sp.connected === "1";
  const errorCode = typeof sp.error === "string" ? sp.error : undefined;

  const tenantId = await getTenantId();
  const { connected, accountId } = await getStripeConnection(tenantId);

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader eyebrow="Integration" title="Payments" />
      <p className="text-sm text-muted-foreground">
        Connect your Stripe account to collect payments from customers.
      </p>
      <ConnectStripeButton
        connected={connected}
        accountId={accountId}
        connectedFlag={connectedFlag}
        errorCode={errorCode}
      />
    </div>
  );
}
