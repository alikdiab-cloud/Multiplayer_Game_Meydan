import { createRoot } from "react-dom/client";
import {
  CheckersGame,
  CHECKERS_BLACK,
  CHECKERS_WHITE,
  TurkishBoard,
  type CheckersPosition,
} from "@ymir-js/checkers";
import App from "../src/App.js";
import { DamaMatch } from "../shared/game.js";

function createTerminalMatch(): DamaMatch {
  const position: CheckersPosition = {
    "4|0": "W",
    "4|4": "b",
    "7|7": "w",
  };
  const match = new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
  match.play({ from: "4|0", path: ["4|5"] });
  return match;
}

function createComputerTerminalMatch(): DamaMatch {
  const match = new DamaMatch();
  const humanOpening = match.getView().legalMoves[0];
  if (humanOpening === undefined) {
    throw new Error("The fixture's human opening move is missing.");
  }
  match.play({ from: humanOpening.from, path: [...humanOpening.path] });

  const computerReply = match.getView().legalMoves[0];
  if (computerReply === undefined) {
    throw new Error("The fixture's computer reply is missing.");
  }
  match.play({ from: computerReply.from, path: [...computerReply.path] });
  match.setApplicationResult({ state: "draw", reason: "agreement" });
  return match;
}

function createComputerTacticalCaptureMatch(): DamaMatch {
  const position: CheckersPosition = {
    "2|0": "w",
    "2|4": "w",
    "1|7": "w",
    "3|0": "b",
    "3|4": "b",
    "5|4": "b",
  };
  return new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
}

function createComputerNoMovesMatch(): DamaMatch {
  const position: CheckersPosition = {
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
  };
  return new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
}

function createCapturePreviewMatch(): DamaMatch {
  const position: CheckersPosition = {
    "0|0": "w",
    "0|7": "w",
    "1|0": "b",
    "2|1": "b",
    "7|7": "b",
  };
  const match = new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_BLACK }),
  );
  match.play({ from: "7|7", path: ["6|7"] });
  return match;
}

function createScorebookCaptureMatch(): DamaMatch {
  const position: CheckersPosition = {
    "0|0": "w",
    "0|7": "w",
    "1|0": "b",
    "2|1": "b",
    "7|7": "b",
  };
  return new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
}

function createScorebookLongMatch(): DamaMatch {
  const match = new DamaMatch();
  let seed = 17;
  for (let ply = 0; ply < 18; ply += 1) {
    const view = match.getView();
    if (view.result !== null || view.legalMoves.length === 0) {
      break;
    }

    seed = (seed * 48_271) % 2_147_483_647;
    const move = view.legalMoves[seed % view.legalMoves.length];
    if (move === undefined) {
      break;
    }
    match.play({ from: move.from, path: [...move.path] });
  }
  return match;
}

function createPromotionMatch(): DamaMatch {
  const position: CheckersPosition = {
    "5|2": "w",
    "1|0": "w",
    "6|2": "b",
    "7|3": "b",
    "5|4": "b",
    "0|7": "b",
  };
  return new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
}

function createBoardFlipMatch(): DamaMatch {
  const position: CheckersPosition = {
    "2|0": "w",
    "1|3": "w",
    "3|7": "w",
    "5|1": "b",
    "6|6": "b",
    "5|4": "b",
  };
  return new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
}

const scenario = new URLSearchParams(window.location.search).get("scenario");
const initialMatch = (() => {
  switch (scenario) {
    case "capture":
      return createCapturePreviewMatch();
    case "scorebook-capture":
      return createScorebookCaptureMatch();
    case "scorebook-long":
      return createScorebookLongMatch();
    case "promotion":
      return createPromotionMatch();
    case "terminal":
      return createTerminalMatch();
    case "computer-terminal":
      return createComputerTerminalMatch();
    case "computer-capture":
      return createComputerTacticalCaptureMatch();
    case "computer-no-moves":
      return createComputerNoMovesMatch();
    case "flip":
      return createBoardFlipMatch();
    default:
      return null;
  }
})();

if (initialMatch === null) {
  throw new Error("Choose a valid local match fixture scenario.");
}

const rootElement = document.getElementById("finished-fixture-root");
if (rootElement === null) {
  throw new Error("The test-only match fixture root is missing.");
}

createRoot(rootElement).render(
  <App
    initialMatch={initialMatch}
    initialPlayMode={scenario?.startsWith("computer-") ? "computer" : "local"}
    initialHumanSide={scenario === "computer-capture" || scenario === "computer-no-moves"
      ? "black"
      : "white"}
    {...(scenario === "computer-capture" ? { initialDifficulty: "easy" as const } : {})}
  />,
);
