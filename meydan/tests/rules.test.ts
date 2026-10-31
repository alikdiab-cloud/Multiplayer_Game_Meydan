import { describe, expect, it } from "vitest";
import {
  CheckersGame,
  CHECKERS_BLACK,
  CHECKERS_WHITE,
  TurkishBoard,
  type CheckersPosition,
} from "@ymir-js/checkers";
import {
  DamaMatch,
  previewSelection,
  resultDetail,
  resultText,
  sameMove,
  selectionMoves,
  squareName,
  type GameResult,
} from "../shared/game.js";
import {
  BOT_EVALUATION_WEIGHTS,
  BOT_SEARCH_PRESETS,
  chooseBotMove,
  evaluatePosition,
  type BotDifficulty,
} from "../shared/bot.js";

type FixtureTurn = typeof CHECKERS_WHITE | typeof CHECKERS_BLACK;

function createFixtureBoard(position: CheckersPosition) {
  return new TurkishBoard().setPosition(position);
}

function createFixtureGame(position: CheckersPosition, turn: FixtureTurn): CheckersGame {
  return new CheckersGame(createFixtureBoard(position), { turn });
}

function legalDestinations(game: CheckersGame, from: string): string[] {
  return game
    .getLegalMoves(from)
    .map((move) => {
      const destination = move.path[move.path.length - 1];
      if (destination === undefined) {
        throw new Error("A legal move must include at least one landing square.");
      }
      return destination;
    })
    .sort();
}

describe("Dama initial position", () => {
  it("starts on an 8 by 8 board with 16 pieces per side and White to move", () => {
    const game = CheckersGame.create("turkish");
    const matrix = game.board.getBoardMatrix();
    const position = game.board.getPosition();
    const whitePieces = Object.values(position).filter((piece) => piece.toLowerCase() === "w");
    const blackPieces = Object.values(position).filter((piece) => piece.toLowerCase() === "b");
    const piecesByRow = (side: "w" | "b") =>
      Array.from({ length: 8 }, (_, row) =>
        Object.entries(position).filter(
          ([square, piece]) => square.startsWith(`${row}|`) && piece.toLowerCase() === side,
        ).length,
      );

    expect(game.board.variant).toBe("turkish");
    expect(matrix).toHaveLength(8);
    expect(matrix.every((row) => row.length === 8)).toBe(true);
    expect(whitePieces).toHaveLength(16);
    expect(blackPieces).toHaveLength(16);
    expect(piecesByRow("w")).toEqual([0, 8, 8, 0, 0, 0, 0, 0]);
    expect(piecesByRow("b")).toEqual([0, 0, 0, 0, 0, 8, 8, 0]);
    expect(position["1|0"]).toBe("w");
    expect(position["5|0"]).toBe("b");
    expect(game.turn).toBe(CHECKERS_WHITE);
    expect(game.getStatus()).toEqual({ state: "playing" });
    expect(game.getLegalMoves().length).toBeGreaterThan(0);
    expect(game.getLegalMoves()[0]).toEqual({
      from: "2|0",
      path: ["3|0"],
      captured: [],
    });
  });
});

describe("square notation", () => {
  it("maps engine rows from top to bottom and columns from left to right", () => {
    expect(squareName("0|0")).toBe("a8");
    expect(squareName("0|7")).toBe("h8");
    expect(squareName("7|0")).toBe("a1");
    expect(squareName("7|7")).toBe("h1");
    expect(squareName("3|4")).toBe("e5");
    expect(() => squareName("8|0")).toThrow(RangeError);
  });
});

describe("automatic draw rules and result messages", () => {
  it("uses the pinned Turkish engine defaults without enabling inactive limits", () => {
    const game = CheckersGame.create("turkish");

    expect(game.drawRules).toEqual({
      repetition: 3,
      kingMoves: false,
      loneKing: false,
      onePieceEach: true,
    });
  });

  it("detects threefold repetition from legal moves and undo removes the final occurrence", () => {
    const match = new DamaMatch(
      createFixtureGame(
        {
          "2|0": "w",
          "1|7": "w",
          "5|7": "b",
          "6|0": "b",
        },
        CHECKERS_WHITE,
      ),
    );
    const initial = match.getView();
    const cycle = [
      { from: "2|0", path: ["2|1"] },
      { from: "5|7", path: ["5|6"] },
      { from: "2|1", path: ["2|0"] },
      { from: "5|6", path: ["5|7"] },
    ];

    let view = initial;
    for (const move of cycle) {
      view = match.play(move);
    }
    expect(view.result).toBeNull();
    expect(view.position).toEqual(initial.position);

    for (const move of cycle) {
      view = match.play(move);
    }
    expect(view.result).toEqual({ state: "draw", reason: "repetition" });
    expect(view.history).toHaveLength(8);
    expect(resultText(view.result!)).toBe("Draw");
    expect(resultDetail(view.result!)).toBe(
      "The same position occurred three times with the same side to move.",
    );

    const afterUndo = match.undo();
    expect(afterUndo.result).toBeNull();
    expect(afterUndo.history).toHaveLength(7);
    expect(afterUndo.turn).toBe("black");
  });

  it("automatically draws when each side has one piece remaining", () => {
    const engine = createFixtureGame({ "4|4": "w", "4|5": "b" }, CHECKERS_WHITE);
    const match = new DamaMatch(engine);

    expect(engine.getStatus()).toEqual({ state: "draw", reason: "one-piece-each" });
    expect(match.getView().legalMoves).toEqual([]);
    expect(match.getView().result).toEqual({ state: "draw", reason: "one-piece-each" });
  });

  it("provides detail text for natural and planned application endings", () => {
    const messages: Array<{ result: GameResult; title: string; detail: string }> = [
      {
        result: { state: "won", winner: "black", reason: "no-moves" },
        title: "Black wins",
        detail: "White has no legal moves.",
      },
      {
        result: { state: "draw", reason: "repetition" },
        title: "Draw",
        detail: "The same position occurred three times with the same side to move.",
      },
      {
        result: { state: "draw", reason: "one-piece-each" },
        title: "Draw",
        detail: "Each side has one piece remaining.",
      },
      {
        result: { state: "draw", reason: "king-moves" },
        title: "Draw",
        detail: "The king-move limit was reached without a capture.",
      },
      {
        result: { state: "draw", reason: "lone-king" },
        title: "Draw",
        detail: "The lone-king endgame limit was reached.",
      },
      {
        result: { state: "won", winner: "white", reason: "resignation" },
        title: "White wins",
        detail: "Black resigned.",
      },
      {
        result: { state: "draw", reason: "agreement" },
        title: "Draw",
        detail: "Both sides agreed to a draw.",
      },
      {
        result: { state: "won", winner: "black", reason: "timeout" },
        title: "Black wins",
        detail: "White ran out of time.",
      },
      {
        result: { state: "won", winner: "white", reason: "disconnection" },
        title: "White wins",
        detail: "Black disconnected.",
      },
    ];

    for (const { result, title, detail } of messages) {
      expect(resultText(result)).toBe(title);
      expect(resultDetail(result)).toBe(detail);
    }
  });
});

