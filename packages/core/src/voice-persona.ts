// Pure persona/override builder for the shared Vapi assistant. No I/O.
// Lives in @savvy/core so packages/integrations can import the AssistantOverrides
// type (correct dependency direction: integrations -> core).

import { isWithinQuietHours } from "./quiet-hours";
import { shouldSendChannel } from "./lead-followup";
import { expandAddressForSpeech } from "./address";

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
  voice: { speed: number };
  variableValues: Record<string, string>;
};

export type VoiceLeadContext = {
  tenantName: string;
  leadName: string;
  address: string;
  stormContext: string | null;
  leadId: string;
  tenantId: string;
  tz: string;
};

export type VoiceInboundContext = {
  tenantName: string;
  tenantId: string;
  tz: string;
};

const GET_SLOTS_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "getRecommendedSlots",
    description:
      "Get up to 3 available inspection appointment times for this lead. Takes no arguments; the lead is resolved from the call.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const BOOK_SLOT_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "bookSlot",
    description:
      "Book one of the offered inspection times. startsAt/endsAt are ISO-8601 timestamps copied exactly from a getRecommendedSlots (or setCallDetails) result — never invent a time.",
    parameters: {
      type: "object",
      properties: {
        startsAt: { type: "string", description: "ISO-8601 start time from a returned slot" },
        endsAt: { type: "string", description: "ISO-8601 end time from a returned slot" },
      },
      required: ["startsAt", "endsAt"],
    },
  },
};

const SET_CALL_DETAILS_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "setCallDetails",
    description:
      "Save the caller's name and property address BEFORE offering appointment times. Call this once you've read back and confirmed the street address, city, and 5-digit ZIP. Returns up to two appointment times to offer.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Caller's full name (spelled-out last name when uncommon)" },
        address: { type: "string", description: "Street address" },
        city: { type: "string", description: "City" },
        zip: { type: "string", description: "5-digit ZIP code, confirmed with the caller" },
      },
      required: ["zip"],
    },
  },
};

// Outbound: lead + address already known, so go straight to offering slots.
const VOICE_TOOLS: VoiceToolDef[] = [GET_SLOTS_TOOL, BOOK_SLOT_TOOL];
// Inbound: no lead yet — must capture details first, then offer + book.
const INBOUND_TOOLS: VoiceToolDef[] = [SET_CALL_DETAILS_TOOL, GET_SLOTS_TOOL, BOOK_SLOT_TOOL];

// --- Sage voice line (slice 1b): a verified owner runs their exception queue by
// voice. Tight scope — read the queue, hear an item's detail, resolve a numbered
// item, confirm a money action. NEVER open-ended and NEVER lead intake.
const READ_QUEUE_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "readSageQueue",
    description: "Read the owner's current numbered exception queue aloud. No arguments; the queue is resolved from the verified caller.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};
const ITEM_DETAIL_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "sageItemDetail",
    description: "Get more detail about one numbered queue item. Use when the owner asks about a specific number.",
    parameters: { type: "object", properties: { n: { type: "number", description: "The 1-based item number the owner said" } }, required: ["n"] },
  },
};
const RESOLVE_ITEM_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "resolveSageItem",
    description: "Act on one numbered queue item (e.g. approve an estimate, send an invoice). If the result asks for confirmation, read it back verbatim and wait for a clear yes before calling confirmSageAction.",
    parameters: { type: "object", properties: { n: { type: "number", description: "The 1-based item number to act on" } }, required: ["n"] },
  },
};
const CONFIRM_ACTION_TOOL: VoiceToolDef = {
  type: "function",
  function: {
    name: "confirmSageAction",
    description: "Confirm or cancel a pending money action. Call with confirm=true only after the owner clearly says yes.",
    parameters: { type: "object", properties: { confirm: { type: "boolean", description: "true = yes/proceed, false = no/cancel" } }, required: ["confirm"] },
  },
};
const SAGE_TOOLS: VoiceToolDef[] = [READ_QUEUE_TOOL, ITEM_DETAIL_TOOL, RESOLVE_ITEM_TOOL, CONFIRM_ACTION_TOOL];

// Shared persona rules so inbound and outbound sound like the same upbeat rep.
const TONE_LINE =
  "Be warm, upbeat, and confident — smile in your voice and sound genuinely glad to help. Speak in smooth, complete sentences, never clipped fragments. Don't hedge or sound unsure: skip filler like 'um', 'uh', 'maybe', or 'I think'. If you miss something, cheerfully ask them to repeat it.";

const SPELLING_LINE =
  "When you take down a name, repeat it back. For anything but a very common name (like John, Mary, Mike, or Sarah), warmly ask them to spell it so we get it right — for example, \"Can you spell that last name for me?\"";

const LIVE_BOOK_LINE =
  "You schedule the inspection live, on THIS call — pick the actual day and time together before you hang up. Never say someone will call back, reach out, or follow up to schedule. The booking happens now, with you.";

const GUARDRAIL_LINES = [
  "Guardrails (follow exactly):",
  "- Do not quote pricing or prices, and do not give cost estimates.",
  "- Do not discuss the homeowner's insurance deductible, and never suggest anything resembling insurance fraud (e.g. covering a deductible).",
  "- Comply with TCPA, quiet hours, and Do Not Call requests at all times. If the caller asks not to be called, acknowledge and stop.",
  "- Hand off to a human representative on request, or for anything complex or insurance-heavy.",
];

