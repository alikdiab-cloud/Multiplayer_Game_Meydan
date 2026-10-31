import { expect, test } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

async function pressKeys(page: import("@playwright/test").Page, keys: string[]): Promise<void> {
  for (const key of keys) {
    await page.keyboard.press(key);
  }
}

test("keyboard users can navigate, cancel, and complete a capture before and after flipping", async ({ page }) => {
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
    const flipButton = page.getByRole("button", { name: "Flip board orientation" });
    const rulesButton = page.getByRole("button", { name: "Read Dama rules" });
    const undoButton = page.getByRole("button", { name: "Undo last local ply" });
    const tabStop = page.locator('.board-grid button[tabindex="0"]');

    await expect(tabStop).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(tabStop).toBeFocused();
    await expect(tabStop).toHaveAttribute("aria-label", "a8, White man, selectable piece");
    const focusShadow = await tabStop.evaluate((button) => getComputedStyle(button).boxShadow);
    expect(focusShadow).not.toBe("none");

    await page.keyboard.press("Enter");
    await pressKeys(page, ["ArrowDown", "ArrowDown"]);
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "a6, empty, legal landing",
    );
    await page.keyboard.press("Space");
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "a6, White man, selected",
    );
    await expect(page.getByRole("button", { name: "c6, empty, legal landing" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".square-control--selected, .square-control--landing")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "a8, White man, selectable piece" })).toBeVisible();
    await expect(page.getByRole("button", { name: "a7, Black man" })).toBeVisible();
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("1 ply");

    await pressKeys(page, ["ArrowUp", "ArrowUp"]);
    await page.keyboard.press("Enter");
    await pressKeys(page, ["ArrowDown", "ArrowDown"]);
    await page.keyboard.press("Space");
    await pressKeys(page, ["ArrowRight", "ArrowRight"]);
    await page.keyboard.press("Enter");
    await expect(turnStatus).toHaveText("Black to move");
    await expect(historyCount).toHaveText("2 plies");
    await expect(page.locator(".history-notation").nth(1)).toHaveText("a8xa6xc6");
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "c6, White man",
    );

    await page.keyboard.press("Tab");
    await expect(flipButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(flipButton).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(rulesButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Turn sound on" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(undoButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("1 ply");

    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Turn sound on" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(rulesButton).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(flipButton).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "c6, empty",
    );

    await pressKeys(page, ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowRight"]);
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "a8, White man, selectable piece",
    );
    await page.keyboard.press("Enter");
    await pressKeys(page, ["ArrowUp", "ArrowUp"]);
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      "a6, empty, legal landing",
    );
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    await expect(page.locator(".square-control--selected, .square-control--landing")).toHaveCount(0);
    await expect(turnStatus).toHaveText("White to move");
    await expect(historyCount).toHaveText("1 ply");

    await pressKeys(page, ["ArrowDown", "ArrowDown"]);
    await page.keyboard.press("Enter");
    await pressKeys(page, ["ArrowUp", "ArrowUp"]);
    await page.keyboard.press("Space");
    await pressKeys(page, ["ArrowLeft", "ArrowLeft"]);
    await page.keyboard.press("Enter");
    await expect(turnStatus).toHaveText("Black to move");
    await expect(historyCount).toHaveText("2 plies");
    await expect(page.locator(".history-notation").nth(1)).toHaveText("a8xa6xc6");
    await expect(flipButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".rank-labels span").first()).toHaveText("1");
    await expect(page.locator(".file-labels span").first()).toHaveText("h");

    await page.keyboard.press("Tab");
    await expect(flipButton).toBeFocused();
    expect(await page.locator(".board-grid button[tabindex='0']").count()).toBe(1);
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
