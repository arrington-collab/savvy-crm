// Pure SB38 contract-template compliance model (Cell 17b). No DB access — takes
// already-fetched templates so it's unit-testable and reusable by both gate
// sites (estimate e-sign and canvass) in @savvy/agents and by the sweep
// invariant in @savvy/core. Mirrors 17a's pure license resolver.

export type ContractClause = "right_to_rescind" | "no_deductible_waiver" | "ten_day";

export type TemplateLike = { state: string; version: number; clauses: string[]; status: string };

// The only gated jurisdiction today is Colorado (SB38): a signed CO contract
// must attest a right to rescind, no waiver of the insurance deductible
// (C.R.S. § 6-22-105), and a 10-day insurer-decision window. Add states here to
// gate them; states absent from this map flow ungated.
export const REQUIRED_CLAUSES: Record<string, ContractClause[]> = {
  CO: ["right_to_rescind", "no_deductible_waiver", "ten_day"],
};

const norm = (s: string | null | undefined): string => (s ?? "").trim().toUpperCase();

export function requiredClausesFor(state: string | null | undefined): ContractClause[] {
  return REQUIRED_CLAUSES[norm(state)] ?? [];
}

export function isJurisdictionGated(state: string | null | undefined): boolean {
  return requiredClausesFor(state).length > 0;
}

export function isTemplateCompliant(template: TemplateLike, state: string): boolean {
  if (template.status !== "active") return false;
  const have = new Set(template.clauses);
  return requiredClausesFor(state).every((c) => have.has(c));
}

export function resolveCompliantTemplate<T extends TemplateLike>(templates: T[], state: string): T | null {
  const st = norm(state);
  const compliant = templates.filter((t) => norm(t.state) === st && isTemplateCompliant(t, state));
  if (compliant.length === 0) return null;
  return compliant.reduce((best, t) => (t.version > best.version ? t : best));
}

export class ContractTemplateRequiredError extends Error {
  constructor(public state: string) {
    super(`no compliant contract template for jurisdiction: ${state}`);
    this.name = "ContractTemplateRequiredError";
  }
}

/**
 * Decision helper for a gate site: returns the compliant template id to stamp,
 * or null when the jurisdiction isn't gated (no stamp, no gate). Throws
 * ContractTemplateRequiredError when the jurisdiction is gated but no compliant
 * template exists (fail-closed).
 */
export function resolveOrThrowContractTemplate<T extends TemplateLike & { id: string }>(
  templates: T[],
  state: string | null | undefined,
): string | null {
  if (!isJurisdictionGated(state)) return null;
  const match = resolveCompliantTemplate(templates, state as string);
  if (!match) throw new ContractTemplateRequiredError(norm(state));
  return match.id;
}