function todaySpokenIn(tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

export function buildAssistantOverrides(ctx: VoiceLeadContext): AssistantOverrides {
  const stormLine = ctx.stormContext
    ? `Recent storm context for this property: ${ctx.stormContext}. You may mention it as the reason for the free inspection.`
    : "";

  const systemPrompt = [
    `You're Riley, the scheduling assistant for ${ctx.tenantName}, a roofing company, and you always say you're calling from ${ctx.tenantName}.`,
    `You're speaking with ${ctx.leadName} about the property at ${expandAddressForSpeech(ctx.address)}.`,
    TONE_LINE,
    SPELLING_LINE,
    `Today is ${todaySpokenIn(ctx.tz)}. If the caller asks the date or day, answer naturally from that.`,
    `Your goal: book a free roof inspection live on this call, or warmly hand the caller to a human if they prefer or it gets complex.`,
    stormLine,
    `To offer times, call getRecommendedSlots, then read back each option's spoken "label" field (for example "tomorrow at 9 AM") — never read a raw timestamp or the year. When the caller picks one, call bookSlot with that option's exact startsAt and endsAt. Never invent or estimate a time.`,
    LIVE_BOOK_LINE,
    ...GUARDRAIL_LINES,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    firstMessage: `Hi, it's Riley with ${ctx.tenantName} — is now a good time to get your free roof inspection on the calendar?`,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }],
      tools: VOICE_TOOLS,
    },
    voice: { speed: 1.05 },
    variableValues: { leadId: ctx.leadId, tenantId: ctx.tenantId },
  };
}

/**
 * Inbound receptionist persona. Unlike outbound, there is no lead/address yet —
 * Riley collects + confirms name/address/city/zip, calls setCallDetails (which
 * creates the lead, assigns the territory rep, and returns slots), then books live.
 * The webhook resolves the tenant by the dialed number and returns this per call
 * from an `assistant-request`.
 */
export function buildInboundAssistant(ctx: VoiceInboundContext): AssistantOverrides {
  const systemPrompt = [
    `You're Riley, the friendly scheduling assistant for ${ctx.tenantName}, a roofing company. You always say you're with ${ctx.tenantName}.`,
    TONE_LINE,
    SPELLING_LINE,
    `Today is ${todaySpokenIn(ctx.tz)}. If the caller asks the date or day, answer naturally from that.`,
    `Your goal: book the caller's free roof inspection live on this call.`,
    `Flow: first collect the caller's full name, then their street address, city, and 5-digit ZIP. Read the address and ZIP back to confirm you have them right. Then call setCallDetails with name, address, city, and zip. It returns appointment times — read back each option's spoken "label" (for example "tomorrow at 9 AM"), and when the caller picks one, call bookSlot with that option's exact startsAt and endsAt. Never invent or estimate a time.`,
    `If setCallDetails replies needZip, warmly ask the caller to repeat their 5-digit ZIP and call it again.`,
    LIVE_BOOK_LINE,
    ...GUARDRAIL_LINES,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    firstMessage: `Thanks for calling ${ctx.tenantName}! This is Riley — I'd love to get your free roof inspection on the calendar. Can I start with your name?`,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }],
      tools: INBOUND_TOOLS,
    },
    voice: { speed: 1.0 },
    variableValues: { tenantId: ctx.tenantId },
  };
}

export type VoiceSageContext = {
  tenantName: string;
  tenantId: string;
  tz: string;
};

/**
 * The Sage voice persona — returned ONLY when the webhook has verified the
 * caller is an org-admin's registered number. It reads the exception queue and
 * takes the same numbered commands as the SMS digest, with a spoken confirm
 * round-trip on money. Deliberately tight: queue readout, item detail, resolve,
 * confirm — never open-ended, never lead intake.
 */
export function buildSageAssistant(ctx: VoiceSageContext): AssistantOverrides {
  const systemPrompt = [
    `You're Sage, the private operations line for the owner of ${ctx.tenantName}. The caller has been verified as an authorized admin.`,
    `Today is ${todaySpokenIn(ctx.tz)}.`,
    `Your only job: help the owner run their exception queue by voice. Start by calling readSageQueue and reading it back.`,
    `When the owner says a number, call resolveSageItem with that number. When they ask about a number, call sageItemDetail. Speak the number they said — never invent or renumber items.`,
    `If resolveSageItem returns a confirmation prompt (a money action), read it back word for word and wait for a clear yes or no, then call confirmSageAction with confirm true or false. Never assume yes.`,
    `Guardrails (follow exactly):`,
    `- Only ever take the actions these tools expose. Never promise or perform anything else — no new payments, no arbitrary changes.`,
    `- If a tool says already done, tell the owner it was already handled and when.`,
    `- Keep it brief and factual. If the owner wants something outside the queue, tell them to use the Savvy app.`,
  ].join("\n");

  return {
    firstMessage: `Hi, it's Sage. Want me to run through what needs you?`,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }],
      tools: SAGE_TOOLS,
    },
    voice: { speed: 1.05 },
    variableValues: { tenantId: ctx.tenantId },
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