describe("DamaMatch", () => {
  it("provides a fresh initial game view", () => {
    const match = new DamaMatch();
    const view = match.getView();
    const pieces = Object.values(view.position);

    expect(pieces.filter((piece) => piece.toLowerCase() === "w")).toHaveLength(16);
    expect(pieces.filter((piece) => piece.toLowerCase() === "b")).toHaveLength(16);
    expect(view.turn).toBe("white");
    expect(view.legalMoves.length).toBeGreaterThan(0);
    expect(view.history).toEqual([]);
    expect(view.result).toBeNull();
  });

  it("plays a legal full-path move and records it", () => {
    const match = new DamaMatch();
    const nextMove = match.getView().legalMoves[0];
    if (!nextMove) {
      throw new Error("The initial Dama position must have a legal move.");
    }

    const view = match.play({ from: nextMove.from, path: nextMove.path });

    expect(view.position["2|0"]).toBeUndefined();
    expect(view.position["3|0"]).toBe("w");
    expect(view.turn).toBe("black");
    expect(view.history).toEqual([
      {
        ply: 1,
        side: "white",
        from: "2|0",
        path: ["3|0"],
        captured: [],
        notation: "a6-a5",
      },
    ]);
    expect(view.result).toBeNull();
  });

  it("undoes one or many plies and safely stops at the beginning", () => {
    const match = new DamaMatch();
    const initial = match.getView();
    const whiteMove = initial.legalMoves[0];
    if (!whiteMove) {
      throw new Error("The initial Dama position must have a legal move.");
    }
    const afterWhite = match.play({ from: whiteMove.from, path: whiteMove.path });
    const blackMove = afterWhite.legalMoves[0];
    if (!blackMove) {
      throw new Error("Black must have a legal move after White moves.");
    }
    const afterBlack = match.play({ from: blackMove.from, path: blackMove.path });

    expect(afterBlack.turn).toBe("white");
    expect(afterBlack.history).toHaveLength(2);

    const afterUndoOne = match.undo();
    expect(afterUndoOne.position).toEqual(afterWhite.position);
    expect(afterUndoOne.turn).toBe(afterWhite.turn);
    expect(afterUndoOne.history).toEqual(afterWhite.history);

    const afterUndoMany = match.undo(20);
    expect(afterUndoMany.position).toEqual(initial.position);
    expect(afterUndoMany.turn).toBe(initial.turn);
    expect(afterUndoMany.legalMoves).toEqual(initial.legalMoves);
    expect(afterUndoMany.history).toEqual([]);
    expect(afterUndoMany.result).toBeNull();
    expect(match.undo()).toEqual(afterUndoMany);
  });

  it("clears an application ending when undoing its last ply", () => {
    const match = new DamaMatch();
    const initial = match.getView();
    const move = initial.legalMoves[0];
    if (!move) {
      throw new Error("The initial Dama position must have a legal move.");
    }
    match.play({ from: move.from, path: move.path });

    const ended = match.setApplicationResult({
      state: "draw",
      reason: "agreement",
    });
    expect(ended.legalMoves).toEqual([]);
    expect(ended.result).toEqual({ state: "draw", reason: "agreement" });

    const undone = match.undo();
    expect(undone.position).toEqual(initial.position);
    expect(undone.turn).toBe(initial.turn);
    expect(undone.history).toEqual([]);
    expect(undone.legalMoves).toEqual(initial.legalMoves);
    expect(undone.result).toBeNull();
  });

  it("delegates validation to the engine and ignores untrusted move metadata", () => {
    const match = new DamaMatch();
    const before = match.getView();

    expect(() => match.play({ from: "2|0", path: ["3|0", "4|0"] })).toThrow();
    expect(match.getView()).toEqual(before);

    const untrustedMove = {
      from: "2|0",
      path: ["3|0"],
      captured: ["1|0"],
      promoted: true,
      position: { "7|7": "B" },
    };
    const view = match.play(untrustedMove);

    expect(view.turn).toBe("black");
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toEqual({
      ply: 1,
      side: "white",
      from: "2|0",
      path: ["3|0"],
      captured: [],
      notation: "a6-a5",
    });
    expect(view.position["2|0"]).toBeUndefined();
    expect(view.position["3|0"]).toBe("w");
    expect(view.position["1|0"]).toBe("w");
    expect(view.position["7|7"]).toBeUndefined();
  });

  it("leaves position, turn, and history unchanged after an illegal move", () => {
    const match = new DamaMatch();
    const before = match.getView();

    expect(() => match.play({ from: "2|0", path: ["4|0"] })).toThrow();

    const after = match.getView();
    expect(after.position).toEqual(before.position);
    expect(after.turn).toBe(before.turn);
    expect(after.history).toEqual(before.history);
    expect(after.legalMoves).toEqual(before.legalMoves);
    expect(after.result).toEqual(before.result);
  });

  it("reports an engine no-moves win and rejects moves after the result", () => {
    const finishedEngine = createFixtureGame(
      {
        "7|0": "w",
        "7|1": "w",
        "7|2": "w",
        "7|3": "w",
        "7|4": "w",
        "7|5": "w",
        "7|6": "w",
        "7|7": "w",
        "0|0": "b",
        "0|7": "b",
      },
      CHECKERS_WHITE,
    );
    const match = new DamaMatch(finishedEngine);

    expect(finishedEngine.getStatus()).toEqual({
      state: "won",
      winner: "black",
      reason: "no-moves",
    });
    const finishedView = match.getView();
    expect(finishedView.result).toEqual({
      state: "won",
      winner: "black",
      reason: "no-moves",
    });
    expect(finishedView.legalMoves).toEqual([]);

    expect(() => match.play({ from: "7|0", path: ["7|1"] })).toThrow();
    expect(match.getView()).toEqual(finishedView);
  });

  it("reports a no-moves win when the side to move has no remaining material", () => {
    const match = new DamaMatch(
      createFixtureGame({ "4|4": "b", "4|5": "b" }, CHECKERS_WHITE),
    );

    expect(match.getView().position).toEqual({ "4|4": "b", "4|5": "b" });
    expect(match.getView().legalMoves).toEqual([]);
    expect(match.getView().result).toEqual({
      state: "won",
      winner: "black",
      reason: "no-moves",
    });
  });

  it("isolates the match from edits to a returned snapshot", () => {
    const match = new DamaMatch();
    const firstMove = match.getView().legalMoves[0];
    if (!firstMove) {
      throw new Error("The initial Dama position must have a legal move.");
    }
    const firstView = match.play({ from: firstMove.from, path: firstMove.path });
    const blackMove = firstView.legalMoves[0];
    if (!blackMove) {
      throw new Error("Black must have a legal move after White moves.");
    }
    match.play({ from: blackMove.from, path: blackMove.path });
    expect(firstView.history).toHaveLength(1);
    expect(firstView.history[0]).toEqual({
      ply: 1,
      side: "white",
      from: firstMove.from,
      path: firstMove.path,
      captured: [],
      notation: "a6-a5",
    });

    const snapshot = match.getView();
    const unchanged = match.getView();
    const legalMove = snapshot.legalMoves[0];
    const moveRecord = snapshot.history[0];
    if (!legalMove || !moveRecord) {
      throw new Error("The played match must have legal moves and move history.");
    }

    snapshot.position["1|0"] = "B";
    snapshot.legalMoves.pop();
    legalMove.from = "0|0";
    legalMove.path.push("0|0");
    legalMove.captured.push("1|1");
    moveRecord.from = "0|0";
    moveRecord.path.push("1|0");
    moveRecord.captured.push("2|0");
    snapshot.history.push({ ...moveRecord, ply: 99 });

    expect(match.getView()).toEqual(unchanged);
  });
});

