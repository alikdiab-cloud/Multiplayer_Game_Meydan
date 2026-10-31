import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

const deploymentMode = process.env.DAMA_DEPLOYMENT_MODE;
let developmentServer: Awaited<ReturnType<typeof startDevelopmentServer>> | undefined;
const responsiveViewports = [
  { width: 1440, height: 960 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
] as const;

function baseURLFor(testInfo: TestInfo): string {
  if (deploymentMode === "development") {
    if (developmentServer === undefined) throw new Error("The Vite development server did not start for this Playwright suite.");
    return `http://127.0.0.1:${developmentServer.port}`;
  }
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("The deployment Playwright configuration must set baseURL.");
  return baseURL;
}

test.beforeAll(async () => {
  if (deploymentMode === "development") {
    developmentServer = await startDevelopmentServer({ port: 0, logUrls: false });
  }
});

test.afterAll(async () => {
  if (developmentServer !== undefined) {
    await developmentServer.close();
    expect(developmentServer.httpServer.listening).toBe(false);
    expect(developmentServer.socketRuntime.io.sockets.sockets.size).toBe(0);
    expect(developmentServer.socketRuntime.registry).toMatchObject({ roomCount: 0, sessionCount: 0 });
    developmentServer = undefined;
  }
});

async function pngDimensions(path: string): Promise<{ width: number; height: number }> {
  const details = await stat(path);
  expect(details.size, `${path} was saved with image data`).toBeGreaterThan(1000);
  const image = await readFile(path);
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

async function playFirstLegalMove(page: Page): Promise<void> {
  const history = page.getByTestId("history-count");
  const before = await history.innerText();
  await page.locator(".square-control--source").first().click();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const landing = page.locator(".square-control--landing").first();
    await expect(landing).toBeVisible();
    await landing.click();
    if ((await history.innerText()) !== before) return;
  }
  throw new Error("A legal move did not complete within the board's maximum path length.");
}

async function responsiveMetrics(page: Page): Promise<{
  width: number;
  documentWidth: number;
  board: { x: number; y: number; width: number; height: number } | null;
  clippedText: string[];
  offscreenControls: string[];
  overlappingControls: string[];
}> {
  return page.evaluate(() => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom };
    };
    const visible = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const dialog = document.querySelector<HTMLElement>("dialog[open]");
    const scope: ParentNode = dialog ?? document;
    const controls = Array.from(scope.querySelectorAll<HTMLElement>(
      "button:not(.square-control), a[href], input, select, textarea, [role='button']",
    )).filter(visible);
    const board = document.querySelector<HTMLElement>(".board-grid");
    const textElements = Array.from(document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, p, span, strong, button, label, dt, dd, input, select",
    )).filter((element) => visible(element) && (element.innerText || element.textContent || "").trim().length > 0);
    const shortLabel = (element: HTMLElement) =>
      (element.getAttribute("aria-label") || element.innerText || element.textContent || element.tagName)
        .replace(/\s+/g, " ").trim().slice(0, 60);
    const clippedText = textElements.flatMap((element) =>
      element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1
        ? [shortLabel(element)]
        : [],
    );
    const offscreenControls = controls.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left < -1 || bounds.right > window.innerWidth + 1 ? [shortLabel(element)] : [];
    });
    const overlappingControls: string[] = [];
    for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
      const first = controls[firstIndex];
      if (first === undefined) continue;
      const firstBounds = first.getBoundingClientRect();
      for (let secondIndex = firstIndex + 1; secondIndex < controls.length; secondIndex += 1) {
        const second = controls[secondIndex];
        if (second === undefined) continue;
        const secondBounds = second.getBoundingClientRect();
        const overlapWidth = Math.min(firstBounds.right, secondBounds.right) - Math.max(firstBounds.left, secondBounds.left);
        const overlapHeight = Math.min(firstBounds.bottom, secondBounds.bottom) - Math.max(firstBounds.top, secondBounds.top);
        if (overlapWidth > 1 && overlapHeight > 1) overlappingControls.push(`${shortLabel(first)} | ${shortLabel(second)}`);
      }
    }
    return {
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      board: board === null ? null : rect(board),
      clippedText,
      offscreenControls,
      overlappingControls,
    };
  });
}

