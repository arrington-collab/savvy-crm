import "server-only";
import { auth } from "@clerk/nextjs/server";

/**
 * True if the caller is an org admin (or in TEST_MODE e2e, which has no Clerk
 * session). Server actions are independently callable HTTP endpoints, so any
 * privileged/credential-mutating action MUST call this — never rely on the UI
 * route being admin-only.
 */
export async function isOrgAdmin(): Promise<boolean> {
  if (process.env.TEST_MODE === "1") return true;
  const { orgRole } = await auth();
  return orgRole === "org:admin";
}
