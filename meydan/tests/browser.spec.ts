import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";
import { startProductionServer } from "../server/production.js";

async function readBoardPieces(page: Page): Promise<Array<string | null>> {
  return page.getByRole("button", { name: /^[a-h][1-8],/ }).evaluateAll((buttons) =>
    buttons.map((button) => button.querySelector("img")?.getAttribute("alt") ?? null),
  );
}

async function readCanonicalBoardPosition(page: Page): Promise<Record<string, string | null>> {
  return page.getByRole("button", { name: /^[a-h][1-8],/ }).evaluateAll((buttons) => {
    const entries: Array<[string, string | null]> = [];
    for (const button of buttons) {
      const label = button.getAttribute("aria-label");
      const square = label?.match(/^([a-h])([1-8]),/);
      if (square?.[1] === undefined || square[2] === undefined) {
        throw new Error(`Unexpected square label: ${String(label)}`);
      }
      const coordinate = `${8 - Number(square[2])}|${square[1].charCodeAt(0) - "a".charCodeAt(0)}`;
      entries.push([coordinate, button.querySelector("img")?.getAttribute("alt") ?? null]);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  });
}

async function readOnlineState(page: Page): Promise<{
  matchNumber: number;
  revision: number;
  position: Record<string, string | null>;
  history: string[];
}> {
  const state = page.getByTestId("online-board-state");
  return {
    matchNumber: Number(await state.getAttribute("data-match-number")),
    revision: Number(await state.getAttribute("data-revision")),
    position: await readCanonicalBoardPosition(page),
    history: await page.getByTestId("move-history").locator(".history-notation").allTextContents(),
  };
}

async function playFirstLegalMove(page: Page): Promise<void> {
  const historyCount = page.getByTestId("history-count");
  const countBeforeMove = await historyCount.innerText();
  const source = page.getByRole("button", {
    name: /^[a-h][1-8], (?:White|Black) (?:man|king), selectable piece$/,
  }).first();
  await expect(source, "the current side should have an accessible legal source").toBeVisible();
  await source.click();
  const selectedPiece = page.getByRole("button", {
    name: /^[a-h][1-8], (?:White|Black) (?:man|king), selected$/,
  });

  for (let landingIndex = 0; landingIndex < 16; landingIndex += 1) {
    const landing = page.getByRole("button", { name: /^[a-h][1-8], empty, legal landing$/ }).first();
    await expect(landing, `legal landing ${landingIndex + 1} should be announced`).toBeVisible();
    await landing.click();
    if (await selectedPiece.count() === 0) {
      await expect(historyCount).not.toHaveText(countBeforeMove);
      return;
    }
  }

  throw new Error("The selected legal move did not finish within the board's maximum path length.");
}

test("loads the Dama application in a browser", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/`, {
      waitUntil: "load",
    });

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("Meydan | The Dama Club");
    await expect(page.getByRole("heading", { level: 1, name: "Dama" })).toBeVisible();
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

test("online lobby creates and joins an invite without losing a game or exposing session credentials", async ({ browser }) => {
  test.setTimeout(60_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let pageC: Page | undefined;
  const pageErrors: string[] = [];

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    await contextA.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await contextB.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("Clipboard denied by browser test.")) },
      });
    });
    pageA = await contextA.newPage();
    pageA.on("pageerror", (error) => pageErrors.push(error.message));
    await pageA.goto(origin, { waitUntil: "load" });

    await playFirstLegalMove(pageA);
    await pageA.getByTestId("mode-online").click();
    const modeConfirmation = pageA.getByRole("dialog", { name: "Change play mode?" });
    await expect(modeConfirmation).toBeVisible();
    await pageA.getByRole("button", { name: "Keep current game" }).click();
    await expect(pageA.getByTestId("history-count")).toHaveText("1 ply");
    await expect(pageA.getByTestId("mode-online")).toHaveAttribute("aria-pressed", "false");

    await pageA.getByTestId("mode-online").click();
    await expect(pageA.getByRole("dialog", { name: "Change play mode?" })).toBeVisible();
    await pageA.getByRole("button", { name: "Change mode" }).click();
    await expect(pageA.getByTestId("online-create")).toBeEnabled();

    await pageA.getByTestId("online-create").click();
    await expect(pageA.getByText("Enter a name of 1–24 letters, numbers, spaces, or . ' - _ characters.")).toBeVisible();
    await expect(pageA.getByTestId("history-count")).toHaveText("0 plies");

    await pageA.getByTestId("online-nickname").fill("Alice Online");
    await pageA.getByTestId("online-side").selectOption("black");
    await pageA.getByTestId("online-time-control").selectOption("blitz");
    await pageA.getByTestId("online-create").click();
    await expect(pageA.getByTestId("online-feedback")).toContainText("created");
    const roomCode = await pageA.getByTestId("online-room-code").innerText();
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
    await expect(pageA.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("Alice Online");
    await expect(pageA.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Waiting for player");
    await expect(pageA.getByTestId("online-room-detail")).toContainText("blitz");

    await pageA.getByTestId("copy-room-code").click();
    await expect(pageA.getByTestId("clipboard-feedback")).toHaveText("Room code copied.");
    expect(await pageA.evaluate(() => navigator.clipboard.readText())).toBe(roomCode);
    await pageA.getByTestId("copy-room-invite").click();
    await expect(pageA.getByTestId("clipboard-feedback")).toHaveText("Invite link copied.");
    const invite = await pageA.evaluate(() => navigator.clipboard.readText());
    const inviteUrl = new URL(invite);
    expect(inviteUrl.origin).toBe(origin);
    expect(inviteUrl.searchParams.get("room")).toBe(roomCode);
    expect([...inviteUrl.searchParams.keys()]).toEqual(["room"]);
    expect(invite).not.toContain("sessionToken");
    const sessionTokenA = await pageA.evaluate(() => {
      const value = Object.entries(sessionStorage).find(([key]) => key.includes("online-session"))?.[1];
      return value === undefined ? null : (JSON.parse(value) as { sessionToken: string }).sessionToken;
    });
    expect(sessionTokenA).not.toBeNull();
    expect(invite).not.toContain(sessionTokenA!);
    expect(invite).not.toContain("sessionToken");
    expect(await pageA.locator("body").innerText()).not.toContain(sessionTokenA!);
    expect(pageA.url()).not.toContain(sessionTokenA!);

    pageB = await contextB.newPage();
    pageB.on("pageerror", (error) => pageErrors.push(error.message));
    await pageB.goto(invite, { waitUntil: "load" });
    await expect(pageB.getByTestId("online-room-code-input")).toHaveValue(roomCode);
    await expect(pageB.getByTestId("online-join-player")).toBeEnabled();
    await expect(pageB.getByTestId("online-room-code")).toHaveCount(0);

    await pageB.getByTestId("online-nickname").fill("Bob Online");
    await pageB.getByTestId("online-room-code-input").fill("bad!");
    await pageB.getByTestId("online-join-player").click();
    await expect(pageB.getByText("Enter a six-character code using A–Z and 2–9.")).toBeVisible();
    await expect(pageB.getByTestId("online-feedback")).toHaveCount(0);
    await expect(pageB.getByTestId("online-room-code")).toHaveCount(0);

    const unavailableCode = `${roomCode[0] === "A" ? "B" : "A"}${roomCode.slice(1)}`;
    await pageB.getByTestId("online-room-code-input").fill(unavailableCode);
    await pageB.getByTestId("online-join-player").click();
    await expect(pageB.getByTestId("online-feedback")).toHaveText("No room has that code. Check the code or create a room.");
    await expect(pageB.getByTestId("online-room-code")).toHaveCount(0);

    await pageB.getByTestId("online-room-code-input").fill(roomCode);
    await pageB.getByTestId("online-join-player").click();
    await expect(pageB.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(pageB.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Bob Online");
    await expect(pageB.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("Alice Online");
    await expect(pageA.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Bob Online");
    await expect(pageA.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("Alice Online");

    pageC = await contextC.newPage();
    pageC.on("pageerror", (error) => pageErrors.push(error.message));
    await pageC.goto(invite, { waitUntil: "load" });
    await expect(pageC.getByTestId("online-room-code-input")).toHaveValue(roomCode);
    await pageC.getByTestId("online-nickname").fill("Casey Spectator");
    await pageC.getByTestId("online-join-spectator").click();
    await expect(pageC.getByTestId("online-role")).toHaveText("You are spectating.");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("1 spectator");
    await expect(pageC.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Bob Online");
    await expect(pageC.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("Alice Online");

    const spectatorStateBeforeAttempt = await readOnlineState(pageC);
    await expect(pageC.locator(".square-control[aria-disabled='true']")).toHaveCount(64);
    await pageC.locator(".square-control[aria-disabled='true'][aria-label*='White man']").first().click({ force: true });
    await expect(pageC.locator(".square-control--selected")).toHaveCount(0);
    expect(await readOnlineState(pageC)).toEqual(spectatorStateBeforeAttempt);

    const stateBeforeWhiteMove = await readOnlineState(pageA);
    expect(await readOnlineState(pageB)).toEqual(stateBeforeWhiteMove);
    expect(await readOnlineState(pageC)).toEqual(stateBeforeWhiteMove);

    await expect(pageB.locator(".square-control--source").first()).toBeVisible();
    await playFirstLegalMove(pageB);
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    }
    const stateAfterWhiteMove = await readOnlineState(pageB);
    expect(stateAfterWhiteMove.revision).toBe(stateBeforeWhiteMove.revision + 1);
    expect(await readOnlineState(pageA)).toEqual(stateAfterWhiteMove);
    expect(await readOnlineState(pageC)).toEqual(stateAfterWhiteMove);

    await playFirstLegalMove(pageA);
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    }
    const stateAfterBlackMove = await readOnlineState(pageA);
    expect(stateAfterBlackMove.revision).toBe(stateAfterWhiteMove.revision + 1);
    expect(await readOnlineState(pageB)).toEqual(stateAfterBlackMove);
    expect(await readOnlineState(pageC)).toEqual(stateAfterBlackMove);

    await pageB.getByTestId("copy-room-code").click();
    await expect(pageB.getByTestId("clipboard-feedback")).toHaveText(
      "Could not copy the code. Select it and copy it manually.",
    );
    await expect(pageB.getByTestId("clipboard-feedback")).not.toHaveText("Room code copied.");
    expect(pageErrors).toEqual([]);
  } finally {
    await pageA?.close();
    await pageB?.close();
    await pageC?.close();
    await contextA.close();
    await contextB.close();
    await contextC.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test.describe("computer play", () => {
  test("commits a human move and bot reply, undoes them, and applies side and difficulty changes", async ({ page }) => {
    test.setTimeout(90_000);
    const server = await startDevelopmentServer({ port: 0, logUrls: false });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
      const openingPosition = await readCanonicalBoardPosition(page);
      const openingPieces = await readBoardPieces(page);
      const historyCount = page.getByTestId("history-count");
      const turnStatus = page.getByTestId("turn-status");
      const history = page.getByTestId("move-history");
      const difficulty = page.getByLabel("Difficulty");
      const humanSide = page.getByLabel("Play as");

      await page.getByRole("button", { name: /Play against computer/ }).click();
      await difficulty.selectOption("hard");
      await expect(difficulty).toHaveValue("hard");
      await playFirstLegalMove(page);
      await expect(historyCount).toHaveText("2 plies", { timeout: 30_000 });
      await expect(turnStatus).toHaveText("White to move");
      await expect(history).toHaveAttribute("data-ply-count", "2");
      await expect(history.locator('td[data-side="white"] .history-notation')).not.toBeEmpty();
      await expect(history.locator('td[data-side="black"] .history-notation')).not.toBeEmpty();
      const afterWhiteHumanAndBotReply = await readCanonicalBoardPosition(page);
      expect(afterWhiteHumanAndBotReply).not.toEqual(openingPosition);

      await page.getByRole("button", { name: "Undo to your turn" }).click();
      await expect(historyCount).toHaveText("0 plies");
      await expect(turnStatus).toHaveText("White to move");
      expect(await readBoardPieces(page)).toEqual(openingPieces);
      expect(await readCanonicalBoardPosition(page)).toEqual(openingPosition);

      await difficulty.selectOption("easy");
      await expect(difficulty).toHaveValue("easy");
      await humanSide.selectOption("black");
      await expect(humanSide).toHaveValue("black");
      await expect(historyCount).toHaveText("1 ply", { timeout: 30_000 });
      await expect(turnStatus).toHaveText("Black to move");
      const afterComputerOpening = await readCanonicalBoardPosition(page);
      expect(afterComputerOpening).not.toEqual(openingPosition);
      await expect(page.getByRole("button", { name: "Undo to your turn" })).toBeDisabled();

      await playFirstLegalMove(page);
      await expect(historyCount).toHaveText("3 plies", { timeout: 30_000 });
      await expect(turnStatus).toHaveText("Black to move");
      await expect(history).toHaveAttribute("data-ply-count", "3");
      await expect(history.locator('td[data-side="white"] .history-notation')).toHaveCount(2);
      await expect(history.locator('td[data-side="black"] .history-notation')).toHaveCount(1);

      await page.getByRole("button", { name: "Undo to your turn" }).click();
      await expect(historyCount).toHaveText("1 ply");
      await expect(turnStatus).toHaveText("Black to move");
      expect(await readCanonicalBoardPosition(page)).toEqual(afterComputerOpening);
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
});

test("computer completes the forced tactical capture fixture", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=computer-capture`,
      { waitUntil: "load" },
    );
    await expect(page.getByTestId("mode-computer")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("history-count")).toHaveText("1 ply", { timeout: 15_000 });
    await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
    const history = page.getByTestId("move-history");
    await expect(history).toHaveAttribute("data-ply-count", "1");
    await expect(history.locator('td[data-side="white"] .history-notation')).toContainText("x");

    const pieces = await readBoardPieces(page);
    expect(pieces.filter((piece) => piece?.startsWith("White "))).toHaveLength(3);
    expect(pieces.filter((piece) => piece?.startsWith("Black "))).toHaveLength(1);
    await expect(page.getByTestId("scorebook-result")).toBeHidden();
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

test("terminal computer fixture keeps the bot idle", async ({ page }) => {
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
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=computer-no-moves`,
      { waitUntil: "load" },
    );
    await expect(page.getByTestId("mode-computer")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByTestId("turn-status")).toContainText("Black wins");
    await expect(page.getByTestId("scorebook-result")).toContainText("White has no legal moves.");
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

test.describe("local board interactions", () => {
  test("keyboard play can reverse and finish a multi-capture, flip the board, and restore rules focus", async ({ page }) => {
    const server = await startDevelopmentServer({ port: 0, logUrls: false });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=capture`,
        { waitUntil: "load" },
      );
      const historyCount = page.getByTestId("history-count");
      const turnStatus = page.getByTestId("turn-status");
      await expect(historyCount).toHaveText("1 ply");
      await expect(turnStatus).toHaveText("White to move");
      const committedPosition = await readCanonicalBoardPosition(page);

      await page.keyboard.press("Tab");
      const source = page.getByRole("button", { name: "a8, White man, selectable piece" });
      await expect(source).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("button", { name: "a6, empty, legal landing" })).toBeFocused();
      await page.keyboard.press("Space");

      await expect(page.getByRole("button", { name: "a6, White man, selected" })).toBeVisible();
      await expect(page.getByRole("button", { name: "a7, empty" })).toBeVisible();
      await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();
      await expect(historyCount).toHaveText("1 ply");
      expect(await readCanonicalBoardPosition(page)).not.toEqual(committedPosition);

      await page.getByRole("button", { name: "Back" }).click();
      await expect(page.getByRole("button", { name: "a8, White man, selected" })).toBeVisible();
      await expect(page.getByRole("button", { name: "a7, Black man" })).toBeVisible();
      await expect(page.getByRole("button", { name: "b6, Black man" })).toBeVisible();
      await expect(historyCount).toHaveText("1 ply");
      expect(await readCanonicalBoardPosition(page)).toEqual(committedPosition);

      // Re-enter the same path with keyboard controls and commit its final jump.
      await page.getByRole("button", { name: "a8, White man, selected" }).focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "c6, empty, legal landing" })).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("button", { name: "c6, empty, legal landing" })).toBeFocused();
      await page.keyboard.press("Space");

      await expect(historyCount).toHaveText("2 plies");
      await expect(turnStatus).toHaveText("Black to move");
      await expect(page.getByTestId("move-history").locator(".history-notation").last())
        .toHaveText("a8xa6xc6");
      await expect(page.getByRole("button", { name: "c6, White man" })).toBeVisible();
      await expect(page.getByRole("button", { name: "a7, empty" })).toBeVisible();
      await expect(page.getByRole("button", { name: "b6, empty" })).toBeVisible();
      const finalPosition = await readCanonicalBoardPosition(page);

      const flipButton = page.getByRole("button", { name: "Flip board orientation" });
      await flipButton.click();
      await expect(flipButton).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".rank-labels span").first()).toHaveText("1");
      await expect(page.locator(".file-labels span").first()).toHaveText("h");
      expect(await readCanonicalBoardPosition(page)).toEqual(finalPosition);
      await expect(page.getByRole("button", { name: "c6, White man" })).toBeVisible();

      const rulesButton = page.getByRole("button", { name: "Read Dama rules" });
      await rulesButton.focus();
      await page.keyboard.press("Enter");
      const rulesDialog = page.getByRole("dialog", { name: "Dama rules" });
      await expect(rulesDialog).toBeVisible();
      await expect(rulesDialog.getByRole("heading", { name: "Dama rules" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(rulesDialog).toBeHidden();
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

  test("promotion changes the piece only after its full turn and the scorebook downloads matching text", async ({ page }) => {
    const server = await startDevelopmentServer({ port: 0, logUrls: false });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=promotion`,
        { waitUntil: "load" },
      );
      await expect(page.getByTestId("history-count")).toHaveText("0 plies");
      await page.getByRole("button", { name: "c3, White man, selectable piece" }).click();
      await page.getByRole("button", { name: "c1, empty, legal landing" }).click();
      await expect(page.getByRole("button", { name: "c1, White man, selected" })).toBeVisible();
      await expect(page.getByTestId("history-count")).toHaveText("0 plies");
      await expect(page.getByRole("button", { name: "e1, empty, legal landing" })).toBeVisible();

      await page.getByRole("button", { name: "e1, empty, legal landing" }).click();
      await expect(page.getByRole("button", { name: "e1, White king" })).toBeVisible();
      await expect(page.getByTestId("turn-status")).toHaveText("Black to move");
      await expect(page.getByTestId("history-count")).toHaveText("1 ply");
      await expect(page.getByTestId("move-history").locator(".history-notation")).toHaveText([
        "c3xc1xe1",
      ]);
      const promotedPosition = await readCanonicalBoardPosition(page);

      const flipButton = page.getByRole("button", { name: "Flip board orientation" });
      await flipButton.click();
      await expect(flipButton).toHaveAttribute("aria-pressed", "true");
      expect(await readCanonicalBoardPosition(page)).toEqual(promotedPosition);
      await expect(page.getByRole("button", { name: "e1, White king" })).toBeVisible();

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download scorebook" }).click(),
      ]);
      const downloadPath = await download.path();
      if (downloadPath === null) throw new Error("The browser did not provide the scorebook file.");
      const scorebook = await readFile(downloadPath, "utf8");
      expect(download.suggestedFilename()).toMatch(/^meydan-dama-scorebook-\d{4}-\d{2}-\d{2}\.txt$/);
      expect(scorebook).toContain("Meydan | The Dama Club\nDama scorebook");
      expect(scorebook).toContain("Mode: Local two-player");
      expect(scorebook).toContain("1. White: c3xc1xe1 | Black: —");
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
});

test("production ignores fixture query parameters and does not serve the test-only board harness", async ({ page }) => {
  const clientDirectory = resolve(process.cwd(), "dist/client");
  test.skip(!existsSync(resolve(clientDirectory, "index.html")), "Build the production client first.");
  const previousNodeEnv = process.env.NODE_ENV;
  const server = await startProductionServer({ port: 0, clientDirectory, logUrls: false });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const harnessResponse = await page.request.get(
      `${origin}/tests/finished-board-harness.html?scenario=promotion`,
    );
    expect(harnessResponse.status()).toBe(404);
    const harnessModuleResponse = await page.request.get(`${origin}/tests/finished-board-harness.tsx`);
    expect(harnessModuleResponse.status()).toBe(404);

    const response = await page.goto(`${origin}/?scenario=promotion`, { waitUntil: "load" });
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
    await expect(page.getByRole("table", { name: "Dama board. White to move." })).toBeVisible();
    await expect(page.getByRole("button", { name: /White man/ })).toHaveCount(16);
    await expect(page.getByRole("button", { name: /Black man/ })).toHaveCount(16);
    expect(await page.evaluate(() => Object.getOwnPropertyNames(window).filter((name) => name.startsWith("__meydan"))))
      .toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  }
});
