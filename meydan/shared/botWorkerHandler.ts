import { chooseBotMove, type BotDifficulty } from "./bot.js";
import type { GameView } from "./game.js";
import type { BotWorkerRequest, BotWorkerResponse } from "./botProtocol.js";

type MessageRecord = Record<string, unknown>;
type Search = typeof chooseBotMove;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDifficulty(value: unknown): value is BotDifficulty {
  return value === "easy" || value === "medium" || value === "hard";
}

function readIdentity(value: unknown): { requestId: number; generation: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.requestId) ||
    !Number.isSafeInteger(value.generation)
  ) {
    return null;
  }
  return {
    requestId: value.requestId as number,
    generation: value.generation as number,
  };
}

function isGameView(value: unknown): value is GameView {
  if (!isRecord(value) || !isRecord(value.position)) {
    return false;
  }
  return (
    (value.turn === "white" || value.turn === "black") &&
    Array.isArray(value.legalMoves) &&
    Array.isArray(value.history) &&
    (value.result === null || isRecord(value.result))
  );
}

function isBotWorkerRequest(value: unknown): value is BotWorkerRequest {
  return (
    isRecord(value) &&
    value.kind === "search" &&
    readIdentity(value) !== null &&
    isDifficulty(value.difficulty) &&
    isGameView(value.view)
  );
}

/** Validates a serializable request and converts thrown engine searches to a failure reply. */
export function createBotWorkerResponse(
  value: unknown,
  search: Search = chooseBotMove,
): BotWorkerResponse | null {
  const identity = readIdentity(value);
  if (identity === null) {
    return null;
  }

  if (!isBotWorkerRequest(value)) {
    return {
      kind: "failure",
      ...identity,
      error: "The computer received an invalid search request.",
    };
  }

  try {
    return {
      kind: "success",
      requestId: value.requestId,
      generation: value.generation,
      result: search(value.view, value.difficulty),
    };
  } catch (error) {
    return {
      kind: "failure",
      requestId: value.requestId,
      generation: value.generation,
      error: error instanceof Error ? error.message : "The computer search failed.",
    };
  }
}
