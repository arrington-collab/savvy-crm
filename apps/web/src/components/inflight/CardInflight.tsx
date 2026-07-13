"use client";

import { useInflight } from "./InflightProvider";
import { TypingDots } from "./TypingDots";

export function CardInflight({ kind, id }: { kind: "job" | "lead"; id: string }) {
  const run = useInflight(kind, id);
  return run ? <TypingDots verb={run.verb} agent={run.agent} /> : null;
}
