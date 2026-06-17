import type { ReactNode } from "react";
import { Sidebar } from "@/components/cockpit/Sidebar";
import { TopBar } from "@/components/cockpit/TopBar";
import { AskSage } from "@/components/cockpit/AskSage";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <AskSage />
    </div>
  );
}
