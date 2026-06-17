import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

const SECTIONS = [
  { href: "/comms/templates", title: "Templates", desc: "SMS + email message templates" },
  { href: "/comms/drips", title: "Drips", desc: "Timed nurture sequences" },
  { href: "/comms/enrollments", title: "Enrollments", desc: "Who's in which drip" },
];

export default function CommsPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Messaging" title="Comms" />
      <div className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="p-4 hover:bg-muted">
              <div className="font-medium">{s.title}</div>
              <div className="text-sm text-muted-foreground">{s.desc}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
