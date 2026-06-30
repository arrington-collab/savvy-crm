import { beforeAll, describe, expect, it } from "vitest";
import { seal, open, maskSecret } from "./secret-box";

beforeAll(() => {
  process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("secret-box", () => {
  it("round-trips plaintext", () => {
    const sealed = seal("AC_super_secret_token");
    expect(sealed.ciphertext).not.toContain("super_secret");
    expect(open(sealed)).toBe("AC_super_secret_token");
    expect(sealed.keyVersion).toBe(1);
  });

  it("rejects a tampered auth tag", () => {
    const sealed = seal("hello");
    const tampered = { ...sealed, tag: Buffer.alloc(16, 0).toString("base64") };
    expect(() => open(tampered)).toThrow();
  });

  it("masks all but the last four chars", () => {
    expect(maskSecret("0123456789")).toBe("••• 6789");
    expect(maskSecret("abc")).toBe("••••");
  });

  it("throws when the key is the wrong length", () => {
    const prev = process.env.INTEGRATION_SECRET_KEY;
    process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => seal("x")).toThrow(/32 bytes/);
    process.env.INTEGRATION_SECRET_KEY = prev;
  });
});
