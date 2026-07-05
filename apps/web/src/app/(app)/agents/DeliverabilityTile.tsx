import { Card } from "@/components/ui/card";
import { A2P_REGISTRATION_STEPS } from "@/lib/deliverability-copy";
import type { getDeliverabilityStatus } from "@/lib/deliverability-queries";

type DeliverabilityStatus = Awaited<ReturnType<typeof getDeliverabilityStatus>>;

interface Props {
  status: DeliverabilityStatus;
}

export function DeliverabilityTile({ status }: Props) {
  const { registered, connectionActive } = status;

  return (
    <Card className="p-4" data-testid="deliverability-tile">
      <div className="eyebrow mb-2">SMS Deliverability (10DLC)</div>

      {registered ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
              style={{ background: "var(--status-ok-010, rgba(34,197,94,0.12))", color: "var(--status-ok, #16a34a)" }}
            >
              Registered
            </span>
          </div>
          <p className="mono text-[12px]" style={{ color: "var(--text-muted)" }}>
            A2P campaign verified.{" "}
            <span style={{ color: connectionActive ? "var(--status-ok, #16a34a)" : "var(--text-faint)" }}>
              {connectionActive ? "Connection active ✓" : "Twilio connection inactive"}
            </span>
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span
              className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
              style={{ background: "var(--accent-010)", color: "var(--accent-gold)" }}
            >
              Not registered — action required
            </span>
          </div>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            SMS messages require A2P 10DLC registration to reach homeowners. Complete these steps in Twilio:
          </p>
          <ol className="mono space-y-2 text-[11px]">
            {A2P_REGISTRATION_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-2">
                <span className="shrink-0 font-semibold" style={{ color: "var(--accent-gold)" }}>{i + 1}.</span>
                <div>
                  <b style={{ color: "var(--text-body)", fontWeight: 500 }}>{step.title}</b>
                  <span style={{ color: "var(--text-muted)" }}> — {step.detail}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}
