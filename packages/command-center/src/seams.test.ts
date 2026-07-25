import { it, expect } from "vitest";
import { MockFlashDelivery, MockFlashScheduler } from "./seams";

it("MockFlashDelivery records what it would send", async () => {
  const d = new MockFlashDelivery();
  await d.send({ headline: "hi", url: "https://x/flash/t", to: "+1555" });
  expect(d.sent).toHaveLength(1);
  expect(d.sent[0]!.headline).toBe("hi");
});

it("MockFlashScheduler stores the hour and triggerNow runs the job once", async () => {
  const s = new MockFlashScheduler();
  let ran = 0;
  s.schedule(18, async () => { ran++; });
  expect(s.hour).toBe(18);
  await s.triggerNow(async () => { ran++; });
  expect(ran).toBe(1);
});
