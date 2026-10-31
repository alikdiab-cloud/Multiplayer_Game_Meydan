import type { BotDifficulty, BotSearchResult } from "./bot.js";
import type { GameView } from "./game.js";

/** Plain structured-clone data sent from the browser thread to the bot worker. */
export type BotWorkerRequest = {
  kind: "search";
  requestId: number;
  generation: number;
  difficulty: BotDifficulty;
  view: GameView;
};

/** The worker reports either a complete result or a serializable error message. */
export type BotWorkerResponse =
  | {
      kind: "success";
      requestId: number;
      generation: number;
      result: BotSearchResult;
    }
  | {
      kind: "failure";
      requestId: number;
      generation: number;
      error: string;
    };

