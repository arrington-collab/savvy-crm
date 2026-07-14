// Customer for Life slice 3: the move double-play — pure config + confidence
// math. Move signals accumulate; a single soft signal NEVER confirms a move
// (below threshold ⇒ verification card on /today). A human's word always does.

import { z } from "./schemas";

export const MOVE_SIGNAL_KINDS = ["ncoa", "returned_mail", "manual"] as const;
export type MoveSignalKind = (typeof MOVE_SIGNAL_KINDS)[number];

const SIGNAL_WEIGHTS: Record<MoveSignalKind, number> = {
  ncoa: 60,
  returned_mail: 25,
  manual: 100,
};

export const DEFAULT_MOVE_PLAY_COPY = {
  playA:
    "Hi {{firstName}} — congrats on the new place! Want us to give its roof the same eyes we kept on your last one? Your Roof Record history rides with you. Just reply here and we'll swing by, free.",
  playB:
    "This roof was installed and documented by {{companyName}}. Its full Roof Record — inspections, photos, workmanship warranty — exists and can transfer to you at no obligation. Register the transfer at {{transferLink}}.",
} as const;

const DEFAULT_TERMS =
  "The workmanship warranty transfers to the new owner of the property upon registration. Coverage terms, remaining duration, and any transfer conditions follow the original warranty agreement.";

export type MovePlayConfig = {
  enabled: boolean;
  confidenceThreshold: number;
  transferFeeCents: number;
  terms: string;
  copy: { playA: string; playB: string };
};

const schema = z.object({
  enabled: z.boolean().default(true),
  confidenceThreshold: z.number().int().min(1).max(100).default(80),
  transferFeeCents: z.number().int().min(0).default(0),
  terms: z.string().min(1).default(DEFAULT_TERMS),
  copy: z
    .object({
      playA: z.string().min(1).default(DEFAULT_MOVE_PLAY_COPY.playA),
      playB: z.string().min(1).default(DEFAULT_MOVE_PLAY_COPY.playB),
    })
    .default({}),
});

export function parseMovePlayConfig(raw: unknown): MovePlayConfig {
  return schema.parse(raw ?? {});
}

/** Signal weights sum, capped at 100. */
export function moveConfidence(signals: { kind: string }[]): number {
  const total = signals.reduce((sum, s) => sum + (SIGNAL_WEIGHTS[s.kind as MoveSignalKind] ?? 0), 0);
  return Math.min(100, total);
}

/** At/above threshold the move is real; anything else asks a human. */
export function moveVerdict(confidence: number, threshold: number): "confirm" | "verify" {
  return confidence >= threshold ? "confirm" : "verify";
}
