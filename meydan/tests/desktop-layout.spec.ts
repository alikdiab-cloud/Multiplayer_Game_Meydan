import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

const desktopViewports = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1440, height: 768 },
] as const;

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type DesktopLayoutSnapshot = {
  viewport: { width: number; height: number };
  document: { width: number; height: number; scrollX: number; scrollY: number };
  gameLayout: Rect | null;
  boardFrame: (Rect & { visibleAtTop: boolean }) | null;
  board: (Rect & { visibleAtTop: boolean }) | null;
  boardColumn: Rect | null;
  tableNotes: Rect | null;
  boardToNotesGap: number | null;
  history: { clientHeight: number; scrollHeight: number; overflowY: string; maxHeight: string } | null;
  openDialog: { title: string; width: number; height: number } | null;
  clockCards: Array<{ side: string; rect: Rect; label: Rect | null; reading: Rect | null; labelReadingOverlap: boolean }>;
  clippedText: Array<{ text: string; tag: string; className: string; clientWidth: number; scrollWidth: number }>;
  horizontallyOffscreenControls: Array<{ name: string; left: number; right: number }>;
};

async function measure(page: Page): Promise<DesktopLayoutSnapshot> {
  return page.evaluate(() => {
    const rect = (element: Element): Rect => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const visible = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const board = document.querySelector<HTMLElement>(".board-plane");
    const boardFrame = document.querySelector<HTMLElement>(".board-coordinate-wrap");
    const boardColumn = document.querySelector<HTMLElement>(".board-column");
    const tableNotes = document.querySelector<HTMLElement>(".table-notes");
    const gameLayout = document.querySelector<HTMLElement>(".game-layout");
    const history = document.querySelector<HTMLElement>(".scorebook-scroll");
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    const boardRect = board === null ? null : rect(board);
    const notesRect = tableNotes === null ? null : rect(tableNotes);
    const textNodes = Array.from(document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, p, span, strong, button, label, dt, dd, input, select",
    )).filter((element) => visible(element) && (element.innerText || element.textContent || "").trim().length > 0);
    const clippedText = textNodes.flatMap((element) => element.scrollWidth > element.clientWidth + 1
      ? [{
          text: (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
            .replace(/\s+/g, " ").trim().slice(0, 70),
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : element.tagName,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }]
      : []);
    const clockCards = Array.from(document.querySelectorAll<HTMLElement>(".online-clock-card")).map((card) => {
      const label = card.querySelector<HTMLElement>(".online-clock-side");
      const reading = card.querySelector<HTMLElement>(".online-clock-reading");
      const labelRect = label === null ? null : rect(label);
      const readingRect = reading === null ? null : rect(reading);
      const labelReadingOverlap = labelRect !== null && readingRect !== null &&
        Math.min(labelRect.right, readingRect.right) > Math.max(labelRect.x, readingRect.x) + 1 &&
        Math.min(labelRect.bottom, readingRect.bottom) > Math.max(labelRect.y, readingRect.y) + 1;
      return {
        side: label?.textContent?.trim() ?? "",
        rect: rect(card),
        label: labelRect,
        reading: readingRect,
        labelReadingOverlap,
      };
    });
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      "button:not(.square-control), a[href], input, select, textarea, [role='button']",
    )).filter(visible);
    const horizontallyOffscreenControls = controls.flatMap((element) => {
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > window.innerWidth + 1
        ? [{
            name: (element.getAttribute("aria-label") || element.innerText || element.textContent || element.tagName)
              .replace(/\s+/g, " ").trim().slice(0, 70),
            left: Math.round(box.left),
            right: Math.round(box.right),
          }]
        : [];
    });

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      gameLayout: gameLayout === null ? null : rect(gameLayout),
      boardFrame: boardFrame === null ? null : {
        ...rect(boardFrame),
        visibleAtTop: boardFrame.getBoundingClientRect().top >= -1 &&
          boardFrame.getBoundingClientRect().bottom <= window.innerHeight + 1,
      },
      board: boardRect === null ? null : {
        ...boardRect,
        visibleAtTop: boardRect.y >= -1 && boardRect.bottom <= window.innerHeight + 1,
      },
      boardColumn: boardColumn === null ? null : rect(boardColumn),
      tableNotes: notesRect,
      boardToNotesGap: boardRect === null || notesRect === null ? null : Math.round((notesRect.x - boardRect.right) * 10) / 10,
      history: history === null ? null : {
        clientHeight: history.clientHeight,
        scrollHeight: history.scrollHeight,
        overflowY: getComputedStyle(history).overflowY,
        maxHeight: getComputedStyle(history).maxHeight,
      },
      openDialog: dialog === null
        ? null
        : {
            title: dialog.getAttribute("aria-labelledby")
              ? document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent?.trim() ?? ""
              : "",
            width: Math.round(dialog.getBoundingClientRect().width),
            height: Math.round(dialog.getBoundingClientRect().height),
          },
      clockCards,
      clippedText,
      horizontallyOffscreenControls,
    } satisfies DesktopLayoutSnapshot;
  });
}

