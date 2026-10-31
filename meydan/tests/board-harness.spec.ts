import { expect, test } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

test("previews, reverses, branches, and commits a looped capture chain", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  const missingPieceAssets: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/pieces/")) {
      missingPieceAssets.push(`${response.status()} ${response.url()}`);
    }
  });

  try {
    const response = await page.goto(
      `http://127.0.0.1:${server.port}/tests/board-harness.html`,
      { waitUntil: "load" },
    );
    const committedState = page.getByTestId("committed-state");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("table", { name: "Dama board. White to move." })).toBeVisible();
    await expect(committedState).toHaveAttribute("data-turn", "white");
    await expect(committedState).toHaveAttribute("data-move-count", "0");
    const initialPosition = await committedState.getAttribute("data-position");
    if (initialPosition === null) {
      throw new Error("The test fixture did not expose its committed starting position.");
    }

    await page.getByRole("button", { name: "d4, White king, selectable piece" }).click();
    await expect(page.getByRole("button", { name: "d6, empty, legal landing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "f4, empty, legal landing" })).toBeVisible();
    await page.getByRole("button", { name: "d6, empty, legal landing" }).click();

    await expect(page.getByRole("button", { name: "d6, White king, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "d5, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "e4, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "f5, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "e6, Black man" })).toBeVisible();
    await expect(committedState).toHaveAttribute("data-position", initialPosition);
    await expect(committedState).toHaveAttribute("data-turn", "white");
    await expect(committedState).toHaveAttribute("data-move-count", "0");
    await page.screenshot({ path: "test-results/capture-first-preview.png", fullPage: true });

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("button", { name: "d4, White king, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "d5, Black man" })).toBeVisible();
    await expect(page.getByRole("button", { name: "d6, empty, legal landing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "f4, empty, legal landing" })).toBeVisible();
    await expect(committedState).toHaveAttribute("data-position", initialPosition);
    await page.screenshot({ path: "test-results/capture-backed-up.png", fullPage: true });

    await page.getByRole("button", { name: "f4, empty, legal landing" }).click();
    await expect(page.getByRole("button", { name: "f4, White king, selected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "e4, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "f6, empty, legal landing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "d6, empty, legal landing" })).toHaveCount(0);
    await expect(committedState).toHaveAttribute("data-position", initialPosition);
    await page.screenshot({ path: "test-results/capture-alternative-preview.png", fullPage: true });

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "d4, White king, selectable piece" })).toBeVisible();
    await expect(page.getByRole("button", { name: "d5, Black man" })).toBeVisible();
    await expect(committedState).toHaveAttribute("data-position", initialPosition);
    await expect(committedState).toHaveAttribute("data-turn", "white");
    await expect(committedState).toHaveAttribute("data-move-count", "0");

    await page.getByRole("button", { name: "d4, White king, selectable piece" }).click();
    await page.getByRole("button", { name: "f4, empty, legal landing" }).click();
    await page.getByRole("button", { name: "f6, empty, legal landing" }).click();
    await page.getByRole("button", { name: "d6, empty, legal landing" }).click();
    await expect(page.getByRole("button", { name: "d4, empty, legal landing" })).toBeVisible();
    await expect(committedState).toHaveAttribute("data-position", initialPosition);
    await page.screenshot({ path: "test-results/capture-source-return-landing.png", fullPage: true });

    await page.getByRole("button", { name: "d4, empty, legal landing" }).click();
    await expect(committedState).toHaveAttribute("data-turn", "black");
    await expect(committedState).toHaveAttribute("data-move-count", "1");
    await expect(committedState).toHaveAttribute("data-last-move-from", "4|3");
    await expect(committedState).toHaveAttribute("data-last-move-path", ' ["4|5","2|5","2|3","4|3"]'.trim());
    await expect(page.getByText("Black to move")).toBeVisible();
    await expect(page.getByRole("button", { name: "d4, White king" })).toBeVisible();
    await expect(page.getByRole("button", { name: "d5, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "e4, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "e6, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "f5, empty" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(page.locator(".square-control--landing, .square-control--selected")).toHaveCount(0);
    await expect(committedState).not.toHaveAttribute("data-position", initialPosition);

    const committedPosition = JSON.parse((await committedState.getAttribute("data-position")) ?? "null") as object;
    expect(committedPosition).toEqual({ "0|0": "b", "0|2": "b", "4|3": "W" });
    await page.screenshot({ path: "test-results/capture-committed.png", fullPage: true });

    expect(pageErrors).toEqual([]);
    expect(missingPieceAssets).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});
