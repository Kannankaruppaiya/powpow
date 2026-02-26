import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("PowPow", 16)).toBe("PowPow");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("powpow-status-output", 10)).toBe("powpow-…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
