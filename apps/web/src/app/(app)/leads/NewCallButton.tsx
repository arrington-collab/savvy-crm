"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function NewCallButton() {
  return (
    <Button asChild data-testid="new-call">
      <Link href="/leads/quick">📞 New Call</Link>
    </Button>
  );
}
