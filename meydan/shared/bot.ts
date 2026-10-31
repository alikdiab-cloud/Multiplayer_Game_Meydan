import {
  CheckersGame,
  CHECKERS_BLACK,
  CHECKERS_WHITE,
  TurkishBoard,
  type CheckersMove,
  type GameStatus,
} from "@ymir-js/checkers";
import type { GameView, LegalMove, Side } from "./game.js";

export const BOT_EVALUATION_WEIGHTS = {
  man: 100,
  king: 300,
  legalMove: 2,
  maxMobility: 100,
  // Exceeds the largest possible material swing on a 64-square board plus capped mobility.
  terminalWin: 1_000_000,
} as const;

function pieceSide(piece: string, square: string): Side {
  switch (piece.toLowerCase()) {
    case "w":
      return "white";
    case "b":
      return "black";
    default:
      throw new TypeError(`Unknown engine piece code at ${square}: ${piece}`);
  }
}

/**
 * Evaluates a snapshot from `DamaMatch.getView()`. Positive scores favor `perspective`;
 * negative scores favor the other side. Legal move choices come only from the engine view.
 */
export function evaluatePosition(view: GameView, perspective: Side): number {
  if (view.result !== null) {
    if (view.result.state === "draw") {
      return 0;
    }
    return view.result.winner === perspective
      ? BOT_EVALUATION_WEIGHTS.terminalWin
      : -BOT_EVALUATION_WEIGHTS.terminalWin;
  }

  let score = 0;
  for (const [square, piece] of Object.entries(view.position)) {
    const owner = pieceSide(piece, square);
    const value = piece === piece.toUpperCase()
      ? BOT_EVALUATION_WEIGHTS.king
      : BOT_EVALUATION_WEIGHTS.man;
    score += owner === perspective ? value : -value;
  }

  // Give a small tempo/mobility bonus only to the side whose canonical legal moves are listed.
  const mobilityBonus = Math.min(
    view.legalMoves.length * BOT_EVALUATION_WEIGHTS.legalMove,
    BOT_EVALUATION_WEIGHTS.maxMobility,
  );
  score += view.turn === perspective ? mobilityBonus : -mobilityBonus;

  return score;
}

export type BotDifficulty = "easy" | "medium" | "hard";

export type BotSearchPreset = {
  maxDepth: number;
  maxNodes: number;
};

/** Deterministic limits; these are search sizes, not calibrated playing ratings. */
export const BOT_SEARCH_PRESETS: Readonly<Record<BotDifficulty, BotSearchPreset>> = {
  easy: { maxDepth: 1, maxNodes: 128 },
  medium: { maxDepth: 3, maxNodes: 2_500 },
  hard: { maxDepth: 5, maxNodes: 20_000 },
};

export type BotSearchStopReason = "depth" | "node-budget" | "terminal" | "no-legal-moves";

export type BotSearchResult = {
  /** A copied, canonical engine move, including every landing and captured square. */
  move: LegalMove | null;
  score: number;
  completedDepth: number;
  nodesSearched: number;
  elapsedMs: number;
  stopReason: BotSearchStopReason;
};

type EngineMove = CheckersMove;

class NodeBudgetReached extends Error {
  constructor() {
    super("The configured node budget was reached.");
    this.name = "NodeBudgetReached";
  }
}

function copyEngineMove(move: EngineMove): LegalMove {
  return { from: move.from, path: [...move.path], captured: [...move.captured] };
}

function engineTurn(side: Side): typeof CHECKERS_WHITE | typeof CHECKERS_BLACK {
  return side === "white" ? CHECKERS_WHITE : CHECKERS_BLACK;
}

function samePosition(first: GameView["position"], second: GameView["position"]): boolean {
  const firstEntries = Object.entries(first).sort(([a], [b]) => a.localeCompare(b));
  const secondEntries = Object.entries(second).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(firstEntries) === JSON.stringify(secondEntries);
}

/**
 * Replays a normal match's structured history when it is a complete game from the
 * standard start. Custom engine fixtures fall back to an independent current-position copy.
 */
function createSearchGame(view: GameView): CheckersGame {
  if (view.history.length > 0) {
    const replay = CheckersGame.create("turkish");
    let replayed = true;
    try {
      for (const record of view.history) {
        replay.play({ from: record.from, path: [...record.path] });
      }
    } catch {
      replayed = false;
    }
    if (
      replayed &&
      replay.turn === view.turn &&
      samePosition(replay.board.getPosition(), view.position)
    ) {
      return replay;
    }
  }

  return new CheckersGame(
    new TurkishBoard().setPosition({ ...view.position }),
    { turn: engineTurn(view.turn) },
  );
}

function scoreStatus(status: GameStatus, perspective: Side, ply: number): number | null {
  if (status.state === "playing") {
    return null;
  }
  if (status.state === "draw") {
    return 0;
  }

  const mateScore = BOT_EVALUATION_WEIGHTS.terminalWin - ply;
  return status.winner === perspective ? mateScore : -mateScore;
}

