import { NextResponse } from "next/server";
import { withTenant, acceptChallenge, setChallengeStatus, listChallenges, isCanvassRepActive } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// POST /challenge/:id?action=accept|decline|cancel
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get("action") || "accept";

  const out = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassRepActive(tx, sess.tenantId, sess.repId))) return { error: "unauthorized" as const };
    const ch = (await listChallenges(tx, sess.tenantId)).find((c) => c.id === id);
    if (!ch) return { error: "not found" as const };
    if (action === "accept") {
      const done = await acceptChallenge(tx, sess.tenantId, id, sess.repId);
      return done ? { ok: true } : { error: "not a participant" as const };
    }
    if (action === "decline") {
      // only the invited opponent can decline, and only while still pending —
      // never a bystander, the creator, or a live/settled challenge.
      const isParticipant = ch.participantIds.includes(sess.repId);
      if (!isParticipant || ch.createdByRepId === sess.repId) return { error: "forbidden" as const };
      if (ch.status !== "pending") return { error: "bad action" as const };
      await setChallengeStatus(tx, sess.tenantId, id, "declined");
      return { ok: true };
    }
    if (action === "cancel") {
      // creator withdraws their own challenge
      if (ch.createdByRepId !== sess.repId) return { error: "forbidden" as const };
      await setChallengeStatus(tx, sess.tenantId, id, "cancelled");
      return { ok: true };
    }
    return { error: "bad action" as const };
  });
  if ("error" in out) {
    const code = out.error === "forbidden" ? 403 : out.error === "unauthorized" ? 401 : out.error === "not found" ? 404 : 400;
    return reply({ error: out.error }, code);
  }
  return reply(out, 200);
}
