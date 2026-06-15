/**
 * Fetch a Nango connection by id and return the organization/end-user identifiers
 * that were bound when the connect session was created.
 *
 * Used server-side to verify that a caller-supplied connectionId actually belongs
 * to the current tenant before persisting it (closes cross-tenant IDOR).
 * Returns null on any Nango error — callers must FAIL CLOSED on null.
 */
export async function getNangoConnection(o: {
  connectionId: string;
  integrationId: string;
}): Promise<{ organizationId: string | null; endUserId: string | null } | null> {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const res = await fetch(
    `${host}/connection/${encodeURIComponent(o.connectionId)}?provider_config_key=${encodeURIComponent(o.integrationId)}`,
    {
      headers: { Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}` },
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    end_user?: { id?: string; organization?: { id?: string } };
    organization?: { id?: string };
  };
  // Nango may nest organization under end_user or at top level depending on API version; check both.
  const organizationId =
    data.end_user?.organization?.id ?? data.organization?.id ?? null;
  const endUserId = data.end_user?.id ?? null;
  return { organizationId, endUserId };
}

export async function nangoProxy(o: {
  connectionId: string;
  integrationId: string;
  method: string;
  endpoint: string;
  body?: unknown;
}): Promise<unknown> {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const res = await fetch(`${host}/proxy${o.endpoint}`, {
    method: o.method,
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Connection-Id": o.connectionId,
      "Provider-Config-Key": o.integrationId,
      "Content-Type": "application/json",
    },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  });
  if (!res.ok) throw new Error(`nango proxy ${o.method} ${o.endpoint} -> ${res.status}`);
  return o.method === "DELETE" ? undefined : res.json();
}
