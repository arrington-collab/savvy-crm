import { redirect } from "next/navigation";
import { getViewerUserId } from "@/lib/viewer";
import { LandingPage } from "@/components/landing/LandingPage";

export const dynamic = "force-dynamic";

export default async function Home() {
  const userId = await getViewerUserId(); // null in TEST_MODE → landing renders (e2e-testable)
  if (userId) redirect("/dashboard");
  return <LandingPage />;
}
