import type { GameView } from "../shared/game.js";

export type GameSoundEvent = "move" | "capture" | "result";

export function committedSoundForChange(
  previous: Pick<GameView, "history" | "result">,
  current: Pick<GameView, "history" | "result">,
): GameSoundEvent | null {
  if (previous.result === null && current.result !== null) return "result";
  if (current.history.length <= previous.history.length) return null;
  const latestMove = current.history.at(-1);
  if (latestMove === undefined) return null;
  return latestMove.captured.length > 0 ? "capture" : "move";
}
