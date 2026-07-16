"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { resolveCDecisionAction } from "@/lib/partner-actions";

export function PartnerGradeActions({ partnerId }: { partnerId: string }) {
  const [pending, startTransition] = useTransition();
  const act = (resolution: "conversation" | "slack_capacity_only" | "dismissed") =>
    startTransition(async () => { await resolveCDecisionAction(partnerId, resolution); });
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" disabled={pending} data-testid="partner-grade-conversation" onClick={() => act("conversation")}>
        I&apos;ll have the conversation
      </Button>
      <Button size="sm" variant="outline" disabled={pending} data-testid="partner-grade-slack" onClick={() => act("slack_capacity_only")}>
        Slack-capacity only
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid="partner-grade-dismiss" onClick={() => act("dismissed")}>
        Dismiss
      </Button>
    </div>
  );
}
