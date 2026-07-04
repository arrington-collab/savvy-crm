import { permanentRedirect } from "next/navigation";

// Operator Console: Dashboard is fully absorbed. Its widgets re-homed —
// velocity + rep-performance → Pipeline, crew health → the Agents roster,
// onboarding checklist → Today. The route now 308-redirects to the home.
export default function DashboardPage() {
  permanentRedirect("/today");
}
