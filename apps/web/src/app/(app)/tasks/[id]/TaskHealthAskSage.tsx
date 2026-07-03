"use client";
import { useEffect } from "react";
import { buildTaskHealthAnswer, type TaskHealthLite } from "@savvy/core";

/**
 * Registers the get_task_health Sage citation for this task (renders nothing).
 * "Is X healthy?" is answered by citing the task's health + last check + open
 * exception, never model memory.
 */
export function TaskHealthAskSage({ detail }: { detail: TaskHealthLite }) {
  useEffect(() => {
    const qs = buildTaskHealthAnswer(detail);
    window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: qs }));
    return () => { window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: [] })); };
  }, [detail]);
  return null;
}
