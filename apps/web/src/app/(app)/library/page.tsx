import { SectionStub } from "@/components/cockpit/SectionStub";

// Interim landing — the "source code of the business" card grid lands in cell-5 slice 5.
export default function LibraryPage() {
  return (
    <SectionStub
      eyebrow="Library · Source code of the business"
      title="Library"
      blurb="Everything the agents read from — policies, playbooks, price book, templates and tenant settings. Change a policy here, change behavior everywhere."
      links={[
        { href: "/tasks", label: "Task Registry", desc: "Browse the 212-task master list with status." },
        { href: "/settings/price-book", label: "Price Book", desc: "Line items, assemblies and margin floors." },
        { href: "/settings/team", label: "Team", desc: "Users, roles and crews." },
        { href: "/schedule", label: "Schedule", desc: "Scheduling config and calendar." },
        { href: "/capacity", label: "Capacity", desc: "Crew capacity and demand." },
        { href: "/settings", label: "Settings", desc: "Tenant settings, timezone and integrations." },
      ]}
      upcoming="Full versioned card grid (policies, playbooks, templates) lands in an upcoming slice."
    />
  );
}
