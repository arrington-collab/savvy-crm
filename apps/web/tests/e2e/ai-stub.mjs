// Minimal OpenAI-compatible stub for the AI gateway in e2e/CI.
// The lead.intake workflow calls generateObject (cheap-classify) expecting a
// {score, reason} object. We answer with BOTH a content JSON string and a
// tool_call, so it satisfies whichever structured-output mode the AI SDK picks.
import { createServer } from "node:http";

const PORT = Number(process.env.AI_STUB_PORT ?? 4010);
const payload = { score: 75, reason: "e2e stub: storm zone, owner-occupied" };

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
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
