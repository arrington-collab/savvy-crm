import { describe, it, expect } from "vitest";
import { selectSms, smsFrom } from "./comms";
import { ringcentralSms } from "./ringcentral";
import { twilioSms } from "./twilio";

describe("selectSms", () => {
  it("returns RingCentral when TELEPHONY_SMS_PROVIDER=ringcentral", () => {
    expect(selectSms({ TELEPHONY_SMS_PROVIDER: "ringcentral" })).toBe(ringcentralSms);
  });
  it("defaults to Twilio when unset or any other value", () => {
    expect(selectSms({})).toBe(twilioSms);
    expect(selectSms({ TELEPHONY_SMS_PROVIDER: "twilio" })).toBe(twilioSms);
  });
});

describe("smsFrom", () => {
  it("uses RINGCENTRAL_FROM_NUMBER when provider is ringcentral", () => {
    expect(smsFrom({ TELEPHONY_SMS_PROVIDER: "ringcentral", RINGCENTRAL_FROM_NUMBER: "+15550001111" })).toBe("+15550001111");
  });
  it("uses TWILIO_FROM otherwise", () => {
    expect(smsFrom({ TWILIO_FROM: "+15552223333" })).toBe("+15552223333");
  });
});