function evaluateEnginePosition(game: CheckersGame, perspective: Side): number {
  const legalMoves = game.getLegalMoves().map(copyEngineMove);
  return evaluatePosition(
    {
      position: { ...game.board.getPosition() },
      turn: game.turn,
      legalMoves,
      history: [],
      result: null,
    },
    perspective,
  );
}

/**
 * Chooses a move by iterative-deepening minimax with alpha-beta pruning. Every
 * candidate and every applied path comes from the pinned Dama engine. Search runs
 * on a private engine copy; an incomplete iteration falls back to the first legal move.
 */
export function chooseBotMove(view: GameView, difficulty: BotDifficulty): BotSearchResult {
  const preset = BOT_SEARCH_PRESETS[difficulty];
  if (preset === undefined) {
    throw new RangeError(`Unknown computer difficulty: ${String(difficulty)}`);
  }

  const startedAt = Date.now();
  const activePerspective = view.turn;
  if (view.result !== null) {
    return {
      move: null,
      score: evaluatePosition(view, activePerspective),
      completedDepth: 0,
      nodesSearched: 0,
      elapsedMs: Date.now() - startedAt,
      stopReason: "terminal",
    };
  }

  const game = createSearchGame(view);
  const rootStatus = game.getStatus();
  const rootTerminalScore = scoreStatus(rootStatus, activePerspective, 0);
  if (rootTerminalScore !== null) {
    return {
      move: null,
      score: rootTerminalScore,
      completedDepth: 0,
      nodesSearched: 0,
      elapsedMs: Date.now() - startedAt,
      stopReason: rootStatus.state === "playing" ? "no-legal-moves" : "terminal",
    };
  }

  const rootMoves = game.getLegalMoves().map(copyEngineMove);
  const fallback = rootMoves[0];
  if (fallback === undefined) {
    return {
      move: null,
      score: evaluateEnginePosition(game, activePerspective),
      completedDepth: 0,
      nodesSearched: 0,
      elapsedMs: Date.now() - startedAt,
      stopReason: "no-legal-moves",
    };
  }

  let nodesSearched = 0;
  let completedDepth = 0;
  let bestMove = fallback;
  let bestScore = evaluateEnginePosition(game, activePerspective);
  let stopReason: BotSearchStopReason = "depth";

  const enterNode = (): void => {
    if (nodesSearched >= preset.maxNodes) {
      throw new NodeBudgetReached();
    }
    nodesSearched += 1;
  };

  const searchNode = (depth: number, ply: number, alpha: number, beta: number): number => {
    enterNode();

    // The engine's status is authoritative and is checked before candidate expansion.
    const status = game.getStatus();
    const terminalScore = scoreStatus(status, activePerspective, ply);
    if (terminalScore !== null) {
      return terminalScore;
    }
    if (depth === 0) {
      return evaluateEnginePosition(game, activePerspective);
    }

    const moves = game.getLegalMoves().map(copyEngineMove);
    if (moves.length === 0) {
      return evaluateEnginePosition(game, activePerspective);
    }

    const maximizing = game.turn === activePerspective;
    let value = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (const move of moves) {
      let applied = false;
      try {
        game.play({ from: move.from, path: [...move.path] });
        applied = true;
        const childValue = searchNode(depth - 1, ply + 1, alpha, beta);
        if (maximizing) {
          value = Math.max(value, childValue);
          alpha = Math.max(alpha, value);
        } else {
          value = Math.min(value, childValue);
          beta = Math.min(beta, value);
        }
      } finally {
        if (applied && game.undo() === null) {
          throw new Error("The rules engine could not restore a searched move.");
        }
      }
      if (alpha >= beta) {
        break;
      }
    }
    return value;
  };

  for (let depth = 1; depth <= preset.maxDepth; depth += 1) {
    try {
      enterNode();
      const rootMaximizing = game.turn === activePerspective;
      let iterationBestMove: EngineMove | undefined;
      let iterationBestScore = rootMaximizing
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY;
      let alpha = Number.NEGATIVE_INFINITY;
      const beta = Number.POSITIVE_INFINITY;

      for (const move of rootMoves) {
        let applied = false;
        let value: number;
        try {
          game.play({ from: move.from, path: [...move.path] });
          applied = true;
          value = searchNode(depth - 1, 1, alpha, beta);
        } finally {
          if (applied && game.undo() === null) {
            throw new Error("The rules engine could not restore a searched root move.");
          }
        }

        if (iterationBestMove === undefined || value > iterationBestScore) {
          iterationBestMove = move;
          iterationBestScore = value;
        }
        alpha = Math.max(alpha, iterationBestScore);
      }

      if (iterationBestMove !== undefined) {
        bestMove = iterationBestMove;
        bestScore = iterationBestScore;
        completedDepth = depth;
      }
    } catch (error) {
      if (!(error instanceof NodeBudgetReached)) {
        throw error;
      }
      stopReason = "node-budget";
      break;
    }
  }

  return {
    move: copyEngineMove(bestMove),
    score: bestScore,
    completedDepth,
    nodesSearched,
    elapsedMs: Date.now() - startedAt,
    stopReason,
  };
}
