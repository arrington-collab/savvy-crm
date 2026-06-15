import { describe, it, expect, vi } from "vitest";
import { makeResendEmail } from "./email";

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
