import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

declare global {
  interface Window {
    __meydanRevokedObjectUrls: string[];
    __meydanFailNextScorebookUrl?: boolean;
  }
}

async function downloadTextScorebook(page: Page): Promise<{ filename: string; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download scorebook" }).click(),
  ]);
  const path = await download.path();
  if (path === null) {
    throw new Error("The browser did not provide the downloaded scorebook file.");
  }
  return {
    filename: download.suggestedFilename(),
    text: await readFile(path, "utf8"),
  };
}

async function visibleScoreLines(page: Page): Promise<string[]> {
  return page.getByTestId("move-history").locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => {
      const number = row.querySelector("th[scope=row]")?.textContent?.trim() ?? "";
      const white = row.querySelector('td[data-side="white"] .history-notation')?.textContent ?? "—";
      const black = row.querySelector('td[data-side="black"] .history-notation')?.textContent ?? "—";
      return `${number} White: ${white} | Black: ${black}`;
    }),
  );
}

async function expectObjectUrlReleased(page: Page, expectedCount: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__meydanRevokedObjectUrls.length))
    .toBe(expectedCount);
}

test("scorebook exports quiet moves and follows undo", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  await page.addInitScript(() => {
    window.__meydanRevokedObjectUrls = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (objectUrl: string) => {
      window.__meydanRevokedObjectUrls.push(objectUrl);
      revoke(objectUrl);
    };
  });

  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await expect(page.getByTestId("empty-history")).toHaveText("No moves recorded.");
    await expect(page.getByRole("button", { name: "Download scorebook" })).toBeVisible();

    const emptyExport = await downloadTextScorebook(page);
    expect(emptyExport.filename).toMatch(/^meydan-dama-scorebook-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(emptyExport.text).toContain("Meydan | The Dama Club\nDama scorebook");
    expect(emptyExport.text).toContain("Mode: Local two-player");
    expect(emptyExport.text).toContain("Match number: 1");
    expect(emptyExport.text).toContain("Time control: Untimed");
    expect(emptyExport.text).toContain("White player: Local player");
    expect(emptyExport.text).toContain("Black player: Local player");
    expect(emptyExport.text).toContain("No moves recorded.");
    expect(emptyExport.text).not.toContain("Result:");
    await expectObjectUrlReleased(page, 1);

    const historyCount = page.getByTestId("history-count");
    const countBeforeMove = await historyCount.innerText();
    await page.locator(".square-control--source").first().click();
    for (let landingIndex = 0; landingIndex < 16; landingIndex += 1) {
      const landing = page.locator(".square-control--landing").first();
      await expect(landing).toBeVisible();
      await landing.click();
      if ((await historyCount.innerText()) !== countBeforeMove) {
        break;
      }
      if (landingIndex === 15) {
        throw new Error("The selected quiet Dama move did not finish.");
      }
    }

    await expect(historyCount).toHaveText("1 ply");
    const visibleLines = await visibleScoreLines(page);
    expect(visibleLines).toHaveLength(1);
    expect(visibleLines[0]).toMatch(/White: [^x]+ \| Black: —/);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);
    const tableSize = await page.getByTestId("move-history").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(tableSize.scrollWidth).toBeLessThanOrEqual(tableSize.clientWidth);

    const moveExport = await downloadTextScorebook(page);
    const exportedLines = moveExport.text.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line));
    expect(exportedLines).toEqual(visibleLines);
    expect(moveExport.text).not.toContain("Result:");
    await expectObjectUrlReleased(page, 2);

    await page.getByRole("button", { name: "Undo last local ply" }).click();
    await expect(historyCount).toHaveText("0 plies");
    await expect(page.getByTestId("empty-history")).toBeVisible();
    const revertedExport = await downloadTextScorebook(page);
    expect(revertedExport.text).toContain("No moves recorded.");
    expect(revertedExport.text).not.toContain(visibleLines[0] ?? "impossible-notation");
    expect(revertedExport.text).not.toContain("Result:");
    await expectObjectUrlReleased(page, 3);

    await page.getByTestId("mode-computer").click();
    await page.getByTestId("bot-difficulty").selectOption("hard");
    const computerExport = await downloadTextScorebook(page);
    expect(computerExport.text).toContain("Mode: Computer · hard");
    expect(computerExport.text).toContain("Match number: 1");
    expect(computerExport.text).toContain("Time control: Untimed");
    expect(computerExport.text).toContain("White player: You");
    expect(computerExport.text).toContain("Black player: Computer");
    expect(computerExport.text).not.toContain("Room code:");
    expect(computerExport.text).toContain("No moves recorded.");
    await expectObjectUrlReleased(page, 4);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("scorebook capture order and terminal result match the visible match", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });

  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=scorebook-capture`,
      { waitUntil: "load" },
    );
    await page.getByRole("button", { name: "a8, White man, selectable piece" }).click();
    await page.getByRole("button", { name: "a6, empty, legal landing" }).click();
    await page.getByRole("button", { name: "c6, empty, legal landing" }).click();
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");

    const visibleCapture = await visibleScoreLines(page);
    expect(visibleCapture).toEqual(["1. White: a8xa6xc6 | Black: —"]);
    const captureExport = await downloadTextScorebook(page);
    expect(captureExport.text.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line))).toEqual(
      visibleCapture,
    );

    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=terminal`,
      { waitUntil: "load" },
    );
    const visibleResult = page.getByTestId("turn-status");
    await expect(visibleResult).toContainText("White wins");
    await expect(visibleResult).toContainText("Black has no legal moves.");
    const resultExport = await downloadTextScorebook(page);
    expect(resultExport.text).toContain("Result: White wins");
    expect(resultExport.text).toContain("Details: Black has no legal moves.");
    expect(resultExport.text.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line))).toEqual(
      await visibleScoreLines(page),
    );
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("scorebook keeps the newest moves in its own scroll region", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=scorebook-long`,
      { waitUntil: "load" },
    );
    const historyCount = page.getByTestId("history-count");
    await expect(historyCount).toHaveText("18 plies");

    const scrollRegion = page.getByTestId("scorebook-scroll");
    const scrollState = await scrollRegion.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
    }));
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    expect(scrollState.scrollTop).toBeGreaterThan(0);
    expect(scrollState.scrollTop + scrollState.clientHeight).toBe(scrollState.scrollHeight);

    const latestNotation = page.locator(".history-notation").last();
    const latestBounds = await latestNotation.boundingBox();
    expect(latestBounds).not.toBeNull();
    expect(latestBounds!.y).toBeGreaterThanOrEqual(scrollState.top);
    expect(latestBounds!.y + latestBounds!.height).toBeLessThanOrEqual(scrollState.bottom);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

test("a failed scorebook download reports the failure and succeeds on retry", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const createObjectUrl = URL.createObjectURL.bind(URL);
    window.__meydanFailNextScorebookUrl = true;
    URL.createObjectURL = (blob: Blob) => {
      if (window.__meydanFailNextScorebookUrl === true) {
        window.__meydanFailNextScorebookUrl = false;
        throw new DOMException("Download URL unavailable", "NotSupportedError");
      }
      return createObjectUrl(blob);
    };
  });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await expect(page.getByTestId("empty-history")).toHaveText("No moves recorded.");
    await page.getByRole("button", { name: "Download scorebook" }).click();
    await expect(page.getByTestId("scorebook-download-error")).toHaveText(
      "Could not start the scorebook download. Check your browser’s download settings and try again.",
    );
    await expect(page.getByRole("button", { name: "Download scorebook" })).toBeEnabled();
    await expect(pageErrors).toEqual([]);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download scorebook" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^meydan-dama-scorebook-\d{4}-\d{2}-\d{2}\.txt$/);
    await expect(page.getByTestId("scorebook-download-error")).toHaveCount(0);
    await expect(pageErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});