describe("partial move selection", () => {
  it("previews a branching capture path, filters continuations, and cancels cleanly", () => {
    const match = new DamaMatch(
      createFixtureGame(
        {
          "4|0": "W",
          "0|7": "w",
          "4|1": "b",
          "4|4": "b",
        },
        CHECKERS_WHITE,
      ),
    );
    const committed = match.getView();
    const noLandingSelected = { from: "4|0", path: [] };
    const firstLanding = { from: "4|0", path: ["4|2"] };
    const alternativeFirstLanding = { from: "4|0", path: ["4|3"] };

    expect(selectionMoves(committed, noLandingSelected)).toHaveLength(6);
    const firstContinuations = selectionMoves(committed, firstLanding);
    expect(firstContinuations).toHaveLength(3);
    expect(firstContinuations.every((move) => move.path[0] === "4|2")).toBe(true);
    expect(firstContinuations.every((move) => move.captured[0] === "4|1")).toBe(true);
    expect(selectionMoves(committed, alternativeFirstLanding)).toHaveLength(3);
    expect(selectionMoves(committed, { from: "4|0", path: ["4|2", "4|4"] })).toEqual([]);

    const firstPreview = previewSelection(committed, firstLanding);
    expect(firstPreview.position).toEqual({
      "0|7": "w",
      "4|2": "W",
      "4|4": "b",
    });
    expect(firstPreview.turn).toBe(committed.turn);
    expect(firstPreview.history).toEqual(committed.history);
    expect(firstPreview.legalMoves).toEqual(committed.legalMoves);

    const finalLanding = { from: "4|0", path: ["4|2", "4|6"] };
    expect(selectionMoves(committed, finalLanding)).toEqual([
      {
        from: "4|0",
        path: ["4|2", "4|6"],
        captured: ["4|1", "4|4"],
      },
    ]);
    const completePreview = previewSelection(committed, finalLanding);
    expect(completePreview.position).toEqual({ "0|7": "w", "4|6": "W" });
    expect(completePreview.turn).toBe(committed.turn);
    expect(completePreview.history).toEqual(committed.history);
    expect(completePreview.legalMoves).toEqual(committed.legalMoves);

    expect(previewSelection(committed, noLandingSelected)).toEqual(committed);
    expect(previewSelection(committed, { from: "4|0", path: ["4|2", "4|4"] })).toEqual(
      committed,
    );
    expect(match.getView()).toEqual(committed);
  });
});

