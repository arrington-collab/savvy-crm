"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type FlowState = {
  signed: boolean;
  depositRequired: boolean;
  depositPaid: boolean;
  depositAmountCents: number;
  ready: boolean;
  accepted: boolean;
  jobId: string | null;
  weeks: string[];
  requestedWeek: string | null;
  statusToken: string | null;
  signingUrl: string | null;
  depositCheckoutUrl: string | null;
};

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const weekLabel = (iso: string) =>
  `Week of ${new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;

// Slice 3: yes → signed → paid → scheduled, one motion, all on this page.
// The server gates everything (acceptance fires only when signed AND deposited);
// this component just walks the homeowner through it and polls for progress.
export function AcceptFlow({
  code,
  tier,
  color,
  expired,
  requireSelection = true,
}: {
  code: string;
  tier: string | null;
  color: string | null;
  expired: boolean;
  /** Retail requires a tier+color pick; the insurance variant accepts the claim-aligned scope as-is. */
  requireSelection?: boolean;
}) {
  const [started, setStarted] = useState(false);
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/estimate/${code}/state`, { cache: "no-store" });
    if (r.ok) setFlow(await r.json());
  }, [code]);

  // Poll while mid-flow (signed/paid arrive via vendor webhooks).
  useEffect(() => {
    if (!started) return;
    // First poll deferred a tick — effects must not set state synchronously.
    const kickoff = setTimeout(() => void refresh(), 0);
    pollRef.current = setInterval(() => void refresh(), 4000);
    return () => {
      clearTimeout(kickoff);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [started, refresh]);

  // Resume a flow already in progress (reload mid-accept).
  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/estimate/${code}/state`, { cache: "no-store" });
      if (!r.ok) return;
      const s: FlowState = await r.json();
      if (s.signed || s.depositPaid || s.accepted) {
        setFlow(s);
        setStarted(true);
      }
    })();
  }, [code]);

  async function begin() {
    setPending(true);
    setError(null);
    try {
      const r = await fetch(`/api/estimate/${code}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, color }),
      });
      const data = await r.json();
      if (!data.ok) {
        setError(data.error === "expired" ? "expired" : "failed");
        return;
      }
      setSigningUrl(data.signingUrl);
      setCheckoutUrl(data.deposit?.checkoutUrl ?? null);
      setStarted(true);
    } finally {
      setPending(false);
    }
  }

  async function pickWeek(weekStart: string) {
    setPending(true);
    try {
      const r = await fetch(`/api/estimate/${code}/install-week`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekStart }),
      });
      if (r.ok) await refresh();
    } finally {
      setPending(false);
    }
  }

  if (expired || error === "expired") {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" data-testid="renewal-prompt">
        <p className="font-medium">This estimate has expired — we&apos;ve let your project manager know.</p>
        <p className="mt-1 text-stone-600">
          Prices move with material costs, so we&apos;ll refresh it at current pricing and send you a new link.
          Nothing to do on your end.
        </p>
      </div>
    );
  }

  // ── Step 0: the CTA ────────────────────────────────────────────────────────
  if (!started) {
    return (
      <div className="space-y-2">
        <button
          data-testid="accept-cta"
          disabled={(requireSelection && (!tier || !color)) || pending}
          onClick={() => void begin()}
          className={`w-full rounded-xl py-3 font-semibold ${
            !requireSelection || (tier && color) ? "bg-stone-900 text-white" : "bg-stone-200 text-stone-400"
          }`}
        >
          {pending ? "One sec…" : "Accept & schedule"}
        </button>
        {requireSelection && (!tier || !color) && (
          <p className="text-center text-xs text-stone-400">Pick an option and a color above to continue.</p>
        )}
        {error && <p className="text-center text-sm text-amber-700">Something hiccuped — try again.</p>}
      </div>
    );
  }

  const signed = flow?.signed ?? false;
  const depositRequired = flow?.depositRequired ?? true;
  const depositPaid = flow?.depositPaid ?? false;
  const accepted = (flow?.accepted ?? false) && flow?.jobId != null;

  // ── Step 3: confirmation ──────────────────────────────────────────────────
  if (accepted && flow) {
    return (
      <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5" data-testid="accept-confirmation">
        <p className="text-lg font-semibold text-emerald-900">You&apos;re on the schedule 🎉</p>
        {flow.requestedWeek ? (
          <p className="text-sm text-emerald-900" data-testid="week-confirmed">
            Requested install: <span className="font-medium">{weekLabel(flow.requestedWeek)}</span> — we&apos;ll
            confirm the exact day with you.
          </p>
        ) : (
          <div className="space-y-2" data-testid="week-picker">
            <p className="text-sm font-medium text-emerald-900">Pick the week that works best:</p>
            <div className="flex flex-wrap gap-2">
              {flow.weeks.map((w) => (
                <button
                  key={w}
                  data-testid={`week-${w}`}
                  disabled={pending}
                  onClick={() => void pickWeek(w)}
                  className="rounded-full border border-emerald-300 bg-white px-3 py-1.5 text-sm"
                >
                  {weekLabel(w)}
                </button>
              ))}
            </div>
          </div>
        )}
        <ol className="space-y-1 text-sm text-emerald-900">
          <li>✓ Signed &amp; deposit received</li>
          <li>→ We order materials and confirm your install day</li>
          <li>→ Crew arrives, tear-off to cleanup usually one day</li>
          <li>→ Final walkthrough together</li>
        </ol>
        {flow.statusToken && (
          <a
            href={`/status/${flow.statusToken}`}
            className="inline-block text-sm font-medium text-emerald-800 underline"
            data-testid="status-link"
          >
            Track your project anytime →
          </a>
        )}
      </div>
    );
  }

  // ── Steps 1–2: sign, then deposit ─────────────────────────────────────────
  return (
    <div className="space-y-3 rounded-xl border border-stone-200 p-4" data-testid="accept-steps">
      <div className="flex items-center gap-3" data-testid="step-sign" data-done={signed}>
        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${signed ? "bg-emerald-500 text-white" : "bg-stone-200"}`}>
          {signed ? "✓" : "1"}
        </span>
        <div className="flex-1">
          <p className="text-sm font-medium">Review &amp; sign</p>
          {!signed && (signingUrl ?? flow?.signingUrl) && (
            <a href={(signingUrl ?? flow?.signingUrl)!} target="_blank" rel="noreferrer" className="text-sm text-stone-600 underline" data-testid="sign-link">
              Open the agreement →
            </a>
          )}
          {signed && <p className="text-xs text-stone-500">Signed — thank you!</p>}
        </div>
      </div>

      {depositRequired && (
        <div className="flex items-center gap-3" data-testid="step-deposit" data-done={depositPaid}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${depositPaid ? "bg-emerald-500 text-white" : "bg-stone-200"}`}>
            {depositPaid ? "✓" : "2"}
          </span>
          <div className="flex-1">
            <p className="text-sm font-medium">
              Deposit{flow?.depositAmountCents ? ` — ${usd(flow.depositAmountCents)}` : ""}
            </p>
            {!depositPaid && (checkoutUrl ?? flow?.depositCheckoutUrl) && (
              <a
                href={(checkoutUrl ?? flow?.depositCheckoutUrl)!}
                className="text-sm text-stone-600 underline"
                data-testid="deposit-link"
              >
                Pay securely →
              </a>
            )}
            {signed && !depositPaid && (
              <p className="text-xs text-stone-500" data-testid="signed-unpaid">
                Your signature is saved — the deposit finishes the booking. This link stays live if you need to come back.
              </p>
            )}
            {depositPaid && <p className="text-xs text-stone-500">Received — thank you!</p>}
          </div>
        </div>
      )}

      <p className="text-xs text-stone-400">Waiting on {!signed ? "your signature" : "the deposit"}… this page updates automatically.</p>
    </div>
  );
}
