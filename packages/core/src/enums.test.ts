import { describe, it, test, expect } from "vitest";
import { MESSAGE_CHANNEL, DRIP_STATUS, DRIP_STOP_REASON, AI_DRAFT_CAPABILITY, APPOINTMENT_TYPE, APPOINTMENT_STATUS, INVOICE_STATUS, PAYMENT_METHOD, COMMISSION_MODEL, COMMISSION_STATUS, ESTIMATE_SOURCE, ESTIMATE_STATUS, PRICE_BOOK_CATEGORY, PRICE_BOOK_UNIT, MEASUREMENT_FIELD } from "./enums";

describe("phase 3 enums", () => {
  it("message channel is sms|email only (no call)", () => {
    expect(MESSAGE_CHANNEL).toEqual(["sms", "email"]);
  });
  it("drip status + stop reasons", () => {
    expect(DRIP_STATUS).toEqual(["active", "stopped", "completed"]);
    expect(DRIP_STOP_REASON).toEqual(["reply", "converted", "opted_out", "manual"]);
  });
  it("ai draft capabilities", () => {
    expect(AI_DRAFT_CAPABILITY).toEqual(["reasoning", "workhorse", "reflex", "reason", "summarize"]);
  });
});

test("appointment enums", () => {
  expect(APPOINTMENT_TYPE).toEqual(["inspection", "cm", "crew"]);
  expect(APPOINTMENT_STATUS).toEqual(["scheduled", "done", "canceled", "no_show"]);
});

test("finance enums", () => {
  expect(INVOICE_STATUS).toEqual(["draft", "sent", "paid", "overdue", "void"]);
  expect(PAYMENT_METHOD).toEqual(["card", "ach", "check", "insurance", "mortgage"]);
});

test("commission enums", () => {
  expect(COMMISSION_MODEL).toEqual(["flat", "profit", "tiered"]);
  expect(COMMISSION_STATUS).toEqual(["pending", "approved", "paid"]);
});

test("phase 7 enums", () => {
  expect(ESTIMATE_SOURCE).toEqual(["roofr", "manual", "carrier"]);
  expect(ESTIMATE_STATUS).toEqual(["draft", "sent", "accepted"]);
  expect(PRICE_BOOK_CATEGORY).toEqual(["material", "labor", "accessory", "upgrade"]);
  expect(PRICE_BOOK_UNIT).toEqual(["square", "lf", "each", "flat"]);
  expect(MEASUREMENT_FIELD).toContain("squares");
  expect(MEASUREMENT_FIELD).toContain("ridgeLf");
});