describe("ordinary Dama men", () => {
  it("uses every board square and moves orthogonally forward and sideways", () => {
    const game = createFixtureGame(
      {
        "3|3": "w",
        "3|2": "w",
        "1|5": "w",
        "2|5": "w",
        "0|7": "b",
        "7|7": "b",
      },
      CHECKERS_WHITE,
    );
    const board = game.board;

    expect(board.getBoardMatrix()).toHaveLength(8);
    expect(board.getBoardMatrix().flat()).toHaveLength(64);
    expect(board.isExistCoord("0|0")).toBe(true);
    expect(board.isExistCoord("7|7")).toBe(true);
    expect(board.getPosition()["3|2"]).toBe("w");
    expect(board.getPosition()["3|3"]).toBe("w");

    const openDestinations = legalDestinations(game, "3|3");
    expect(openDestinations).toEqual(["3|4", "4|3"]);
    expect(openDestinations).not.toContain("4|2");
    expect(openDestinations).not.toContain("4|4");
    expect(openDestinations).not.toContain("2|3");
    expect(openDestinations).not.toContain("3|2");

    const blockedForwardDestinations = legalDestinations(game, "1|5");
    expect(blockedForwardDestinations).toEqual(["1|4", "1|6"]);
    expect(blockedForwardDestinations).not.toContain("2|5");
  });

  it("mirrors forward movement for Black and forbids backward non-captures", () => {
    const game = createFixtureGame(
      {
        "4|4": "b",
        "4|5": "b",
        "6|7": "b",
        "0|0": "w",
        "0|7": "w",
      },
      CHECKERS_BLACK,
    );

    const destinations = legalDestinations(game, "4|4");
    expect(destinations).toEqual(["3|4", "4|3"]);
    expect(destinations).not.toContain("2|4");
    expect(destinations).not.toContain("5|4");
    expect(destinations).not.toContain("3|3");
    expect(destinations).not.toContain("3|5");
    expect(destinations).not.toContain("4|5");

    const unblockedGame = createFixtureGame(
      { "4|4": "b", "0|0": "w", "0|7": "w" },
      CHECKERS_BLACK,
    );
    expect(legalDestinations(unblockedGame, "4|4")).toEqual(["3|4", "4|3", "4|5"]);
  });

  it("keeps forward and sideways moves inside the board at both corners", () => {
    const whiteEdgeGame = createFixtureGame(
      {
        "0|0": "w",
        "2|2": "w",
        "7|7": "b",
        "5|5": "b",
      },
      CHECKERS_WHITE,
    );
    const blackEdgeGame = createFixtureGame(
      {
        "0|0": "w",
        "2|2": "w",
        "7|7": "b",
        "5|5": "b",
      },
      CHECKERS_BLACK,
    );

    expect(legalDestinations(whiteEdgeGame, "0|0")).toEqual(["0|1", "1|0"]);
    expect(legalDestinations(blackEdgeGame, "7|7")).toEqual(["6|7", "7|6"]);
  });
});

