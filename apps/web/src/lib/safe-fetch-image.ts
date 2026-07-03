import { lookup } from "node:dns/promises";

/** True if an IPv4/IPv6 address string is loopback, private, link-local, ULA, or otherwise non-global. */
export function isBlockedIp(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 127) return true;                 // 0.0.0.0/8, loopback
    if (a === 10) return true;                             // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
    if (a === 192 && b === 168) return true;               // 192.168/16
    if (a === 169 && b === 254) return true;               // link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT 100.64/10
    if (a >= 224) return true;                             // multicast/reserved
    return false;
  }
  // IPv6 (normalize lowercase)
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;            // loopback / unspecified
  if (v6.startsWith("fe80")) return true;                  // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // ULA fc00::/7
  if (v6.startsWith("::ffff:")) {                          // IPv4-mapped
    const mapped = v6.slice(7);
    return isBlockedIp(mapped);
  }
  return false;
}

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

/** Fetch an image URL with SSRF protection: https-only, DNS-resolved host must be
 *  globally routable, redirects rejected, content-type must be image/*, size-capped. */
export async function safeFetchImage(rawUrl: string): Promise<{ bytes: Uint8Array; mime: string }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("invalid_url"); }
  if (url.protocol !== "https:") throw new Error("insecure_scheme");

  const addrs = await lookup(url.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) throw new Error("blocked_host");

  const r = await fetch(url, { redirect: "manual" });
  if (r.status >= 300 && r.status < 400) throw new Error("redirect_rejected");
  if (!r.ok) throw new Error(`fetch_${r.status}`);

  const mime = r.headers.get("content-type") ?? "";
  if (!mime.startsWith("image/")) throw new Error("not_an_image");

  const len = Number(r.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) throw new Error("too_large");

  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("too_large");
  return { bytes, mime };
}
