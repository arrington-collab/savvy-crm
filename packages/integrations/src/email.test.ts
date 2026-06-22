import { describe, it, expect, vi } from "vitest";
import { makeResendEmail, makeGmailEmail, getEmailSender, resendEmail } from "./email";

describe("resendEmail", () => {
  it("POSTs to Resend and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-123" }),
    });
    const sender = makeResendEmail({ apiKey: "re_test", fetchImpl: fetchMock as never });
    const res = await sender.sendEmail({ to: "a@b.com", from: "x@y.com", subject: "Hi", html: "<p>hi</p>" });
    expect(res.id).toBe("resend-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "bad" });
    const sender = makeResendEmail({ apiKey: "re_test", fetchImpl: fetchMock as never });
    await expect(sender.sendEmail({ to: "a@b.com", from: "x@y.com", subject: "s", html: "h" }))
      .rejects.toThrow(/resend/i);
  });
});

describe("makeGmailEmail", () => {
  it("sends an RFC822/base64url message via the Nango proxy and returns {id}", async () => {
    const calls: any[] = [];
    const proxy = async (o: any) => { calls.push(o); return { id: "msg-1" }; };
    const g = makeGmailEmail({ connectionId: "c1", proxyImpl: proxy as never });
    const res = await g.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "Hi", html: "<p>x</p>" });
    expect(res).toEqual({ id: "msg-1" });
    expect(calls[0].connectionId).toBe("c1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].endpoint).toBe("/gmail/v1/users/me/messages/send");
    const decoded = Buffer.from(calls[0].body.raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: a@b.com");
    expect(decoded).toContain("Subject: Hi");
    expect(decoded).toContain("<p>x</p>");
  });

  it("strips CRLF from header values to prevent header injection", async () => {
    const calls: any[] = [];
    const proxy = async (o: any) => { calls.push(o); return { id: "m" }; };
    const g = makeGmailEmail({ connectionId: "c1", proxyImpl: proxy as never });
    await g.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "Hi\r\nBcc: evil@x.com", html: "<p>x</p>" });
    const decoded = Buffer.from(calls[0].body.raw, "base64url").toString("utf8");
    // the injected line must NOT appear as its own header
    expect(decoded).not.toMatch(/^Bcc: evil@x\.com/m);
    expect(decoded).toContain("Subject: Hi Bcc: evil@x.com"); // collapsed onto the Subject line
  });
  it("assembles all required headers", async () => {
    const calls: any[] = [];
    const proxy = async (o: any) => { calls.push(o); return { id: "m" }; };
    const g = makeGmailEmail({ connectionId: "c1", proxyImpl: proxy as never });
    await g.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "Hi", html: "<p>x</p>" });
    const decoded = Buffer.from(calls[0].body.raw, "base64url").toString("utf8");
    expect(decoded).toContain("From: me@x.com");
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain('Content-Type: text/html; charset="UTF-8"');
  });
});

describe("getEmailSender", () => {
  it("returns the Resend sender when no gmail connection", () => {
    expect(getEmailSender({})).toBe(resendEmail);
    expect(getEmailSender({ gmailConnectionId: null })).toBe(resendEmail);
  });
  it("returns a non-Resend (Gmail) sender when a connection is present", () => {
    expect(getEmailSender({ gmailConnectionId: "c1" })).not.toBe(resendEmail);
  });
});
