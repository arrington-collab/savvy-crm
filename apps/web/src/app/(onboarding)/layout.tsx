import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getCurrentUser } from "@/lib/current-user";

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  if (process.env.TEST_MODE !== "1") {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
    await getCurrentUser(); // lazily provision tenant + this user's row
  }
  return (
    <main className="min-h-screen p-6" style={{ background: "var(--surface-app)" }}>
      <div className="mx-auto max-w-2xl py-10">{children}</div>
    </main>
  );
}
