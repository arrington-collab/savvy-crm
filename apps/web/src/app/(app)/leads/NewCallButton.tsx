"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Matches the sibling "+ New Lead" entry's <Link><Button> pattern in leads/page.tsx.
export function NewCallButton() {
  return (
    <Link href="/leads/quick">
      <Button data-testid="new-call">📞 New Call</Button>
    </Link>
  );
}
