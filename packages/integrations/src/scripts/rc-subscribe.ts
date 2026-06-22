// One-time: register a RingCentral WebHook subscription so inbound SMS is pushed to
// our /api/ringcentral/inbound route. Re-runnable. RC WebHook subscriptions expire
// (~7 days / on repeated delivery failure) — re-run to renew for the pilot.
//   pnpm rc:subscribe
async function main() {
  const serverUrl = process.env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com";
  const clientId = process.env.RINGCENTRAL_CLIENT_ID ?? "";
  const clientSecret = process.env.RINGCENTRAL_CLIENT_SECRET ?? "";
  const jwt = process.env.RINGCENTRAL_JWT ?? "";
  const appBase = process.env.APP_BASE_URL;
  const verificationToken = process.env.RINGCENTRAL_WEBHOOK_TOKEN ?? "";
  if (!clientId || !clientSecret || !jwt || !appBase) throw new Error("RINGCENTRAL_* and APP_BASE_URL required");
  if (!verificationToken && process.env.NODE_ENV === "production") {
    throw new Error("RINGCENTRAL_WEBHOOK_TOKEN must be set in production — the inbound route fails closed without it, so a tokenless subscription would silently drop every message.");
  }
  if (!verificationToken) {
    console.warn("No RINGCENTRAL_WEBHOOK_TOKEN set — subscription will be unauthenticated (dev only).");
  }

  const authRes = await fetch(`${serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!authRes.ok) throw new Error(`auth failed: ${authRes.status} ${await authRes.text()}`);
  const { access_token } = (await authRes.json()) as { access_token: string };

  const subRes = await fetch(`${serverUrl}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      eventFilters: ["/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"],
      deliveryMode: {
        transportType: "WebHook",
        address: `${appBase}/api/ringcentral/inbound`,
        ...(verificationToken ? { verificationToken } : {}),
      },
      expiresIn: 604800,
    }),
  });
  const out = await subRes.text();
  if (!subRes.ok) throw new Error(`subscription failed: ${subRes.status} ${out}`);
  try {
    const sub = JSON.parse(out) as { id?: string; expirationTime?: string; expiresIn?: number };
    console.log("RingCentral subscription created:", sub.id, "expires", sub.expirationTime ?? sub.expiresIn);
  } catch {
    console.log("RingCentral subscription created (id unavailable)");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
