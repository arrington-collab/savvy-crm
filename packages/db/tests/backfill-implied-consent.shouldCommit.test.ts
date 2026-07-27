import { describe, expect, it } from "vitest";
import { shouldCommit } from "../src/scripts/backfill-implied-consent";

// Pure unit tests for the arg-parsing decision — no DB involved. The script
// itself is a deploy-time prod op (see header comment on the script); this
// only covers the safety-critical "did the caller explicitly ask to write?"
// logic. Default (no flags) must be dry-run; --commit is required to write;
// if both --dry-run and --commit are passed, dry-run wins (safer default).
describe("shouldCommit", () => {
  it("defaults to false (dry-run) when no flags are passed", () => {
    expect(shouldCommit([])).toBe(false);
  });

  it("is false when --dry-run is passed explicitly", () => {
    expect(shouldCommit(["--dry-run"])).toBe(false);
  });

  it("is true when --commit is passed", () => {
    expect(shouldCommit(["--commit"])).toBe(true);
  });

  it("dry-run wins when both --commit and --dry-run are passed", () => {
    expect(shouldCommit(["--commit", "--dry-run"])).toBe(false);
  });

  it("is false for unrelated flags like --tenant=", () => {
    expect(shouldCommit(["--tenant=abc"])).toBe(false);
  });
});