async function expectResponsiveState(page: Page, width: number, state: string): Promise<void> {
  const metrics = await responsiveMetrics(page);
  expect(metrics.width, `${state} viewport width`).toBe(width);
  expect(metrics.documentWidth, `${state} has no horizontal page overflow`).toBeLessThanOrEqual(width);
  expect(metrics.board, `${state} has a rendered Dama board`).not.toBeNull();
  expect(metrics.board?.width).toBeGreaterThan(0);
  expect(Math.abs((metrics.board?.width ?? 0) - (metrics.board?.height ?? 0)), `${state} board remains square`).toBeLessThanOrEqual(1);
  expect(metrics.clippedText, `${state} has no horizontally clipped labels`).toEqual([]);
  expect(metrics.offscreenControls, `${state} keeps controls inside the viewport width`).toEqual([]);
  expect(metrics.overlappingControls, `${state} does not overlap essential controls`).toEqual([]);
}

async function expectControlReachable(page: Page, testId: string, viewport: { width: number; height: number }): Promise<void> {
  const control = page.getByTestId(testId);
  await expect(control).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  expect(bounds, `${testId} is reachable by scrolling`).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(-1);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds?.y).toBeGreaterThanOrEqual(-1);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 1);
}

test("serves the SPA, static assets, and online transport for the configured server", async ({ page }, testInfo) => {
  test.skip(deploymentMode !== "development" && deploymentMode !== "production", "Run with a deployment Playwright config.");
  test.setTimeout(60_000);
  const baseURL = baseURLFor(testInfo);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const requests: string[] = [];
  const webSocketUrls: string[] = [];
  const assetResponses: Array<{ url: string; status: number; resourceType: string }> = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  page.on("request", (request) => requests.push(request.url()));
  page.on("websocket", (webSocket) => webSocketUrls.push(webSocket.url()));
  page.on("response", (response) => {
    const resourceType = response.request().resourceType();
    if (["script", "stylesheet", "image", "font"].includes(resourceType)) {
      assetResponses.push({ url: response.url(), status: response.status(), resourceType });
    }
  });

  const deepRoute = `${baseURL}/play/integration-check`;
  const documentResponse = await page.goto(deepRoute, { waitUntil: "load" });
  expect(documentResponse?.status()).toBe(200);
  await expect(page).toHaveTitle("Meydan | The Dama Club");
  await expect(page.getByTestId("mode-local")).toBeVisible();
  await expect(page.getByTestId("mode-online")).toBeVisible();

  const health = await page.request.get(`${baseURL}/api/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const sourceRequests = requests.filter((url) => /\/@vite|\/@id|\/@fs|@react-refresh|\/src\/main\.tsx/.test(new URL(url).pathname + new URL(url).search));
  if (deploymentMode === "production") {
    expect(sourceRequests, "production pages do not request Vite middleware or source modules").toEqual([]);
    expect(assetResponses.some(({ url, resourceType }) => resourceType === "script" && /\/assets\/index-[^/]+\.js$/.test(new URL(url).pathname))).toBe(true);
    expect(assetResponses.some(({ url, resourceType }) => resourceType === "stylesheet" && /\/assets\/index-[^/]+\.css$/.test(new URL(url).pathname))).toBe(true);
  } else {
    expect(sourceRequests.some((url) => url.includes("/@vite/client"))).toBe(true);
  }
  expect(assetResponses.length).toBeGreaterThan(0);
  expect(assetResponses.filter(({ status }) => status < 200 || status >= 400)).toEqual([]);

  const brokenImages = await page.evaluate(() =>
    Array.from(document.images)
      .filter((image) => !image.complete || image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src),
  );
  expect(brokenImages).toEqual([]);

  const socketRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/socket.io/")) socketRequests.push(request.url());
  });
  await page.getByTestId("mode-online").click();
  await page.getByTestId("online-nickname").fill("Mira Vale");
  await page.getByTestId("online-create").click();
  await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");
  await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-phase", "waiting");
  await expect.poll(() => socketRequests.length).toBeGreaterThan(0);
  await expect.poll(() => webSocketUrls.some((url) => {
    const parsed = new URL(url);
    return parsed.pathname === "/socket.io/" && parsed.searchParams.get("transport") === "websocket";
  })).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("computer play loads and completes through the configured worker bundle", async ({ page }, testInfo) => {
  test.skip(deploymentMode !== "development" && deploymentMode !== "production", "Run with a deployment Playwright config.");
  test.setTimeout(60_000);
  const baseURL = baseURLFor(testInfo);
  const pageErrors: string[] = [];
  const workerUrls: string[] = [];
  const workerResponses: Array<{ url: string; status: number }> = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("worker", (worker) => workerUrls.push(worker.url()));
  page.on("response", (response) => {
    if (/bot\.worker/.test(new URL(response.url()).pathname)) {
      workerResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto(`${baseURL}/`, { waitUntil: "load" });
  await page.getByTestId("mode-computer").click();
  await page.getByLabel("Difficulty").selectOption("easy");
  await page.getByLabel("Play as").selectOption("black");
  await expect(page.getByTestId("history-count")).toHaveText("1 ply", { timeout: 30_000 });
  expect(workerUrls.length).toBeGreaterThan(0);
  expect(workerUrls.some((url) => /bot\.worker/.test(new URL(url).pathname))).toBe(true);
  await expect.poll(() => workerResponses.length).toBeGreaterThan(0);
  expect(workerResponses.every(({ status }) => status === 200)).toBe(true);

  await playFirstLegalMove(page);
  await expect(page.getByTestId("history-count")).toHaveText("3 plies", { timeout: 30_000 });
  expect(pageErrors).toEqual([]);
});

for (const viewport of responsiveViewports) {
  test(`responsive online layout at ${viewport.width} by ${viewport.height}`, async ({ browser }, testInfo) => {
    test.skip(deploymentMode !== "development" && deploymentMode !== "production", "Run with a deployment Playwright config.");
    test.setTimeout(90_000);
    const baseURL = baseURLFor(testInfo);
    const evidenceDirectory = resolve(process.cwd(), "test-results", "deployment-evidence", deploymentMode ?? "unconfigured");
    await mkdir(evidenceDirectory, { recursive: true });
    const isPhone = viewport.width <= 390;
    const contextOptions = {
      viewport,
      deviceScaleFactor: 1,
      isMobile: isPhone,
      hasTouch: isPhone,
    };
    const playerContext = await browser.newContext(contextOptions);
    const opponentContext = await browser.newContext(contextOptions);
    let playerPage: Page | undefined;
    let opponentPage: Page | undefined;
    try {
      playerPage = await playerContext.newPage();
      opponentPage = await opponentContext.newPage();
      await playerPage.goto(baseURL, { waitUntil: "load" });
      await playerPage.getByTestId("mode-online").click();
      await playerPage.getByTestId("online-nickname").fill("Alexandria Vale");
      await playerPage.getByTestId("online-time-control").selectOption("rapid");
      await expectResponsiveState(playerPage, viewport.width, "online lobby");
      const lobbyPath = join(evidenceDirectory, `${viewport.width}-lobby.png`);
      await playerPage.screenshot({ path: lobbyPath, fullPage: false });
      expect(await pngDimensions(lobbyPath)).toEqual({ width: viewport.width, height: viewport.height });

      await playerPage.getByTestId("online-create").click();
      const roomCode = (await playerPage.getByTestId("online-room-code").innerText()).trim();
      await opponentPage.goto(baseURL, { waitUntil: "load" });
      await opponentPage.getByTestId("mode-online").click();
      await opponentPage.getByTestId("online-nickname").fill("Jordan Rivers");
      await opponentPage.getByTestId("online-room-code-input").fill(roomCode);
      await opponentPage.getByTestId("online-join-player").click();
      await expect(playerPage.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
      await playFirstLegalMove(playerPage);
      await expect(playerPage.getByTestId("history-count")).toHaveText("1 ply");
      const roomCodeLocator = playerPage.getByTestId("online-room-code");
      const scorebookRoomCode = playerPage.getByTestId("scorebook-room-code");
      await expect(scorebookRoomCode).toHaveText(roomCode);
      const roomCodeEvidenceMasks = [roomCodeLocator, scorebookRoomCode];
      await expectResponsiveState(playerPage, viewport.width, "online play");
      await expectControlReachable(playerPage, "draw-offer", viewport);
      await expectControlReachable(playerPage, "online-resign", viewport);
      await expectControlReachable(playerPage, "online-leave-room", viewport);
      await playerPage.evaluate(() => window.scrollTo(0, 0));

      const onlinePath = join(evidenceDirectory, `${viewport.width}-online.png`);
      await playerPage.screenshot({
        path: onlinePath,
        fullPage: false,
        mask: roomCodeEvidenceMasks,
        maskColor: "#f5f5ef",
      });
      expect(await pngDimensions(onlinePath)).toEqual({ width: viewport.width, height: viewport.height });

      if (deploymentMode === "production" && viewport.width === 1440) {
        const coverPath = resolve(process.cwd(), "docs", "cover.png");
        await mkdir(resolve(process.cwd(), "docs"), { recursive: true });
        await playerPage.screenshot({
          path: coverPath,
          fullPage: false,
          mask: roomCodeEvidenceMasks,
          maskColor: "#f5f5ef",
        });
        expect(await pngDimensions(coverPath)).toEqual({ width: 1440, height: 960 });
      }

      await expectControlReachable(playerPage, "online-resign", viewport);
      await playerPage.getByTestId("online-resign").click();
      const resignDialog = playerPage.getByRole("dialog", { name: "Resign this match?" });
      await expect(resignDialog).toBeVisible();
      await resignDialog.getByRole("button", { name: "Resign", exact: true }).click();
      const resultDialog = playerPage.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      await expect(resultDialog.getByRole("button", { name: "Continue" })).toBeVisible();
      await expect(resultDialog.getByRole("button", { name: "Close dialog" })).toBeVisible();
      const modalMetrics = await resultDialog.evaluate((dialog) => {
        const bounds = dialog.getBoundingClientRect();
        const content = dialog.querySelector<HTMLElement>(".modal-content");
        const close = dialog.querySelector<HTMLElement>('button[aria-label="Close dialog"], button[data-testid="result-dialog-dismiss"]');
        const closeBounds = close?.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          contentClientHeight: content?.clientHeight ?? 0,
          contentScrollHeight: content?.scrollHeight ?? 0,
          closeInside: closeBounds !== undefined && closeBounds.left >= bounds.left && closeBounds.right <= bounds.right &&
            closeBounds.top >= bounds.top && closeBounds.bottom <= bounds.bottom,
        };
      });
      expect(modalMetrics.width).toBeLessThanOrEqual(viewport.width - 16);
      expect(modalMetrics.height).toBeLessThanOrEqual(viewport.height - 16);
      expect(modalMetrics.x).toBeGreaterThanOrEqual(0);
      expect(modalMetrics.y).toBeGreaterThanOrEqual(0);
      expect(modalMetrics.x + modalMetrics.width).toBeLessThanOrEqual(viewport.width);
      expect(modalMetrics.y + modalMetrics.height).toBeLessThanOrEqual(viewport.height);
      expect(modalMetrics.closeInside).toBe(true);
      await expectResponsiveState(playerPage, viewport.width, "result dialog");
      const resultPath = join(evidenceDirectory, `${viewport.width}-result.png`);
      await playerPage.screenshot({
        path: resultPath,
        fullPage: false,
        mask: roomCodeEvidenceMasks,
        maskColor: "#f5f5ef",
      });
      expect(await pngDimensions(resultPath)).toEqual({ width: viewport.width, height: viewport.height });
      await resultDialog.getByRole("button", { name: "Continue" }).click();
      await expect(playerPage.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
      await expectResponsiveState(playerPage, viewport.width, "finished match");
      await expectControlReachable(playerPage, "rematch-vote", viewport);
      await expectControlReachable(playerPage, "online-leave-room", viewport);

      const summaryPath = join(evidenceDirectory, `${viewport.width}-measurements.json`);
      const finalMetrics = await responsiveMetrics(playerPage);
      const report = {
        deploymentMode,
        viewport,
        states: ["online lobby", "online play", "result dialog", "finished match"],
        finalMetrics,
        resultDialog: modalMetrics,
        screenshots: [lobbyPath, onlinePath, resultPath],
      };
      await writeFile(summaryPath, JSON.stringify(report, null, 2));
      expect(await stat(summaryPath)).toMatchObject({ size: expect.any(Number) });
    } finally {
      await Promise.all([playerPage?.close(), opponentPage?.close()].filter((close): close is Promise<void> => close !== undefined));
      await Promise.all([playerContext.close(), opponentContext.close()]);
    }
  });
}
