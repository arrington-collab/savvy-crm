import { renderTemplate, type DripStep } from "@savvy/core";
import * as ai from "@savvy/ai";

export type DripContext = { name: string; firstName: string };

export type DraftedMessage = { body: string; aiHandled: boolean; model?: string };

/**
 * Produces the message body for a drip step. Template step -> {{var}} render;
 * AI step -> capability-gateway draft. Pure: `aiClient` is injectable for tests.
 */
export async function draftMessage(
  input: { step: DripStep; templateBody?: string; ctx: DripContext },
  aiClient: Pick<typeof ai, "complete"> = ai,
): Promise<DraftedMessage> {
  const { step, templateBody, ctx } = input;
  if (step.aiPrompt) {
    const { text, model } = await aiClient.complete({
      capability: step.aiCapability ?? "summarize",
      system: "You write short, friendly roofing-company follow-up messages. No placeholders.",
      prompt: `${step.aiPrompt}\n\nContact: ${ctx.name}. Keep it concise for ${step.channel}.`,
    });
    return { body: text, aiHandled: true, model };
  }
  const vars: Record<string, string> = { name: ctx.name, firstName: ctx.firstName };
  return { body: renderTemplate(templateBody ?? "", vars), aiHandled: false };
}
