import { describe, expect, it } from "vitest";
import { committedSoundForChange } from "../src/gameSoundEvents.js";
import type { GameView, MoveRecord } from "../shared/game.js";

function view(history: MoveRecord[] = [], result: GameView["result"] = null): Pick<GameView, "history" | "result"> {
  return { history, result };
}

function move(captured: string[] = []): MoveRecord {
  return {
    ply: 1,
    side: "white",
    from: "2|0",
    path: ["3|0"],
    captured,
    notation: captured.length === 0 ? "a3" : "a3xa5",
  };
}

describe("committed game sounds", () => {
  it("does not sound for previews, repeated views, or undo", () => {
    const committed = view([move()]);
    expect(committedSoundForChange(view(), view())).toBeNull();
    expect(committedSoundForChange(committed, committed)).toBeNull();
    expect(committedSoundForChange(committed, view())).toBeNull();
  });

  it("distinguishes quiet moves, captures, and a result ending on a move", () => {
    expect(committedSoundForChange(view(), view([move()]))).toBe("move");
    expect(committedSoundForChange(view(), view([move(["3|1"])]))).toBe("capture");
    expect(committedSoundForChange(view(), view([move()], { state: "won", winner: "white", reason: "no-moves" })))
      .toBe("result");
  });

  it("plays a result for an offer, resignation, or other terminal event without a new move", () => {
    expect(committedSoundForChange(view([move()]), view([move()], { state: "draw", reason: "agreement" })))
      .toBe("result");
  });
});
