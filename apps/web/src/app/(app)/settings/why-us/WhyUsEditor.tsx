"use client";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/cockpit/PageHeader";
import type { WhyUsConfig } from "@savvy/core";
import { saveWhyUs } from "@/lib/why-us-actions";

// Slice 5: the Why Us content block — owner-editable words, rendered on the
// estimate page. Content is config, not code.
export function WhyUsEditor({ initial }: { initial: WhyUsConfig }) {
  const [story, setStory] = useState(initial.story);
  const [yearsLine, setYearsLine] = useState(initial.yearsLine);
  const [promise, setPromise] = useState(initial.workmanshipPromise);
  const [timeline, setTimeline] = useState(initial.timeline.join("\n"));
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Library" title="Why Us" />
      <Card className="p-4 space-y-3">
        <label className="block text-sm">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Your story (shows on every estimate)</span>
          <textarea value={story} onChange={(e) => setStory(e.target.value)} rows={4}
            className="mt-1 w-full rounded-md border p-2 text-sm" style={{ background: "transparent", borderColor: "var(--border-panel)", color: "var(--text-body)" }} />
        </label>
        <label className="block text-sm">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Years / local line (e.g. &ldquo;Family-run in Phoenix since 2009&rdquo;)</span>
          <input value={yearsLine} onChange={(e) => setYearsLine(e.target.value)}
            className="mt-1 w-full rounded-md border p-2 text-sm" style={{ background: "transparent", borderColor: "var(--border-panel)", color: "var(--text-body)" }} />
        </label>
        <label className="block text-sm">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Workmanship promise (rendered as a quote)</span>
          <input value={promise} onChange={(e) => setPromise(e.target.value)}
            className="mt-1 w-full rounded-md border p-2 text-sm" style={{ background: "transparent", borderColor: "var(--border-panel)", color: "var(--text-body)" }} />
        </label>
        <label className="block text-sm">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Process timeline — one step per line</span>
          <textarea value={timeline} onChange={(e) => setTimeline(e.target.value)} rows={5}
            className="mt-1 w-full rounded-md border p-2 text-sm" style={{ background: "transparent", borderColor: "var(--border-panel)", color: "var(--text-body)" }} />
        </label>
        <Button size="sm" disabled={pending}
          onClick={() => start(async () => {
            await saveWhyUs({ story, yearsLine, workmanshipPromise: promise, timeline: timeline.split("\n").map((t) => t.trim()).filter(Boolean) });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          })}>
          {pending ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </Button>
      </Card>
    </div>
  );
}
