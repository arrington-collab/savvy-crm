/** Resolve a safe supplier email recipient from an inbound `from` header.
 *  Returns a valid external address, or null when the address is missing,
 *  malformed, or belongs to a self domain — in which case the guard handler
 *  falls back to drafting the credit request instead of auto-sending. */

// exactly one @, non-empty local (no whitespace), domain with at least one dot.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Savvy-owned domains that must never receive a supplier credit request. */
export const SUPPLIER_SELF_DOMAINS = ["getsavvy.com"];

/** `"ABC" <ar@abc.com>` -> `ar@abc.com`; a plain address is returned as-is. */
function extractAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim();
}

function domainOf(addr: string): string {
  return addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();
}

/** True when `domain` equals or is a subdomain of any self domain. */
function isSelfDomain(domain: string, selfDomains: string[]): boolean {
  return selfDomains.some((s) => {
    const sd = s.toLowerCase();
    return domain === sd || domain.endsWith(`.${sd}`);
  });
}

export function resolveSupplierRecipient(
  from: string | null | undefined,
  opts: { selfDomains: string[] },
): string | null {
  if (!from) return null;
  const addr = extractAddress(from);
  if (!EMAIL_RE.test(addr)) return null;
  if (isSelfDomain(domainOf(addr), opts.selfDomains)) return null;
  return addr;
}
