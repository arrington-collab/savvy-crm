import { getTenantId } from "@/lib/tenant";
import { getTelephonyMode, getTelephonyConnection, getVapiConnection } from "@savvy/db";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { TelephonyCard } from "./TelephonyCard";

export const dynamic = "force-dynamic";

export default async function IntegrationsSettingsPage() {
  const tenantId = await getTenantId();
  const mode = await getTelephonyMode(tenantId);
  const twilio = await getTelephonyConnection(tenantId, "twilio");
  const vapi = await getVapiConnection(tenantId);

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader eyebrow="Integrations" title="Telephony" />
      <p className="text-sm text-muted-foreground">
        Choose whether Savvy sends calls and texts from the shared platform account, or connect your
        own Twilio account. Prefer not to set it up yourself? Ask Savvy to do it for you.
      </p>
      <TelephonyCard
        mode={mode}
        status={twilio?.status ?? null}
        fromNumber={twilio?.fromNumber ?? null}
        vapiStatus={vapi?.status ?? null}
        vapiAssistantId={vapi?.assistantId ?? null}
        vapiPhoneNumberId={vapi?.phoneNumberId ?? null}
      />
    </div>
  );
}
