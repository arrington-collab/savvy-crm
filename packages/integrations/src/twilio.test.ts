import { describe, expect, it } from "vitest";
import { makeTwilioSms, makeTwilioSmsWithClient, verifyTwilioCreds } from "./twilio";

describe("twilio factory", () => {
  it("makeTwilioSms returns an SmsSender shape", () => {
    const sender = makeTwilioSms({ accountSid: "AC1", authToken: "tok" });
    expect(typeof sender.sendSms).toBe("function");
  });

  it("verifyTwilioCreds returns true on a 200 from the account endpoint", async () => {
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      expect(url).toContain("/Accounts/AC1.json");
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Basic /);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await verifyTwilioCreds({ accountSid: "AC1", authToken: "tok" }, fakeFetch)).toBe(true);
  });

  it("verifyTwilioCreds returns false on a 401", async () => {
    const fakeFetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await verifyTwilioCreds({ accountSid: "AC1", authToken: "bad" }, fakeFetch)).toBe(false);
  });
});

describe("sendSms optional fields", () => {
  it("forwards statusCallback and messagingServiceSid to messages.create when provided", async () => {
    const created: Record<string, unknown>[] = [];
    const fakeClient = {
      messages: {
        create: async (o: Record<string, unknown>) => {
          created.push(o);
          return { sid: "SM1" };
        },
      },
    };
    const sender = makeTwilioSmsWithClient(fakeClient);
    await sender.sendSms({
      to: "+1",
      from: "+2",
      body: "b",
      statusCallback: "https://x/cb",
      messagingServiceSid: "MG1",
    });
    expect(created[0]).toMatchObject({
      to: "+1",
      body: "b",
      statusCallback: "https://x/cb",
      messagingServiceSid: "MG1",
    });
  });

  it("omits statusCallback/messagingServiceSid when not provided", async () => {
    const created: Record<string, unknown>[] = [];
    const fakeClient = {
      messages: {
        create: async (o: Record<string, unknown>) => {
          created.push(o);
          return { sid: "SM2" };
        },
      },
    };
    const sender = makeTwilioSmsWithClient(fakeClient);
    await sender.sendSms({ to: "+1", from: "+2", body: "b" });
    expect(created[0]).not.toHaveProperty("statusCallback");
    expect(created[0]).not.toHaveProperty("messagingServiceSid");
  });
});