describe("Dama captures", () => {
  it("allows men to capture forward and sideways for each side, but not backward", () => {
    expect(
      createFixtureBoard({ "2|2": "w", "3|2": "b" }).getCaptureSequences("2|2"),
    ).toEqual([{ from: "2|2", path: ["4|2"], captured: ["3|2"] }]);
    expect(
      createFixtureBoard({ "2|2": "w", "2|1": "b" }).getCaptureSequences("2|2"),
    ).toEqual([{ from: "2|2", path: ["2|0"], captured: ["2|1"] }]);
    expect(
      createFixtureBoard({ "2|2": "w", "2|3": "b" }).getCaptureSequences("2|2"),
    ).toEqual([{ from: "2|2", path: ["2|4"], captured: ["2|3"] }]);
    expect(
      createFixtureBoard({ "4|2": "w", "3|2": "b" }).getCaptureSequences("4|2"),
    ).toEqual([]);

    expect(
      createFixtureBoard({ "5|4": "b", "4|4": "w" }).getCaptureSequences("5|4"),
    ).toEqual([{ from: "5|4", path: ["3|4"], captured: ["4|4"] }]);
    expect(
      createFixtureBoard({ "5|4": "b", "5|3": "w" }).getCaptureSequences("5|4"),
    ).toEqual([{ from: "5|4", path: ["5|2"], captured: ["5|3"] }]);
    expect(
      createFixtureBoard({ "5|4": "b", "5|5": "w" }).getCaptureSequences("5|4"),
    ).toEqual([{ from: "5|4", path: ["5|6"], captured: ["5|5"] }]);
    expect(
      createFixtureBoard({ "3|4": "b", "4|4": "w" }).getCaptureSequences("3|4"),
    ).toEqual([]);
  });

  it("forces captures and allows only the globally longest complete sequence", () => {
    const game = createFixtureGame(
      {
        "2|0": "w",
        "2|4": "w",
        "1|7": "w",
        "3|0": "b",
        "3|4": "b",
        "5|4": "b",
      },
      CHECKERS_WHITE,
    );
    const shorterCapture = {
      from: "2|0",
      path: ["4|0"],
      captured: ["3|0"],
    };
    const longestCapture = {
      from: "2|4",
      path: ["4|4", "6|4"],
      captured: ["3|4", "5|4"],
    };

    expect(game.board.getCaptureSequences("2|0")).toEqual([shorterCapture]);
    expect(game.board.getCaptureSequences("2|4")).toEqual([longestCapture]);
    expect(game.board.getPlainMoves("1|7")).toContain("1|6");
    expect(game.getLegalMoves()).toEqual([longestCapture]);
    expect(game.getLegalMoves("2|0")).toEqual([]);
    expect(game.getLegalMoves("1|7")).toEqual([]);

    const currentState = () => ({
      position: game.board.getPosition(),
      turn: game.turn,
      history: game.moves,
      status: game.getStatus(),
    });
    const before = currentState();

    expect(() => game.play({ from: "2|0", path: ["4|0"] })).toThrow();
    expect(currentState()).toEqual(before);
    expect(() => game.play({ from: "1|7", path: ["1|6"] })).toThrow();
    expect(currentState()).toEqual(before);
    expect(() => game.play({ from: "2|4", path: ["4|4"] })).toThrow();
    expect(currentState()).toEqual(before);
    expect(() => game.play({ from: "2|4", path: ["4|4", "6|4", "7|4"] })).toThrow();
    expect(currentState()).toEqual(before);
    expect(() => game.play({ from: "2|0", path: ["4|4", "6|4"] })).toThrow();
    expect(currentState()).toEqual(before);
    expect(() => game.play({ from: "5|4", path: ["4|4"] })).toThrow();
    expect(currentState()).toEqual(before);

    const wrappedView = new DamaMatch(game).play({
      from: "2|4",
      path: ["4|4", "6|4"],
    });
    expect(wrappedView.history[0]?.notation).toBe("e6xe4xe2");
    expect(wrappedView.history[0]?.path).toEqual(["4|4", "6|4"]);

    const played = game.play({ from: "2|4", path: ["4|4", "6|4"] });
    expect(played).toEqual(longestCapture);
    expect(game.moves).toHaveLength(1);
    expect(game.turn).toBe("black");
    expect(game.board.getPosition()).toEqual({
      "1|7": "w",
      "2|0": "w",
      "3|0": "b",
      "6|4": "w",
    });
  });

  it("keeps every tied globally longest capture alternative legal", () => {
    const game = createFixtureGame(
      {
        "2|0": "w",
        "2|4": "w",
        "0|7": "w",
        "3|0": "b",
        "5|0": "b",
        "3|4": "b",
        "5|4": "b",
      },
      CHECKERS_WHITE,
    );

    expect(game.getLegalMoves()).toHaveLength(2);
    expect(game.getLegalMoves()).toEqual(
      expect.arrayContaining([
        { from: "2|0", path: ["4|0", "6|0"], captured: ["3|0", "5|0"] },
        { from: "2|4", path: ["4|4", "6|4"], captured: ["3|4", "5|4"] },
      ]),
    );
  });

  it("uses a captured square as empty during a later king jump", () => {
    const game = createFixtureGame(
      {
        "4|1": "W",
        "4|2": "b",
        "3|3": "b",
        "2|2": "b",
        "3|1": "b",
        "4|4": "b",
      },
      CHECKERS_WHITE,
    );
    // The last jump crosses 4|2, removed by the first jump, to reach 4|4.
    const fullPath = ["4|3", "2|3", "2|1", "4|1", "4|5"];
    const captured = ["4|2", "3|3", "2|2", "3|1", "4|4"];

    expect(game.getLegalMoves()).toContainEqual({
      from: "4|1",
      path: fullPath,
      captured,
    });

    const played = game.play({ from: "4|1", path: fullPath });

    expect(played.captured).toEqual(captured);
    expect(game.board.getPosition()).toEqual({ "4|5": "W" });
  });
});

