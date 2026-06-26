type ParsedTool = { id: string; name: string; args: Record<string, unknown> };
export type ParsedVapiMessage = {
  type: string;
  metadata: Record<string, string>;
  toolCalls: ParsedTool[];
  transcript: string | null;
  recordingUrl: string | null;
  durationSeconds: number | null;
  outcomeRaw: string | null;
  toNumber: string | null;
  fromNumber: string | null;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function parseVapiMessage(body: unknown): ParsedVapiMessage {
  const message = asRecord(asRecord(body).message);
  const call = asRecord(message.call);
  const metaRaw = asRecord(call.metadata);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(metaRaw)) if (typeof v === "string") metadata[k] = v;

  const rawCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls
    : Array.isArray(message.toolCallList)
      ? message.toolCallList
      : [];
  const toolCalls: ParsedTool[] = rawCalls.map((c) => {
    const cc = asRecord(c);
    const fn = asRecord(cc.function);
    let args: Record<string, unknown>;
    if (typeof fn.arguments === "string") {
      try {
        args = asRecord(JSON.parse(fn.arguments));
      } catch {
        args = {};
      }
    } else {
      args = asRecord(fn.arguments);
    }
    return { id: String(cc.id ?? ""), name: String(fn.name ?? ""), args };
  });

  const artifact = asRecord(message.artifact);
  const analysis = asRecord(message.analysis);
  const structured = asRecord(analysis.structuredData);
  const phone = asRecord(message.phoneNumber);
  const customer = asRecord(message.customer);
  const durationRaw = message.durationSeconds ?? artifact.durationSeconds;

  return {
    type: String(message.type ?? ""),
    metadata,
    toolCalls,
    transcript: typeof artifact.transcript === "string" ? artifact.transcript : null,
    recordingUrl: typeof artifact.recordingUrl === "string" ? artifact.recordingUrl : null,
    durationSeconds: typeof durationRaw === "number" ? durationRaw : null,
    outcomeRaw: typeof structured.outcome === "string" ? structured.outcome : null,
    toNumber: typeof phone.number === "string" ? phone.number : null, // the dialed (tenant) number
    fromNumber: typeof customer.number === "string" ? customer.number : null, // the caller's number
  };
}

export function toolResult(
  toolCallId: string,
  result: unknown,
): { results: { toolCallId: string; result: unknown }[] } {
  return { results: [{ toolCallId, result }] };
}
