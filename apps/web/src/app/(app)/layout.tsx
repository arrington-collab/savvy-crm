import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/cockpit/Sidebar";
import { TopBar } from "@/components/cockpit/TopBar";
import { AskSage } from "@/components/cockpit/AskSage";
import { getCurrentUser } from "@/lib/current-user";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const authEnabled = process.env.TEST_MODE !== "1";
  if (authEnabled) {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
    await getCurrentUser(); // lazily provision tenant + this user's row
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar authEnabled={authEnabled} />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <AskSage />
    </div>
  );
}