describe("Dama promotion", () => {
  it("promotes after the complete capture sequence, not at an intermediate landing", () => {
    const engine = createFixtureGame(
      {
        "5|2": "w",
        "1|0": "w",
        "6|2": "b",
        "7|3": "b",
        "5|4": "b",
        "0|7": "b",
      },
      CHECKERS_WHITE,
    );
    const match = new DamaMatch(engine);
    const fullMove = {
      from: "5|2",
      path: ["7|2", "7|4"],
      captured: ["6|2", "7|3"],
    };

    expect(engine.board.getItem("5|2")?.king).toBe(false);
    expect(engine.getLegalMoves()).toEqual([fullMove]);
    expect(match.getView().legalMoves).toEqual([fullMove]);

    const committed = match.getView();
    const onPromotionRank = previewSelection(committed, {
      from: "5|2",
      path: ["7|2"],
    });
    expect(onPromotionRank.position["7|2"]).toBe("w");
    expect(onPromotionRank.position["6|2"]).toBeUndefined();
    expect(onPromotionRank.position["7|3"]).toBe("b");
    expect(match.getView()).toEqual(committed);

    const completePreview = previewSelection(committed, {
      from: "5|2",
      path: ["7|2", "7|4"],
    });
    expect(completePreview.position["7|4"]).toBe("w");
    expect(match.getView()).toEqual(committed);

    const view = match.play({ from: "5|2", path: ["7|2", "7|4"] });

    expect(view.position).toEqual({
      "0|7": "b",
      "1|0": "w",
      "5|4": "b",
      "7|4": "W",
    });
    expect(view.turn).toBe("black");
    expect(view.history).toEqual([{ ply: 1, side: "white", ...fullMove, notation: "c3xc1xe1" }]);
    expect(view.result).toBeNull();
  });

  it("mirrors delayed promotion for Black on row zero", () => {
    const engine = createFixtureGame(
      {
        "2|2": "b",
        "1|0": "w",
        "1|2": "w",
        "0|3": "w",
        "2|4": "w",
        "0|7": "w",
      },
      CHECKERS_BLACK,
    );
    const match = new DamaMatch(engine);
    const fullMove = {
      from: "2|2",
      path: ["0|2", "0|4"],
      captured: ["1|2", "0|3"],
    };

    expect(engine.getLegalMoves()).toEqual([fullMove]);

    const view = match.play({ from: "2|2", path: ["0|2", "0|4"] });

    expect(view.position["0|4"]).toBe("B");
    expect(view.position["2|4"]).toBe("w");
    expect(view.turn).toBe("white");
    expect(view.history).toEqual([{ ply: 1, side: "black", ...fullMove, notation: "c6xc8xe8" }]);
    expect(view.result).toBeNull();
  });
});

describe("flying kings", () => {
  it("slides long distances orthogonally and stops before a friendly piece", () => {
    const game = createFixtureGame(
      {
        "3|3": "W",
        "3|6": "w",
        "0|0": "b",
        "7|7": "b",
      },
      CHECKERS_WHITE,
    );

    const destinations = legalDestinations(game, "3|3");
    expect(destinations).toEqual([
      "0|3",
      "1|3",
      "2|3",
      "3|0",
      "3|1",
      "3|2",
      "3|4",
      "3|5",
      "4|3",
      "5|3",
      "6|3",
      "7|3",
    ]);
    expect(destinations).not.toContain("3|6");
    expect(destinations).not.toContain("3|7");
    expect(destinations).not.toContain("4|4");

    const blockedCaptureGame = createFixtureGame(
      {
        "4|0": "W",
        "4|2": "w",
        "0|0": "w",
        "4|4": "b",
        "7|7": "b",
      },
      CHECKERS_WHITE,
    );
    expect(blockedCaptureGame.board.getCaptureSequences("4|0")).toEqual([]);
    expect(legalDestinations(blockedCaptureGame, "4|0")).not.toContain("4|4");
  });

  it("keeps distinct full paths for each legal landing choice in a capture chain", () => {
    const game = createFixtureGame(
      {
        "4|0": "W",
        "0|7": "w",
        "4|1": "b",
        "4|4": "b",
      },
      CHECKERS_WHITE,
    );
    const moves = game.getLegalMoves();
    const captures = ["4|1", "4|4"];

    expect(moves).toHaveLength(6);
    expect(moves).toEqual(
      expect.arrayContaining([
        { from: "4|0", path: ["4|2", "4|5"], captured: captures },
        { from: "4|0", path: ["4|2", "4|6"], captured: captures },
        { from: "4|0", path: ["4|2", "4|7"], captured: captures },
        { from: "4|0", path: ["4|3", "4|5"], captured: captures },
        { from: "4|0", path: ["4|3", "4|6"], captured: captures },
        { from: "4|0", path: ["4|3", "4|7"], captured: captures },
      ]),
    );

    const sameFinalSquare = moves.filter((move) => move.path.at(-1) === "4|5");
    expect(sameFinalSquare).toHaveLength(2);
    expect(sameFinalSquare).toEqual(
      expect.arrayContaining([
        { from: "4|0", path: ["4|2", "4|5"], captured: captures },
        { from: "4|0", path: ["4|3", "4|5"], captured: captures },
      ]),
    );

    const firstFullPath = moves.find(
      (move) => move.from === "4|0" && sameMove(move, { from: "4|0", path: ["4|2", "4|5"] }),
    );
    const secondFullPath = moves.find(
      (move) => move.from === "4|0" && sameMove(move, { from: "4|0", path: ["4|3", "4|5"] }),
    );
    if (!firstFullPath || !secondFullPath) {
      throw new Error("Both distinct full paths to 4|5 must be legal.");
    }
    expect(firstFullPath.path.at(-1)).toBe(secondFullPath.path.at(-1));
    expect(sameMove(firstFullPath, secondFullPath)).toBe(false);
    expect(sameMove(firstFullPath, { from: "4|0", path: ["4|2", "4|5"] })).toBe(true);

    const played = game.play({ from: "4|0", path: ["4|2", "4|5"] });
    expect(played.captured).toEqual(captures);
    expect(game.board.getPosition()).toEqual({ "0|7": "w", "4|5": "W" });
  });

  it("rejects an immediate 180-degree reversal after a capture", () => {
    const game = createFixtureGame(
      {
        "4|3": "W",
        "4|2": "b",
        "4|4": "b",
      },
      CHECKERS_WHITE,
    );
    const reversal = { from: "4|3", path: ["4|5", "4|1"] };

    // From 4|5, reversing west would jump through the just-removed 4|4 to 4|2.
    expect(game.getLegalMoves()).toHaveLength(5);
    expect(game.getLegalMoves()).not.toContainEqual({
      ...reversal,
      captured: ["4|4", "4|2"],
    });
    expect(game.board.getCaptureSequences("4|3").every((move) => move.path.length === 1)).toBe(
      true,
    );

    const before = {
      position: game.board.getPosition(),
      turn: game.turn,
      history: game.moves,
      status: game.getStatus(),
    };
    expect(() => game.play(reversal)).toThrow();
    expect({
      position: game.board.getPosition(),
      turn: game.turn,
      history: game.moves,
      status: game.getStatus(),
    }).toEqual(before);
  });
});

