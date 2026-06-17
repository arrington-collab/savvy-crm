import { PageHeader } from "@/components/cockpit/PageHeader";
import { personaLine, PERSONAS } from "@/lib/agents";

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Funnel" title="Leads" />
      <p style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.ATLAS)}</p>
    </div>
  );
}
