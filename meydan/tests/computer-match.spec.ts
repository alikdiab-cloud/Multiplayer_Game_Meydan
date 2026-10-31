import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";
import { startProductionServer } from "../server/production.js";
import { DamaMatch } from "../shared/game.js";

type HumanSide = "white" | "black";
type Difficulty = "easy" | "medium" | "hard";

function boardPiecesForPosition(position: Record<string, string>): Array<string | null> {
  return Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, column) => {
      const piece = position[`${row}|${column}`];
      if (piece === undefined) {
        return null;
      }
      const side = piece.toLowerCase() === "w" ? "White" : "Black";
      const kind = piece === piece.toLowerCase() ? "man" : "king";
      return `${side} ${kind}`;
    }),
  ).flat();
}

async function readBoardPieces(page: Page): Promise<Array<string | null>> {
  return page.locator(".board-grid button").evaluateAll((buttons) =>
    buttons.map((button) => button.querySelector("img")?.getAttribute("alt") ?? null),
  );
}

async function playFirstLegalMove(page: Page): Promise<void> {
  const historyCount = page.getByTestId("history-count");
  const countBeforeMove = await historyCount.innerText();
  await page.locator(".square-control--source").first().click();

  for (let landingIndex = 0; landingIndex < 16; landingIndex += 1) {
    const landing = page.locator(".square-control--landing").first();
    await expect(landing).toBeVisible();
    await landing.click();
    if ((await historyCount.innerText()) !== countBeforeMove) {
      return;
    }
  }

  throw new Error("The selected legal move did not finish within the board's maximum path length.");
}

async function tryUnrelatedControlsWhileThinking(page: Page): Promise<void> {
  const count = Number.parseInt(await page.getByTestId("history-count").innerText(), 10);
  await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");
  await expect(page.locator(".square-control[aria-disabled='true']")).toHaveCount(64);
  await page.locator(".square-control").first().click();
  const countAfterBoardClick = Number.parseInt(await page.getByTestId("history-count").innerText(), 10);
  expect(countAfterBoardClick).toBeLessThanOrEqual(count + 1);

  await page.getByRole("button", { name: "Read Dama rules" }).click();
  const rules = page.getByRole("dialog", { name: "Dama rules" });
  await expect(rules).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(rules).toBeHidden();
}

for (const humanSide of ["white", "black"] satisfies HumanSide[]) {
  for (const difficulty of ["easy", "medium", "hard"] satisfies Difficulty[]) {
    test(`computer plays as ${humanSide === "white" ? "Black" : "White"} at ${difficulty} difficulty`, async ({ page }) => {
      test.setTimeout(60_000);
      const server = await startDevelopmentServer({ port: 0, logUrls: false });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      try {
        await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
        await page.getByTestId("mode-computer").click();
        await page.getByLabel("Difficulty").selectOption(difficulty);
        if (humanSide === "black") {
          await page.getByLabel("Play as").selectOption("black");
          if (difficulty === "hard") {
            await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");
            await tryUnrelatedControlsWhileThinking(page);
          }
          await expect(page.getByTestId("history-count")).toHaveText("1 ply", {
            timeout: 30_000,
          });
          await expect(page.getByTestId("black-seat")).toContainText("To move");
        } else {
          await expect(page.getByTestId("white-seat")).toContainText("You");
          await expect(page.getByTestId("black-seat")).toContainText("Computer");
          await expect(page.getByTestId("turn-status")).toHaveText("White to move");
        }

        const beforeHumanMove = humanSide === "black" ? "1 ply" : "0 plies";
        await expect(page.getByTestId("history-count")).toHaveText(beforeHumanMove);
        await playFirstLegalMove(page);

        if (difficulty === "hard" && humanSide === "white") {
          const status = await page.getByTestId("computer-status").innerText();
          if (status === "Computer thinking…") {
            await tryUnrelatedControlsWhileThinking(page);
          }
        }

        const expectedAfterComputerReply = humanSide === "black" ? "3 plies" : "2 plies";
        await expect(page.getByTestId("history-count")).toHaveText(expectedAfterComputerReply, {
          timeout: 30_000,
        });
        await expect(page.getByTestId("turn-status")).toHaveText(`${humanSide === "white" ? "White" : "Black"} to move`);
        await page.waitForTimeout(250);
        await expect(page.getByTestId("history-count")).toHaveText(expectedAfterComputerReply);
        expect(pageErrors).toEqual([]);
      } finally {
        try {
          await page.close();
        } finally {
          await server.close();
          expect(server.httpServer.listening).toBe(false);
        }
      }
    });
  }
}

