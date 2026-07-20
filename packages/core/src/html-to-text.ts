// Flatten HTML to readable plain text. AccuLynx stores some "messages" as full
// HTML email documents (EagleView orders, supplements with <br> lists); dumping
// that markup verbatim into the comm timeline is unreadable. This strips it to
// text: block tags become line breaks, head/style/script are dropped, entities
// decode, whitespace collapses. Deliberately dependency-free (runs in the
// importer and a backfill script); not a general-purpose sanitizer.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  trade: "™", reg: "®", copy: "©", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;
  // Drop non-content elements entirely (including their text).
  s = s.replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Block-level boundaries → newline.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n");
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Normalize whitespace: nbsp → space, collapse spaces/tabs, cap blank lines.
  s = s.replace(/\u00a0/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
