/**
 * Pick the candidate whose name best matches free text — most shared word
 * tokens (length ≥ 3) wins. Pure + deterministic. Used to resolve a job from a
 * free-text Sage question like "did we send the Hendricks estimate?".
 */
export function matchJobByName(
  text: string,
  candidates: { jobId: string; name: string | null }[],
): { jobId: string; name: string } | null {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let best: { jobId: string; name: string; hits: number } | null = null;
  for (const c of candidates) {
    if (!c.name) continue;
    const tokens = (c.name.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3);
    const hits = tokens.filter((t) => words.has(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { jobId: c.jobId, name: c.name, hits };
  }
  return best ? { jobId: best.jobId, name: best.name } : null;
}
