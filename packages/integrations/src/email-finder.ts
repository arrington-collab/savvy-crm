// Skip-trace email append seam. DORMANT by default: residential email-append is a
// compliance-heavy, account-gated space, so no concrete provider ships here — the
// default finder is a no-op until a real adapter + key are wired behind this same
// interface. Appended emails are transactional-only (enforced by the drip guard).

export interface EmailFinder {
  findEmail(o: { name?: string | null; phone?: string | null; address?: string | null }): Promise<string | null>;
}

/** Inert finder — always null. Wiring a provider replaces this default. */
export function makeDormantEmailFinder(): EmailFinder {
  return { async findEmail() { return null; } };
}

export function makeFakeEmailFinder(email: string | null): EmailFinder {
  return { async findEmail() { return email; } };
}

export const emailFinder: EmailFinder = makeDormantEmailFinder();
