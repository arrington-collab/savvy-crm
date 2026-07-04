import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fnDir = join(dirname(fileURLToPath(import.meta.url)), "functions");

describe("comms bodies carry no raw signed-token links", () => {
  it("no agent function builds a raw /status/ or /book/ link from signPayloadToken", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(fnDir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(fnDir, f), "utf8");
      // A raw link is `.../status/${signPayloadToken(...)}` or `.../book/${signPayloadToken(...)}`
      if (/\/(status|book)\/\$\{\s*signPayloadToken/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
