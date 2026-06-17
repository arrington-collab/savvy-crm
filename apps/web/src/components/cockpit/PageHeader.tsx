import type { ReactNode } from "react";

/** Standard cockpit page header: mono eyebrow + Geist title (+ optional right slot). */
export function PageHeader({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {right ? <div>{right}</div> : null}
    </div>
  );
}
