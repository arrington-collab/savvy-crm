"use client";
import { useState } from "react";

function sessionId(): string {
  let s = window.sessionStorage.getItem("est-session");
  if (!s) {
    s = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.sessionStorage.setItem("est-session", s);
  }
  return s;
}

// Slice 5: "ask a question" — answers come grounded in this estimate only;
// anything the context can't cover goes to the project manager instead.
export function QABox({ code }: { code: string }) {
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<{ q: string; a: string; escalated: boolean }[]>([]);
  const [pending, setPending] = useState(false);

  async function ask() {
    const question = q.trim();
    if (question.length < 3 || pending) return;
    setPending(true);
    try {
      const r = await fetch(`/api/estimate/${code}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, sessionId: sessionId() }),
      });
      const data = await r.json();
      if (data.ok) {
        setThread((t) => [...t, { q: question, a: data.answer, escalated: data.escalated }]);
        setQ("");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3" data-testid="estimate-qa">
      <h2 className="text-lg font-semibold">Questions?</h2>
      {thread.map((t, i) => (
        <div key={i} className="space-y-1">
          <p className="text-sm font-medium text-stone-700">You: {t.q}</p>
          <p
            className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600"
            data-testid={t.escalated ? "qa-escalated" : "qa-answer"}
          >
            {t.a}
          </p>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask()}
          placeholder="Ask anything about this estimate…"
          className="flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm"
          data-testid="qa-input"
        />
        <button
          onClick={() => void ask()}
          disabled={pending || q.trim().length < 3}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-stone-200 disabled:text-stone-400"
          data-testid="qa-send"
        >
          {pending ? "…" : "Ask"}
        </button>
      </div>
    </section>
  );
}