describe("computer position evaluation", () => {
  it("scores material from the requested perspective for White and Black", () => {
    const whiteAdvantage = new DamaMatch(
      createFixtureGame({ "4|0": "w", "4|1": "w", "1|7": "b" }, CHECKERS_WHITE),
    ).getView();
    const whiteScore = evaluatePosition(whiteAdvantage, "white");

    expect(whiteScore).toBeGreaterThan(0);
    expect(evaluatePosition(whiteAdvantage, "black")).toBe(-whiteScore);

    const blackAdvantage = new DamaMatch(
      createFixtureGame({ "3|7": "w", "4|0": "b", "4|1": "b" }, CHECKERS_BLACK),
    ).getView();
    const blackScore = evaluatePosition(blackAdvantage, "black");

    expect(blackScore).toBeGreaterThan(0);
    expect(evaluatePosition(blackAdvantage, "white")).toBe(-blackScore);
  });

  it("uses only a capped bonus for the engine's current legal move choices", () => {
    const view = new DamaMatch().getView();
    const expectedMobilityBonus = Math.min(
      view.legalMoves.length * BOT_EVALUATION_WEIGHTS.legalMove,
      BOT_EVALUATION_WEIGHTS.maxMobility,
    );

    expect(view.legalMoves.length).toBeGreaterThan(0);
    expect(evaluatePosition(view, "white")).toBe(expectedMobilityBonus);
    expect(evaluatePosition(view, "black")).toBe(-expectedMobilityBonus);
  });

  it("values an engine king above a man while leaving Black's legal moves unchanged", () => {
    const manView = new DamaMatch(
      createFixtureGame({ "0|0": "w", "3|3": "b", "5|7": "b" }, CHECKERS_BLACK),
    ).getView();
    const kingView = new DamaMatch(
      createFixtureGame({ "0|0": "W", "3|3": "b", "5|7": "b" }, CHECKERS_BLACK),
    ).getView();

    expect(kingView.legalMoves).toEqual(manView.legalMoves);
    expect(evaluatePosition(manView, "black") - evaluatePosition(kingView, "black")).toBe(
      BOT_EVALUATION_WEIGHTS.king - BOT_EVALUATION_WEIGHTS.man,
    );
  });

  it("scores wins above material and draws neutrally", () => {
    const wonView = new DamaMatch(
      createFixtureGame({ "4|4": "b", "4|5": "b" }, CHECKERS_WHITE),
    ).getView();
    expect(wonView.result).toEqual({ state: "won", winner: "black", reason: "no-moves" });
    expect(evaluatePosition(wonView, "black")).toBe(BOT_EVALUATION_WEIGHTS.terminalWin);
    expect(evaluatePosition(wonView, "white")).toBe(-BOT_EVALUATION_WEIGHTS.terminalWin);

    const materiallyBehindMatch = new DamaMatch(
      createFixtureGame(
        {
          "1|0": "w",
          "1|2": "w",
          "1|4": "w",
          "1|6": "w",
          "5|7": "b",
        },
        CHECKERS_BLACK,
      ),
    );
    const materiallyBehindView = materiallyBehindMatch.getView();
    expect(materiallyBehindView.result).toBeNull();
    expect(evaluatePosition(materiallyBehindView, "black")).toBeLessThan(0);
    const resignationResult = materiallyBehindMatch.setApplicationResult({
      state: "won",
      winner: "black",
      reason: "resignation",
    });
    expect(evaluatePosition(resignationResult, "black")).toBe(BOT_EVALUATION_WEIGHTS.terminalWin);

    const drawView = new DamaMatch(
      createFixtureGame({ "4|4": "W", "4|5": "b" }, CHECKERS_WHITE),
    ).getView();
    expect(drawView.result).toEqual({ state: "draw", reason: "one-piece-each" });
    expect(evaluatePosition(drawView, "white")).toBe(0);
    expect(evaluatePosition(drawView, "black")).toBe(0);
  });

  it("does not mutate the engine-backed view or live match", () => {
    const match = new DamaMatch(
      createFixtureGame({ "4|0": "w", "4|1": "w", "1|7": "b" }, CHECKERS_WHITE),
    );
    const view = match.getView();
    const before = JSON.stringify(view);

    evaluatePosition(view, "white");
    evaluatePosition(view, "black");

    expect(JSON.stringify(view)).toBe(before);
    expect(JSON.stringify(match.getView())).toBe(before);
  });
});

