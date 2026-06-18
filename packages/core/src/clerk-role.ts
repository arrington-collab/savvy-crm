import type { UserRole } from "./enums";

export type ClerkMappedRole = Extract<UserRole, "owner" | "admin" | "rep">;

/** Maps a Clerk org membership to an app role. The org creator is owner; an
 *  org:admin is admin; everyone else is a rep. office/crew are app-assigned. */
export function mapClerkRole(orgRole: string | null | undefined, isCreator: boolean): ClerkMappedRole {
  if (isCreator) return "owner";
  return orgRole === "org:admin" ? "admin" : "rep";
}
