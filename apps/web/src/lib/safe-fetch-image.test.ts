import { describe, it, expect } from "vitest";
import { isBlockedIp } from "./safe-fetch-image";

describe("isBlockedIp", () => {
  it("blocks loopback, private, link-local, and metadata IPv4", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
  it("blocks loopback/link-local/ULA IPv6 and mapped IPv4", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("allows public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
});