describe("computer move selection", () => {
  const difficulties: BotDifficulty[] = ["easy", "medium", "hard"];

  it.each(difficulties)("returns a complete canonical legal move at %s difficulty", (difficulty) => {
    const match = new DamaMatch();
    const view = match.getView();
    const before = JSON.stringify(view);
    const result = chooseBotMove(view, difficulty);
    const preset = BOT_SEARCH_PRESETS[difficulty];

    expect(result.move).not.toBeNull();
    expect(view.legalMoves.some((move) => sameMove(move, result.move!))).toBe(true);
    expect(result.move?.captured).toEqual(
      view.legalMoves.find((move) => sameMove(move, result.move!))?.captured,
    );
    expect(result.completedDepth).toBe(preset.maxDepth);
    expect(result.stopReason).toBe("depth");
    expect(result.nodesSearched).toBeLessThanOrEqual(preset.maxNodes);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(view)).toBe(before);
    expect(JSON.stringify(match.getView())).toBe(before);
  });

  it.each(difficulties)("keeps the engine's entire forced capture path at %s difficulty", (difficulty) => {
    const match = new DamaMatch(
      createFixtureGame(
        {
          "2|0": "w",
          "2|4": "w",
          "1|7": "w",
          "3|0": "b",
          "3|4": "b",
          "5|4": "b",
        },
        CHECKERS_WHITE,
      ),
    );
    const view = match.getView();
    const result = chooseBotMove(view, difficulty);

    expect(view.legalMoves).toEqual([
      { from: "2|4", path: ["4|4", "6|4"], captured: ["3|4", "5|4"] },
    ]);
    expect(result.move).toEqual(view.legalMoves[0]);
    expect(result.move?.path).toHaveLength(2);
  });

  it("returns a legal fallback without exceeding the node budget when search is cut short", () => {
    const match = new DamaMatch();
    const view = match.getView();
    const before = JSON.stringify(view);
    const originalNodeBudget = BOT_SEARCH_PRESETS.easy.maxNodes;

    try {
      BOT_SEARCH_PRESETS.easy.maxNodes = 1;
      const result = chooseBotMove(view, "easy");

      expect(result.stopReason).toBe("node-budget");
      expect(result.nodesSearched).toBe(1);
      expect(result.nodesSearched).toBeLessThanOrEqual(BOT_SEARCH_PRESETS.easy.maxNodes);
      expect(result.completedDepth).toBe(0);
      expect(result.move).toEqual(view.legalMoves[0]);
      expect(view.legalMoves.some((move) => sameMove(move, result.move!))).toBe(true);
      expect(JSON.stringify(view)).toBe(before);
      expect(JSON.stringify(match.getView())).toBe(before);
    } finally {
      BOT_SEARCH_PRESETS.easy.maxNodes = originalNodeBudget;
    }
  });

  it.each(difficulties)("finds an immediate no-moves win at %s difficulty", (difficulty) => {
    const match = new DamaMatch(
      createFixtureGame(
        {
          "2|1": "W",
          "1|0": "w",
          "0|2": "w",
          "2|0": "w",
          "0|0": "b",
        },
        CHECKERS_WHITE,
      ),
    );
    const view = match.getView();
    const immediateWins = view.legalMoves.filter((move) => {
      const candidate = createFixtureGame(view.position, CHECKERS_WHITE);
      candidate.play({ from: move.from, path: [...move.path] });
      const status = candidate.getStatus();
      return status.state === "won" && status.winner === "white";
    });

    expect(view.result).toBeNull();
    expect(immediateWins).toHaveLength(1);
    expect(immediateWins[0]).toEqual({ from: "2|1", path: ["0|1"], captured: [] });

    const result = chooseBotMove(view, difficulty);
    expect(result.move).toEqual(immediateWins[0]);
    expect(result.score).toBeGreaterThan(0);
    expect(JSON.stringify(match.getView())).toEqual(JSON.stringify(view));
  });

  it("returns no move for an engine-reported no-moves result without searching", () => {
    const match = new DamaMatch(
      createFixtureGame({ "4|4": "b", "4|5": "b" }, CHECKERS_WHITE),
    );
    const view = match.getView();
    const result = chooseBotMove(view, "hard");

    expect(view.result).toEqual({ state: "won", winner: "black", reason: "no-moves" });
    expect(result.move).toBeNull();
    expect(result.nodesSearched).toBe(0);
    expect(result.completedDepth).toBe(0);
    expect(result.stopReason).toBe("terminal");
  });

  it("uses increasing deterministic depth and node budgets with stable tie handling", () => {
    expect(BOT_SEARCH_PRESETS.easy.maxDepth).toBeLessThan(BOT_SEARCH_PRESETS.medium.maxDepth);
    expect(BOT_SEARCH_PRESETS.medium.maxDepth).toBeLessThan(BOT_SEARCH_PRESETS.hard.maxDepth);
    expect(BOT_SEARCH_PRESETS.easy.maxNodes).toBeLessThan(BOT_SEARCH_PRESETS.medium.maxNodes);
    expect(BOT_SEARCH_PRESETS.medium.maxNodes).toBeLessThan(BOT_SEARCH_PRESETS.hard.maxNodes);

    const view = new DamaMatch().getView();
    const first = chooseBotMove(view, "easy");
    const second = chooseBotMove(view, "easy");
    expect(second.move).toEqual(first.move);
  });
});
