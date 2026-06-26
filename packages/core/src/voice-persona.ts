// Pure persona/override builder for the shared Vapi assistant. No I/O.
// Lives in @savvy/core so packages/integrations can import the AssistantOverrides
// type (correct dependency direction: integrations -> core).

import { isWithinQuietHours } from "./quiet-hours";
import { shouldSendChannel } from "./lead-followup";

export type VoiceToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  };
};

export type AssistantOverrides = {
  firstMessage: string;
  model: {
    provider: string;
    model: string;
    messages: { role: "system"; content: string }[];
    tools: VoiceToolDef[];
  };
  variableValues: Record<string, string>;
};

export type VoiceLeadContext = {
  tenantName: string;
  leadName: string;
  address: string;
  stormContext: string | null;
  leadId: string;
  tenantId: string;
};

const VOICE_TOOLS: VoiceToolDef[] = [
  {
    type: "function",
    function: {
      name: "getRecommendedSlots",
      description:
        "Get up to 3 available inspection appointment times for this lead. Takes no arguments; the lead is resolved from the call.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "bookSlot",
      description:
        "Book one of the offered inspection times. startsAt/endsAt are ISO-8601 timestamps copied exactly from a getRecommendedSlots result — never invent a time.",
      parameters: {
        type: "object",
        properties: {
          startsAt: { type: "string", description: "ISO-8601 start time from getRecommendedSlots" },
          endsAt: { type: "string", description: "ISO-8601 end time from getRecommendedSlots" },
        },
        required: ["startsAt", "endsAt"],
      },
    },
  },
];

export function buildAssistantOverrides(ctx: VoiceLeadContext): AssistantOverrides {
  const stormLine = ctx.stormContext
    ? `Recent storm context for this property: ${ctx.stormContext}. You may mention it as the reason for the free inspection.`
    : "";

  const systemPrompt = [
    `You are the scheduling assistant for ${ctx.tenantName}, a roofing company. You always identify yourself as calling from ${ctx.tenantName}.`,
    `You are speaking with ${ctx.leadName} about the property at ${ctx.address}.`,
    `Your goal: book a free roof inspection, or warmly hand the caller to a human representative if they prefer or the conversation gets complex.`,
    stormLine,
    `To offer times, call the getRecommendedSlots tool, read back the options, and when the caller picks one call bookSlot with that exact startsAt/endsAt. Never invent or estimate an appointment time.`,
    `Guardrails (follow exactly):`,
    `- Do not quote pricing or prices, and do not give cost estimates.`,
    `- Do not discuss the homeowner's insurance deductible, and never suggest anything resembling insurance fraud (e.g. covering a deductible).`,
    `- Comply with TCPA, quiet hours, and Do Not Call requests at all times. If the caller asks not to be called, acknowledge and stop.`,
    `- Hand off to a human representative on request, or for anything complex or insurance-heavy.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    firstMessage: `Hi, this is the scheduling assistant for ${ctx.tenantName}. Is now a good time to set up your free roof inspection?`,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }],
      tools: VOICE_TOOLS,
    },
    variableValues: { leadId: ctx.leadId, tenantId: ctx.tenantId },
  };
}

export type VoiceOutcome = "booked" | "no_answer" | "callback" | "dnc" | "needs_human";

const VOICE_OUTCOMES: readonly VoiceOutcome[] = ["booked", "no_answer", "callback", "dnc", "needs_human"];

export function parseVoiceOutcome(raw: string | null | undefined): VoiceOutcome | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return (VOICE_OUTCOMES as readonly string[]).includes(v) ? (v as VoiceOutcome) : null;
}

const VOICE_OPEN_STATUSES = ["new", "contacted", "qualified", "booked"];

export type VoiceGuardInput = {
  status: string;
  firstRepContactAt: Date | null;
  phone: string | null;
  smsOptOut: boolean;
  emailOptOut: boolean;
  smsConsentAt: Date | null;
  now: Date;
  tz: string;
  quietHours: { startHour: number; endHour: number };
};

export function shouldPlaceVoiceCall(i: VoiceGuardInput): { ok: true } | { ok: false; reason: string } {
  if (!VOICE_OPEN_STATUSES.includes(i.status)) return { ok: false, reason: "closed" };
  if (i.firstRepContactAt != null) return { ok: false, reason: "contacted" };
  if (!i.phone) return { ok: false, reason: "no-phone" };
  // SMS-grade consent stands in for call consent/DNC (we have no separate voice-consent column).
  if (!shouldSendChannel("sms", { smsOptOut: i.smsOptOut, emailOptOut: i.emailOptOut, smsConsentAt: i.smsConsentAt }))
    return { ok: false, reason: "no-consent" };
  if (isWithinQuietHours(i.now, i.tz, i.quietHours)) return { ok: false, reason: "quiet-hours" };
  return { ok: true };
}
