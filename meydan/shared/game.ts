import {
  CheckersGame,
  CHECKERS_WHITE,
  type CheckersMove,
  type CheckersPosition,
  type DrawReason,
  type GameStatus,
} from "@ymir-js/checkers";

export type Side = "white" | "black";

// Retained for the existing client shell while callers adopt Side.
export type DamaSide = Side;

export const FIRST_TO_MOVE: Side = CHECKERS_WHITE;

export type MoveInput = {
  from: string;
  path: string[];
};

/** A source square plus zero or more landing squares selected so far. */
export type MoveSelection = MoveInput;

export function sameMove(first: MoveInput, second: MoveInput): boolean {
  if (first.from !== second.from || first.path.length !== second.path.length) {
    return false;
  }

  for (let index = 0; index < first.path.length; index += 1) {
    if (first.path[index] !== second.path[index]) {
      return false;
    }
  }

  return true;
}

export type LegalMove = MoveInput & {
  captured: string[];
};

export type ApplicationResult =
  | { state: "won"; winner: Side; reason: "resignation" | "timeout" | "disconnection" }
  | { state: "draw"; reason: "agreement" | "mutual-disconnection" };

/**
 * @ymir-js/checkers 0.14.0's `turkish` defaults enable threefold repetition
 * and one-piece-each. Its king-move and lone-king limits default to false;
 * these result variants remain mapped for engine compatibility, not enabled rules.
 */
export type GameResult =
  | { state: "won"; winner: Side; reason: "no-moves" }
  | { state: "draw"; reason: DrawReason }
  | ApplicationResult;

export function resultText(result: GameResult): string {
  return result.state === "won" ? `${capitalizeSide(result.winner)} wins` : "Draw";
}

export function resultDetail(result: GameResult): string {
  if (result.state === "won") {
    const losingSide = capitalizeSide(sideAfter(result.winner));
    switch (result.reason) {
      case "no-moves":
        return `${losingSide} has no legal moves.`;
      case "resignation":
        return `${losingSide} resigned.`;
      case "timeout":
        return `${losingSide} ran out of time.`;
      case "disconnection":
        return `${losingSide} disconnected.`;
    }
  }

  switch (result.reason) {
    case "repetition":
      return "The same position occurred three times with the same side to move.";
    case "one-piece-each":
      return "Each side has one piece remaining.";
    case "king-moves":
      return "The king-move limit was reached without a capture.";
    case "lone-king":
      return "The lone-king endgame limit was reached.";
    case "agreement":
      return "Both sides agreed to a draw.";
    case "mutual-disconnection":
      return "Both players were disconnected when the recovery period expired.";
  }
}

export type MoveRecord = LegalMove & {
  ply: number;
  side: Side;
  notation: string;
};

export type GameView = {
  position: CheckersPosition;
  turn: Side;
  legalMoves: LegalMove[];
  history: MoveRecord[];
  result: GameResult | null;
};

function isValidSelection(selection: MoveSelection): boolean {
  if (
    selection === null ||
    typeof selection !== "object" ||
    typeof selection.from !== "string" ||
    !Array.isArray(selection.path)
  ) {
    return false;
  }

  for (const square of selection.path) {
    if (typeof square !== "string") {
      return false;
    }
  }

  return true;
}

const FILE_NAMES = "abcdefgh";

/** Maps engine coordinates to algebraic file/rank names; row zero is rank eight. */
export function squareName(coord: string): string {
  const match = /^([0-7])\|([0-7])$/.exec(coord);
  if (!match) {
    throw new RangeError(`Invalid Dama square coordinate: ${coord}`);
  }

  const rowText = match[1];
  const columnText = match[2];
  if (rowText === undefined || columnText === undefined) {
    throw new RangeError(`Invalid Dama square coordinate: ${coord}`);
  }

  const row = Number(rowText);
  const column = Number(columnText);
  return `${FILE_NAMES.charAt(column)}${8 - row}`;
}

function copyMove(move: CheckersMove): LegalMove {
  return {
    from: move.from,
    path: [...move.path],
    captured: [...move.captured],
  };
}

function moveNotation(move: CheckersMove): string {
  const separator = move.captured.length > 0 ? "x" : "-";
  return [move.from, ...move.path].map(squareName).join(separator);
}

function copyRecord(record: MoveRecord): MoveRecord {
  return {
    ply: record.ply,
    side: record.side,
    from: record.from,
    path: [...record.path],
    captured: [...record.captured],
    notation: record.notation,
  };
}

