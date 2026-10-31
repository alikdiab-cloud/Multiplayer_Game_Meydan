import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

const viewportWidths = [320, 390, 1024, 1440] as const;

function squareFromLabel(label: string | null): string {
  const square = label?.match(/^([a-h][1-8]),/)?.[1];
  if (square === undefined) {
    throw new Error(`Expected an accessible Dama square label, received ${String(label)}.`);
  }
  return square;
}

async function moveFocusByArrows(
  page: Page,
  fromSquare: string,
  toSquare: string,
  flipped = false,
): Promise<void> {
  const visualIndex = (square: string): { row: number; column: number } => {
    const row = 8 - Number(square.slice(1));
    const column = square.charCodeAt(0) - "a".charCodeAt(0);
    return flipped ? { row: 7 - row, column: 7 - column } : { row, column };
  };
  const from = visualIndex(fromSquare);
  const to = visualIndex(toSquare);

  for (let row = from.row; row < to.row; row += 1) await page.keyboard.press("ArrowDown");
  for (let row = from.row; row > to.row; row -= 1) await page.keyboard.press("ArrowUp");
  for (let column = from.column; column < to.column; column += 1) {
    await page.keyboard.press("ArrowRight");
  }
  for (let column = from.column; column > to.column; column -= 1) {
    await page.keyboard.press("ArrowLeft");
  }
}

async function focusedSquare(page: Page): Promise<string> {
  return squareFromLabel(await page.locator(".board-grid button:focus").getAttribute("aria-label"));
}

async function moveToFirstLegalSource(page: Page, flipped = false): Promise<void> {
  const currentSquare = await focusedSquare(page);
  const source = page.locator(".square-control--source").first();
  const sourceSquare = squareFromLabel(await source.getAttribute("aria-label"));
  await moveFocusByArrows(page, currentSquare, sourceSquare, flipped);
  await page.keyboard.press("Enter");
}

async function moveToFirstLanding(page: Page, fromSquare: string, flipped = false): Promise<void> {
  const landing = page.locator(".square-control--landing").first();
  await expect(landing).toBeVisible();
  const landingSquare = squareFromLabel(await landing.getAttribute("aria-label"));
  await moveFocusByArrows(page, fromSquare, landingSquare, flipped);
  await page.keyboard.press("Enter");
}

async function commitFirstKeyboardMove(page: Page, flipped = false): Promise<void> {
  const sourceSquare = await focusedSquare(page);
  await page.keyboard.press("Enter");
  await moveToFirstLanding(page, sourceSquare, flipped);
}

async function readGridRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.locator(".board-grid").boundingBox();
  if (rect === null) {
    throw new Error("The Dama board was not visible in the browser.");
  }
  return rect;
}

