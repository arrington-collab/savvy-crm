import { inngest } from "../client.js";

export const examplePing = inngest.createFunction(
  { id: "example-ping" },
  { event: "demo/ping" },
  async ({ event, step }) => {
    await step.run("log", async () => ({ received: event.data.msg }));
    return { ok: true };
  },
);
