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
