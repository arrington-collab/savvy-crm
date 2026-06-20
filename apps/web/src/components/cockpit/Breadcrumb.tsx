import Link from "next/link";

export type Crumb = { label: string; href?: string };

/** Cockpit breadcrumb trail. Each segment with an href is a link; the last
 *  segment is the current page (rendered plain, never linked). */
export function Breadcrumb({ segments }: { segments: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb" className="mono mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
      {segments.map((s, i) => {
        const last = i === segments.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {s.href && !last ? (
              <Link href={s.href} className="hover:underline" style={{ color: "var(--text-faint)" }}>
                {s.label}
              </Link>
            ) : (
              <span style={{ color: last ? "var(--text-primary)" : "var(--text-faint)" }}>{s.label}</span>
            )}
            {!last ? <span aria-hidden style={{ color: "var(--text-faint)" }}>/</span> : null}
          </span>
        );
      })}
    </nav>
  );
}
