"use client";
import { useRef } from "react";

function sessionId(): string {
  let s = window.sessionStorage.getItem("est-session");
  if (!s) {
    s = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.sessionStorage.setItem("est-session", s);
  }
  return s;
}

// Slice 5b: the human touch above the numbers — the rep's post-inspection
// note, or the owner's day-after word (featured when the SMS link lands with
// ?v=1). Watch telemetry feeds the personalized-vs-generic close-rate split.
export function VideoSlot({
  code,
  documentId,
  title,
  featured,
}: {
  code: string;
  documentId: string;
  title: string;
  featured: boolean;
}) {
  const tracked = useRef(false);
  return (
    <section className={`space-y-2 ${featured ? "rounded-xl border-2 border-emerald-200 p-3" : ""}`} data-testid="estimate-video">
      <h2 className="text-lg font-semibold">{title}</h2>
      <video
        controls
        playsInline
        preload="metadata"
        src={`/api/estimate/${code}/video/${documentId}`}
        className="w-full rounded-xl"
        onPlay={() => {
          if (tracked.current) return;
          tracked.current = true;
          void fetch(`/api/estimate/${code}/telemetry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "video_watch", sessionId: sessionId(), meta: { documentId } }),
            keepalive: true,
          }).catch(() => {});
        }}
      />
    </section>
  );
}
