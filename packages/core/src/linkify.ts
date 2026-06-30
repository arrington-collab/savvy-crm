// Turn a plain-text message body (e.g. an outbound SMS) into renderable
// segments so long URLs can be shown as short, clickable links.

export interface BodySegment {
  type: "text" | "link";
  value: string;
  /** Full URL to navigate to (link segments only). */
  href?: string;
}

/** Strip the protocol and truncate an over-long URL for display. */
export function shortenUrl(url: string, maxLength = 32): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > maxLength ? `${bare.slice(0, maxLength)}…` : bare;
}

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Split a body into text + link segments. Each link segment carries the full
 * `href` plus a shortened display `value`. Bodies with no URL collapse to one
 * text segment.
 */
export function linkifyBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(URL_RE)) {
    const url = m[0];
    const i = m.index ?? 0;
    if (i > last) segments.push({ type: "text", value: body.slice(last, i) });
    segments.push({ type: "link", value: shortenUrl(url), href: url });
    last = i + url.length;
  }
  if (last < body.length) segments.push({ type: "text", value: body.slice(last) });
  if (segments.length === 0) segments.push({ type: "text", value: body });
  return segments;
}
