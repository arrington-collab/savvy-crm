// Estimate Experience slice 5: page Q&A. NOVA answers grounded ONLY in this
// estimate's scope, tiers, warranty, and validity — below confidence it hands
// off to the rep (60s-race-style SMS) instead of inventing. Every exchange is
// logged on the estimate: the objection data feeds the close-rate loop.

import {
  withTenant,
  eq,
  estimate,
  lead,
  user,
  tierProduct,
  recordEstimateEvent,
  listEstimateEvents,
  recordAgentRun,
  ensureEstimateLink,
  type EstimateEventKind,
} from "@savvy/db";
import { completeObject } from "@savvy/ai";
import type { Capability } from "@savvy/ai";
import { z, type TierEstimate, type EstimateLineItem } from "@savvy/core";
import { getTenantSms } from "./telephony";

const answerSchema = z.object({
  answer: z.string().max(600),
  // The model's own honesty rating: how completely the supplied context covers
  // the question. Anything below the threshold escalates to a human.
  confidence: z.number().min(0).max(1),
});
type AnswerOutput = z.infer<typeof answerSchema>;

type Deps = {
  ai: {
    completeObject: (o: {
      capability: Capability;
      schema: z.ZodType<AnswerOutput>;
      system?: string;
      prompt: string;
    }) => Promise<{ object: AnswerOutput; model: string }>;
  };
  getTenantSms: typeof getTenantSms;
};
const defaultDeps: Deps = { ai: { completeObject }, getTenantSms };

const CONFIDENCE_FLOOR = 0.6;
const SESSION_QUESTION_CAP = 5;
const ESCALATION_COPY =
  "Great question — that one deserves a real answer, so I'm looping in your project manager. They'll text you shortly.";

export async function answerEstimateQuestion(
  input: { tenantId: string; estimateId: string; sessionId: string; question: string },
  deps: Deps = defaultDeps,
): Promise<{ answer: string; escalated: boolean; rateLimited?: boolean }> {
  const { tenantId, estimateId, sessionId } = input;
  const question = input.question.slice(0, 500);

  // Rate limit per browsing session — a QA box, not a chatbot.
  const events = await listEstimateEvents(tenantId, estimateId);
  const asked = events.filter(
    (e) => (e.kind === "question" || e.kind === "question_escalated") && e.sessionId === sessionId,
  ).length;
  if (asked >= SESSION_QUESTION_CAP) {
    return {
      answer: "You've got a lot of good questions — easier to just talk! Your project manager will reach out.",
      escalated: false,
      rateLimited: true,
    };
  }

  // Grounding context: THIS estimate only.
  const ctx = await withTenant(tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
    if (!est) return null;
    const products = await tx.select().from(tierProduct).where(eq(tierProduct.active, true));
    return { est, products };
  });
  if (!ctx) return { answer: ESCALATION_COPY, escalated: true };

  const tiers = (ctx.est.tiers ?? []) as unknown as TierEstimate[];
  const grounding = {
    lineItems: ((ctx.est.lineItems ?? []) as EstimateLineItem[]).map((l) => ({ name: l.name, quantity: l.quantity, unit: l.unit })),
    tiers: tiers.map((t) => ({ tier: t.tier, product: t.productName, manufacturer: t.manufacturer, totalCents: t.subtotalCents, warranty: t.warrantyText, recommended: t.recommended })),
    colors: Object.fromEntries(ctx.products.map((p) => [p.tier, (p.colorPalette ?? []).map((c) => c.name)])),
    validityDays: 30,
    selectedTier: ctx.est.selectedTier,
    notes: "Deposit is collected at acceptance; install week is chosen after acceptance.",
  };

  let out: AnswerOutput;
  try {
    ({ object: out } = await deps.ai.completeObject({
      capability: "reason",
      schema: answerSchema,
      system:
        "You answer a homeowner's question about THEIR roof estimate using ONLY the supplied context. " +
        "Plain, warm, 1-3 sentences, no hype. If the context does not cover the question (other trades, " +
        "scheduling specifics, discounts, anything not present), set confidence low and leave the answer brief — " +
        "NEVER invent scope, prices, or promises.",
      prompt: `Question: "${question}"\nEstimate context: ${JSON.stringify(grounding)}`,
    }));
  } catch {
    out = { answer: "", confidence: 0 };
  }

  if (out.confidence < CONFIDENCE_FLOOR || !out.answer.trim()) {
    // Escalate: race-style rep notify with the actual question.
    try {
      const rep = await withTenant(tenantId, async (tx) => {
        if (!ctx.est.leadId) return null;
        const [l] = await tx.select({ assignedUserId: lead.assignedUserId }).from(lead).where(eq(lead.id, ctx.est.leadId));
        if (!l?.assignedUserId) return null;
        const [u] = await tx.select({ phone: user.phone }).from(user).where(eq(user.id, l.assignedUserId));
        return u ?? null;
      });
      if (rep?.phone) {
        const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
        const { code } = await ensureEstimateLink({ tenantId, estimateId });
        const { sender, from } = await deps.getTenantSms(tenantId);
        await sender.sendSms({
          to: rep.phone,
          from,
          body: `Estimate page question needs you: "${question}" — ${base}/estimate/${code}`,
        });
      }
    } catch {
      /* fail-soft: the homeowner still gets the handoff copy */
    }
    await recordEstimateEvent({
      tenantId,
      estimateId,
      kind: "question_escalated" as EstimateEventKind,
      sessionId,
      meta: { question, confidence: out.confidence },
    });
    await recordAgentRun({ tenantId, agent: "comms", taskKey: "estimate.qa-escalate", status: "ok", jobId: null });
    return { answer: ESCALATION_COPY, escalated: true };
  }

  await recordEstimateEvent({
    tenantId,
    estimateId,
    kind: "question" as EstimateEventKind,
    sessionId,
    meta: { question, answer: out.answer, confidence: out.confidence },
  });
  await recordAgentRun({ tenantId, agent: "comms", taskKey: "estimate.qa-answer", status: "ok", jobId: null });
  return { answer: out.answer, escalated: false };
}
