import "server-only";
import { auth } from "@clerk/nextjs/server";

/** Clerk userId for the caller, or null in TEST_MODE (auth() throws there). */
export async function getViewerUserId(): Promise<string | null> {
  if (process.env.TEST_MODE === "1") return null;
  const { userId } = await auth();
  return userId ?? null;
}