async function playFirstLegalMove(page: Page): Promise<void> {
  const history = page.getByTestId("history-count");
  const before = await history.innerText();
  await page.locator(".square-control--source").first().click();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const landing = page.locator(".square-control--landing").first();
    if (await landing.count() === 0) break;
    await landing.click();
    if ((await history.innerText()) !== before) return;
  }
  await expect(history).not.toHaveText(before);
}

async function expectControlReachable(page: Page, selector: string): Promise<void> {
  const control = page.locator(selector);
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds, `${selector} exists and is visible`).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds?.y).toBeGreaterThanOrEqual(-1);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  expect(bounds?.x).toBeGreaterThanOrEqual(-1);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
}

for (const viewport of desktopViewports) {
  test(`desktop layout at ${viewport.width}x${viewport.height} keeps the board and controls usable`, async ({ browser }) => {
    test.setTimeout(120_000);
    const server = await startDevelopmentServer({ port: 0, logUrls: false });
    const screenshotRoot = join(process.cwd(), "browser-artifacts", "desktop-layout");
    await mkdir(screenshotRoot, { recursive: true });
    const origin = `http://127.0.0.1:${server.port}/`;
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    const states: Array<{ name: string; layout: DesktopLayoutSnapshot }> = [];

    async function newPage(): Promise<Page> {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      return page;
    }

    async function capture(page: Page, name: string, options: { viewport?: boolean; fullPage?: boolean } = {}): Promise<DesktopLayoutSnapshot> {
      await page.evaluate(() => window.scrollTo(0, 0));
      if (options.viewport === true) {
        await page.screenshot({ path: join(screenshotRoot, `${viewport.width}x${viewport.height}-${name}-viewport.png`), fullPage: false });
      }
      if (options.fullPage !== false) {
        await page.screenshot({ path: join(screenshotRoot, `${viewport.width}x${viewport.height}-${name}.png`), fullPage: true });
      }
      const layout = await measure(page);
      states.push({ name, layout });
      expect(layout.document.width, `${name} does not overflow horizontally`).toBeLessThanOrEqual(viewport.width);
      expect(layout.boardFrame?.visibleAtTop, `${name} keeps the board and its coordinates in the initial viewport`).toBe(true);
      expect(layout.board, `${name} has a board`).not.toBeNull();
      expect(Math.abs((layout.board?.width ?? 0) - (layout.board?.height ?? 0)), `${name} keeps a square board`).toBeLessThanOrEqual(1);
      expect(layout.board?.width).toBeGreaterThan(layout.tableNotes?.width ?? 0);
      expect(layout.boardToNotesGap).not.toBeNull();
      expect(layout.boardToNotesGap ?? 0).toBeLessThanOrEqual(48);
      if (layout.history !== null) {
        expect(layout.history.overflowY).toBe("auto");
        expect(Number.parseFloat(layout.history.maxHeight)).toBeLessThanOrEqual(240);
        expect(layout.history.clientHeight).toBeLessThanOrEqual(240);
      }
      expect(layout.clippedText, `${name} has no horizontally clipped labels`).toEqual([]);
      expect(layout.horizontallyOffscreenControls, `${name} keeps controls within the viewport width`).toEqual([]);
      for (const clock of layout.clockCards) {
        expect(clock.labelReadingOverlap, `${name} keeps the ${clock.side} clock label clear of its reading`).toBe(false);
      }
      return layout;
    }

    try {
      const player = await newPage();
      await player.goto(origin, { waitUntil: "load" });
      await player.getByTestId("mode-online").click();
      await player.getByTestId("online-nickname").fill("AlexandriaLongPlayerName");
      await player.getByTestId("online-time-control").selectOption("rapid");
      await capture(player, "lobby");
      await player.getByTestId("online-create").click();
      const roomCode = (await player.getByTestId("online-room-code").innerText()).trim();

      const opponent = await newPage();
      await opponent.goto(origin, { waitUntil: "load" });
      await opponent.getByTestId("mode-online").click();
      await opponent.getByTestId("online-nickname").fill("ConstantinopleBlackPlay");
      await opponent.getByTestId("online-room-code-input").fill(roomCode);
      await opponent.getByTestId("online-join-player").click();
      await expect(player.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

      await playFirstLegalMove(player);
      await playFirstLegalMove(opponent);
      await expect(player.getByTestId("history-count")).toHaveText("2 plies");
      const beforeSpectator = await capture(player, "online-play", { viewport: true });

      const spectator = await newPage();
      await spectator.goto(origin, { waitUntil: "load" });
      await spectator.getByTestId("mode-online").click();
      await spectator.getByTestId("online-nickname").fill("DesktopSpectator");
      await spectator.getByTestId("online-room-code-input").fill(roomCode);
      await spectator.getByTestId("online-join-spectator").click();
      await expect(spectator.getByTestId("online-role")).toHaveText("You are spectating.");

      const afterSpectator = await capture(player, "spectator-joined");
      await capture(spectator, "spectator-view");
      expect(afterSpectator.board?.width).toBeCloseTo(beforeSpectator.board?.width ?? 0, 1);
      expect(afterSpectator.board?.height).toBeCloseTo(beforeSpectator.board?.height ?? 0, 1);
      expect(afterSpectator.board?.x).toBeCloseTo(beforeSpectator.board?.x ?? 0, 1);
      expect(afterSpectator.board?.y).toBeCloseTo(beforeSpectator.board?.y ?? 0, 1);
      expect(afterSpectator.clockCards).toHaveLength(beforeSpectator.clockCards.length);
      for (const [index, card] of afterSpectator.clockCards.entries()) {
        const previous = beforeSpectator.clockCards[index];
        expect(previous).toBeDefined();
        expect(card.rect.width).toBeCloseTo(previous?.rect.width ?? 0, 1);
        expect(card.rect.height).toBeCloseTo(previous?.rect.height ?? 0, 1);
      }

      await expectControlReachable(player, '[data-testid="draw-offer"]');
      await expectControlReachable(player, '[data-testid="online-resign"]');
      await expectControlReachable(player, '[data-testid="online-leave-room"]');

      await player.getByTestId("online-resign").click();
      const confirmDialog = player.getByRole("dialog", { name: "Resign this match?" });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole("button", { name: "Resign", exact: true }).click();
      const resultDialog = player.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      const ended = await capture(player, "result-dialog", { viewport: true, fullPage: false });
      expect(ended.openDialog?.title).toBe("Match result");
      await resultDialog.getByRole("button", { name: "Continue" }).click();
      await expect(resultDialog).toBeHidden();
      const finished = await capture(player, "finished-match");
      expect(finished.board?.width).toBeCloseTo(beforeSpectator.board?.width ?? 0, 1);
      expect(finished.board?.height).toBeCloseTo(beforeSpectator.board?.height ?? 0, 1);
      expect(finished.board?.x).toBeCloseTo(beforeSpectator.board?.x ?? 0, 1);
      expect(finished.board?.y).toBeCloseTo(beforeSpectator.board?.y ?? 0, 1);
      await expectControlReachable(player, '[data-testid="rematch-vote"]');
      await expectControlReachable(player, '[data-testid="online-leave-room"]');

      await writeFile(
        join(screenshotRoot, `${viewport.width}x${viewport.height}-measurements.json`),
        JSON.stringify({ viewport, states }, null, 2),
      );
    } finally {
      await Promise.all(pages.map((page) => page.close()));
      await Promise.all(contexts.map((context) => context.close()));
      await server.close();
      expect(server.httpServer.listening).toBe(false);
    }
  });
}
