// Pure pipeline-board math (no I/O). Used by the jobs board for dollars-in-stage
// and the gross pipeline total.

/** Sums job-card estimate values (cents), treating a missing value as 0. */
export function sumCardValues(cards: ReadonlyArray<{ valueEstimate: number | null }>): number {
  return cards.reduce((sum, c) => sum + (c.valueEstimate ?? 0), 0);
}
