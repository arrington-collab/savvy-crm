import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";

/** The calling user's notify-handle, matched against escalation `notify` lists.
 *  TEST_MODE returns TEST_ACTOR_HANDLE (default "arrington" — keeps seeded
 *  escalations surfacing in e2e/demo); real requests resolve the Clerk identity
 *  (username → email local-part → userId), since notify handles are usernames. */
export async function getActorHandle(): Promise<string> {
  if (process.env.TEST_MODE === "1") {
    return process.env.TEST_ACTOR_HANDLE ?? "arrington";
  }
  const { userId } = await auth();
  if (!userId) throw new Error("not authenticated");
  const cc = await clerkClient();
  const cu = await cc.users.getUser(userId);
  if (cu.username) return cu.username;
  const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
  if (primary?.emailAddress) return primary.emailAddress.split("@")[0];
  return userId;
}
