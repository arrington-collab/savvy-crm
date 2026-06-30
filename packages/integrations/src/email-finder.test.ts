import { describe, it, expect } from "vitest";
import { makeDormantEmailFinder, makeFakeEmailFinder } from "./email-finder";

describe("EmailFinder", () => {
  it("the dormant finder returns null (inert until a provider is wired)", async () => {
    expect(await makeDormantEmailFinder().findEmail({ phone: "+16025550000" })).toBeNull();
  });

  it("the fake finder returns its configured email", async () => {
    expect(await makeFakeEmailFinder("found@x.com").findEmail({ phone: "+16025550000" })).toBe("found@x.com");
  });
});
