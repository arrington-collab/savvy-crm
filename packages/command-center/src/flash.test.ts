import { it, expect } from "vitest";
import { renderFlashHeadline, renderFlashHtml, dollars } from "./flash";
import { emptyMetrics } from "./metrics";

it("dollars formats cents to whole grouped dollars", () => {
  expect(dollars(2400000)).toBe("$24,000");
  expect(dollars(0)).toBe("$0");
});

it("headline carries totals + open-exception count, no PII", () => {
  const m = emptyMetrics("2026-07-01");
  m.topLine.leadsTotal = 5;
  m.topLine.contractsSigned = 2;
  m.topLine.contractValueCents = 4200000;
  m.money.cashCollectedCents = 2400000;
  const h = renderFlashHeadline(m, [
    { severity: "high" } as never,
    { severity: "high" } as never,
  ]);
  expect(h).toContain("5 leads");
  expect(h).toContain("$42,000");
  expect(h).toContain("2 need you");
  expect(h).not.toMatch(/customer|@|\bcard\b/i);
});

it("quiet day headline says quiet, zero exceptions", () => {
  const h = renderFlashHeadline(emptyMetrics("2026-07-01"), []);
  expect(h.toLowerCase()).toContain("quiet");
});

it("HTML pins Needs you at top and renders — for null metrics", () => {
  const m = emptyMetrics("2026-07-01"); // medianSpeedToLeadMs null etc.
  const html = renderFlashHtml(
    m,
    [
      {
        severity: "high",
        reason: "18% margin",
        ruleId: "low-margin",
      } as never,
    ],
    {
      leadsTotalVsYesterday: null,
      contractValueVsTrailing7: null,
      cashCollectedVsTrailing7: null,
    }
  );
  const needsIdx = html.indexOf("Needs you");
  const moneyIdx = html.indexOf("Cash collected");
  expect(needsIdx).toBeGreaterThanOrEqual(0);
  expect(needsIdx).toBeLessThan(moneyIdx); // pinned above money
  expect(html).toContain("—"); // null speed rendered as em dash
  expect(html).toContain("18% margin");
});
