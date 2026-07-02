"use client";
import { useEffect, useRef } from "react";
import { recordTaskFirstView } from "@/lib/task-actions";

/**
 * Fires the first-view write once when the owner opens a task's exception page.
 * Server Components can't write during render, so this client effect calls the
 * server action; the DB write itself is idempotent (only stamps if null).
 */
export function TaskViewTracker({ taskId }: { taskId: number }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void recordTaskFirstView(taskId);
  }, [taskId]);
  return null;
}