async function assertResponsiveLayout(page: Page, width: number): Promise<void> {
  const visualCheck = await page.evaluate(() => {
    const grid = document.querySelector(".board-grid");
    if (!(grid instanceof HTMLElement)) {
      return { missingBoard: true as const };
    }

    const gridRect = grid.getBoundingClientRect();
    const visibleButtons = Array.from(document.querySelectorAll("button"))
      .map((button) => ({
        button,
        rect: button.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    const smallButtons = visibleButtons
      .filter(({ rect }) => rect.width < 24 || rect.height < 24)
      .map(({ button, rect }) => ({
        label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "button",
        width: rect.width,
        height: rect.height,
      }));
    const overlaps: string[] = [];
    for (let leftIndex = 0; leftIndex < visibleButtons.length; leftIndex += 1) {
      const left = visibleButtons[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < visibleButtons.length; rightIndex += 1) {
        const right = visibleButtons[rightIndex];
        if (right === undefined) continue;
        const overlapWidth = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
        const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
        if (overlapWidth > 1 && overlapHeight > 1) {
          overlaps.push(
            `${left.button.getAttribute("aria-label") ?? left.button.textContent}|${right.button.getAttribute("aria-label") ?? right.button.textContent}`,
          );
        }
      }
    }

    return {
      missingBoard: false as const,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      squareCount: grid.querySelectorAll("button").length,
      pieceCount: grid.querySelectorAll(".piece-art").length,
      boardWidth: gridRect.width,
      boardHeight: gridRect.height,
      squareWidth: grid.querySelector("button")?.getBoundingClientRect().width ?? 0,
      squareHeight: grid.querySelector("button")?.getBoundingClientRect().height ?? 0,
      brokenImages: Array.from(document.images)
        .filter((image) => !image.complete || image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src),
      smallButtons,
      overlaps,
    };
  });

  expect(visualCheck.missingBoard).toBe(false);
  if (visualCheck.missingBoard) return;
  expect(visualCheck.viewportWidth).toBe(width);
  expect(visualCheck.documentWidth).toBeLessThanOrEqual(width);
  expect(visualCheck.squareCount).toBe(64);
  expect(visualCheck.pieceCount).toBe(32);
  expect(visualCheck.boardWidth).toBeGreaterThan(0);
  expect(Math.abs(visualCheck.boardWidth - visualCheck.boardHeight)).toBeLessThanOrEqual(2);
  expect(Math.abs(visualCheck.squareWidth - visualCheck.squareHeight)).toBeLessThanOrEqual(1);
  expect(visualCheck.brokenImages).toEqual([]);
  expect(visualCheck.smallButtons).toEqual([]);
  expect(visualCheck.overlaps).toEqual([]);
}

async function downloadWithKeyboard(page: Page): Promise<{ filename: string; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Enter"),
  ]);
  const path = await download.path();
  if (path === null) {
    throw new Error("The browser did not provide a scorebook download.");
  }
  return { filename: download.suggestedFilename(), text: await readFile(path, "utf8") };
}

test("local Dama journey works by keyboard at 320, 390, 1024, and 1440 pixels", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const screenshotDirectory = join(process.cwd(), "test-results", "local-journey");
  await mkdir(screenshotDirectory, { recursive: true });
  const pageErrors: string[] = [];
  const missingAssets: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if ((path.startsWith("/pieces/") || path.startsWith("/art/")) && response.status() >= 400) {
      missingAssets.push(`${response.status()} ${path}`);
    }
  });

  try {
    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
      await expect(page).toHaveTitle("Meydan | The Dama Club");
      await assertResponsiveLayout(page, width);

      const startingGridRect = await readGridRect(page);
      const historyCount = page.getByTestId("history-count");
      await page.keyboard.press("Tab");
      const firstSource = page.locator(".board-grid button:focus");
      await expect(firstSource).toHaveAttribute("aria-label", /selectable piece/);
      await page.keyboard.press("Enter");
      await expect(page.locator(".square-control--selected")).toHaveCount(1);
      expect(await readGridRect(page)).toEqual(startingGridRect);
      await page.keyboard.press("Escape");
      await expect(page.locator(".square-control--selected, .square-control--landing")).toHaveCount(0);
      expect(await readGridRect(page)).toEqual(startingGridRect);

      await commitFirstKeyboardMove(page);
      await expect(historyCount).toHaveText("1 ply");
      await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
      const whiteNotation = await page.locator(".history-notation").first().innerText();
      expect(whiteNotation).toContain("-");
      expect(whiteNotation).not.toContain("x");
      expect(await readGridRect(page)).toEqual(startingGridRect);

      await moveToFirstLegalSource(page);
      const focusedAfterSelect = await focusedSquare(page);
      await moveToFirstLanding(page, focusedAfterSelect);
      await expect(historyCount).toHaveText("2 plies");
      await expect(page.getByTestId("turn-status")).toHaveText("White to move");
      expect(await readGridRect(page)).toEqual(startingGridRect);
      await assertResponsiveLayout(page, width);

      await page.screenshot({
        path: join(screenshotDirectory, `meydan-${width}.png`),
        fullPage: true,
      });

      const flipButton = page.getByRole("button", { name: "Flip board orientation" });
      const rulesButton = page.getByRole("button", { name: "Read Dama rules" });
      const undoButton = page.getByRole("button", { name: "Undo last local ply" });
      const newGameButton = page.getByRole("button", { name: "Start a new local Dama game" });
      await page.keyboard.press("Tab");
      await expect(flipButton).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(rulesButton).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Turn sound on" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(undoButton).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(historyCount).toHaveText("1 ply");
      await expect(page.getByTestId("turn-status")).toHaveText("Black to move");

      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(flipButton).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(flipButton).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".rank-labels span").first()).toHaveText("1");
      await expect(page.locator(".file-labels span").first()).toHaveText("h");

      await page.keyboard.press("Tab");
      await expect(rulesButton).toBeFocused();
      await page.keyboard.press("Enter");
      const rulesDialog = page.getByRole("dialog", { name: "Dama rules" });
      await expect(rulesDialog).toBeVisible();
      await expect(rulesDialog).toContainText("greatest number of pieces");
      await page.keyboard.press("Escape");
      await expect(rulesDialog).toBeHidden();
      await expect(rulesButton).toBeFocused();

      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(newGameButton).toBeFocused();
      await page.keyboard.press("Enter");
      const newGameDialog = page.getByRole("dialog", { name: "Start a new game?" });
      await expect(newGameDialog).toBeVisible();
      await expect(page.getByRole("button", { name: "Keep current game" })).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(newGameDialog).toBeHidden();
      await expect(page.getByTestId("turn-status")).toHaveText("White to move");
      await expect(historyCount).toHaveText("0 plies");
      await expect(page.getByTestId("empty-history")).toBeVisible();
      await expect(newGameButton).toBeFocused();

      await page.keyboard.press("Tab");
      const downloadButton = page.getByRole("button", { name: "Download scorebook" });
      await expect(downloadButton).toBeFocused();
      const emptyScorebook = await downloadWithKeyboard(page);
      expect(emptyScorebook.filename).toMatch(/^meydan-dama-scorebook-\d{4}-\d{2}-\d{2}\.txt$/);
      expect(emptyScorebook.text).toContain("Mode: Local two-player");
      expect(emptyScorebook.text).toContain("No moves recorded.");

      await page.goto(
        `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=capture`,
        { waitUntil: "load" },
      );
      await page.keyboard.press("Tab");
      await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
        "aria-label",
        "a8, White man, selectable piece",
      );
      const captureGridRect = await readGridRect(page);
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "a6, White man, selected" })).toBeVisible();
      await expect(page.getByRole("button", { name: "a7, empty" })).toBeVisible();
      await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();
      await expect(page.getByTestId("history-count")).toHaveText("1 ply");
      expect(await readGridRect(page)).toEqual(captureGridRect);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("history-count")).toHaveText("2 plies");
      await expect(page.locator(".history-notation").last()).toHaveText("a8xa6xc6");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(undoButton).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("history-count")).toHaveText("1 ply");
      await expect(page.getByTestId("turn-status")).toHaveText("White to move");
      await expect(page.getByRole("button", { name: "a7, Black man" })).toBeVisible();
      await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();

      await page.goto(
        `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=promotion`,
        { waitUntil: "load" },
      );
      await page.keyboard.press("Tab");
      await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
        "aria-label",
        "c3, White man, selectable piece",
      );
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "c1, White man, selected" })).toBeVisible();
      await expect(page.getByRole("button", { name: "e1, empty, legal landing" })).toBeVisible();
      await expect(page.getByTestId("turn-status")).toHaveText("White to move");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "e1, White king" })).toBeVisible();
      await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
      await expect(page.getByTestId("history-count")).toHaveText("1 ply");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(undoButton).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("history-count")).toHaveText("0 plies");
      await expect(page.getByRole("button", { name: "c3, White man, selectable piece" })).toBeVisible();
      await expect(page.getByRole("button", { name: "e1, empty" })).toBeVisible();
      await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    }

    expect(missingAssets).toEqual([]);
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
