import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

async function tabTo(page: Page, target: Locator, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const focused = await target.evaluate((element) => document.activeElement === element).catch(() => false);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach ${description} using Tab navigation.`);
}

async function typeInto(page: Page, target: Locator, value: string, description: string): Promise<void> {
  await tabTo(page, target, description);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(value);
}

function squareName(label: string | null): string {
  const square = label?.match(/^([a-h][1-8]),/)?.[1];
  if (square === undefined) throw new Error(`Unexpected accessible square name: ${String(label)}`);
  return square;
}

function visualPosition(square: string, flipped: boolean): { row: number; column: number } {
  const row = 8 - Number(square.slice(1));
  const column = square.charCodeAt(0) - "a".charCodeAt(0);
  return flipped ? { row: 7 - row, column: 7 - column } : { row, column };
}

async function moveBoardFocus(page: Page, toSquare: string, flipped = false): Promise<void> {
  const active = page.locator(".board-grid button:focus");
  const from = visualPosition(squareName(await active.getAttribute("aria-label")), flipped);
  const to = visualPosition(toSquare, flipped);
  for (let row = from.row; row < to.row; row += 1) await page.keyboard.press("ArrowDown");
  for (let row = from.row; row > to.row; row -= 1) await page.keyboard.press("ArrowUp");
  for (let column = from.column; column < to.column; column += 1) await page.keyboard.press("ArrowRight");
  for (let column = from.column; column > to.column; column -= 1) await page.keyboard.press("ArrowLeft");
}

async function auditVisibleControlNames(page: Page): Promise<void> {
  const unnamed = await page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rects = element.getClientRects();
      return rects.length > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    return Array.from(document.querySelectorAll<HTMLElement>(
      "button, input:not([type='hidden']), select, textarea, [role='button']",
    ))
      .filter(visible)
      .flatMap((element) => {
        const labelledBy = element.getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        const explicit = element.getAttribute("aria-label")?.trim();
        const labelText = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
          ? Array.from(element.labels ?? []).map((label) => label.textContent ?? "").join(" ").trim()
          : "";
        const content = element instanceof HTMLButtonElement || element.getAttribute("role") === "button"
          ? (element.innerText || element.querySelector("img")?.getAttribute("alt") || "").trim()
          : "";
        const hasName = Boolean(explicit || labelledBy || labelText || content);
        return hasName ? [] : [{ control: element.outerHTML.slice(0, 180), titleOnly: element.title.trim() }];
      });
  });
  expect(unnamed, "Every visible control should have a name beyond a tooltip").toEqual([]);
}

async function selectOnlineMode(page: Page): Promise<void> {
  const mode = page.getByTestId("mode-online");
  await tabTo(page, mode, "Play online mode");
  await page.keyboard.press("Enter");
  await expect(mode).toHaveAttribute("aria-pressed", "true");
}

async function dismissResultByKeyboard(page: Page): Promise<void> {
  const result = page.getByRole("dialog", { name: "Match result" });
  await expect(result).toBeVisible();
  const continueButton = result.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(result).toBeHidden();
  const activeAfterClose = await page.evaluate(() => document.activeElement instanceof HTMLElement
    ? document.activeElement.outerHTML.slice(0, 180)
    : String(document.activeElement));
  await expect(page.getByTestId("turn-status"), `Focus after closing the result dialog: ${activeAfterClose}`).toBeFocused();
}

test("local and computer modes support keyboard play, inactive turn controls, and dialog restoration", async ({ page }) => {
  test.setTimeout(60_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await auditVisibleControlNames(page);

    const localUndo = page.getByTestId("undo-button");
    await expect(localUndo).toBeDisabled();
    await tabTo(page, page.getByTestId("sound-toggle"), "sound control");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("new-game-button")).toBeFocused();

    const localMode = page.getByTestId("mode-local");
    await tabTo(page, localMode, "Local two-player mode");
    await page.keyboard.press("Enter");
    await expect(localMode).toHaveAttribute("aria-pressed", "true");

    const computerMode = page.getByTestId("mode-computer");
    await tabTo(page, computerMode, "Play against computer mode");
    await page.keyboard.press("Enter");
    await expect(computerMode).toHaveAttribute("aria-pressed", "true");
    await auditVisibleControlNames(page);

    const difficulty = page.getByLabel("Difficulty");
    await tabTo(page, difficulty, "computer difficulty setting");
    const currentDifficulty = await difficulty.inputValue();
    if (currentDifficulty === "medium") {
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowDown");
    } else {
      await page.keyboard.press(currentDifficulty === "hard" ? "ArrowUp" : "ArrowDown");
    }
    await expect(difficulty).toHaveValue("medium");

    const firstSquare = page.locator('.board-grid button[tabindex="0"]');
    await tabTo(page, firstSquare, "the Dama board");
    const focusedSquare = squareName(await firstSquare.getAttribute("aria-label"));
    const source = page.locator(".square-control--source").first();
    const sourceSquare = squareName(await source.getAttribute("aria-label"));
    await moveBoardFocus(page, sourceSquare);
    await page.keyboard.press("Enter");
    await expect(page.locator(".square-control--selected")).toHaveCount(1);
    const landing = page.locator(".square-control--landing").first();
    const landingSquare = squareName(await landing.getAttribute("aria-label"));
    await moveBoardFocus(page, landingSquare);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    await expect(page.getByTestId("computer-status")).toHaveText("Computer thinking…");
    await expect(page.locator('.square-control[aria-disabled="true"]')).toHaveCount(64);
    await expect(page.locator(".board-grid button[tabindex='0']")).toBeFocused();

    // Enter on an aria-disabled square must not make a move during the computer turn.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    await expect(page.getByTestId("history-count")).toHaveText("2 plies", { timeout: 30_000 });
    expect(focusedSquare).toMatch(/^[a-h][1-8]$/);

    const rulesButton = page.getByRole("button", { name: "Read Dama rules" });
    await tabTo(page, rulesButton, "Dama rules");
    await page.keyboard.press("Enter");
    const rulesDialog = page.getByRole("dialog", { name: "Dama rules" });
    await expect(rulesDialog).toBeVisible();
    const title = rulesDialog.getByRole("heading", { name: "Dama rules" });
    await expect(title).toBeFocused();
    await expect(title).toContainText("Dama rules");
    expect(await title.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Tab");
    await expect(rulesDialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(rulesDialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rulesDialog).toBeHidden();
    await expect(rulesButton).toBeFocused();

    const newGame = page.getByRole("button", { name: "Start a new computer Dama game" });
    await tabTo(page, newGame, "New game");
    const newGameFocus = await newGame.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(newGameFocus).not.toBe("none");
    await page.keyboard.press("Enter");
    const confirmation = page.getByRole("dialog", { name: "Start a new game?" });
    await expect(confirmation).toBeVisible();
    const cancel = confirmation.getByRole("button", { name: "Keep current game" });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    const closeConfirmation = confirmation.getByRole("button", { name: "Close dialog" });
    await expect(closeConfirmation).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirmation.getByRole("button", { name: "Start new game" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeConfirmation).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(newGame).toBeFocused();

    await tabTo(page, localMode, "return to Local two-player mode");
    await page.keyboard.press("Enter");
    const modeConfirmation = page.getByRole("dialog", { name: "Change play mode?" });
    await expect(modeConfirmation).toBeVisible();
    await expect(modeConfirmation.getByRole("button", { name: "Keep current game" })).toBeFocused();
    await tabTo(page, modeConfirmation.getByRole("button", { name: "Change mode" }), "confirm mode change");
    await page.keyboard.press("Enter");
    await expect(modeConfirmation).toBeHidden();
    await expect(localMode).toHaveAttribute("aria-pressed", "true");
    await expect(localMode).toBeFocused();
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

test("online create, play or spectate, draw, rematch, resign, export, and leave are keyboard operable", async ({ browser }) => {
  test.setTimeout(120_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [contextA, contextB, contextC] = contexts;
  if (contextA === undefined || contextB === undefined || contextC === undefined) {
    throw new Error("The online accessibility test needs three browser contexts.");
  }
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageC = await contextC.newPage();
  const pageErrors: string[] = [];
  for (const page of [pageA, pageB, pageC]) {
    page.on("pageerror", (error) => pageErrors.push(error.message));
  }

  try {
    const origin = `http://127.0.0.1:${server.port}/`;
    await Promise.all([pageA.goto(origin), pageB.goto(origin), pageC.goto(origin)]);
    await Promise.all([auditVisibleControlNames(pageA), auditVisibleControlNames(pageB), auditVisibleControlNames(pageC)]);

    await selectOnlineMode(pageA);
    await expect(pageA.getByTestId("online-create")).toBeEnabled();
    const nameA = pageA.getByTestId("online-nickname");
    await tabTo(pageA, pageA.getByTestId("online-create"), "Create room");
    await pageA.keyboard.press("Enter");
    await expect(nameA).toHaveAttribute("aria-invalid", "true");
    await expect(nameA).toHaveAttribute("aria-describedby", "online-name-error");
    await expect(pageA.getByRole("alert")).toContainText("Enter a name");
    await typeInto(pageA, nameA, "Keyboard Alice", "nickname field");
    await expect(nameA).not.toHaveAttribute("aria-invalid", "true");
    await tabTo(pageA, pageA.getByTestId("online-create"), "Create room");
    await pageA.keyboard.press("Enter");
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");
    const roomCode = (await pageA.getByTestId("online-room-code").innerText()).trim();
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
    await auditVisibleControlNames(pageA);

    await selectOnlineMode(pageB);
    await expect(pageB.getByTestId("online-join-player")).toBeEnabled();
    await typeInto(pageB, pageB.getByTestId("online-nickname"), "Keyboard Bob", "nickname field");
    await typeInto(pageB, pageB.getByTestId("online-room-code-input"), "bad!", "room code field");
    await tabTo(pageB, pageB.getByTestId("online-join-player"), "Join as player");
    await pageB.keyboard.press("Enter");
    const roomCodeField = pageB.getByTestId("online-room-code-input");
    await expect(roomCodeField).toHaveAttribute("aria-invalid", "true");
    await expect(roomCodeField).toHaveAttribute("aria-describedby", "online-code-error");
    await expect(pageB.getByRole("alert")).toContainText("six-character code");
    await typeInto(pageB, roomCodeField, roomCode, "room code field");
    await tabTo(pageB, pageB.getByTestId("online-join-player"), "Join as player");
    await pageB.keyboard.press("Enter");
    await expect(pageB.getByTestId("online-role")).toHaveText("You are playing as Black.");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await expect(pageA.getByTestId("online-clocks")).toHaveAttribute("aria-live", "off");

    await selectOnlineMode(pageC);
    await expect(pageC.getByTestId("online-join-spectator")).toBeEnabled();
    await typeInto(pageC, pageC.getByTestId("online-nickname"), "Keyboard Casey", "nickname field");
    await typeInto(pageC, pageC.getByTestId("online-room-code-input"), roomCode, "room code field");
    await tabTo(pageC, pageC.getByTestId("online-join-spectator"), "Join as spectator");
    await pageC.keyboard.press("Enter");
    await expect(pageC.getByTestId("online-role")).toHaveText("You are spectating.");
    await expect(pageC.getByTestId("spectator-action-status")).toHaveText("Read-only spectator");
    await auditVisibleControlNames(pageC);

    const spectatorState = await pageC.getByTestId("online-board-state").evaluate((element) => ({
      revision: element.getAttribute("data-revision"),
      history: document.querySelector('[data-testid="history-count"]')?.textContent,
    }));
    await expect(pageC.locator('.square-control[aria-disabled="true"]')).toHaveCount(64);
    await expect(pageC.locator('.board-grid button[tabindex="0"]')).toHaveCount(1);
    const spectatorBoard = pageC.locator('.board-grid button[tabindex="0"]');
    await tabTo(pageC, spectatorBoard, "read-only spectator board");
    await expect(spectatorBoard).toHaveAttribute("aria-label", /^(?:[a-h][1-8]),/);
    await moveBoardFocus(pageC, "e4");
    await expect(pageC.locator(".board-grid button:focus")).toHaveAttribute("aria-label", /^e4,/);
    await pageC.keyboard.press("ArrowRight");
    await expect(pageC.locator(".board-grid button:focus")).toHaveAttribute("aria-label", /^f4,/);

    const flip = pageC.getByRole("button", { name: "Flip board orientation" });
    await tabTo(pageC, flip, "Flip board orientation");
    await pageC.keyboard.press("Enter");
    await expect(flip).toHaveAttribute("aria-pressed", "true");
    await pageC.keyboard.press("Shift+Tab");
    await expect(pageC.locator(".board-grid button:focus")).toHaveAttribute("aria-label", /^f4,/);
    await pageC.keyboard.press("ArrowRight");
    await expect(pageC.locator(".board-grid button:focus")).toHaveAttribute("aria-label", /^e4,/);
    await pageC.keyboard.press("Enter");
    await expect(pageC.locator(".square-control--selected")).toHaveCount(0);
    expect(await pageC.getByTestId("online-board-state").evaluate((element) => ({
      revision: element.getAttribute("data-revision"),
      history: document.querySelector('[data-testid="history-count"]')?.textContent,
    }))).toEqual(spectatorState);

    const rulesButton = pageC.getByRole("button", { name: "Read Dama rules" });
    await tabTo(pageC, rulesButton, "Dama rules");
    await pageC.keyboard.press("Enter");
    const rulesDialog = pageC.getByRole("dialog", { name: "Dama rules" });
    await expect(rulesDialog.getByRole("heading", { name: "Dama rules" })).toBeFocused();
    await pageC.keyboard.press("Escape");
    await expect(rulesDialog).toBeHidden();
    await expect(rulesButton).toBeFocused();

    await tabTo(pageA, pageA.getByTestId("draw-offer"), "Offer draw");
    await pageA.keyboard.press("Enter");
    await expect(pageA.getByTestId("draw-offer-status")).toContainText("Outgoing draw offer");
    await expect(pageB.getByTestId("draw-offer-status")).toContainText("Incoming draw offer");
    await tabTo(pageB, pageB.getByTestId("draw-accept"), "Accept draw");
    await pageB.keyboard.press("Enter");
    const acceptDialog = pageB.getByRole("dialog", { name: "Accept this draw?" });
    await expect(acceptDialog).toBeVisible();
    const cancelDraw = acceptDialog.getByRole("button", { name: "Cancel" });
    await expect(cancelDraw).toBeFocused();
    await pageB.keyboard.press("Tab");
    await expect(acceptDialog.getByRole("button", { name: "Accept draw" })).toBeFocused();
    await pageB.keyboard.press("Tab");
    const closeDraw = acceptDialog.getByRole("button", { name: "Close dialog" });
    await expect(closeDraw).toBeFocused();
    await pageB.keyboard.press("Shift+Tab");
    await expect(acceptDialog.getByRole("button", { name: "Accept draw" })).toBeFocused();
    await pageB.keyboard.press("Enter");
    await expect(pageB.getByTestId("online-result")).toHaveAttribute("data-result-state", "draw");
    await dismissResultByKeyboard(pageB);
    await dismissResultByKeyboard(pageA);
    await expect(pageC.getByTestId("turn-status")).toContainText("Draw");

    const [download] = await Promise.all([
      pageA.waitForEvent("download"),
      tabTo(pageA, pageA.getByRole("button", { name: "Download scorebook" }), "Download scorebook")
        .then(() => pageA.keyboard.press("Enter")),
    ]);
    const downloadPath = await download.path();
    if (downloadPath === null) throw new Error("The scorebook download did not produce a file.");
    const scorebookText = await readFile(downloadPath, "utf8");
    expect(scorebookText).toContain("Mode: Online player");
    expect(scorebookText).toContain("Details: Both sides agreed to a draw.");

    await tabTo(pageA, pageA.getByTestId("rematch-vote"), "Request rematch");
    await pageA.keyboard.press("Enter");
    const rematchDialogA = pageA.getByRole("dialog", { name: "Agree to a rematch?" });
    await expect(rematchDialogA.getByRole("button", { name: "Cancel" })).toBeFocused();
    await tabTo(pageA, rematchDialogA.getByRole("button", { name: "Agree to rematch" }), "Agree to rematch");
    await pageA.keyboard.press("Enter");
    await expect(pageA.getByTestId("rematch-status")).toHaveText("You agreed · waiting for opponent");
    await expect(pageA.getByTestId("turn-status")).toBeFocused();

    await tabTo(pageB, pageB.getByTestId("rematch-vote"), "Request rematch");
    await pageB.keyboard.press("Enter");
    const rematchDialogB = pageB.getByRole("dialog", { name: "Agree to a rematch?" });
    await tabTo(pageB, rematchDialogB.getByRole("button", { name: "Agree to rematch" }), "Agree to rematch");
    await pageB.keyboard.press("Enter");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "2");
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "2");

    await tabTo(pageA, pageA.getByTestId("online-resign"), "Resign");
    await pageA.keyboard.press("Enter");
    const resignDialog = pageA.getByRole("dialog", { name: "Resign this match?" });
    await expect(resignDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await tabTo(pageA, resignDialog.getByRole("button", { name: "Resign" }), "Confirm resignation");
    await pageA.keyboard.press("Enter");
    await expect(pageA.getByTestId("online-result")).toHaveAttribute("data-result-reason", "resignation");
    await dismissResultByKeyboard(pageA);
    await dismissResultByKeyboard(pageB);
    await expect(pageC.getByTestId("turn-status")).toContainText("wins");

    await tabTo(pageC, pageC.getByTestId("online-leave-room"), "Leave room");
    await pageC.keyboard.press("Enter");
    const leaveDialog = pageC.getByRole("dialog", { name: "Leave this room?" });
    await expect(leaveDialog.getByRole("button", { name: "Stay in room" })).toBeFocused();
    await tabTo(pageC, leaveDialog.getByRole("button", { name: "Leave room" }), "Confirm leaving room");
    await pageC.keyboard.press("Enter");
    await expect(pageC.getByTestId("online-create")).toBeVisible();
    await expect(pageC.getByTestId("turn-status")).toBeFocused();
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("reduced motion keeps selection usable and all timed effects at a minimum", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const motion = await page.evaluate(() => ({
      requested: matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      maxTransitionSeconds: Math.max(...Array.from(document.querySelectorAll<HTMLElement>("*"), (element) =>
        Math.max(...getComputedStyle(element).transitionDuration.split(",").map((duration) => Number.parseFloat(duration) || 0)),
      )),
      maxAnimationSeconds: Math.max(...Array.from(document.querySelectorAll<HTMLElement>("*"), (element) =>
        Math.max(...getComputedStyle(element).animationDuration.split(",").map((duration) => Number.parseFloat(duration) || 0)),
      )),
    }));
    expect(motion.requested).toBe(true);
    expect(motion.scrollBehavior).toBe("auto");
    expect(motion.maxTransitionSeconds).toBeLessThanOrEqual(0.001);
    expect(motion.maxAnimationSeconds).toBeLessThanOrEqual(0.001);

    const contrast = (foreground: string, background: string): number => {
      const luminance = (color: string): number => {
        const channels = color.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255);
        if (channels === undefined || channels.length < 3) throw new Error(`Expected a hex color, got ${color}.`);
        const linear = channels.slice(0, 3).map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
      };
      const a = luminance(foreground);
      const b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const palette = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        faint: root.getPropertyValue("--ink-faint").trim(),
        brassText: root.getPropertyValue("--brass-text").trim(),
        paper: root.getPropertyValue("--paper").trim(),
        canvas: root.getPropertyValue("--canvas").trim(),
      };
    });
    expect(contrast(palette.faint, palette.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.faint, palette.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.faint, "#f8f9f4")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.faint, "#f3f5ee")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.brassText, palette.paper)).toBeGreaterThanOrEqual(4.5);

    const board = page.locator(".board-grid");
    const before = await board.boundingBox();
    await page.keyboard.press("Tab");
    const source = page.locator(".square-control--source").first();
    await moveBoardFocus(page, squareName(await source.getAttribute("aria-label")));
    await page.keyboard.press("Enter");
    await expect(page.locator(".square-control--selected")).toHaveCount(1);
    expect(await board.boundingBox()).toEqual(before);
  } finally {
    try {
      await page.close();
    } finally {
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  }
});

