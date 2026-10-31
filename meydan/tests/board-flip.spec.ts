import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

async function readPosition(page: Page): Promise<Record<string, string | null>> {
  const position = await page.locator(".board-grid button").evaluateAll((buttons) => {
    const entries = buttons.map((button) => {
      const label = button.getAttribute("aria-label") ?? "";
      const [square = "", piece = "empty"] = label.split(", ");
      return [square, piece === "empty" ? null : piece] as const;
    });
    return Object.fromEntries(entries.sort(([first], [second]) => first.localeCompare(second)));
  });
  return position;
}

async function readHistory(page: Page): Promise<string[]> {
  return page.locator(".history-row").evaluateAll((rows) =>
    rows.map(
      (row) =>
        `${row.getAttribute("data-side") ?? ""}|${row.querySelector(".history-notation")?.textContent ?? ""}`,
    ),
  );
}

async function boardDimensions(page: Page): Promise<{ width: number; height: number }> {
  const bounds = await page.locator(".board-plane").boundingBox();
  if (bounds === null) {
    throw new Error("The Dama board is not visible in the browser.");
  }
  return { width: bounds.width, height: bounds.height };
}

async function expectCoordinateLabels(page: Page, flipped: boolean): Promise<void> {
  const ranks = await page.locator(".rank-labels span").allTextContents();
  const files = await page.locator(".file-labels span").allTextContents();
  expect(ranks).toEqual(flipped ? ["1", "2", "3", "4", "5", "6", "7", "8"] : ["8", "7", "6", "5", "4", "3", "2", "1"]);
  expect(files).toEqual(flipped ? ["h", "g", "f", "e", "d", "c", "b", "a"] : ["a", "b", "c", "d", "e", "f", "g", "h"]);
}

test("flipping changes only board presentation and preserves legal coordinate identity", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=flip`,
      { waitUntil: "load" },
    );

    const flipButton = page.getByRole("button", { name: "Flip board orientation" });
    const firstSquare = page.locator(".board-grid button").first();
    const lastSquare = page.locator(".board-grid button").last();
    const boardSeats = page.locator(".board-column .seat-line");

    await expect(flipButton).toHaveAttribute("aria-pressed", "false");
    await expectCoordinateLabels(page, false);
    await expect(firstSquare).toHaveAttribute("aria-label", "a8, empty");
    await expect(lastSquare).toHaveAttribute("aria-label", "h1, empty");
    await expect(boardSeats.nth(0)).toHaveAttribute("data-testid", "white-seat");
    await expect(boardSeats.nth(1)).toHaveAttribute("data-testid", "black-seat");
    const initialBoardDimensions = await boardDimensions(page);

    await page.getByRole("button", { name: "a6, White man, selectable piece" }).click();
    await page.getByRole("button", { name: "a5, empty, legal landing" }).click();
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");

    const positionAfterMove = await readPosition(page);
    const historyAfterMove = await readHistory(page);
    expect(historyAfterMove).toHaveLength(1);

    await flipButton.click();
    await expect(flipButton).toHaveAttribute("aria-pressed", "true");
    await expectCoordinateLabels(page, true);
    await expect(page.locator(".board-grid button").first()).toHaveAttribute("aria-label", "h1, empty");
    await expect(page.locator(".board-grid button").last()).toHaveAttribute("aria-label", "a8, empty");
    await expect(boardSeats.nth(0)).toHaveAttribute("data-testid", "black-seat");
    await expect(boardSeats.nth(1)).toHaveAttribute("data-testid", "white-seat");
    expect(await readPosition(page)).toEqual(positionAfterMove);
    expect(await readHistory(page)).toEqual(historyAfterMove);
    expect(await boardDimensions(page)).toEqual(initialBoardDimensions);

    await flipButton.click();
    await expect(flipButton).toHaveAttribute("aria-pressed", "false");
    await expectCoordinateLabels(page, false);
    expect(await readPosition(page)).toEqual(positionAfterMove);
    expect(await readHistory(page)).toEqual(historyAfterMove);
    expect(await boardDimensions(page)).toEqual(initialBoardDimensions);
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");

    await flipButton.click();
    await expect(flipButton).toHaveAttribute("aria-pressed", "true");
    const source = page.locator(".square-control--source").first();
    const sourceLabel = await source.getAttribute("aria-label");
    if (sourceLabel === null || !sourceLabel.includes("Black")) {
      throw new Error("The flipped board did not expose a Black legal source with its actual square name.");
    }
    const sourceSquare = sourceLabel.split(",")[0];
    await source.click();
    await expect(page.locator(".square-control--selected")).toHaveAttribute(
      "aria-label",
      `${sourceSquare}, Black man, selected`,
    );

    await flipButton.click();
    await expect(page.locator(".square-control--selected")).toHaveAttribute(
      "aria-label",
      `${sourceSquare}, Black man, selected`,
    );
    expect(await readPosition(page)).toEqual(positionAfterMove);
    expect(await readHistory(page)).toEqual(historyAfterMove);
    await flipButton.click();
    await expect(flipButton).toHaveAttribute("aria-pressed", "true");
    await expectCoordinateLabels(page, true);
    await expect(page.locator(".square-control--selected")).toHaveAttribute(
      "aria-label",
      `${sourceSquare}, Black man, selected`,
    );

    await page.locator(".square-control--landing").first().click();
    await expect(page.getByTestId("turn-status")).toHaveText("White to move");
    await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    const firstMove = historyAfterMove[0]?.split("|") ?? [];
    await expect(page.locator(".history-row").nth(0)).toHaveAttribute(
      "data-side",
      firstMove[0] ?? "",
    );
    await expect(page.locator(".history-notation").nth(0)).toHaveText(firstMove[1] ?? "");
    await expect(page.locator(".history-row").nth(1)).toHaveAttribute("data-side", "black");
    await expectCoordinateLabels(page, true);
    expect(await readPosition(page)).not.toEqual(positionAfterMove);
    expect(await boardDimensions(page)).toEqual(initialBoardDimensions);
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

test("flipping during a partial capture keeps its exact path continuation", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=capture`,
      { waitUntil: "load" },
    );
    const flipButton = page.getByRole("button", { name: "Flip board orientation" });
    const turnStatus = page.getByTestId("turn-status");
    const historyCount = page.getByTestId("history-count");
    const initialHistory = await readHistory(page);

    await flipButton.click();
    await expectCoordinateLabels(page, true);
    await page.getByRole("button", { name: "a8, White man, selectable piece" }).click();
    await page.getByRole("button", { name: "a6, empty, legal landing" }).click();

    await expect(page.getByRole("button", { name: "a6, White man, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "a7, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "c6, empty, legal landing" })).toBeVisible();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("1 ply");
    expect(await readHistory(page)).toEqual(initialHistory);

    await flipButton.click();
    await expectCoordinateLabels(page, false);
    await expect(page.getByRole("button", { name: "a6, White man, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "c6, empty, legal landing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

    await flipButton.click();
    await expectCoordinateLabels(page, true);
    await expect(page.getByRole("button", { name: "a6, White man, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "c6, empty, legal landing" })).toBeVisible();
    await page.getByRole("button", { name: "c6, empty, legal landing" }).click();

    await expect(turnStatus).toHaveText("Black to move");
    await expect(historyCount).toHaveText("2 plies");
    await expect(page.locator(".history-row").nth(0)).toHaveAttribute("data-side", "black");
    await expect(page.locator(".history-row").nth(1)).toHaveAttribute("data-side", "white");
    await expect(page.locator(".history-notation").nth(1)).toHaveText("a8xa6xc6");
    await expectCoordinateLabels(page, true);
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
