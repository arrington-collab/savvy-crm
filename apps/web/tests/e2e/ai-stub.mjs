// Minimal OpenAI-compatible stub for the AI gateway in e2e/CI.
// The lead.intake workflow calls generateObject (cheap-classify) expecting a
// {score, reason} object. We answer with BOTH a content JSON string and a
// tool_call, so it satisfies whichever structured-output mode the AI SDK picks.
import { createServer } from "node:http";

const PORT = Number(process.env.AI_STUB_PORT ?? 4010);

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // Guard-spec sentinel: guard invoice (sku shingle-hdz, 8000 \$/unit, qty 30 → 30k overage at 7k baseline)
    const isGuardSentinel = body.includes("GUARD-SENTINEL");
    // Credit-memo sentinel: negative-total recovery invoice
    const isCreditMemoSentinel = body.includes("CREDIT-MEMO-SENTINEL");
    // The supplier-invoice parser's schema uniquely carries .
    const isSupplierInvoiceParse = body.includes("unitBilledCents") || body.includes("amountBilledCents");
    const isScopeDraft = body.includes("Scope change") || body.includes('"items"');
    const payload = isGuardSentinel
      ? {
          supplierName: "ABC Supply",
          invoiceNumber: "INV-GUARD-E2E",
          invoiceDate: "2026-07-04",
          totalCents: 240000,
          lines: [{ description: "GAF Timberline HDZ", sku: "shingle-hdz", quantity: 30, unit: "SQ", unitBilledCents: 8000, amountBilledCents: 240000 }],
          confidence: 0.95,
        }
      : isCreditMemoSentinel
      ? {
          supplierName: "ABC Supply",
          invoiceNumber: null,
          invoiceDate: "2026-07-04",
          totalCents: -30000,
          lines: [],
          confidence: 0.95,
        }
      : isSupplierInvoiceParse
      ? {
          supplierName: "ABC Supply",
          invoiceNumber: "INV-E2E-1",
          invoiceDate: "2026-07-02",
          totalCents: 234000,
          lines: [{ description: "GAF Timberline HDZ", sku: "HDZ-CHAR", quantity: 30, unit: "BD", unitBilledCents: 7800, amountBilledCents: 234000 }],
          confidence: 0.95,
        }
      : isScopeDraft
      ? { items: [{ key: "pipe-boots", quantity: 2 }], summary: "e2e stub: 2 pipe boots" }
      : { score: 75, reason: "e2e stub: storm zone, owner-occupied" };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 0,
        model: "gemini-flash",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(payload),
              tool_calls: [
                {
                  id: "call_stub",
                  type: "function",
                  function: { name: "json", arguments: JSON.stringify(payload) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});

server.listen(PORT, () => console.log(`ai-stub listening on :${PORT}`));
