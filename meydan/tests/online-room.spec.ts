import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDevelopmentServer } from "../server/index.js";
import { DEFAULT_ROOM_IDLE_TIMEOUT_MS, RoomRegistryError } from "../server/rooms.js";
import type { RoomSnapshot } from "../shared/protocol.js";

async function openHarness(context: BrowserContext, origin: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/tests/online-room-harness.html`, { waitUntil: "load" });
  await expect(page.getByTestId("online-status")).toHaveText("connected");
  return page;
}

async function playFirstLegalMove(page: Page): Promise<void> {
  const historyCount = page.getByTestId("history-count");
  const countBeforeMove = await historyCount.innerText();
  await page.locator(".square-control--source").first().click();

  for (let landingIndex = 0; landingIndex < 16; landingIndex += 1) {
    const landing = page.locator(".square-control--landing").first();
    if (await landing.count() === 0) {
      await expect(historyCount).not.toHaveText(countBeforeMove);
      return;
    }
    await landing.click();
    if ((await historyCount.innerText()) !== countBeforeMove) return;
  }

  throw new Error("The selected legal move did not finish within the board's maximum path length.");
}

async function visibleScorebookLines(page: Page): Promise<string[]> {
  return page.getByTestId("move-history").locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => {
      const number = row.querySelector("th[scope=row]")?.textContent?.trim() ?? "";
      const white = row.querySelector('td[data-side="white"] .history-notation')?.textContent ?? "—";
      const black = row.querySelector('td[data-side="black"] .history-notation')?.textContent ?? "—";
      return `${number} White: ${white} | Black: ${black}`;
    }),
  );
}

async function readVisibleOnlineState(page: Page): Promise<{
  matchNumber: number;
  revision: number;
  phase: string;
  viewerSide: string;
  position: Record<string, string | null>;
  history: string[];
}> {
  const state = page.getByTestId("online-board-state");
  const position = await page.getByRole("button", { name: /^[a-h][1-8],/ }).evaluateAll((buttons) => {
    const entries: Array<[string, string | null]> = [];
    for (const button of buttons) {
      const label = button.getAttribute("aria-label") ?? "";
      const square = /^([a-h])([1-8]),/.exec(label);
      if (square?.[1] === undefined || square[2] === undefined) {
        throw new Error(`Unexpected square accessible name: ${label}`);
      }
      const coordinate = `${8 - Number(square[2])}|${square[1].charCodeAt(0) - "a".charCodeAt(0)}`;
      entries.push([coordinate, button.querySelector("img")?.getAttribute("alt") ?? null]);
    }
    return Object.fromEntries(entries);
  });
  return {
    matchNumber: Number(await state.getAttribute("data-match-number")),
    revision: Number(await state.getAttribute("data-revision")),
    phase: (await state.getAttribute("data-phase")) ?? "",
    viewerSide: (await state.getAttribute("data-viewer-side")) ?? "",
    position,
    history: await page.getByTestId("move-history").locator(".history-notation").allTextContents(),
  };
}

function snapshotPosition(snapshot: RoomSnapshot): Record<string, string | null> {
  const pieceLabels = { w: "White man", W: "White king", b: "Black man", B: "Black king" } as const;
  const position: Record<string, string | null> = {};
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const coordinate = `${row}|${column}`;
      const piece = snapshot.gameView.position[coordinate];
      position[coordinate] = piece === undefined ? null : pieceLabels[piece];
    }
  }
  return position;
}

async function expectViewerToMatchSnapshot(page: Page, snapshot: RoomSnapshot): Promise<void> {
  await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-revision", String(snapshot.revision));
  expect(await readVisibleOnlineState(page)).toEqual({
    matchNumber: snapshot.matchNumber,
    revision: snapshot.revision,
    phase: snapshot.phase,
    viewerSide: snapshot.viewerSide ?? "spectator",
    position: snapshotPosition(snapshot),
    history: snapshot.gameView.history.map(({ notation }) => notation),
  });
}

async function expectAllViewersToMatchRegistry(
  server: Awaited<ReturnType<typeof startDevelopmentServer>>,
  viewers: ReadonlyArray<readonly [Page, string]>,
): Promise<void> {
  for (const [page, sessionToken] of viewers) {
    const snapshot = server.socketRuntime.registry.snapshotForSession(sessionToken);
    if (snapshot === undefined) throw new Error("An online browser session lost its authoritative room snapshot.");
    const serializedSnapshot = JSON.stringify(snapshot);
    for (const [, credential] of viewers) expect(serializedSnapshot).not.toContain(credential);
    await expectViewerToMatchSnapshot(page, snapshot);
  }
}

async function expectOnlineViewport(page: Page, width: number): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.viewportWidth).toBe(width);
  expect(dimensions.documentWidth).toBeLessThanOrEqual(width);
  const board = await page.getByRole("table", { name: /^Dama board\./ }).boundingBox();
  expect(board).not.toBeNull();
  expect(Math.abs(board!.width - board!.height)).toBeLessThanOrEqual(2);
}

async function installAudioStartCounter(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const trackedWindow = window as Window & { __meydanToneStarts?: number };
    trackedWindow.__meydanToneStarts = 0;
    if (typeof window.AudioContext !== "function") return;
    const createOscillator = window.AudioContext.prototype.createOscillator;
    window.AudioContext.prototype.createOscillator = function () {
      const oscillator = createOscillator.call(this);
      const originalStart = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
        trackedWindow.__meydanToneStarts = (trackedWindow.__meydanToneStarts ?? 0) + 1;
        originalStart(when);
      };
      return oscillator;
    };
  });
}

async function audioStartCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __meydanToneStarts?: number }).__meydanToneStarts ?? 0);
}

test("online hook stores per-tab credentials, applies server state, rejects commands, and cleans up", async ({ browser }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    pageA = await openHarness(contextA, origin);
    pageB = await openHarness(contextB, origin);

    await pageA.getByLabel("Display name").fill("White Browser");
    await pageA.getByTestId("create-room").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("created");
    await expect(pageA.getByTestId("room-phase")).toHaveText("waiting");
    await expect(pageA.getByTestId("viewer-side")).toHaveText("white");
    const roomCode = await pageA.getByTestId("room-code").innerText();
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);

    const storedSessionA = await pageA.evaluate(() => {
      const entries = Object.entries(sessionStorage);
      return entries.find(([key]) => key.includes("online-session"))?.[1] ?? null;
    });
    expect(storedSessionA).not.toBeNull();
    const tokenA = JSON.parse(storedSessionA!).sessionToken as string;

    await pageB.getByLabel("Display name").fill("Black Browser");
    await pageB.getByLabel("Room code").fill(roomCode);
    await pageB.getByTestId("join-room").click();
    await expect(pageB.getByTestId("command-result")).toHaveText("joined");
    await expect(pageB.getByTestId("viewer-side")).toHaveText("black");
    await expect(pageB.getByTestId("room-phase")).toHaveText("playing");
    await expect(pageA.getByTestId("room-phase")).toHaveText("playing");

    await pageA.getByTestId("invalid-move").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("invalid-move");
    await expect(pageA.getByTestId("history-count")).toHaveText("0");
    await expect(pageA.getByTestId("recoverable-error")).toHaveText("invalid-move");

    const storedSessionB = await pageB.evaluate(() => {
      const entries = Object.entries(sessionStorage);
      return entries.find(([key]) => key.includes("online-session"))?.[1] ?? null;
    });
    expect(storedSessionB).not.toBeNull();
    const tokenB = JSON.parse(storedSessionB!).sessionToken as string;
    expect(tokenB).not.toBe(tokenA);
    for (const page of [pageA, pageB]) {
      expect(await page.locator("body").innerText()).not.toContain(tokenA);
      expect(await page.locator("body").innerText()).not.toContain(tokenB);
      expect(page.url()).not.toContain(tokenA);
      expect(page.url()).not.toContain(tokenB);
    }
    const localStorageA = await pageA.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    const localStorageB = await pageB.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    expect(localStorageA).not.toContain(tokenA);
    expect(localStorageB).not.toContain(tokenB);

    await pageA.getByTestId("legal-move").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("moved");
    await expect(pageA.getByTestId("history-count")).toHaveText("1");
    await expect(pageB.getByTestId("history-count")).toHaveText("1");
    await expect(pageB.getByTestId("turn-side")).toHaveText("black");

    // Navigating away unmounts the hook and closes its socket; the other tab receives
    // the resulting authoritative connection-status update from the registry.
    await pageA.goto("about:blank");
    await expect(pageB.getByTestId("white-connected")).toHaveText("no");
  } finally {
    await pageA?.close();
    await pageB?.close();
    await contextA.close();
    await contextB.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("a stale online move refreshes the room snapshot and is never replayed", async ({ browser }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    pageA = await openHarness(contextA, origin);
    pageB = await openHarness(contextB, origin);
    await pageA.getByLabel("Display name").fill("Current White");
    await pageA.getByTestId("create-room").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("created");
    const roomCode = await pageA.getByTestId("room-code").innerText();

    await pageB.getByLabel("Display name").fill("Current Black");
    await pageB.getByLabel("Room code").fill(roomCode);
    await pageB.getByTestId("join-room").click();
    await expect(pageA.getByTestId("room-phase")).toHaveText("playing");
    await expect(pageB.getByTestId("room-phase")).toHaveText("playing");
    const oldRevision = Number(await pageA.getByTestId("revision").innerText());
    expect(Number(await pageB.getByTestId("revision").innerText())).toBe(oldRevision);

    server.socketRuntime.registry.joinRoom({
      name: "Revision Observer",
      code: roomCode,
      role: "spectator",
    });
    expect(Number(await pageA.getByTestId("revision").innerText())).toBe(oldRevision);

    await pageA.getByTestId("legal-move").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("stale-revision");
    await expect(pageA.getByTestId("revision")).toHaveText(String(oldRevision + 1));
    await expect(pageB.getByTestId("revision")).toHaveText(String(oldRevision + 1));
    await expect(pageA.getByTestId("spectator-count")).toHaveText("1");
    await expect(pageA.getByTestId("history-count")).toHaveText("0");
    await expect(pageB.getByTestId("history-count")).toHaveText("0");
    await expect(pageA.getByTestId("turn-side")).toHaveText("white");
    await expect(pageA.getByTestId("pending-command")).toHaveText("none");
    await expect(pageA.getByTestId("recoverable-error")).toHaveText("none");
  } finally {
    await pageA?.close();
    await pageB?.close();
    await contextA.close();
    await contextB.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("reloading a player tab restores its side, room, moves, and running clocks", async ({ browser }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    pageA = await openHarness(contextA, origin);
    pageB = await openHarness(contextB, origin);

    await pageA.getByLabel("Display name").fill("Reloading White");
    await pageA.getByTestId("create-room").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("created");
    const roomCode = await pageA.getByTestId("room-code").innerText();

    await pageB.getByLabel("Display name").fill("Staying Black");
    await pageB.getByLabel("Room code").fill(roomCode);
    await pageB.getByTestId("join-room").click();
    await expect(pageA.getByTestId("room-phase")).toHaveText("playing");
    await expect(pageA.getByTestId("clock-active-side")).toHaveText("white");

    await pageA.getByTestId("legal-move").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("moved");
    await expect(pageB.getByTestId("history-count")).toHaveText("1");
    await expect(pageA.getByTestId("clock-active-side")).toHaveText("black");
    const whiteClockBeforeReload = Number(await pageA.getByTestId("white-clock-ms").innerText());
    const blackClockBeforeReload = Number(await pageA.getByTestId("black-clock-ms").innerText());

    await pageA.reload({ waitUntil: "load" });
    await expect(pageA.getByTestId("online-status")).toHaveText("connected");
    await expect(pageA.getByTestId("pending-command")).toHaveText("none");
    await expect(pageA.getByTestId("viewer-side")).toHaveText("white");
    await expect(pageA.getByTestId("room-code")).toHaveText(roomCode);
    await expect(pageA.getByTestId("room-phase")).toHaveText("playing");
    await expect(pageA.getByTestId("match-number")).toHaveText("1");
    await expect(pageA.getByTestId("history-count")).toHaveText("1");
    await expect(pageA.getByTestId("turn-side")).toHaveText("black");
    await expect(pageA.getByTestId("clock-active-side")).toHaveText("black");
    expect(Number(await pageA.getByTestId("white-clock-ms").innerText())).toBe(whiteClockBeforeReload);
    expect(Number(await pageA.getByTestId("black-clock-ms").innerText())).toBeLessThanOrEqual(blackClockBeforeReload);
  } finally {
    await pageA?.close();
    await pageB?.close();
    await contextA.close();
    await contextB.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("online clocks interpolate, use the server increment, continue while disconnected, and resync after reload", async ({ browser }) => {
  test.setTimeout(45_000);
  let fakeNow = Date.now();
  const server = await startDevelopmentServer({
    port: 0,
    logUrls: false,
    socketRuntimeOptions: {
      clockTickMs: 20,
      registryOptions: { now: () => fakeNow },
    },
  });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let pageC: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    pageA = await openHarness(contextA, origin);
    pageB = await openHarness(contextB, origin);

    await pageA.getByLabel("Display name").fill("Clock White");
    await pageA.getByTestId("create-room").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("created");
    await expect(pageA.getByTestId("white-display-clock").locator(".online-clock-value")).toHaveText("10:00.0");
    const roomCode = await pageA.getByTestId("room-code").innerText();

    await pageB.getByLabel("Display name").fill("Clock Black");
    await pageB.getByLabel("Room code").fill(roomCode);
    await pageB.getByTestId("join-room").click();
    await expect(pageA.getByTestId("room-phase")).toHaveText("playing");
    await expect(pageA.getByTestId("white-clock-ms")).toHaveText("600000");
    await expect(pageA.getByTestId("white-display-clock")).toHaveAttribute("data-active", "true");

    await pageA.waitForTimeout(500);
    const whiteDisplayAfterWait = Number(await pageA.getByTestId("white-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    expect(whiteDisplayAfterWait).toBeLessThan(600_000);
    expect(whiteDisplayAfterWait).toBeGreaterThan(598_500);
    await pageB.bringToFront();
    await pageA.waitForTimeout(500);
    await pageA.bringToFront();
    const whiteDisplayAfterBackground = Number(await pageA.getByTestId("white-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    expect(whiteDisplayAfterBackground).toBeLessThan(whiteDisplayAfterWait - 400);
    for (let tick = 0; tick < 3; tick += 1) {
      await pageA.getByTestId("advance-display-clock").click();
    }
    const whiteDisplayAfterControlledTime = Number(await pageA.getByTestId("white-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    // Browser scheduling may add a few milliseconds beyond the three controlled 100ms ticks.
    expect(whiteDisplayAfterControlledTime).toBeGreaterThan(598_250);
    expect(whiteDisplayAfterControlledTime).toBeLessThanOrEqual(598_500);

    fakeNow += 1_600;
    await pageA.getByTestId("legal-move").click();
    await expect(pageA.getByTestId("command-result")).toHaveText("moved");
    await expect(pageA.getByTestId("white-clock-ms")).toHaveText("603400");
    await expect(pageA.getByTestId("white-display-clock").locator(".online-clock-value")).toHaveText("10:03.4");
    await expect(pageA.getByTestId("black-display-clock")).toHaveAttribute("data-active", "true");

    await pageA.reload({ waitUntil: "load" });
    await expect(pageA.getByTestId("viewer-side")).toHaveText("white");
    await expect(pageA.getByTestId("white-clock-ms")).toHaveText("603400");
    await expect(pageA.getByTestId("black-clock-ms")).toHaveText("600000");
    const blackAfterReload = Number(await pageA.getByTestId("black-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    expect(blackAfterReload).toBeGreaterThan(599_800);
    expect(blackAfterReload).toBeLessThanOrEqual(600_000);

    fakeNow += 2_300;
    await pageA.reload({ waitUntil: "load" });
    await expect(pageA.getByTestId("viewer-side")).toHaveText("white");
    await expect(pageA.getByTestId("pending-command")).toHaveText("none");
    await expect(pageA.getByTestId("black-clock-ms")).toHaveText("597700");
    await expect(pageB.getByTestId("white-connected")).toHaveText("yes");
    const blackAfterResync = Number(await pageA.getByTestId("black-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    // A reload snapshot includes the measured half-round-trip age from the server response.
    expect(blackAfterResync).toBeGreaterThan(597_450);
    expect(blackAfterResync).toBeLessThanOrEqual(597_700);

    const disconnectUpdate = expect(pageB.getByTestId("online-recovery-status")).toContainText("White disconnected.");
    await pageA.goto("about:blank");
    await disconnectUpdate;
    await expect(pageB.getByTestId("online-recovery-status")).toContainText("Seat reserved until");
    await expect(pageB.getByTestId("online-recovery-status")).toContainText("The active clock continues.");

    fakeNow += 1_800;
    pageC = await openHarness(contextC, origin);
    await pageC.getByLabel("Display name").fill("Clock Observer");
    await pageC.getByLabel("Room code").fill(roomCode);
    await pageC.getByTestId("join-room").click();
    await expect(pageC.getByTestId("viewer-side")).toHaveText("none");
    await expect(pageB.getByTestId("black-clock-ms")).toHaveText("595900");
    const blackAfterDisconnectUpdate = Number(await pageB.getByTestId("black-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    expect(blackAfterDisconnectUpdate).toBeGreaterThan(595_700);
    expect(blackAfterDisconnectUpdate).toBeLessThanOrEqual(595_900);
    for (let tick = 0; tick < 3; tick += 1) {
      await pageB.getByTestId("advance-display-clock").click();
    }
    const blackAfterControlledDisconnectTime = Number(await pageB.getByTestId("black-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"));
    // Three display-only 500 ms advances should move the visible clock by about
    // 1.5 s; keep a small scheduling tolerance for the live browser renderer.
    expect(blackAfterControlledDisconnectTime).toBeLessThan(blackAfterDisconnectUpdate - 1_300);
    expect(blackAfterControlledDisconnectTime).toBeGreaterThan(blackAfterDisconnectUpdate - 1_600);
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

test("the main app resumes a saved room without prompting for a new room", async ({ browser }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    page = await context.newPage();
    await page.goto(origin, { waitUntil: "load" });
    await page.getByTestId("mode-online").click();
    await expect(page.getByTestId("online-create")).toBeEnabled();
    await page.getByTestId("online-nickname").fill("App Recovery");
    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(page.getByTestId("white-display-clock").locator(".online-clock-value")).toHaveText("Untimed");
    await expect(page.getByTestId("black-display-clock").locator(".online-clock-value")).toHaveText("Untimed");
    const roomCode = await page.getByTestId("online-room-code").innerText();

    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(page.getByTestId("online-room-code")).toHaveText(roomCode);
    await expect(page.getByTestId("online-create")).toHaveCount(0);
  } finally {
    await page?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("missing or malformed tab credentials leave the app unbound", async ({ browser }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;
  let missingCredentialPage: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    missingCredentialPage = await context.newPage();
    await missingCredentialPage.goto(origin, { waitUntil: "load" });
    await expect(missingCredentialPage.getByTestId("mode-online")).toHaveAttribute("aria-pressed", "false");
    expect(await missingCredentialPage.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
    await missingCredentialPage.close();

    page = await context.newPage();
    await page.addInitScript(() => sessionStorage.setItem("meydan.online-session.v1", "{invalid json"));
    await page.goto(origin, { waitUntil: "load" });
    await expect(page.getByTestId("mode-online")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => page!.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
  } finally {
    await page?.close();
    await missingCredentialPage?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("a server-rejected saved credential is cleared and returns to the room lobby", async ({ browser }) => {
  test.setTimeout(45_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    page = await context.newPage();
    await page.goto(origin, { waitUntil: "load" });
    await page.getByTestId("mode-online").click();
    await expect(page.getByTestId("online-create")).toBeEnabled();
    await page.getByTestId("online-nickname").fill("Expired Session");
    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");

    const token = await page.evaluate(() => {
      const stored = sessionStorage.getItem("meydan.online-session.v1");
      return stored === null ? null : (JSON.parse(stored) as { sessionToken: string }).sessionToken;
    });
    expect(token).not.toBeNull();
    server.socketRuntime.registry.leaveRoom(token!);

    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("online-create")).toBeEnabled();
    await expect(page.getByTestId("online-room-code")).toHaveCount(0);
    await expect.poll(() => page!.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
  } finally {
    await page?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("online lifecycle controls use server results, gate by role, and update consent after a swapped-side rematch", async ({ browser }) => {
  test.setTimeout(60_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let pageC: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const openOnlineApp = async (context: BrowserContext): Promise<Page> => {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "load" });
      await page.getByTestId("mode-online").click();
      await expect(page.getByTestId("online-create")).toBeEnabled();
      return page;
    };

    pageA = await openOnlineApp(contextA);
    pageB = await openOnlineApp(contextB);
    pageC = await openOnlineApp(contextC);

    await pageA.getByTestId("online-nickname").fill("Lifecycle Alice");
    await pageA.getByTestId("online-create").click();
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");
    const roomCode = await pageA.getByTestId("online-room-code").innerText();

    await pageB.getByTestId("online-nickname").fill("Lifecycle Bob");
    await pageB.getByTestId("online-room-code-input").fill(roomCode);
    await pageB.getByTestId("online-join-player").click();
    await expect(pageB.getByTestId("online-role")).toHaveText("You are playing as Black.");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    await pageC.getByTestId("online-nickname").fill("Lifecycle Observer");
    await pageC.getByTestId("online-room-code-input").fill(roomCode);
    await pageC.getByTestId("online-join-spectator").click();
    await expect(pageC.getByTestId("online-role")).toHaveText("You are spectating.");
    await expect(pageC.getByTestId("spectator-action-status")).toHaveText("Read-only spectator");
    for (const testId of ["draw-offer", "draw-accept", "draw-decline", "online-resign", "rematch-vote"]) {
      await expect(pageC.getByTestId(testId)).toHaveCount(0);
    }

    await expect(pageA.getByTestId("draw-offer")).toBeVisible();
    await expect(pageB.getByTestId("draw-offer")).toBeVisible();
    await pageA.getByTestId("draw-offer").click();
    await expect(pageA.getByTestId("draw-offer-status")).toHaveAttribute("data-offer-direction", "outgoing");
    await expect(pageA.getByTestId("draw-offer-status")).toContainText("Outgoing draw offer");
    await expect(pageB.getByTestId("draw-offer-status")).toHaveAttribute("data-offer-direction", "incoming");
    await expect(pageB.getByTestId("draw-accept")).toBeVisible();
    await expect(pageB.getByTestId("draw-decline")).toBeVisible();
    await expect(pageA.getByTestId("draw-accept")).toHaveCount(0);
    await expect(pageA.getByTestId("draw-decline")).toHaveCount(0);

    await pageB.getByTestId("draw-decline").click();
    await expect(pageA.getByTestId("draw-offer-status")).toHaveAttribute("data-offer-direction", "none");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    await pageA.getByTestId("draw-offer").click();
    await expect(pageB.getByTestId("draw-offer-status")).toHaveAttribute("data-offer-direction", "incoming");
    await pageB.getByTestId("draw-accept").click();
    const acceptDialog = pageB.getByRole("dialog", { name: "Accept this draw?" });
    await expect(acceptDialog).toBeVisible();
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await acceptDialog.getByRole("button", { name: "Accept draw" }).click();
    await expect(pageA.getByTestId("online-result")).toHaveAttribute("data-result-state", "draw");
    await expect(pageA.getByTestId("online-result")).toHaveAttribute("data-result-reason", "agreement");
    await expect(pageB.getByTestId("online-result")).toContainText("Draw");
    await expect(pageC.getByTestId("online-result")).toHaveAttribute("data-result-reason", "agreement");
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "1");
    }
    for (const playerPage of [pageA, pageB]) {
      const resultDialog = playerPage.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      await resultDialog.getByTestId("result-dialog-dismiss").click();
    }

    await expect(pageC.getByTestId("rematch-status")).toContainText("Players only");
    await expect(pageC.getByTestId("rematch-vote")).toHaveCount(0);
    await pageA.getByTestId("rematch-vote").click();
    const rematchDialogA = pageA.getByRole("dialog", { name: "Agree to a rematch?" });
    await expect(rematchDialogA).toBeVisible();
    await rematchDialogA.getByRole("button", { name: "Agree to rematch" }).click();
    await expect(pageA.getByTestId("rematch-white-consent")).toContainText("Lifecycle Alice");
    await expect(pageA.getByTestId("rematch-white-consent")).toContainText("Agreed");
    await expect(pageA.getByTestId("rematch-black-consent")).toContainText("Waiting");
    await expect(pageA.getByTestId("rematch-status")).toContainText("waiting for opponent");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "1");
    await expect(pageB.getByTestId("rematch-status")).toContainText("Opponent agreed");
    await expect(pageC.getByTestId("rematch-white-consent")).toContainText("Agreed");

    await pageB.getByTestId("rematch-vote").click();
    const rematchDialogB = pageB.getByRole("dialog", { name: "Agree to a rematch?" });
    await rematchDialogB.getByRole("button", { name: "Agree to rematch" }).click();
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "2");
      await expect(page.getByTestId("online-result")).toHaveCount(0);
    }
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-viewer-side", "black");
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-viewer-side", "white");
    await expect(pageA.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("Lifecycle Alice");
    await expect(pageA.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Lifecycle Bob");
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-viewer-side", "spectator");
    await expect(pageC.getByTestId("online-resign")).toHaveCount(0);

    await pageA.getByTestId("online-resign").click();
    const resignDialog = pageA.getByRole("dialog", { name: "Resign this match?" });
    await expect(resignDialog).toBeVisible();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await resignDialog.getByRole("button", { name: "Resign", exact: true }).click();
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
      await expect(page.getByTestId("online-result")).toHaveAttribute("data-result-state", "won");
      await expect(page.getByTestId("online-result")).toHaveAttribute("data-result-reason", "resignation");
      await expect(page.getByTestId("online-result")).toContainText("White wins");
      await expect(page.getByTestId("online-result")).toContainText("Black resigned");
    }
    await expect(pageC.getByTestId("rematch-vote")).toHaveCount(0);
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

test("a spectator follows public room state, can use read-only tools, and stays a spectator through a rematch", async ({ browser }) => {
  test.setTimeout(120_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false, socketRuntimeOptions: { clockTickMs: 50 } });
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const contextB = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const contextC = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const contextFallback = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let pageC: Page | undefined;
  let fallbackPage: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    await contextA.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await installAudioStartCounter(contextA);
    const openOnlineApp = async (context: BrowserContext): Promise<Page> => {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "load" });
      await page.getByTestId("mode-online").click();
      await expect(page.getByTestId("online-create")).toBeEnabled();
      return page;
    };
    const sessionTokenFor = async (page: Page): Promise<string> => page.evaluate(() => {
      const raw = sessionStorage.getItem("meydan.online-session.v1");
      if (raw === null) throw new Error("Expected a private room credential in this tab's session storage.");
      return (JSON.parse(raw) as { sessionToken: string }).sessionToken;
    });

    pageA = await openOnlineApp(contextA);
    pageC = await openOnlineApp(contextC);
    await pageA.getByTestId("online-nickname").fill("O'Neil λ");
    await pageA.getByTestId("online-time-control").selectOption("rapid");
    await pageA.getByTestId("online-create").click();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "waiting");
    const roomCode = await pageA.getByTestId("online-room-code").innerText();

    await pageA.getByTestId("copy-room-invite").click();
    await expect(pageA.getByTestId("clipboard-feedback")).toHaveText("Invite link copied.");
    const invite = await pageA.evaluate(() => navigator.clipboard.readText());
    const inviteUrl = new URL(invite);
    expect(inviteUrl.origin).toBe(origin);
    expect(inviteUrl.searchParams.get("room")).toBe(roomCode);
    expect([...inviteUrl.searchParams.keys()]).toEqual(["room"]);

    await pageC.getByTestId("online-nickname").fill("Room Spectator");
    await pageC.getByTestId("online-room-code-input").fill(roomCode);
    await pageC.getByTestId("online-join-spectator").click();
    await expect(pageC.getByTestId("online-role")).toHaveText("You are spectating.");
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-phase", "waiting");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("Waiting room");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("1 spectator");
    await expect(pageC.getByTestId("player-connection-white")).toHaveAttribute("data-connected", "true");
    await expect(pageC.getByTestId("player-connection-black")).toContainText("Waiting for player");
    await expect(pageC.getByTestId("white-display-clock")).toBeVisible();
    await expect(pageC.getByTestId("black-display-clock")).toBeVisible();
    await expect(pageC.getByTestId("undo-button")).toHaveCount(0);
    await expect(pageC.getByTestId("new-game-button")).toHaveCount(0);

    pageB = await contextB.newPage();
    await pageB.goto(invite, { waitUntil: "load" });
    await expect(pageB.getByTestId("online-room-code-input")).toHaveValue(roomCode);
    await expect(pageB.getByTestId("online-join-player")).toBeEnabled();
    await pageB.getByTestId("online-nickname").fill("Mika-東京");
    await pageB.getByTestId("online-join-player").click();
    const whiteToken = await sessionTokenFor(pageA);
    const blackToken = await sessionTokenFor(pageB);
    const spectatorToken = await sessionTokenFor(pageC);
    expect(new Set([whiteToken, blackToken, spectatorToken]).size).toBe(3);
    expect(invite).not.toContain(whiteToken);
    expect(invite).not.toContain(blackToken);
    expect(invite).not.toContain(spectatorToken);
    for (const [page, ownToken] of [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]] as const) {
      expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).toContain(ownToken);
      expect(page.url()).not.toContain(whiteToken);
      expect(page.url()).not.toContain(blackToken);
      expect(page.url()).not.toContain(spectatorToken);
      expect(await page.locator("body").innerText()).not.toContain(whiteToken);
      expect(await page.locator("body").innerText()).not.toContain(blackToken);
      expect(await page.locator("body").innerText()).not.toContain(spectatorToken);
    }
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("Live match");
    await expect(pageC.getByTestId("player-connection-black")).toHaveAttribute("data-connected", "true");
    await expect(pageC.getByTestId("draw-offer-status")).toHaveText("No draw offer");
    await expect(pageC.getByTestId("spectator-action-status")).toHaveText("Read-only spectator");
    for (const testId of ["draw-offer", "draw-accept", "draw-decline", "online-resign", "rematch-vote"]) {
      await expect(pageC.getByTestId(testId)).toHaveCount(0);
    }
    await expect(pageC.locator(".square-control--source")).toHaveCount(0);
    await expect(pageC.locator(".square-control[aria-disabled='true']")).toHaveCount(64);
    await expect(pageC.locator(".square-control[tabindex='0']")).toHaveCount(1);
    await expectOnlineViewport(pageA, 1440);
    await expectOnlineViewport(pageB, 1024);
    await expectOnlineViewport(pageC, 390);
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);

    const playerDownloadPromise = pageA.waitForEvent("download");
    await pageA.getByRole("button", { name: "Download scorebook" }).click();
    const playerDownload = await playerDownloadPromise;
    const playerScorebookPath = await playerDownload.path();
    if (playerScorebookPath === null) throw new Error("The online player's scorebook did not download.");
    const playerScorebookText = await readFile(playerScorebookPath, "utf8");
    expect(playerDownload.suggestedFilename()).toMatch(/^meydan-dama-scorebook-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(playerScorebookText).toContain("Mode: Online player");
    expect(playerScorebookText).toContain("Match number: 1");
    expect(playerScorebookText).toContain("Time control: Rapid · 10 min + 5 sec increment");
    expect(playerScorebookText).toContain(`Room code: ${roomCode}`);
    expect(playerScorebookText).toContain("White player: O'Neil λ");
    expect(playerScorebookText).toContain("Black player: Mika-東京");
    expect(playerScorebookText).toContain("No moves recorded.");
    expect(playerScorebookText).not.toContain("Result:");
    for (const token of [whiteToken, blackToken, spectatorToken]) {
      expect(playerScorebookText).not.toContain(token);
    }

    fallbackPage = await openOnlineApp(contextFallback);
    await fallbackPage.getByTestId("online-nickname").fill("Full Room Visitor");
    await fallbackPage.getByTestId("online-room-code-input").fill(roomCode);
    await fallbackPage.getByTestId("online-join-player").click();
    await expect(fallbackPage.getByTestId("online-role")).toHaveText("You are spectating.");
    await expect(fallbackPage.getByTestId("online-feedback")).toContainText("spectating");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("2 spectators");
    await fallbackPage.getByTestId("online-leave-room").click();
    const spectatorLeaveDialog = fallbackPage.getByRole("dialog", { name: "Leave this room?" });
    await spectatorLeaveDialog.getByRole("button", { name: "Leave room" }).click();
    await expect(fallbackPage.getByTestId("online-create")).toBeVisible();
    await expect(pageC.getByTestId("online-room-detail")).toContainText("1 spectator");

    await pageA.getByTestId("sound-toggle").click();
    await expect(pageA.getByTestId("sound-toggle")).toHaveAccessibleName("Turn sound off");
    await playFirstLegalMove(pageA);
    await expect(pageC.getByTestId("history-count")).toHaveText("1 ply");
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);
    await playFirstLegalMove(pageB);
    await expect(pageC.getByTestId("history-count")).toHaveText("2 plies");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("Live match");
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);

    const whiteClockBeforeDisconnect = Number(
      await pageC.getByTestId("white-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"),
    );
    await pageA.goto("about:blank");
    await expect(pageC.getByTestId("player-connection-white")).toHaveAttribute("data-connected", "false");
    await expect(pageC.getByTestId("player-connection-white")).toContainText("Disconnected");
    await expect(pageC.getByTestId("player-connection-white")).toContainText("seat reserved until");
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await expect(pageC.locator(".square-control[aria-disabled='true']")).toHaveCount(64);
    await expect(pageC.locator(".square-control[tabindex='0']")).toHaveCount(1);
    await pageC.waitForTimeout(500);
    const whiteClockDuringDisconnect = Number(
      await pageC.getByTestId("white-display-clock").locator(".online-clock-value").getAttribute("data-remaining-ms"),
    );
    expect(whiteClockDuringDisconnect).toBeLessThan(whiteClockBeforeDisconnect - 250);
    await pageA.goto(origin, { waitUntil: "load" });
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(pageC.getByTestId("player-connection-white")).toHaveAttribute("data-connected", "true");

    const socketCountBeforeReload = server.socketRuntime.io.sockets.sockets.size;
    await pageA.reload({ waitUntil: "load" });
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(pageA.getByTestId("online-room-code")).toHaveText(roomCode);
    await expect(pageA.getByTestId("history-count")).toHaveText("2 plies");
    await expect.poll(() => server.socketRuntime.io.sockets.sockets.size).toBe(socketCountBeforeReload);
    expect(server.socketRuntime.registry.sessionCount).toBe(3);
    await expect(pageA.getByTestId("sound-toggle")).toHaveAccessibleName("Activate sound");
    await pageA.getByTestId("sound-toggle").click();
    await expect(pageA.getByTestId("sound-toggle")).toHaveAccessibleName("Turn sound off");
    expect(await audioStartCount(pageA)).toBe(0);
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);

    const aliceBeforeMove = server.socketRuntime.registry.snapshotForSession(whiteToken);
    if (aliceBeforeMove === undefined) throw new Error("White's recovered session lost its room snapshot.");
    await playFirstLegalMove(pageA);
    await expect(pageA.getByTestId("history-count")).toHaveText("3 plies");
    const aliceAfterMove = server.socketRuntime.registry.snapshotForSession(whiteToken);
    expect(aliceAfterMove?.revision).toBe(aliceBeforeMove.revision + 1);
    expect(aliceAfterMove?.gameView.history).toHaveLength(aliceBeforeMove.gameView.history.length + 1);
    await expect.poll(() => audioStartCount(pageA!)).toBe(1);
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);

    const firstSquareBeforeFlip = await pageC.locator(".board-grid button").first().getAttribute("aria-label");
    const flipButton = pageC.getByTestId("board-flip");
    await expect(flipButton).toBeVisible();
    await expect(flipButton).toHaveAttribute("aria-pressed", "false");
    await flipButton.click();
    await expect(flipButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => pageC!.locator(".board-grid button").first().getAttribute("aria-label"))
      .not.toBe(firstSquareBeforeFlip);

    await pageC.getByRole("button", { name: "Read Dama rules" }).click();
    const rulesDialog = pageC.getByRole("dialog", { name: "Dama rules" });
    await expect(rulesDialog).toBeVisible();
    await expect(rulesDialog).toContainText("Online games use server-managed clocks and results");
    await expect(rulesDialog).not.toContainText(await sessionTokenFor(pageC));
    await rulesDialog.getByRole("button", { name: "Close dialog" }).click();

    const spectatorSnapshot = server.socketRuntime.registry.snapshotForSession(spectatorToken);
    expect(spectatorSnapshot?.viewerSide).toBeNull();
    const forgedMove = spectatorSnapshot?.gameView.legalMoves[0];
    if (spectatorSnapshot === undefined || forgedMove === undefined) {
      throw new Error("The spectator must receive the public legal move list for the current position.");
    }
    let forgedActionError: unknown;
    try {
      server.socketRuntime.registry.move(spectatorToken, {
        revision: spectatorSnapshot.revision,
        from: forgedMove.from,
        path: [...forgedMove.path],
      });
    } catch (error) {
      forgedActionError = error;
    }
    expect(forgedActionError).toBeInstanceOf(RoomRegistryError);
    expect((forgedActionError as RoomRegistryError).code).toBe("not-your-turn");
    const spectatorSnapshotAfterAttempt = server.socketRuntime.registry.snapshotForSession(spectatorToken);
    expect(spectatorSnapshotAfterAttempt?.revision).toBe(spectatorSnapshot.revision);
    expect(spectatorSnapshotAfterAttempt?.gameView.history).toEqual(spectatorSnapshot.gameView.history);

    const downloadPromise = pageC.waitForEvent("download");
    await pageC.getByRole("button", { name: "Download scorebook" }).click();
    const scorebook = await downloadPromise;
    const scorebookPath = await scorebook.path();
    if (scorebookPath === null) throw new Error("The public spectator scorebook did not produce a downloadable file.");
    const scorebookText = await readFile(scorebookPath, "utf8");
    expect(scorebook.suggestedFilename()).toMatch(/^meydan-dama-scorebook-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(scorebookText).toContain("Mode: Online spectator");
    expect(scorebookText).toContain("Match number: 1");
    expect(scorebookText).toContain("Time control: Rapid · 10 min + 5 sec increment");
    expect(scorebookText).toContain(`Room code: ${roomCode}`);
    expect(scorebookText).toContain("White player: O'Neil λ");
    expect(scorebookText).toContain("Black player: Mika-東京");
    expect(scorebookText).toContain("Moves:");
    expect(scorebookText.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line)))
      .toEqual(await visibleScorebookLines(pageC));
    for (const token of [whiteToken, blackToken, spectatorToken]) {
      expect(scorebookText).not.toContain(token);
      expect(await pageC.locator("body").innerText()).not.toContain(token);
      expect(pageC.url()).not.toContain(token);
    }

    await pageA.getByTestId("draw-offer").click();
    await expect(pageC.getByTestId("draw-offer-status")).toContainText("offered a draw");
    await pageB.getByTestId("draw-accept").click();
    const acceptDialog = pageB.getByRole("dialog", { name: "Accept this draw?" });
    await acceptDialog.getByRole("button", { name: "Accept draw" }).click();
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("Finished match");
    await expect(pageC.getByTestId("online-result")).toHaveAttribute("data-result-reason", "agreement");
    await expect(pageC.getByTestId("scorebook-result")).toContainText("Draw");
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);
    for (const playerPage of [pageA, pageB]) {
      const resultDialog = playerPage.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      await resultDialog.getByTestId("result-dialog-dismiss").click();
    }

    const finishedDownloadPromise = pageA.waitForEvent("download");
    await pageA.getByRole("button", { name: "Download scorebook" }).click();
    const finishedDownload = await finishedDownloadPromise;
    const finishedScorebookPath = await finishedDownload.path();
    if (finishedScorebookPath === null) throw new Error("The finished online scorebook did not download.");
    const finishedScorebookText = await readFile(finishedScorebookPath, "utf8");
    expect(finishedScorebookText).toContain("Mode: Online player");
    expect(finishedScorebookText).toContain("Match number: 1");
    expect(finishedScorebookText).toContain("Result: Draw");
    expect(finishedScorebookText).toContain("Details: Both sides agreed to a draw.");
    expect(finishedScorebookText.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line)))
      .toEqual(await visibleScorebookLines(pageA));
    for (const token of [whiteToken, blackToken, spectatorToken]) {
      expect(finishedScorebookText).not.toContain(token);
    }

    await pageA.getByTestId("rematch-vote").click();
    const whiteRematchDialog = pageA.getByRole("dialog", { name: "Agree to a rematch?" });
    await whiteRematchDialog.getByRole("button", { name: "Agree to rematch" }).click();
    await expect(pageC.getByTestId("rematch-white-consent")).toContainText("Agreed");
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
    await pageB.getByTestId("rematch-vote").click();
    const blackRematchDialog = pageB.getByRole("dialog", { name: "Agree to a rematch?" });
    await blackRematchDialog.getByRole("button", { name: "Agree to rematch" }).click();
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "2");
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-viewer-side", "spectator");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("Live match");
    await expect(pageC.getByTestId("online-room-detail")).toContainText("1 spectator");
    await expect(pageC.getByTestId("board-flip")).toHaveAttribute("aria-pressed", "true");
    await expect(pageC.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("O'Neil λ");
    await expect(pageC.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Mika-東京");
    await expect(pageC.locator(".square-control[aria-disabled='true']")).toHaveCount(64);
    await expect(pageC.locator(".square-control[tabindex='0']")).toHaveCount(1);
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);
    for (const testId of ["draw-offer", "draw-accept", "draw-decline", "online-resign", "rematch-vote"]) {
      await expect(pageC.getByTestId(testId)).toHaveCount(0);
    }

    await expect(pageC.getByTestId("scorebook-mode")).toHaveText("Online spectator");
    await expect(pageC.getByTestId("scorebook-match-number")).toHaveText("2");
    await expect(pageC.getByTestId("scorebook-white-player")).toHaveText("Mika-東京");
    await expect(pageC.getByTestId("scorebook-black-player")).toHaveText("O'Neil λ");
    await expect(pageC.getByTestId("scorebook-result")).toHaveCount(0);
    const previousMatchLines = scorebookText.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line));
    await playFirstLegalMove(pageB);
    await expect(pageC.getByTestId("history-count")).toHaveText("1 ply");
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);
    const rematchDownloadPromise = pageC.waitForEvent("download");
    await pageC.getByRole("button", { name: "Download scorebook" }).click();
    const rematchDownload = await rematchDownloadPromise;
    const rematchScorebookPath = await rematchDownload.path();
    if (rematchScorebookPath === null) throw new Error("The spectator's rematch scorebook did not download.");
    const rematchScorebookText = await readFile(rematchScorebookPath, "utf8");
    const rematchLines = rematchScorebookText.split(/\r?\n/).filter((line) => /^\d+\. White:/.test(line));
    expect(rematchScorebookText).toContain("Mode: Online spectator");
    expect(rematchScorebookText).toContain("Match number: 2");
    expect(rematchScorebookText).toContain("White player: Mika-東京");
    expect(rematchScorebookText).toContain("Black player: O'Neil λ");
    expect(rematchScorebookText).not.toContain("Result:");
    expect(rematchLines).toEqual(await visibleScorebookLines(pageC));
    expect(rematchLines).toHaveLength(1);
    for (const oldLine of previousMatchLines.slice(1)) expect(rematchScorebookText).not.toContain(oldLine);
    for (const token of [whiteToken, blackToken, spectatorToken]) {
      expect(rematchScorebookText).not.toContain(token);
    }

    await pageA.getByTestId("online-resign").click();
    const resignDialog = pageA.getByRole("dialog", { name: "Resign this match?" });
    await expect(resignDialog).toBeVisible();
    await resignDialog.getByRole("button", { name: "Resign", exact: true }).click();
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
      await expect(page.getByTestId("online-result")).toHaveAttribute("data-result-state", "won");
      await expect(page.getByTestId("online-result")).toHaveAttribute("data-result-reason", "resignation");
    }
    await expectAllViewersToMatchRegistry(server, [[pageA, whiteToken], [pageB, blackToken], [pageC, spectatorToken]]);

    await pageC.getByTestId("online-leave-room").click();
    const finalSpectatorLeaveDialog = pageC.getByRole("dialog", { name: "Leave this room?" });
    await finalSpectatorLeaveDialog.getByRole("button", { name: "Leave room" }).click();
    await expect(pageC.getByTestId("online-create")).toBeVisible();
    await expect(pageA.getByTestId("online-room-detail")).toContainText("0 spectators");
    await expect(pageB.getByTestId("online-room-detail")).toContainText("0 spectators");
    expect(await pageC.locator("body").innerText()).not.toContain(spectatorToken);
  } finally {
    await pageA?.close();
    await pageB?.close();
    await pageC?.close();
    await fallbackPage?.close();
    await contextA.close();
    await contextB.close();
    await contextC.close();
    await contextFallback.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
    expect(server.socketRuntime.io.sockets.sockets.size).toBe(0);
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 0, sessionCount: 0 });
  }
});

test("cancel preserves a room, transport loss is recoverable, and leaving to local forfeits only after confirmation", async ({ browser }) => {
  test.setTimeout(90_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false, socketRuntimeOptions: { clockTickMs: 50 } });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  let pageA: Page | undefined;
  let pageB: Page | undefined;

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const openOnlineApp = async (context: BrowserContext): Promise<Page> => {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "load" });
      await page.getByTestId("mode-online").click();
      await expect(page.getByTestId("online-create")).toBeEnabled();
      return page;
    };
    pageA = await openOnlineApp(contextA);
    pageB = await openOnlineApp(contextB);
    await pageA.getByTestId("online-nickname").fill("Leaving White");
    await pageA.getByTestId("online-time-control").selectOption("rapid");
    await pageA.getByTestId("online-create").click();
    const roomCode = await pageA.getByTestId("online-room-code").innerText();
    await pageB.getByTestId("online-nickname").fill("Staying Black");
    await pageB.getByTestId("online-room-code-input").fill(roomCode);
    await pageB.getByTestId("online-join-player").click();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    const originalToken = await pageA.evaluate(() => {
      const saved = sessionStorage.getItem("meydan.online-session.v1");
      return saved === null ? null : (JSON.parse(saved) as { sessionToken: string }).sessionToken;
    });
    expect(originalToken).not.toBeNull();
    await pageA.getByTestId("online-leave-room").click();
    const leaveDialog = pageA.getByRole("dialog", { name: "Leave this room?" });
    await expect(leaveDialog).toContainText("server records a disconnection win for your opponent");
    await leaveDialog.getByRole("button", { name: "Stay in room" }).click();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    expect(await pageA.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).not.toBeNull();
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    await pageA.evaluate(() => {
      const browserWindow = window as Window & { __modeSwitchBlockedWhilePending?: boolean };
      browserWindow.__modeSwitchBlockedWhilePending = false;
      const observer = new MutationObserver(() => {
        const pending = document.querySelector('[data-testid="online-pending-action"]');
        const localMode = document.querySelector<HTMLButtonElement>('[data-testid="mode-local"]');
        if (pending !== null && localMode?.disabled === true) {
          localMode.click();
          browserWindow.__modeSwitchBlockedWhilePending =
            document.querySelector('[data-testid="mode-online"]')?.getAttribute("aria-pressed") === "true";
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    await pageA.getByTestId("draw-offer").click();
    await expect(pageB.getByTestId("draw-offer-status")).toHaveAttribute("data-offer-direction", "incoming");
    expect(await pageA.evaluate(() => (window as Window & { __modeSwitchBlockedWhilePending?: boolean }).__modeSwitchBlockedWhilePending)).toBe(true);
    await pageB.getByTestId("draw-decline").click();
    await expect(pageA.getByTestId("draw-offer-status")).toHaveAttribute("data-offer-direction", "none");

    await pageA.goto("about:blank");
    await expect(pageB.getByTestId("online-recovery-status")).toContainText("White disconnected.");
    await expect(pageB.getByTestId("online-recovery-status")).toContainText("Seat reserved until");
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await pageA.goto(origin, { waitUntil: "load" });
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(pageB.getByTestId("player-connection-white")).toHaveAttribute("data-connected", "true");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    await pageA.reload({ waitUntil: "load" });
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");

    await pageA.getByTestId("mode-local").click();
    const switchDialog = pageA.getByRole("dialog", { name: "Leave online room and switch?" });
    await expect(switchDialog).toContainText("Leaving an active match is a forfeit");
    await switchDialog.getByRole("button", { name: "Stay in room" }).click();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    await pageA.getByTestId("mode-local").click();
    const confirmedSwitch = pageA.getByRole("dialog", { name: "Leave online room and switch?" });
    await confirmedSwitch.getByRole("button", { name: "Leave room and switch" }).click();
    await expect(pageA.getByTestId("mode-local")).toHaveAttribute("aria-pressed", "true");
    await expect(pageA.getByTestId("online-board-state")).toHaveCount(0);
    await expect(pageA.getByTestId("history-count")).toHaveText("0 plies");
    expect(await pageA.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
    await expect(pageB.getByTestId("online-result")).toHaveAttribute("data-result-reason", "disconnection");
    await expect(pageB.getByTestId("online-result")).toContainText("Black wins");
    await expect(pageB.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Waiting for player");
    expect(() => server.socketRuntime.registry.snapshotForSession(originalToken!)).toThrow(RoomRegistryError);

    await playFirstLegalMove(pageA);
    await expect(pageA.getByTestId("history-count")).toHaveText("1 ply");
    await pageA.waitForTimeout(300);
    await expect(pageA.getByTestId("mode-local")).toHaveAttribute("aria-pressed", "true");
    await expect(pageA.getByTestId("history-count")).toHaveText("1 ply");

    await pageA.getByTestId("new-game-button").click();
    const newLocalGameDialog = pageA.getByRole("dialog", { name: "Start a new game?" });
    await newLocalGameDialog.getByRole("button", { name: "Start new game" }).click();
    await expect(pageA.getByTestId("history-count")).toHaveText("0 plies");
    await pageA.getByTestId("mode-online").click();
    await expect(pageA.getByTestId("online-create")).toBeEnabled();
    await pageA.getByTestId("online-nickname").fill("Waiting Leave");
    await pageA.getByTestId("online-create").click();
    await expect(pageA.getByTestId("online-room-code")).toBeVisible();
    expect(server.socketRuntime.registry.roomCount).toBe(2);
    const waitingToken = await pageA.evaluate(() => {
      const saved = sessionStorage.getItem("meydan.online-session.v1");
      return saved === null ? null : (JSON.parse(saved) as { sessionToken: string }).sessionToken;
    });
    expect(waitingToken).not.toBeNull();
    await pageA.getByTestId("online-leave-room").click();
    const waitingLeaveDialog = pageA.getByRole("dialog", { name: "Leave this room?" });
    await expect(waitingLeaveDialog).toContainText("A waiting or finished match is not changed");
    await waitingLeaveDialog.getByRole("button", { name: "Leave room" }).click();
    await expect(pageA.getByTestId("online-create")).toBeVisible();
    expect(server.socketRuntime.registry.roomCount).toBe(1);
    expect(await pageA.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
    expect(() => server.socketRuntime.registry.snapshotForSession(waitingToken!)).toThrow(RoomRegistryError);
  } finally {
    await pageA?.close();
    await pageB?.close();
    await contextA.close();
    await contextB.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("a server restart invalidates the saved room and offers a safe new-room path", async ({ browser }) => {
  test.setTimeout(90_000);
  let server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;

  try {
    const oldPort = server.port;
    const origin = `http://127.0.0.1:${oldPort}`;
    page = await context.newPage();
    await page.goto(origin, { waitUntil: "load" });
    await page.getByTestId("mode-online").click();
    await expect(page.getByTestId("online-create")).toBeEnabled();
    await page.getByTestId("online-nickname").fill("Restarted Room");
    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");
    const oldRoomCode = await page.getByTestId("online-room-code").innerText();
    const savedSession = await page.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"));
    expect(savedSession).not.toBeNull();

    await page.goto("about:blank");
    await expect.poll(() => server.socketRuntime.registry.snapshotForSession(
      (JSON.parse(savedSession!) as { sessionToken: string }).sessionToken,
    ).players.white?.connected).toBe(false);
    await server.close();
    server = await startDevelopmentServer({ port: oldPort, logUrls: false });
    await page.goto(origin, { waitUntil: "load" });
    // A new server has no in-memory room registry. Resume fails authoritatively,
    // so the stale private credential is cleared while the public room code remains
    // available for an explicit join attempt.
    await expect.poll(() => page!.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
    await expect.poll(async () => {
      const createEnabled = await page!.getByTestId("online-create").isEnabled();
      const retryCount = await page!.getByTestId("online-retry-connection").count();
      return createEnabled || retryCount === 1;
    }, { timeout: 20_000 }).toBe(true);
    if (await page.getByTestId("online-retry-connection").count() > 0) {
      await page.getByTestId("online-retry-connection").click();
    }
    await expect(page.getByTestId("online-create")).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByTestId("online-feedback")).toContainText("server restarted");
    await expect(page.getByTestId("online-room-code-input")).toHaveValue(oldRoomCode);
    expect(await page.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
    await expect(page.getByTestId("online-room-detail")).toHaveCount(0);

    await page.getByTestId("online-join-player").click();
    await expect(page.getByTestId("online-feedback")).toContainText("No room has that code. Check the code or create a room.");
    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "1");
    await expect(page.getByTestId("history-count")).toHaveText("0 plies");
  } finally {
    await page?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("a connected client receives idle-expiry feedback and returns to the online lobby", async ({ browser }) => {
  let fakeNow = Date.now();
  const server = await startDevelopmentServer({
    port: 0,
    logUrls: false,
    socketRuntimeOptions: {
      clockTickMs: 10,
      registryOptions: { now: () => fakeNow },
    },
  });
  const context = await browser.newContext();
  let page: Page | undefined;

  try {
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "load" });
    await page.getByTestId("mode-online").click();
    await page.getByTestId("online-nickname").fill("Idle Room Owner");
    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as White.");
    const expiredRoomCode = await page.getByTestId("online-room-code").innerText();
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });

    fakeNow += DEFAULT_ROOM_IDLE_TIMEOUT_MS;
    await expect(page.getByTestId("online-feedback")).toContainText("expired after six hours");
    await expect(page.getByTestId("online-create")).toBeEnabled();
    await expect(page.getByTestId("online-room-detail")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).toBeNull();
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 0, sessionCount: 0 });
    expect(await page.getByTestId("online-room-code-input").inputValue()).toBe(expiredRoomCode);
  } finally {
    await page?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
    expect(server.socketRuntime.io.sockets.sockets.size).toBe(0);
    expect(server.socketRuntime.registry.roomCount).toBe(0);
    expect(server.socketRuntime.registry.sessionCount).toBe(0);
  }
});
