import { AUTOMATION_LEVEL, type AutomationLevel } from "./enums";

// The promotion order for a module's automation: Manual → AI-assisted → AI-auto.
// Cycling past `full` wraps back to `manual` so a single control both promotes and resets.
const CYCLE: AutomationLevel[] = ["manual", "partial", "full"];

/** Next automation level when the operator taps the promote control (wraps full → manual). */
export function nextAutomationLevel(current: AutomationLevel): AutomationLevel {
  const i = CYCLE.indexOf(current);
  return CYCLE[(i + 1) % CYCLE.length] ?? "manual";
}

/** Type guard for a raw string that should be an AutomationLevel. */
export function isAutomationLevel(v: unknown): v is AutomationLevel {
  return typeof v === "string" && (AUTOMATION_LEVEL as readonly string[]).includes(v);
}
