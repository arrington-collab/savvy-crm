import { z } from "./schemas";

/**
 * Difference hash: takes a 9-wide × 8-tall grayscale matrix (rows of 9 values).
 * For each of the 8 rows, compare 8 adjacent column pairs (col c vs c+1): bit=1
 * if left > right. 64 bits total → 16 hex chars.
 */
export function dHash(gray9x8: number[][]): string {
  let bits = "";
  for (const row of gray9x8) {
    for (let c = 0; c < row.length - 1; c++) bits += row[c]! > row[c + 1]! ? "1" : "0";
  }
  // 64 bits → 16 hex chars
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const HEX_BITS: Record<string, number> = {};
for (let n = 0; n < 16; n++) HEX_BITS[n.toString(16)] = (n.toString(2).match(/1/g) ?? []).length;

/** Number of differing bits between two equal-length hex hash strings. */
export function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    d += (x.toString(2).match(/1/g) ?? []).length;
  }
  return d;
}

const photoQcSchema = z.object({
  enabled: z.boolean().default(true),
  dupeMaxDistance: z.number().int().min(0).max(64).default(10),
});
export type PhotoQcConfig = z.infer<typeof photoQcSchema>;
export function parsePhotoQcConfig(raw: unknown): PhotoQcConfig {
  return photoQcSchema.parse(raw ?? {});
}
