import { SectionStub } from "@/components/cockpit/SectionStub";

// Interim landing — the merged lead→paid board lands in cell-5 slice 2.
export default function PipelinePage() {
  return (
    <SectionStub
      eyebrow="Pipeline · Lead → Paid"
      title="Pipeline"
      blurb="One continuum — a lead and a job are stages of the same thing, not separate modules. Agents move the cards; you act on them from Today."
      links={[
        { href: "/jobs", label: "Jobs", desc: "The job board across production stages." },
        { href: "/leads", label: "Leads", desc: "Inbound and enriched leads before they become jobs." },
      ]}
      upcoming="Full lead→paid board with waiting-on lines and filter chips lands in the next slice."
    />
  );
}