function copyResult(result: GameResult | null): GameResult | null {
  return result === null ? null : { ...result };
}

function copyView(view: GameView): GameView {
  return {
    position: { ...view.position },
    turn: view.turn,
    legalMoves: view.legalMoves.map(copyMove),
    history: view.history.map(copyRecord),
    result: copyResult(view.result),
  };
}

export function selectionMoves(view: GameView, selection: MoveSelection): LegalMove[] {
  if (!isValidSelection(selection)) {
    return [];
  }

  return view.legalMoves
    .filter(
      (move) =>
        move.from === selection.from &&
        selection.path.length <= move.path.length &&
        selection.path.every((landing, index) => move.path[index] === landing),
    )
    .map(copyMove);
}

/** Returns a preview snapshot only; the committed match and turn are untouched. */
export function previewSelection(view: GameView, selection: MoveSelection): GameView {
  const snapshot = copyView(view);
  if (!isValidSelection(selection) || selection.path.length === 0) {
    return snapshot;
  }

  const matchingMoves = selectionMoves(view, selection);
  const canonicalMove = matchingMoves[0];
  const movingPiece = view.position[selection.from];
  const latestLanding = selection.path[selection.path.length - 1];
  if (canonicalMove === undefined || movingPiece === undefined || latestLanding === undefined) {
    return snapshot;
  }

  const alreadyCaptured = canonicalMove.captured.slice(0, selection.path.length);
  delete snapshot.position[selection.from];
  for (const capturedSquare of alreadyCaptured) {
    delete snapshot.position[capturedSquare];
  }
  snapshot.position[latestLanding] = movingPiece;
  return snapshot;
}

function toGameResult(status: GameStatus): GameResult | null {
  if (status.state === "playing") {
    return null;
  }

  if (status.state === "won") {
    return { state: "won", winner: status.winner, reason: status.reason };
  }

  return { state: "draw", reason: status.reason };
}

function sideAfter(side: Side): Side {
  return side === "white" ? "black" : "white";
}

function capitalizeSide(side: Side): string {
  return side === "white" ? "White" : "Black";
}

function recordMove(move: CheckersMove, ply: number, side: Side): MoveRecord {
  return {
    ...copyMove(move),
    ply,
    side,
    notation: moveNotation(move),
  };
}

/** Small application boundary around the pinned Dama rules engine. */
export class DamaMatch {
  readonly #game: CheckersGame;
  readonly #history: MoveRecord[];
  #applicationResult: ApplicationResult | null = null;

  /** Clones an engine-owned state when supplied; move inputs still contain only source and path. */
  constructor(engine?: CheckersGame) {
    if (engine === undefined) {
      this.#game = CheckersGame.create("turkish");
      this.#history = [];
      return;
    }

    const saved = engine.toJSON();
    this.#game = CheckersGame.fromJSON(saved);
    this.#history = saved.moves.map((move, index) => ({
      ...recordMove(
        move,
        index + 1,
        index % 2 === 0 ? saved.start.turn : sideAfter(saved.start.turn),
      ),
    }));
  }

  getView(): GameView {
    const engineResult = toGameResult(this.#game.getStatus());
    const result = engineResult ?? copyResult(this.#applicationResult);
    return {
      position: { ...this.#game.board.getPosition() },
      turn: this.#game.turn,
      legalMoves: result === null ? this.#game.getLegalMoves().map(copyMove) : [],
      history: this.#history.map(copyRecord),
      result,
    };
  }

  play(move: MoveInput): GameView {
    if (this.#applicationResult !== null) {
      throw new Error("The match has already ended.");
    }

    const side = this.#game.turn;
    const playedMove = this.#game.play({ from: move.from, path: [...move.path] });

    this.#history.push(recordMove(playedMove, this.#history.length + 1, side));

    return this.getView();
  }

  setApplicationResult(result: ApplicationResult): GameView {
    if (this.#applicationResult !== null || this.#game.getStatus().state !== "playing") {
      throw new Error("The match has already ended.");
    }

    this.#applicationResult = { ...result };
    return this.getView();
  }

  undo(plies = 1): GameView {
    if (!Number.isInteger(plies) || plies < 0) {
      throw new RangeError("Undo plies must be a non-negative integer.");
    }
    if (plies === 0) {
      return this.getView();
    }

    this.#applicationResult = null;
    const undoCount = Math.min(plies, this.#history.length);
    for (let index = 0; index < undoCount; index += 1) {
      const undone = this.#game.undo();
      if (undone === null) {
        break;
      }
      this.#history.pop();
    }

    return this.getView();
  }
}
