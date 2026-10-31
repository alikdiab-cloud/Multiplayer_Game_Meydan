import { expect, test } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

test("Dama rules are readable and dismissible by keyboard at 320 pixels", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });

    const rulesButton = page.getByRole("button", { name: "Read Dama rules" });
    await page.keyboard.press("Tab");
    await expect(page.locator(".board-grid button:focus")).toHaveAttribute(
      "aria-label",
      /selectable piece/,
    );
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Flip board orientation" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(rulesButton).toBeFocused();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Dama rules" });
    const title = dialog.getByRole("heading", { name: "Dama rules" });
    const content = dialog.locator(".modal-content");
    const closeButton = dialog.getByRole("button", { name: "Close dialog" });
    await expect(dialog).toBeVisible();
    await expect(title).toBeFocused();
    await expect(dialog).toContainText("Every square is in play, and White moves first.");
    await expect(dialog).toContainText("must choose a sequence that captures the greatest number of pieces");
    await expect(dialog).toContainText("it stays a man and finishes the sequence using man movement");
    await expect(dialog).toContainText("the same position with the same side to move occurs three times");
    await expect(dialog).toContainText("does not use king-move or lone-king draw counters");
    await expect(dialog).toContainText("Online games use server-managed clocks and results");
    const titleFocus = await title.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(titleFocus).not.toBe("none");

    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    const contentSize = await content.evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    }));
    expect(contentSize.scrollHeight).toBeGreaterThan(contentSize.clientHeight);
    expect(contentSize.scrollWidth).toBeLessThanOrEqual(contentSize.clientWidth);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);

    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(closeButton).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(rulesButton).toBeFocused();
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
