"use client";
import Link from "next/link";
import type { OnboardingSteps } from "@savvy/core";
import { dismissChecklist } from "@/lib/onboarding-actions";

const ITEMS: { key: keyof OnboardingSteps; label: string; href: string }[] = [
  { key: "band", label: "Choose your plan", href: "/onboarding" },
  { key: "team", label: "Invite a teammate", href: "/settings/team" },
  { key: "integrations", label: "Connect a tool", href: "/onboarding" },
];

export function OnboardingChecklist({ steps }: { steps: OnboardingSteps }) {
  const done = ITEMS.filter((i) => steps[i.key]).length;
  return (
    <div data-testid="onboarding-checklist" className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">Finish setting up Savvy — {done}/{ITEMS.length}</div>
        <button data-testid="checklist-dismiss" className="text-sm underline" style={{ color: "var(--text-faint)" }} onClick={() => dismissChecklist()}>
          Dismiss
        </button>
      </div>
      <ul className="space-y-2">
        {ITEMS.map((i) => (
          <li key={i.key} className="flex items-center gap-2">
            <span style={{ color: steps[i.key] ? "var(--status-ok)" : "var(--text-faint)" }}>{steps[i.key] ? "✓" : "○"}</span>
            {steps[i.key] ? <span style={{ color: "var(--text-faint)" }}>{i.label}</span> : <Link href={i.href} className="underline">{i.label}</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}
