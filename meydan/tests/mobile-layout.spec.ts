import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

const phoneViewports = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
] as const;

type MobileLayoutSnapshot = {
  viewport: { width: number; height: number; visualHeight: number };
  document: { width: number; height: number; scrollX: number; scrollY: number };
  board: { x: number; y: number; width: number; height: number; visible: boolean } | null;
  smallestBoardSquare: { width: number; height: number } | null;
  shortTargets: Array<{ label: string; width: number; height: number }>;
  clippedText: Array<{ text: string; element: string; className: string; clientWidth: number; scrollWidth: number }>;
  offscreenHorizontally: Array<{ label: string; left: number; right: number }>;
  overlappingControls: Array<{ first: string; second: string }>;
  openDialog: { title: string; x: number; y: number; width: number; height: number; contentClientHeight: number; contentScrollHeight: number } | null;
};

async function captureLayout(page: Page): Promise<MobileLayoutSnapshot> {
  return page.evaluate(() => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right, bottom: bounds.bottom };
    };
    const visible = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const shortLabel = (element: HTMLElement) => (element.getAttribute("aria-label") || element.innerText || element.textContent || element.tagName)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    const board = document.querySelector<HTMLElement>(".board-coordinate-wrap");
    const boardBounds = board === null ? null : rect(board);
    const grid = document.querySelector<HTMLElement>(".board-grid");
    const gridBounds = grid === null ? null : rect(grid);
    const square = document.querySelector<HTMLElement>(".board-grid button");
    const squareBounds = square === null ? null : rect(square);
    const dialogContent = dialog?.querySelector<HTMLElement>(".modal-content") ?? null;
    const activeScope: ParentNode = dialog ?? document;
    const controls = Array.from(activeScope.querySelectorAll<HTMLElement>(
      "button:not(.square-control), input, select, textarea, [role='button']",
    )).filter(visible);
    const shortTargets = controls.flatMap((element) => {
      const bounds = rect(element);
      return bounds.width < 44 || bounds.height < 44
        ? [{ label: shortLabel(element), width: Math.round(bounds.width * 10) / 10, height: Math.round(bounds.height * 10) / 10 }]
        : [];
    });
    const textElements = Array.from(document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, p, span, strong, button, label, dt, dd, input, select",
    )).filter((element) => visible(element) && (element.innerText || element.textContent || "").trim().length > 0);
    const clippedText = textElements.flatMap((element) =>
      element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1
        ? [{
            text: shortLabel(element),
            element: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : element.tagName,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          }]
        : [],
    );
    const visibleFocusables = controls.map((element) => ({ element, bounds: rect(element) }));
    const offscreenHorizontally = visibleFocusables.flatMap(({ element, bounds }) =>
      bounds.left < -1 || bounds.right > window.innerWidth + 1
        ? [{ label: shortLabel(element), left: Math.round(bounds.left), right: Math.round(bounds.right) }]
        : [],
    );
    const overlappingControls: Array<{ first: string; second: string }> = [];
    for (let leftIndex = 0; leftIndex < visibleFocusables.length; leftIndex += 1) {
      const left = visibleFocusables[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < visibleFocusables.length; rightIndex += 1) {
        const right = visibleFocusables[rightIndex];
        if (right === undefined) continue;
        const width = Math.min(left.bounds.right, right.bounds.right) - Math.max(left.bounds.left, right.bounds.left);
        const height = Math.min(left.bounds.bottom, right.bounds.bottom) - Math.max(left.bounds.y, right.bounds.y);
        if (width > 1 && height > 1) {
          overlappingControls.push({ first: shortLabel(left.element), second: shortLabel(right.element) });
        }
      }
    }
    const dialogBounds = dialog === null ? null : rect(dialog);
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        visualHeight: window.visualViewport?.height ?? window.innerHeight,
      },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      board: boardBounds === null || gridBounds === null
        ? null
        : {
            x: Math.round(boardBounds.x),
            y: Math.round(boardBounds.y),
            width: Math.round(gridBounds.width * 10) / 10,
            height: Math.round(gridBounds.height * 10) / 10,
            visible: boardBounds.y >= -1 && boardBounds.bottom <= window.innerHeight + 1,
          },
      smallestBoardSquare: squareBounds === null
        ? null
        : { width: Math.round(squareBounds.width * 10) / 10, height: Math.round(squareBounds.height * 10) / 10 },
      shortTargets,
      clippedText,
      offscreenHorizontally,
      overlappingControls,
      openDialog: dialog === null || dialogBounds === null
        ? null
        : {
            title: dialog.getAttribute("aria-labelledby")
              ? document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent?.trim() ?? ""
              : "",
            x: Math.round(dialogBounds.x),
            y: Math.round(dialogBounds.y),
            width: Math.round(dialogBounds.width),
            height: Math.round(dialogBounds.height),
            contentClientHeight: dialogContent?.clientHeight ?? 0,
            contentScrollHeight: dialogContent?.scrollHeight ?? 0,
          },
    } satisfies MobileLayoutSnapshot;
  });
}

