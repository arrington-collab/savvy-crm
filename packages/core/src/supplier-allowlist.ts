/** Opt-in per-tenant supplier recipient allow-list check.
 *  Empty list ⇒ no restriction (allow). Non-empty ⇒ the recipient's domain must
 *  be in the list (case-insensitive). All domains are compared lowercased. */
export function isRecipientAllowed(recipientEmail: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const at = recipientEmail.lastIndexOf("@");
  if (at < 0 || at === recipientEmail.length - 1) return false;
  const domain = recipientEmail.slice(at + 1).toLowerCase();
  const allowed = new Set(allowedDomains.map((d) => d.trim().toLowerCase()));
  return allowed.has(domain);
}
