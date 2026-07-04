import { createStatusLink, createBookingLink } from "@savvy/db";

const appBase = (): string => process.env.APP_BASE_URL ?? "http://localhost:3000";

/**
 * Mint a short `/b/{code}` link for an already-signed token, so comms bodies stay
 * under the comms.body_quality 33-char URL limit (raw signed tokens are ~124 chars).
 * kind "status" → resolves to /status/{token}; "booking" → /book/{token} (see the /b route).
 */
export async function buildShortLink(input: {
  tenantId: string;
  token: string;
  kind: "status" | "booking";
}): Promise<string> {
  const code =
    input.kind === "status"
      ? await createStatusLink({ tenantId: input.tenantId, token: input.token })
      : await createBookingLink({ tenantId: input.tenantId, token: input.token });
  return `${appBase()}/b/${code}`;
}
