import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

test("capture product-contract screenshots and browser diagnostics", async ({ page }) => {
  test.setTimeout(90_000);
  const output = resolve("browser-artifacts/product-contract-review");
  await mkdir(output, { recursive: true });
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const consoleMessages: Array<{ type: string; text: string; location: unknown }> = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; error: string }> = [];
  const requests: Array<{ url: string; resourceType: string }> = [];
  const badResponses: Array<{ url: string; status: number }> = [];

  try {
    page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() }));
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
    page.on("request", (request) => requests.push({ url: request.url(), resourceType: request.resourceType() }));
    page.on("response", (response) => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() }); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(output, "1440-local-play.png"), fullPage: true });
    const desktop = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "",
      favicon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? "",
      visibleBrand: document.querySelector(".brand-name")?.textContent?.trim() ?? "",
      heading: document.querySelector("h1")?.textContent?.trim() ?? "",
      fonts: {
        body: getComputedStyle(document.body).fontFamily,
        heading: getComputedStyle(document.querySelector("h1")!).fontFamily,
        fontFaces: [...document.fonts].map((face) => ({ family: face.family, status: face.status })),
      },
      images: [...new Set([...document.images].map((image) => new URL(image.src).pathname))].map((path) => {
        const image = [...document.images].find((candidate) => new URL(candidate.src).pathname === path)!;
        return { src: path, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
      }),
      iconButtons: [...document.querySelectorAll("button")].filter((button) => button.innerText.trim() === "").map((button) => ({
        text: button.innerText.trim(),
        ariaLabel: button.getAttribute("aria-label"),
        title: button.title,
      })),
      unnamedButtons: [...document.querySelectorAll("button")].filter((button) => button.innerText.trim() === "" && !button.getAttribute("aria-label")?.trim()).length,
      board: (() => { const box = document.querySelector(".board-coordinate-wrap")!.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })(),
      palette: ["--ink", "--ink-soft", "--ink-faint", "--paper", "--canvas", "--pine", "--pine-deep", "--sage", "--brass", "--brass-text", "--coral"].reduce((values, key) => ({ ...values, [key]: getComputedStyle(document.documentElement).getPropertyValue(key).trim() }), {} as Record<string, string>),
    }));
    await page.locator(".square-control--source").first().click();
    await page.screenshot({ path: resolve(output, "1440-local-selection.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Read Dama rules" }).click();
    const desktopRules = page.getByRole("dialog", { name: "Dama rules" });
    await desktopRules.waitFor({ state: "visible" });
    await expect(desktopRules.getByRole("button", { name: "Close dialog" })).toBeVisible();
    await page.screenshot({ path: resolve(output, "1440-rules-dialog.png") });
    await desktopRules.locator(".modal-content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: resolve(output, "1440-rules-dialog-bottom.png") });
    await page.getByRole("button", { name: "Close dialog" }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(output, "390-local-play.png"), fullPage: true });
    await page.locator(".square-control--source").first().click();
    await page.screenshot({ path: resolve(output, "390-local-selection.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Read Dama rules" }).click();
    const phoneRules = page.getByRole("dialog", { name: "Dama rules" });
    await phoneRules.waitFor({ state: "visible" });
    await expect(phoneRules.getByRole("button", { name: "Close dialog" })).toBeVisible();
    await page.screenshot({ path: resolve(output, "390-rules-dialog.png") });
    await phoneRules.locator(".modal-content").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: resolve(output, "390-rules-dialog-bottom.png") });
    await page.getByRole("button", { name: "Close dialog" }).click();
    const phone = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      board: (() => { const box = document.querySelector(".board-coordinate-wrap")!.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })(),
    }));

    const assetChecks = await Promise.all([
      "/art/club-mark.svg",
      "/favicon.ico",
      "/pieces/piece-white-man.svg",
      "/pieces/piece-white-king.svg",
      "/pieces/piece-black-man.svg",
      "/pieces/piece-black-king.svg",
    ].map(async (path) => ({ path, status: (await page.request.get(`${origin}${path}`)).status() })));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/tests/finished-board-harness.html?scenario=promotion`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "c3, White man, selectable piece" }).click();
    await page.getByRole("button", { name: "c1, empty, legal landing" }).click();
    await page.getByRole("button", { name: "e1, empty, legal landing" }).click();
    await expect(page.getByRole("button", { name: "e1, White king" })).toBeVisible();
    await page.screenshot({ path: resolve(output, "1440-king-promotion.png"), fullPage: true });
    const report = {
      desktop,
      phone,
      consoleErrors: consoleMessages.filter((message) => message.type === "error"),
      consoleWarnings: consoleMessages.filter((message) => message.type === "warning"),
      pageErrors,
      failedRequests,
      requests: requests.filter(({ resourceType }) => ["image", "font", "stylesheet"].includes(resourceType)),
      badResponses,
      assetChecks,
    };
    await writeFile(resolve(output, "browser-review-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      title: desktop.title,
      description: desktop.description,
      visibleBrand: desktop.visibleBrand,
      heading: desktop.heading,
      fontStacks: desktop.fonts,
      board: desktop.board,
      phone,
      assetChecks,
      unnamedButtons: desktop.unnamedButtons,
      consoleErrors: report.consoleErrors,
      consoleWarnings: report.consoleWarnings,
      pageErrors,
      failedRequests,
      badResponses,
    }, null, 2));
    expect(desktop.title).toBe("Meydan | The Dama Club");
    expect(desktop.heading).toBe("Dama");
    expect(desktop.visibleBrand).toBe("Meydan | The Dama Club");
    expect(desktop.images.every((image) => image.complete && image.width > 0)).toBe(true);
    expect(desktop.unnamedButtons).toBe(0);
    expect(phone.documentWidth).toBeLessThanOrEqual(phone.viewportWidth);
    expect(assetChecks.every((asset) => asset.status === 200)).toBe(true);
    expect(consoleMessages.filter((message) => message.type === "error")).toEqual([]);
    expect(consoleMessages.filter((message) => message.type === "warning")).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(badResponses).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
});
