import { SectionStub } from "@/components/cockpit/SectionStub";

// Interim landing — the agent roster + audit screen lands in cell-5 slice 4.
export default function AgentsPage() {
  return (
    <SectionStub
      eyebrow="Agents · Roster & Audit"
      title="Agents"
      blurb="Who does what, and who checks them. Tasks owned, health and audit score per agent — raw run telemetry lives one click deeper."
      links={[
        { href: "/command-center", label: "Command Center", desc: "Live agent run telemetry (soon a per-agent drill-down)." },
        { href: "/comms", label: "Comms", desc: "Templates, drips and delivery config." },
      ]}
      upcoming="Full agent roster cards + audit-principle panel land in an upcoming slice."
    />
  );
}
