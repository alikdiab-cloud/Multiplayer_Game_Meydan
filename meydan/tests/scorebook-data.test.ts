import { describe, expect, it } from "vitest";
import { createScorebookText, normalizeScorebookLine } from "../src/scorebook.js";

describe("scorebook text fields", () => {
  it("keeps names and notation on one exported line while preserving allowed Unicode text", () => {
    expect(normalizeScorebookLine("O'Neil λ\r\nMika-東京\rnotation\ncontinued\u2028line"))
      .toBe("O'Neil λ Mika-東京 notation continued line");
  });

  it("builds one move line and includes only the supplied public match result", () => {
    const scorebook = createScorebookText([{
      ply: 1,
      side: "white",
      from: "2|0",
      path: ["3|1"],
      captured: [],
      notation: "c6-c5\r\ncontinuation",
    }], {
      state: "draw",
      reason: "agreement",
    }, "Online spectator", { white: "O'Neil λ", black: "Mika-東京" }, "ABC234", 2, {
      kind: "rapid",
      initialMs: 600_000,
      incrementMs: 5_000,
    });

    expect(scorebook).toContain("Mode: Online spectator\nMatch number: 2");
    expect(scorebook).toContain("Time control: Rapid · 10 min + 5 sec increment\nRoom code: ABC234");
    expect(scorebook).toContain("White player: O'Neil λ\nBlack player: Mika-東京");
    expect(scorebook).toContain("1. White: c6-c5 continuation | Black: —");
    expect(scorebook).toContain("Result: Draw\nDetails: Both sides agreed to a draw.");
    expect(scorebook.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line))).toHaveLength(1);
  });
});
