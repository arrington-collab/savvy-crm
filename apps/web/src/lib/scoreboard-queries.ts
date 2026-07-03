import "server-only";
import { getTenantRollup, getTaskDetail, listOpenTaskExceptions, listAutomationRoadmap } from "@savvy/db";
import { getTenantId } from "./tenant";

/** Page-facing wrapper: the active tenant's Coverage Map snapshot (null pre-first-sweep). */
export async function loadTenantRollup() {
  return getTenantRollup(await getTenantId());
}

/** The per-task proof surface for /tasks/[id] (null for an unknown task id). */
export async function loadTaskDetail(taskId: number) {
  return getTaskDetail(await getTenantId(), taskId);
}

/** Open scoreboard exceptions for the Today worklist. */
export async function loadOpenTaskExceptions() {
  return listOpenTaskExceptions(await getTenantId());
}

/** The automation priority queue: manual/assisted tasks ranked by founder-minutes. */
export async function loadAutomationRoadmap(limit = 8) {
  return listAutomationRoadmap(await getTenantId(), limit);
}
