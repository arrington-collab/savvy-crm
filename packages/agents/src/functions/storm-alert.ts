import { adminDb, withTenant, tenant, user, canvassKnock, dossierCache, eq, and, gte } from "@savvy/db";
import { stormProof, slimStormSwaths, getEmailSender } from "@savvy/integrations";
import { inngest } from "../client";
import { clusterKnockCenters, newAlertSwaths, swathSignature, alertEmailHtml } from "../storm-alert";

// Daily 14:00 UTC (≈7am AZ / 8am MT): for each tenant with recent canvassing,
// look up verified storms at their operating centers and email owners/admins
// about anything new in the last 48 h. De-duped per (tenant, center) via
// dossier_cache kind "stormalert" — the same event never alerts twice.
export const stormAlertDaily = inngest.createFunction(
  { id: "storm-alert-daily" },
  { cron: "0 14 * * *" },
  async ({ step }) => {
    const tenants = await step.run("tenants", () =>
      adminDb.select({ id: tenant.id, name: tenant.name }).from(tenant),
    );

    let alerted = 0;
    for (const t of tenants) {
      const r = await step.run(`tenant:${t.id}`, async () => {
        const knocks = await withTenant(t.id, (tx) =>
          tx
            .select({ lat: canvassKnock.lat, lng: canvassKnock.lng })
            .from(canvassKnock)
            .where(gte(canvassKnock.createdAt, new Date(Date.now() - 30 * 86_400_000)))
            .limit(2000),
        );
        if (knocks.length < 5) return { sent: false }; // not actively canvassing

        const centers = clusterKnockCenters(knocks);
        const newEvents: { kind: string; mag: string; date: string }[] = [];

        for (const c of centers) {
          const coordKey = `${c.lat.toFixed(1)},${c.lng.toFixed(1)}`;
          const swaths = slimStormSwaths(await stormProof.lookupStormTracks({ lat: c.lat, lng: c.lng, months: 1 }).catch(() => []));
          const fresh = await withTenant(t.id, async (tx) => {
            const [hit] = await tx
              .select({ payload: dossierCache.payload })
              .from(dossierCache)
              .where(and(eq(dossierCache.kind, "stormalert"), eq(dossierCache.coordKey, coordKey)));
            const seen = ((hit?.payload as { seen?: string[] } | null)?.seen ?? []).slice(-200);
            const found = newAlertSwaths(swaths, seen);
            if (found.length) {
              const payload = { seen: [...seen, ...found.map(swathSignature)] };
              await tx
                .insert(dossierCache)
                .values({ tenantId: t.id, kind: "stormalert", coordKey, payload, fetchedAt: new Date() })
                .onConflictDoUpdate({
                  target: [dossierCache.tenantId, dossierCache.kind, dossierCache.coordKey],
                  set: { payload, fetchedAt: new Date() },
                });
            }
            return found;
          });
          for (const s of fresh) {
            newEvents.push({
              kind: s.kind,
              mag: s.kind === "hail" ? `${s.size ?? "?"}" hail` : `${s.windMph ?? "?"} mph gust`,
              date: s.date.slice(0, 10),
            });
          }
        }
        if (!newEvents.length) return { sent: false };

        const admins = await adminDb
          .select({ email: user.email })
          .from(user)
          .where(and(eq(user.tenantId, t.id), eq(user.role, "owner")));
        if (!admins.length) return { sent: false };

        const email = getEmailSender({ gmailConnectionId: null });
        for (const a of admins) {
          try {
            await email.sendEmail({
              to: a.email,
              from: process.env.EMAIL_FROM ?? "noreply@example.com",
              subject: `⛈ New verified storm near your canvassing area (${newEvents.length} event${newEvents.length > 1 ? "s" : ""})`,
              html: alertEmailHtml(t.name, newEvents),
            });
          } catch {
            // fail-soft: no email creds in dev/test
          }
        }
        return { sent: true };
      });
      if (r.sent) alerted++;
    }
    return { alerted };
  },
);
