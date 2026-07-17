import "server-only";
import { canApproveMoney, canManageSettings } from "@savvy/core";
import { getCurrentUser } from "./current-user";

/**
 * Phase 26 S6: gates run on the SAVVY role (user.role), not the Clerk org role
 * — the two diverge (see the S6a audit; this replaced isOrgAdmin). Server
 * actions are independently callable HTTP endpoints, so any privileged/
 * credential-mutating action MUST call these itself — never rely on the UI
 * route being scoped. TEST_MODE e2e resolves to role "owner" in getCurrentUser.
 */
export async function canApproveMoneyNow(): Promise<boolean> {
  try {
    return canApproveMoney((await getCurrentUser()).role);
  } catch {
    return false; // unauthenticated / no org context ⇒ never privileged
  }
}

export async function canManageSettingsNow(): Promise<boolean> {
  try {
    return canManageSettings((await getCurrentUser()).role);
  } catch {
    return false;
  }
}
