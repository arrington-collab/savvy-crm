import type { SageCommand } from "./types";

/**
 * Parse an inbound SMS/voice body into a Sage command. Pure + deterministic.
 * Order is deliberate: a 6-digit verification code must be recognized BEFORE
 * the bare-number action rule, or a code like "123456" would be misread as
 * "resolve exception #123456".
 */
export function parseSageCommand(body: string): SageCommand {
  const raw = body.trim();
  const upper = raw.toUpperCase();

  if (upper === "YES" || upper === "Y") return { type: "confirm", ok: true };
  if (upper === "NO" || upper === "N") return { type: "confirm", ok: false };
  if (upper === "HELP" || upper === "SAGE" || upper === "QUEUE") return { type: "help" };

  const verifyMatch = upper.match(/^VERIFY\s+(\d{6})$/);
  if (verifyMatch) return { type: "verify", code: verifyMatch[1]! };
  if (/^\d{6}$/.test(raw)) return { type: "verify", code: raw };

  const detailMatch = raw.match(/^(\d+)\?$/);
  if (detailMatch) {
    const n = Number(detailMatch[1]!);
    if (n > 0) return { type: "detail", n };
  }

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return { type: "action", n };
  }

  return { type: "freetext", text: raw };
}