async function saveState(
  page: Page,
  screenshotRoot: string,
  width: number,
  state: string,
  fullPage = true,
): Promise<MobileLayoutSnapshot> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(screenshotRoot, `${width}-${state}.png`), fullPage });
  return captureLayout(page);
}

async function reachControl(page: Page, selector: string): Promise<void> {
  const control = page.locator(selector);
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  if (box === null) throw new Error(`Could not reach visible mobile control ${selector}.`);
  const viewport = page.viewportSize();
  if (viewport === null || box.y < -1 || box.y + box.height > viewport.height + 1) {
    throw new Error(`Mobile control ${selector} did not settle inside the viewport after scrolling.`);
  }
}

for (const viewport of phoneViewports) {
  test(`mobile layout at ${viewport.width} CSS pixels keeps game states usable`, async ({ browser }) => {
    test.setTimeout(120_000);
    const server = await startDevelopmentServer({ port: 0, logUrls: false });
    const screenshotRoot = join(process.cwd(), "browser-artifacts", "mobile-layout");
    await mkdir(screenshotRoot, { recursive: true });
    const metrics: Array<{ width: number; state: string; layout: MobileLayoutSnapshot }> = [];
    const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
    const pages: Page[] = [];

    async function newPhonePage(stallComputer = false): Promise<Page> {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      if (stallComputer) {
        await page.addInitScript(() => {
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            override postMessage(): void {
              // Keep this screenshot on the thinking state without starting a search.
            }
          } as typeof Worker;
        });
      }
      return page;
    }

    async function record(page: Page, state: string, fullPage = true): Promise<MobileLayoutSnapshot> {
      const layout = await saveState(page, screenshotRoot, viewport.width, state, fullPage);
      metrics.push({ width: viewport.width, state, layout });
      expect(layout.document.width, `${state} has horizontal page overflow`).toBeLessThanOrEqual(viewport.width);
      expect(layout.board, `${state} keeps its board visible`).not.toBeNull();
      expect(layout.board?.visible, `${state} keeps the full board in the viewport`).toBe(true);
      expect(Math.abs((layout.board?.width ?? 0) - (layout.board?.height ?? 0)), `${state} keeps the board square`).toBeLessThanOrEqual(1);
      expect(layout.shortTargets, `${state} keeps non-board touch controls at least 44px tall`).toEqual([]);
      expect(layout.clippedText, `${state} has no clipped labels`).toEqual([]);
      expect(layout.offscreenHorizontally, `${state} keeps controls within the viewport`).toEqual([]);
      expect(layout.overlappingControls, `${state} keeps controls separate`).toEqual([]);
      if (layout.openDialog !== null) {
        expect(layout.openDialog.width).toBeLessThanOrEqual(viewport.width - 24);
        expect(layout.openDialog.height).toBeLessThanOrEqual(viewport.height - 24);
        expect(layout.openDialog.title.length).toBeGreaterThan(0);
      }
      return layout;
    }

    try {
      const localPage = await newPhonePage();
      await localPage.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
      await localPage.getByTestId("mode-local").click();
      await localPage.locator(".square-control--source").first().click();
      await localPage.locator(".square-control--landing").first().click();
      await expect(localPage.getByTestId("history-count")).toHaveText("1 ply");
      await record(localPage, "local-play");
      const flip = localPage.getByRole("button", { name: "Flip board orientation" });
      await flip.tap();
      await expect(flip).toHaveAttribute("aria-pressed", "true");
      await expect(localPage.locator(".rank-labels span")).toHaveText(["1", "2", "3", "4", "5", "6", "7", "8"]);
      await record(localPage, "local-play-flipped");
      await flip.tap();
      await expect(flip).toHaveAttribute("aria-pressed", "false");
      await expect(localPage.locator(".rank-labels span")).toHaveText(["8", "7", "6", "5", "4", "3", "2", "1"]);

      const computerPage = await newPhonePage(true);
      await computerPage.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
      await computerPage.getByTestId("mode-computer").click();
      await computerPage.getByLabel("Difficulty").selectOption("hard");
      await computerPage.getByLabel("Play as").selectOption("black");
      await expect(computerPage.getByTestId("computer-status")).toHaveText("Computer thinking…");
      await record(computerPage, "computer-thinking");

      const contextA = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      });
      const contextB = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      });
      const contextC = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      });
      contexts.push(contextA, contextB, contextC);
      const playerPage = await contextA.newPage();
      const secondPlayerPage = await contextB.newPage();
      const spectatorPage = await contextC.newPage();
      pages.push(playerPage, secondPlayerPage, spectatorPage);
      const origin = `http://127.0.0.1:${server.port}/`;

      await playerPage.goto(origin, { waitUntil: "load" });
      await playerPage.getByTestId("mode-online").click();
      await playerPage.getByTestId("online-nickname").fill("AlexandriaLongPlayerName");
      await playerPage.getByTestId("online-time-control").selectOption("rapid");
      await expect(playerPage.getByTestId("online-create")).toBeEnabled();
      await record(playerPage, "lobby");
      const lobbyName = playerPage.getByTestId("online-nickname");
      await lobbyName.tap();
      const viewportBeforeKeyboard = await playerPage.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
      await playerPage.setViewportSize({ width: viewport.width, height: 360 });
      await lobbyName.scrollIntoViewIfNeeded();
      const keyboardFormMetrics = await lobbyName.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewportHeight: window.visualViewport?.height ?? window.innerHeight };
      });
      expect(keyboardFormMetrics.top).toBeGreaterThanOrEqual(-1);
      expect(keyboardFormMetrics.bottom).toBeLessThanOrEqual(keyboardFormMetrics.viewportHeight + 1);
      await playerPage.screenshot({ path: join(screenshotRoot, `${viewport.width}-keyboard-form.png`), fullPage: false });
      await playerPage.setViewportSize({ width: viewport.width, height: viewport.height });

      await playerPage.getByTestId("online-create").click();
      const roomCode = (await playerPage.getByTestId("online-room-code").innerText()).trim();
      await secondPlayerPage.goto(origin, { waitUntil: "load" });
      await secondPlayerPage.getByTestId("mode-online").click();
      await secondPlayerPage.getByTestId("online-nickname").fill("ConstantinopleBlackPlayer");
      await secondPlayerPage.getByTestId("online-room-code-input").fill(roomCode);
      await expect(secondPlayerPage.getByTestId("online-join-player")).toBeEnabled();
      await secondPlayerPage.getByTestId("online-join-player").click();
      await expect(playerPage.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

      await spectatorPage.goto(origin, { waitUntil: "load" });
      await spectatorPage.getByTestId("mode-online").click();
      await spectatorPage.getByTestId("online-nickname").fill("PhoneSpectator");
      await spectatorPage.getByTestId("online-room-code-input").fill(roomCode);
      await expect(spectatorPage.getByTestId("online-join-spectator")).toBeEnabled();
      await spectatorPage.getByTestId("online-join-spectator").click();
      await expect(spectatorPage.getByTestId("online-role")).toHaveText("You are spectating.");
      await record(playerPage, "online-play");
      await record(spectatorPage, "spectator");

      await spectatorPage.getByRole("button", { name: "Read Dama rules" }).tap();
      const rulesDialog = spectatorPage.getByRole("dialog", { name: "Dama rules" });
      await expect(rulesDialog).toBeVisible();
      const rulesLayout = await record(spectatorPage, "rules", false);
      expect(rulesLayout.openDialog?.contentScrollHeight).toBeGreaterThan(rulesLayout.openDialog?.contentClientHeight ?? 0);
      await rulesDialog.locator(".modal-content").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(rulesDialog.locator(".rules-service-note")).toBeInViewport();
      const closeBounds = await rulesDialog.getByRole("button", { name: "Close dialog" }).boundingBox();
      expect(closeBounds).not.toBeNull();
      expect(closeBounds?.height).toBeGreaterThanOrEqual(44);
      expect(closeBounds?.y).toBeGreaterThanOrEqual(0);
      expect((closeBounds?.y ?? 0) + (closeBounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
      await spectatorPage.evaluate(() => window.getSelection()?.removeAllRanges());
      await record(spectatorPage, "rules-scrolled", false);
      await rulesDialog.getByRole("button", { name: "Close dialog" }).tap();

      await reachControl(playerPage, '[data-testid="online-resign"]');
      await playerPage.getByTestId("online-resign").tap();
      const resignDialog = playerPage.getByRole("dialog", { name: "Resign this match?" });
      await expect(resignDialog).toBeVisible();
      await resignDialog.getByRole("button", { name: "Resign", exact: true }).tap();
      const resultDialog = playerPage.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      await playerPage.evaluate(() => window.scrollTo(0, 0));
      const resultLayout = await record(playerPage, "result", false);
      await expect(resultDialog.getByRole("button", { name: "Continue" })).toBeVisible();
      expect(resultLayout.openDialog?.title).toBe("Match result");
      expect(resultLayout.shortTargets).toEqual([]);
      await resultDialog.getByRole("button", { name: "Continue" }).tap();
      await expect(resultDialog).not.toBeVisible();
      await record(playerPage, "online-finished");
      await reachControl(playerPage, '[data-testid="rematch-vote"]');
      await reachControl(playerPage, '[data-testid="online-leave-room"]');

      for (const page of pages) {
        const horizontal = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(horizontal, `${viewport.width}px page has horizontal overflow at ${page.url()}`).toBeLessThanOrEqual(viewport.width);
      }
      const reportPath = join(screenshotRoot, `${viewport.width}-measurements.json`);
      await writeFile(reportPath, JSON.stringify({ viewport, viewportBeforeKeyboard, keyboardFormMetrics, states: metrics }, null, 2));
    } finally {
      await Promise.all(pages.map((page) => page.close()));
      await Promise.all(contexts.map((context) => context.close()));
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  });
}

