"use client";
import { linkifyBody } from "@savvy/core";

/**
 * Renders a communication body as text, turning any URL into a short, clickable
 * link (the long booking-token URLs would otherwise dominate the timeline).
 */
export function MessageBody({ body }: { body: string | null }) {
  if (!body) return <p style={{ color: "var(--text-body)" }}>—</p>;
  return (
    <p style={{ color: "var(--text-body)" }}>
      {linkifyBody(body).map((seg, i) =>
        seg.type === "link" ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent-gold)", textDecoration: "underline" }}
          >
            {seg.value}
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </p>
  );
}
