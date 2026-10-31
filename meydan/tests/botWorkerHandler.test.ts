import { describe, expect, it } from "vitest";
import { DamaMatch } from "../shared/game.js";
import { createBotWorkerResponse } from "../shared/botWorkerHandler.js";

describe("bot worker request handling", () => {
  it("returns a failure response when the search throws", () => {
    const response = createBotWorkerResponse({
      kind: "search",
      requestId: 12,
      generation: 4,
      difficulty: "medium",
      view: new DamaMatch().getView(),
    }, () => {
      throw new Error("forced search failure");
    });

    expect(response).toEqual({
      kind: "failure",
      requestId: 12,
      generation: 4,
      error: "forced search failure",
    });
  });

  it("keeps non-Error throws inside the failure contract", () => {
    const response = createBotWorkerResponse({
      kind: "search",
      requestId: 13,
      generation: 5,
      difficulty: "easy",
      view: new DamaMatch().getView(),
    }, () => {
      throw "forced non-Error failure";
    });

    expect(response).toEqual({
      kind: "failure",
      requestId: 13,
      generation: 5,
      error: "The computer search failed.",
    });
  });
});
