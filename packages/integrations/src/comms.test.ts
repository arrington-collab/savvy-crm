import { describe, it, expect } from "vitest";
import { selectSms } from "./comms";
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
