"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function NewCallButton() {
  return (
    <Link href="/leads/quick">
      <Button data-testid="new-call">📞 New Call</Button>
    </Link>
  );
}
