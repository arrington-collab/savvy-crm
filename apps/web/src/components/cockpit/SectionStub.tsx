import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

// Interim landing for an Operator Console section whose full screen lands in a
// later cell-5 slice. It keeps the 5-item nav functional + deployable today by
// linking to the existing sub-pages the section absorbs. The later slice
// replaces this page's body with the real board/grid; these sub-pages live on.
export function SectionStub({
  eyebrow, title, blurb, links, upcoming,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
  links: { href: string; label: string; desc: string }[];
  upcoming: string;
}) {
  return (
    <div className="space-y-5" data-testid="section-stub">
      <PageHeader eyebrow={eyebrow} title={title} />
      <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>{blurb}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link key={l.href} href={l.href} data-testid="section-link">
            <Card className="h-full p-3.5 transition-colors hover:border-[var(--accent-040)]">
              <div className="font-semibold">{l.label}</div>
              <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>{l.desc}</p>
            </Card>
          </Link>
        ))}
      </div>
      <p className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{upcoming}</p>
    </div>
  );
}