test("mode changes confirm before discarding, and local play remains two-player", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.name = "0";
      window.Worker = class extends NativeWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          window.name = String(Number(window.name) + 1);
          super(scriptURL, options);
        }
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("easy");
    await page.getByLabel("Play as").selectOption("black");
    await expect(page.getByTestId("history-count")).toHaveText("1 ply", { timeout: 15_000 });
    await playFirstLegalMove(page);
    await expect(page.getByTestId("history-count")).toHaveText("3 plies", { timeout: 15_000 });

    await page.getByTestId("mode-local").click();
    const confirmation = page.getByRole("dialog", { name: "Change play mode?" });
    await expect(confirmation).toBeVisible();
    await expect(page.getByTestId("history-count")).toHaveText("3 plies");
    await page.getByRole("button", { name: "Keep current game" }).click();
    await expect(confirmation).toBeHidden();
    await expect(page.getByTestId("mode-computer")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("history-count")).toHaveText("3 plies");

    await page.getByTestId("mode-local").click();
    await page.getByRole("button", { name: "Change mode" }).click();
    await expect(page.getByTestId("mode-local")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("board-flip")).toBeVisible();

    await page.evaluate(() => { window.name = "0"; });
    await playFirstLegalMove(page);
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    expect(await page.evaluate(() => window.name)).toBe("0");
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("worker startup failure can be retried without applying a fallback move", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      let failNextBotWorker = true;
      window.Worker = class extends NativeWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          if (failNextBotWorker && String(scriptURL).includes("bot.worker")) {
            failNextBotWorker = false;
            throw new Error("test-only worker startup failure");
          }
          super(scriptURL, options);
        }
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("easy");
    await playFirstLegalMove(page);

    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    await expect(page.getByTestId("computer-status")).toHaveText(
      "Computer search failed. Retry or start a new game.",
    );
    await expect(page.getByTestId("computer-retry")).toBeVisible();
    await expect(page.getByTestId("turn-status")).toContainText("Computer search failed.");

    await page.getByTestId("computer-retry").click();
    await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");
    await expect(page.getByTestId("history-count")).toHaveText("2 plies", { timeout: 15_000 });
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await page.waitForTimeout(250);
    await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("confirming a mode change during search cancels the old worker request", async ({ page }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const openingPieces = boardPiecesForPosition(new DamaMatch().getView().position);
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("hard");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");

    await page.getByTestId("mode-local").click();
    const confirmation = page.getByRole("dialog", { name: "Change play mode?" });
    await expect(confirmation).toBeVisible();
    await page.getByRole("button", { name: "Change mode" }).click();
    await expect(confirmation).toBeHidden();
    await expect(page.getByTestId("mode-local")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    expect(await readBoardPieces(page)).toEqual(openingPieces);

    await page.waitForTimeout(15_000);
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("undo during a hard search ignores the previous position's reply", async ({ page }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const openingPieces = boardPiecesForPosition(new DamaMatch().getView().position);
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("hard");
    await playFirstLegalMove(page);
    expect(await readBoardPieces(page)).not.toEqual(openingPieces);
    await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    await page.getByTestId("undo-button").click();
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    await page.waitForTimeout(15_000);
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("computer undo after a completed round returns to the previous human position", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const openingPieces = boardPiecesForPosition(new DamaMatch().getView().position);
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("easy");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("history-count")).toHaveText("2 plies", { timeout: 15_000 });
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).not.toEqual(openingPieces);

    await page.getByTestId("undo-button").click();
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("reset during a computer search clears the old position and result", async ({ page }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const openingPieces = boardPiecesForPosition(new DamaMatch().getView().position);
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("hard");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).not.toEqual(openingPieces);

    await page.getByTestId("new-game-button").click();
    const confirmation = page.getByRole("dialog", { name: "Start a new game?" });
    await expect(confirmation).toBeVisible();
    await page.getByRole("button", { name: "Start new game" }).click();
    await expect(confirmation).toBeHidden();
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    await page.waitForTimeout(15_000);
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("Black-side opening undo stays disabled until a human turn can be undone", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("easy");
    await page.getByLabel("Play as").selectOption("black");
    await expect(page.getByTestId("history-count")).toHaveText("1 ply", { timeout: 15_000 });
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    const afterOpeningPieces = await readBoardPieces(page);
    expect(afterOpeningPieces).not.toEqual(boardPiecesForPosition(new DamaMatch().getView().position));
    const undo = page.getByTestId("undo-button");
    await expect(undo).toBeDisabled();

    await playFirstLegalMove(page);
    await expect(page.getByTestId("history-count")).toHaveText("3 plies", { timeout: 15_000 });
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).not.toEqual(afterOpeningPieces);
    await expect(undo).toBeEnabled();

    await undo.click();
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).toEqual(afterOpeningPieces);
    await expect(undo).toBeDisabled();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    expect(await readBoardPieces(page)).toEqual(afterOpeningPieces);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("finished computer match undo clears the result and restores the human opening", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=computer-terminal`,
      { waitUntil: "load" },
    );
    const openingPieces = boardPiecesForPosition(new DamaMatch().getView().position);
    await expect(page.getByTestId("mode-computer")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    await expect(page.getByTestId("scorebook-result")).toContainText("Draw");
    await expect(page.getByTestId("turn-status")).toContainText("Draw");
    await expect(page.getByTestId("undo-button")).toBeEnabled();

    await page.getByTestId("undo-button").click();
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
    expect(await readBoardPieces(page)).toEqual(openingPieces);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("production computer play loads the emitted worker and commits one reply", async ({ page }) => {
  const clientDirectory = resolve(process.cwd(), "dist/client");
  test.skip(!existsSync(resolve(clientDirectory, "index.html")), "Run the production build first.");
  const server = await startProductionServer({
    port: 0,
    clientDirectory,
    logUrls: false,
  });
  const pageErrors: string[] = [];
  const workerUrls: string[] = [];
  const workerResponses: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("worker", (worker) => workerUrls.push(worker.url()));
  page.on("response", (response) => {
    if (/\/assets\/bot\.worker-[^/]+\.js$/.test(new URL(response.url()).pathname)) {
      workerResponses.push(response.status());
    }
  });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.getByTestId("mode-computer").click();
    await page.getByLabel("Difficulty").selectOption("easy");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("history-count")).toHaveText("2 plies", { timeout: 15_000 });
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await page.waitForTimeout(250);
    await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    expect(workerUrls).toHaveLength(1);
    expect(workerUrls[0]).toMatch(/bot\.worker-[^/]+\.js$/);
    expect(workerResponses).toEqual([200]);
    expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});
