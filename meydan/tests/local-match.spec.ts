import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

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

async function readBoardLabels(page: Page): Promise<Array<string | null>> {
  return page.locator(".board-grid button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")),
  );
}

async function openLocalApp(page: Page, server: Awaited<ReturnType<typeof startDevelopmentServer>>) {
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
}

test("local undo and new game preserve the match lifecycle", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await openLocalApp(page, server);
    const turnStatus = page.getByTestId("turn-status");
    const historyCount = page.getByTestId("history-count");
    const history = page.getByTestId("move-history");
    const undoButton = page.getByRole("button", { name: "Undo last local ply" });
    const newGameButton = page.getByRole("button", { name: "Start a new local Dama game" });
    const openingBoard = await readBoardLabels(page);

    await expect(page).toHaveTitle("Meydan | The Dama Club");
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("0 plies");
    await expect(undoButton).toBeDisabled();
    await expect(newGameButton).toHaveAttribute(
      "title",
      "Start a fresh game. Moves will be confirmed before they are discarded.",
    );

    await playFirstLegalMove(page);
    await expect(turnStatus).toHaveText("Black to move");
    await expect(historyCount).toHaveText("1 ply");
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("0 plies");
    expect(await readBoardLabels(page)).toEqual(openingBoard);
    await expect(page.getByTestId("empty-history")).toBeVisible();

    for (let ply = 0; ply < 4; ply += 1) {
      await playFirstLegalMove(page);

      const nextSide = ply % 2 === 0 ? "Black" : "White";
      const movingSide = ply % 2 === 0 ? "white" : "black";
      await expect(turnStatus).toHaveText(`${nextSide} to move`);
      await expect(historyCount).toHaveText(`${ply + 1} ${ply === 0 ? "ply" : "plies"}`);
      await expect(history).toHaveAttribute("data-ply-count", String(ply + 1));
      await expect(history.locator(".history-row").nth(ply)).toHaveAttribute(
        "data-side",
        movingSide,
      );
      await expect(history.locator(".history-notation").nth(ply)).not.toBeEmpty();
    }

    await expect(history.locator(".history-row")).toHaveCount(4);
    await page.locator(".square-control--source").first().click();
    await expect(page.locator(".square-control--selected")).toHaveCount(1);

    await newGameButton.click();
    const confirmation = page.getByRole("dialog", { name: "Start a new game?" });
    const keepGameButton = page.getByRole("button", { name: "Keep current game" });
    await expect(confirmation).toBeVisible();
    await expect(keepGameButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(newGameButton).toBeFocused();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("4 plies");
    await expect(page.locator(".square-control--selected")).toHaveCount(1);

    await newGameButton.click();
    await expect(confirmation).toBeVisible();
    await expect(keepGameButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Start new game" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(confirmation).toBeHidden();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("0 plies");
    await expect(page.getByTestId("empty-history")).toBeVisible();
    await expect(page.locator(".square-control--selected, .square-control--landing")).toHaveCount(0);
    await expect(newGameButton).toBeFocused();
    expect(await readBoardLabels(page)).toEqual(openingBoard);
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

test("new-game dialog stays keyboard-contained and restores focus on a small viewport", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await openLocalApp(page, server);

    const historyCount = page.getByTestId("history-count");
    await page.keyboard.press("Tab");
    const source = page.locator(".board-grid button:focus");
    await expect(source).toHaveAttribute("aria-label", /selectable piece/);
    const sourceName = await source.getAttribute("aria-label");
    const sourceSquare = sourceName?.split(",")[0];
    if (sourceSquare === undefined) {
      throw new Error("The board did not expose the focused source square name.");
    }
    await page.keyboard.press("Enter");

    const firstLanding = page.locator(".square-control--landing").first();
    const landingName = await firstLanding.getAttribute("aria-label");
    const landingSquare = landingName?.split(",")[0];
    if (landingSquare === undefined) {
      throw new Error("The selected piece did not expose a legal landing square.");
    }

    const sourceFile = sourceSquare.charCodeAt(0) - "a".charCodeAt(0);
    const landingFile = landingSquare.charCodeAt(0) - "a".charCodeAt(0);
    const sourceRow = 8 - Number(sourceSquare.slice(1));
    const landingRow = 8 - Number(landingSquare.slice(1));
    for (let row = sourceRow; row < landingRow; row += 1) await page.keyboard.press("ArrowDown");
    for (let row = sourceRow; row > landingRow; row -= 1) await page.keyboard.press("ArrowUp");
    for (let column = sourceFile; column < landingFile; column += 1) await page.keyboard.press("ArrowRight");
    for (let column = sourceFile; column > landingFile; column -= 1) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await expect(historyCount).toHaveText("1 ply");

    const flipButton = page.getByRole("button", { name: "Flip board orientation" });
    const rulesButton = page.getByRole("button", { name: "Read Dama rules" });
    const soundButton = page.getByTestId("sound-toggle");
    const undoButton = page.getByRole("button", { name: "Undo last local ply" });
    const newGameButton = page.getByRole("button", { name: "Start a new local Dama game" });
    await page.keyboard.press("Tab");
    await expect(flipButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(rulesButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(soundButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(undoButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(newGameButton).toBeFocused();
    await page.keyboard.press("Enter");

    const confirmation = page.getByRole("dialog", { name: "Start a new game?" });
    const keepGameButton = page.getByRole("button", { name: "Keep current game" });
    const confirmButton = page.getByRole("button", { name: "Start new game" });
    const closeButton = page.getByRole("button", { name: "Close dialog" });
    await expect(confirmation).toBeVisible();
    await expect(keepGameButton).toBeFocused();
    const modalContent = confirmation.locator(".modal-content");
    await modalContent.evaluate((element) => {
      const tallContent = document.createElement("div");
      tallContent.setAttribute("aria-hidden", "true");
      tallContent.style.height = "900px";
      element.append(tallContent);
    });
    const contentSize = await modalContent.evaluate((element) => ({
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(contentSize.scrollHeight).toBeGreaterThan(contentSize.height);
    await modalContent.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole("button", { name: "Close dialog" })).toBeVisible();
    const dialogBounds = await confirmation.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(320);
    await expect(closeButton).toBeVisible();
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);

    for (let tab = 0; tab < 4; tab += 1) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest("dialog"))),
      ).toBe(true);
    }
    await expect(confirmButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(newGameButton).toBeFocused();
    await expect(historyCount).toHaveText("1 ply");

    await page.keyboard.press("Enter");
    await expect(confirmation).toBeVisible();
    await expect(keepGameButton).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(confirmation).toBeHidden();
    await expect(newGameButton).toBeFocused();
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

test("undo cancels an unfinished capture preview before reversing one committed ply", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=capture`,
      { waitUntil: "load" },
    );
    const turnStatus = page.getByTestId("turn-status");
    const historyCount = page.getByTestId("history-count");

    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("1 ply");
    await page.getByRole("button", { name: "a8, White man, selectable piece" }).click();
    await page.getByRole("button", { name: "a6, empty, legal landing" }).click();
    await expect(page.getByRole("button", { name: "a6, White man, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "a7, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("1 ply");
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

    await page.getByRole("button", { name: "Undo last local ply" }).click();
    await expect(turnStatus).toHaveText("Black to move");
    await expect(historyCount).toHaveText("0 plies");
    await expect(page.getByTestId("empty-history")).toBeVisible();
    await expect(page.locator(".square-control--selected, .square-control--landing")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "a8, White man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "a7, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo last local ply" })).toBeDisabled();
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

test("undo restores the playing position after a natural terminal move", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=terminal`,
      { waitUntil: "load" },
    );
    const turnStatus = page.getByTestId("turn-status");
    const historyCount = page.getByTestId("history-count");
    const undoButton = page.getByRole("button", { name: "Undo last local ply" });

    await expect(turnStatus).toContainText("White wins");
    await expect(turnStatus).toContainText("Black has no legal moves.");
    await expect(historyCount).toHaveText("1 ply");
    await expect(page.locator('.square-control[aria-disabled="true"]')).toHaveCount(64);
    await expect(undoButton).toBeEnabled();

    await page.getByRole("button", { name: "f4, White king" }).click({ force: true });
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "f4, White king",
    );
    await expect(historyCount).toHaveText("1 ply");
    await expect(turnStatus).toContainText("White wins");

    await undoButton.click();
    await expect(page.getByRole("button", { name: "Start a new local Dama game" })).toBeFocused();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("0 plies");
    await expect(page.getByTestId("empty-history")).toBeVisible();
    await expect(page.getByRole("button", { name: "a4, White king, selectable piece" })).toBeVisible();
    await expect(page.getByRole("button", { name: "e4, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "h1, White man" })).toBeVisible();
    await expect(page.locator('.square-control[aria-disabled="true"]')).toHaveCount(0);
    await expect(undoButton).toBeDisabled();
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
