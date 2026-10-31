import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckersGame,
  CHECKERS_WHITE,
  TurkishBoard,
  type CheckersPosition,
} from "@ymir-js/checkers";
import { Board } from "../src/components/Board.js";
import { DamaMatch, type GameView, type MoveInput } from "../shared/game.js";

const fixturePosition: CheckersPosition = {
  "4|3": "W",
  "4|4": "b",
  "3|5": "b",
  "2|4": "b",
  "3|3": "b",
  "0|0": "b",
  "0|2": "b",
};
const match = new DamaMatch(
  new CheckersGame(new TurkishBoard().setPosition(fixturePosition), { turn: CHECKERS_WHITE }),
);

function turnName(view: GameView): string {
  return view.turn === "white" ? "White" : "Black";
}

function CaptureHarness() {
  const [view, setView] = useState(() => match.getView());
  const committedView = match.getView();

  function playMove(move: MoveInput): void {
    setView(match.play(move));
  }

  return (
    <main className="app-shell capture-harness">
      <header className="harness-heading">
        <p className="eyebrow">Test-only capture fixture</p>
        <h1>Dama</h1>
      </header>
      <output
        className="harness-state"
        data-testid="committed-state"
        data-turn={committedView.turn}
        data-move-count={committedView.history.length}
        data-last-move-from={committedView.history.at(-1)?.from ?? ""}
        data-last-move-path={JSON.stringify(committedView.history.at(-1)?.path ?? [])}
        data-position={JSON.stringify(committedView.position)}
      >
        Committed state: {turnName(committedView)} to move · {committedView.history.length} plies
      </output>
      <section className="board-column" aria-label="Dama capture fixture board">
        <Board view={view} onMove={playMove} />
      </section>
    </main>
  );
}

const rootElement = document.getElementById("capture-fixture-root");
if (rootElement === null) {
  throw new Error("The test-only capture fixture root is missing.");
}

createRoot(rootElement).render(<CaptureHarness />);
