import { afterEach, describe, expect, it } from "vitest";
import { requireSecret } from "./secrets.js";

const KEY = "TEST_SECRET_XYZ";

afterEach(() => {
  delete process.env[KEY];
  delete process.env.NODE_ENV;
});

describe("requireSecret", () => {
  it("returns the env value when set", () => {
    process.env[KEY] = "real-value";
    expect(requireSecret(KEY)).toBe("real-value");
  });

  it("returns the env value when set even in production", () => {
    process.env.NODE_ENV = "production";
    process.env[KEY] = "real-value";
    expect(requireSecret(KEY, { devFallback: "dev" })).toBe("real-value");
  });

  it("throws when unset in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => requireSecret(KEY)).toThrow("Missing required secret: TEST_SECRET_XYZ");
  });

  it("returns the explicit dev fallback when unset outside production", () => {
    process.env.NODE_ENV = "development";
    expect(requireSecret(KEY, { devFallback: "dev-test" })).toBe("dev-test");
  });

  it("returns a derived default fallback when unset and no devFallback given", () => {
    process.env.NODE_ENV = "development";
    expect(requireSecret(KEY)).toBe("dev-test_secret_xyz");
  });
});
