import { createHmac, timingSafeEqual } from "node:crypto";
import { nangoProxy } from "./nango";

export interface CompanyCamEvent {
  type: string;
  projectId: string;
  photoId: string;
  url: string;
  capturedAt?: string;
}

export interface CompanyCamGateway {
  /** HMAC-sha256 of the raw body. Empty secret -> allow (dev/test); fail closed in prod via env. */
  verifyWebhook(rawBody: string, signature: string | null): boolean;
  parseEvent(payload: unknown): CompanyCamEvent | null;
  /** Defined for completeness (future pull-to-R2); unused in reference-by-URL. */
  getPhoto(o: { connectionId: string; photoId: string }): Promise<{ url: string }>;
}

const CC_INTEGRATION = () => process.env.NANGO_COMPANYCAM_INTEGRATION_ID ?? "companycam";

function pickUri(uris?: { uri: string; type: string }[]): string {
  if (!uris || uris.length === 0) return "";
  return uris.find((u) => u.type === "original")?.uri ?? uris[0]!.uri;
}

export const httpCompanyCam: CompanyCamGateway = {
  verifyWebhook(raw, sig) {
    const secret = process.env.COMPANYCAM_WEBHOOK_SECRET ?? "";
    if (!secret) return process.env.NODE_ENV !== "production";
    if (!sig) return false;
    const expected = createHmac("sha256", secret).update(raw).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, "hex");
    } catch {
      return false;
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  },
  parseEvent(payload) {
    const p = payload as {
      type?: string;
      event?: string;
      data?: {
        photo?: {
          id?: string | number;
          project_id?: string | number;
          uris?: { uri: string; type: string }[];
          captured_at?: string;
        };
      };
    };
    const photo = p.data?.photo;
    if (!photo?.id || !photo.project_id) return null;
    const url = pickUri(photo.uris);
    if (!url) return null;
    return {
      type: p.type ?? p.event ?? "photo",
      projectId: String(photo.project_id),
      photoId: String(photo.id),
      url,
      capturedAt: photo.captured_at,
    };
  },
  async getPhoto({ connectionId, photoId }) {
    const res = await nangoProxy({
      connectionId,
      integrationId: CC_INTEGRATION(),
      method: "GET",
      endpoint: `/v2/photos/${photoId}`,
    });
    const r = res as { uris?: { uri: string; type: string }[] };
    return { url: pickUri(r.uris) };
  },
};

export function makeFakeCompanyCam(): CompanyCamGateway & { calls: { op: string; id: string }[] } {
  const calls: { op: string; id: string }[] = [];
  return {
    calls,
    verifyWebhook() {
      return true;
    },
    parseEvent(payload) {
      const p = payload as { type?: string; projectId?: string; photoId?: string; url?: string };
      if (!p.projectId || !p.photoId || !p.url) return null;
      return { type: p.type ?? "photo.created", projectId: p.projectId, photoId: p.photoId, url: p.url };
    },
    async getPhoto({ photoId }) {
      calls.push({ op: "getPhoto", id: photoId });
      return { url: `https://fake-companycam/${photoId}.jpg` };
    },
  };
}

/** Default export: real when an API key is configured, fake otherwise (tests/dev). */
export const companyCam: CompanyCamGateway = process.env.COMPANYCAM_API_KEY ? httpCompanyCam : makeFakeCompanyCam();
