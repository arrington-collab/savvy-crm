"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { OnboardingSteps } from "@savvy/core";
import { completeWelcome, saveProfile } from "@/lib/onboarding-actions";
import { inviteMember } from "@/lib/team-actions";

type Band = { key: string; name: string; monthlyPriceCents: number };
const STEPS = ["Welcome", "Profile", "Invite", "Connect"] as const;
const fmtUsd = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;

export function OnboardingWizard({
  tenantName,
  steps,
  bands,
}: {
  tenantName: string;
  steps: OnboardingSteps;
  bands: Band[];
}) {
  const router = useRouter();
  // Start past Welcome if it's already done (resuming optional steps).
  const [step, setStep] = useState(steps.company ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [company, setCompany] = useState(tenantName);
  const [band, setBand] = useState(bands[0]?.key ?? "starter");
  const [tz, setTz] = useState("America/Phoenix");
  const [inviteEmail, setInviteEmail] = useState("");

  const finish = () => router.push("/dashboard");
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  async function run(fn: () => Promise<{ ok: true } | { error: string }>, after: () => void) {
    setBusy(true);
    setErr(null);
    const r = await fn();
    setBusy(false);
    if ("error" in r) setErr(r.error);
    else after();
  }

  return (
    <div data-testid="onboarding-wizard" className="space-y-6">
      <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-faint)" }}>
        {STEPS.map((s, i) => (
          <span key={s} data-testid={`wizard-step-${i}`} style={{ fontWeight: i === step ? 700 : 400, color: i === step ? "var(--accent-gold)" : undefined }}>
            {s}{i < STEPS.length - 1 ? " ›" : ""}
          </span>
        ))}
      </div>

      {err && <p data-testid="wizard-error" style={{ color: "var(--status-error)" }}>{err}</p>}

      {step === 0 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Welcome to Savvy</h1>
          <p style={{ color: "var(--text-faint)" }}>Confirm your company name to get started.</p>
          <input
            data-testid="welcome-company"
            className="w-full rounded border bg-transparent px-3 py-2"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Company name"
          />
          <button
            data-testid="welcome-continue"
            disabled={busy || !company.trim()}
            className="rounded px-4 py-2 font-semibold"
            style={{ background: "var(--accent-gold)", color: "#1a1206" }}
            onClick={() => run(() => completeWelcome(company), next)}
          >
            Continue
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Your plan & timezone</h1>
          <div className="grid grid-cols-3 gap-3">
            {bands.map((b) => (
              <button
                key={b.key}
                data-testid={`band-${b.key}`}
                onClick={() => setBand(b.key)}
                className="rounded border p-3 text-left"
                style={{ borderColor: band === b.key ? "var(--accent-gold)" : undefined }}
              >
                <div className="font-semibold">{b.name}</div>
                <div className="text-sm" style={{ color: "var(--text-faint)" }}>{fmtUsd(b.monthlyPriceCents)}/mo</div>
              </button>
            ))}
          </div>
          <input
            data-testid="profile-tz"
            className="w-full rounded border bg-transparent px-3 py-2"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="America/Phoenix"
          />
          <div className="flex gap-3">
            <button data-testid="profile-save" disabled={busy} className="rounded px-4 py-2 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}
              onClick={() => run(() => saveProfile({ revenueBand: band, timezone: tz }), next)}>Save & continue</button>
            <button data-testid="profile-skip" className="rounded px-4 py-2" onClick={next}>Skip</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Invite your team</h1>
          <input
            data-testid="invite-email"
            className="w-full rounded border bg-transparent px-3 py-2"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@company.com"
          />
          <div className="flex gap-3">
            <button data-testid="invite-send" disabled={busy || !inviteEmail.trim()} className="rounded px-4 py-2 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}
              onClick={() => run(() => inviteMember(inviteEmail, "rep"), () => setInviteEmail(""))}>Send invite</button>
            <button data-testid="invite-skip" className="rounded px-4 py-2" onClick={next}>Skip</button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Connect your tools</h1>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: "Stripe", href: "/settings/payments" },
              { name: "CompanyCam", href: "/settings/crew" },
              { name: "QuickBooks", href: "/settings/quickbooks" },
              { name: "Roofr", href: "/settings" },
            ].map((c) => (
              <Link key={c.name} data-testid={`connect-${c.name.toLowerCase()}`} href={c.href} className="rounded border p-4">
                Connect {c.name}
              </Link>
            ))}
          </div>
          <button data-testid="onboarding-finish" className="rounded px-4 py-2 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }} onClick={finish}>
            Go to dashboard
          </button>
        </section>
      )}

      <button data-testid="skip-to-dashboard" className="text-sm underline" style={{ color: "var(--text-faint)" }} onClick={finish}>
        Skip to dashboard
      </button>
    </div>
  );
}
