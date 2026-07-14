import { describe, it, expect } from "vitest";
import { buildVideoQueueItem, needsPhoneticHint, pickDeliveryVideo } from "./video-batch";

describe("needsPhoneticHint", () => {
  it("obvious names skip the hint; unusual ones ask for it", () => {
    expect(needsPhoneticHint("John Smith")).toBe(false);
    expect(needsPhoneticHint("Siobhan Nguyen")).toBe(true);
    expect(needsPhoneticHint("Xochitl Ramirez")).toBe(true);
  });
});

describe("buildVideoQueueItem", () => {
  it("bundles everything the owner needs to record with zero lookup", () => {
    const item = buildVideoQueueItem({
      customerName: "Jordan Hale",
      repName: "Seth",
      city: "Mesa",
      selectedTier: "better",
      tiers: [
        { tier: "good", productName: "IKO Cambridge", subtotalCents: 1_800_000 },
        { tier: "better", productName: "IKO Dynasty", subtotalCents: 2_100_000 },
      ],
      isInsurance: false,
      recentQuestion: "Is the ridge vent included?",
    });
    expect(item.headline).toBe("Jordan Hale — Mesa");
    expect(item.repLine).toContain("Seth");
    expect(item.priceLine).toContain("IKO Dynasty");
    expect(item.priceLine).toContain("$21,000");
    expect(item.nugget).toContain("ridge vent"); // their live concern beats the generic nugget
  });

  it("falls back to claim-vs-retail as the nugget and the recommended tier when nothing was picked", () => {
    const item = buildVideoQueueItem({
      customerName: "Ana Cruz",
      repName: "Rita",
      city: "Tempe",
      selectedTier: null,
      tiers: [{ tier: "better", productName: "IKO Dynasty", subtotalCents: 2_000_000, recommended: true }],
      isInsurance: true,
      recentQuestion: null,
    });
    expect(item.priceLine).toContain("IKO Dynasty");
    expect(item.nugget.toLowerCase()).toContain("insurance");
  });
});

describe("pickDeliveryVideo", () => {
  const vid = (role: string, approved: boolean) => ({ role, approvedAt: approved ? new Date() : null, documentId: `d-${role}` });
  it("personalized approved take wins", () => {
    expect(pickDeliveryVideo([vid("owner", true)], "generic-doc")).toEqual({ documentId: "d-owner", personalized: true });
  });
  it("unapproved takes NEVER send — generic fallback covers", () => {
    expect(pickDeliveryVideo([vid("owner", false)], "generic-doc")).toEqual({ documentId: "generic-doc", personalized: false });
  });
  it("no takes + no generic → nothing sends", () => {
    expect(pickDeliveryVideo([], null)).toBeNull();
  });
});
