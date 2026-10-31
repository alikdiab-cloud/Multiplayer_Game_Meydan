import { useCallback, useEffect, useRef } from "react";
import type { BotDifficulty } from "../shared/bot.js";
import type { GameView } from "../shared/game.js";
import { BotWorkerClient } from "./botWorkerClient.js";

/** React lifecycle wrapper; callers can cancel on reset, undo, or mode changes. */
export function useBotWorker() {
  const clientRef = useRef<BotWorkerClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new BotWorkerClient();
  }
  const client = clientRef.current;

  useEffect(() => () => client.dispose(), [client]);

  const search = useCallback(
    (view: GameView, difficulty: BotDifficulty) => client.search(view, difficulty),
    [client],
  );
  const cancel = useCallback(() => client.cancel(), [client]);

  return { search, cancel };
}
