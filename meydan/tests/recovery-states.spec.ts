import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";
import { RoomRegistryError } from "../server/rooms.js";

async function openOnlineMode(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "load" });
  await page.getByTestId("mode-online").click();
  await expect(page.getByTestId("online-create")).toBeEnabled();
}

async function makeFirstLegalMove(page: Page): Promise<string> {
  const history = page.getByTestId("history-count");
  const before = await history.innerText();
  const source = page.locator(".square-control--source").first();
  const sourceName = await source.getAttribute("aria-label");
  if (sourceName === null) throw new Error("A legal source square should have an accessible name.");
  await source.click();

  for (let landingCount = 0; landingCount < 16; landingCount += 1) {
    const landing = page.locator(".square-control--landing").first();
    if (await landing.count() === 0) break;
    await landing.click();
  }

  await expect(page.getByTestId("online-pending-action")).toHaveCount(0);
  if ((await history.innerText()) === before && await page.getByTestId("online-feedback").count() === 0) {
    throw new Error("The selected legal move did not finish or report a result.");
  }
  return sourceName;
}

test("invalid invite and missing room keep the entered values and recover on a valid join", async ({ browser }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;
  let creator: Page | undefined;
  const pageErrors: string[] = [];

  try {
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 320, height: 720 });
    await openOnlineMode(page, `http://127.0.0.1:${server.port}`);

    const nickname = page.getByTestId("online-nickname");
    const invalidNickname = "<img src=x onerror>";
    await nickname.fill(invalidNickname);
    await page.getByTestId("online-create").click();
    await expect(page.getByRole("alert")).toContainText("Enter a name of 1–24");
    await expect(nickname).toHaveValue(invalidNickname);
    await expect(page.locator("img[src='x']")).toHaveCount(0);

    await nickname.fill("N12345678901234567890123");
    const codeInput = page.getByTestId("online-room-code-input");
    await codeInput.fill("A0BCDE");
    await page.getByTestId("online-join-player").click();
    await expect(page.getByRole("alert")).toContainText("Enter a six-character code using A–Z and 2–9.");
    await expect(codeInput).toHaveValue("A0BCDE");
    await expect(page.getByTestId("online-join-player")).toBeEnabled();

    await codeInput.fill("AAAAAA");
    await page.getByTestId("online-join-player").click();
    await expect(page.getByTestId("online-feedback")).toHaveText("No room has that code. Check the code or create a room.");
    await expect(nickname).toHaveValue("N12345678901234567890123");
    await expect(codeInput).toHaveValue("AAAAAA");
    await expect(page.getByTestId("online-pending-action")).toHaveCount(0);

    creator = await context.newPage();
    await openOnlineMode(creator, `http://127.0.0.1:${server.port}`);
    await creator.getByTestId("online-nickname").fill("Room Maker");
    await creator.getByTestId("online-create").click();
    const roomCode = await creator.getByTestId("online-room-code").innerText();

    await codeInput.fill(roomCode);
    await page.getByTestId("online-join-player").click();
    await expect(page.getByTestId("online-role")).toHaveText("You are playing as Black.");
    await expect(page.getByTestId("online-feedback")).toHaveText("Joined as Black.");
    await expect(page.locator(".online-room-players")).toContainText("N12345678901234567890123");
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(pageErrors).toEqual([]);
  } finally {
    await page?.close();
    await creator?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
    expect(server.socketRuntime.registry.sessionCount).toBe(0);
  }
});

test("service capacity errors preserve the form and clear after a successful retry", async ({ browser }) => {
  const server = await startDevelopmentServer({
    port: 0,
    logUrls: false,
    socketRuntimeOptions: { registryOptions: { limits: { sessions: 1 } } },
  });
  const context = await browser.newContext();
  let owner: Page | undefined;
  let waiting: Page | undefined;
  const pageErrors: string[] = [];

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    owner = await context.newPage();
    waiting = await context.newPage();
    owner.on("pageerror", (error) => pageErrors.push(error.message));
    waiting.on("pageerror", (error) => pageErrors.push(error.message));
    await openOnlineMode(owner, origin);
    await openOnlineMode(waiting, origin);

    await owner.getByTestId("online-nickname").fill("Capacity Owner");
    await owner.getByTestId("online-create").click();
    await expect(owner.getByTestId("online-role")).toBeVisible();
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });

    const nickname = waiting.getByTestId("online-nickname");
    const code = waiting.getByTestId("online-room-code-input");
    await nickname.fill("Waiting Player");
    await code.fill("B2C3D4");
    await waiting.getByTestId("online-create").click();
    await expect(waiting.getByTestId("online-feedback")).toHaveText("The service is at capacity. Try again when a player slot opens.");
    await expect(nickname).toHaveValue("Waiting Player");
    await expect(code).toHaveValue("B2C3D4");
    await expect(waiting.getByTestId("online-create")).toBeEnabled();
    await expect(waiting.getByTestId("online-pending-action")).toHaveCount(0);
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });

    await owner.getByTestId("online-leave-room").click();
    await owner.getByRole("dialog", { name: "Leave this room?" }).getByRole("button", { name: "Leave room" }).click();
    await expect(owner.getByTestId("online-create")).toBeVisible();
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 0, sessionCount: 0 });

    await waiting.getByTestId("online-create").click();
    await expect(waiting.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(waiting.getByTestId("online-feedback")).toContainText("created");
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });
    expect(pageErrors).toEqual([]);
  } finally {
    await owner?.close();
    await waiting?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("a rejected move is announced as text, unlocks controls, and can be retried once", async ({ browser }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let white: Page | undefined;
  let black: Page | undefined;
  const pageErrors: string[] = [];

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    white = await context.newPage();
    black = await context.newPage();
    white.on("pageerror", (error) => pageErrors.push(error.message));
    await openOnlineMode(white, origin);
    await openOnlineMode(black, origin);
    await white.getByTestId("online-nickname").fill("White Player");
    await white.getByTestId("online-create").click();
    const code = await white.getByTestId("online-room-code").innerText();
    await black.getByTestId("online-nickname").fill("Black Player");
    await black.getByTestId("online-room-code-input").fill(code);
    await black.getByTestId("online-join-player").click();
    await expect(white.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    const registry = server.socketRuntime.registry;
    const originalMove = registry.move.bind(registry);
    const unsafeMessage = 'The server rejected this move: <img src=x onerror="window.__unsafeMarkupRan = true">';
    let rejectNextMove = true;
    registry.move = ((sessionToken: string, request: unknown) => {
      if (rejectNextMove) {
        rejectNextMove = false;
        throw new RoomRegistryError("invalid-move", unsafeMessage);
      }
      return originalMove(sessionToken, request);
    }) as typeof registry.move;

    const sourceName = await makeFirstLegalMove(white);
    await expect(white.getByTestId("online-feedback")).toHaveText(unsafeMessage);
    await expect(white.locator("img[src='x']")).toHaveCount(0);
    expect(await white.evaluate(() => (window as Window & { __unsafeMarkupRan?: boolean }).__unsafeMarkupRan)).toBeUndefined();
    await expect(white.getByTestId("history-count")).toHaveText("0 plies");
    await expect(white.getByTestId("draw-offer")).toBeEnabled();
    expect(server.socketRuntime.registry.sessionCount).toBe(2);

    await white.getByRole("button", { name: sourceName, exact: true }).click();
    for (let landingCount = 0; landingCount < 16; landingCount += 1) {
      const landing = white.locator(".square-control--landing").first();
      if (await landing.count() === 0) break;
      await landing.click();
    }
    await expect(white.getByTestId("history-count")).toHaveText("1 ply");
    await expect(white.getByTestId("online-feedback")).toHaveCount(0);
    await expect(black.getByTestId("history-count")).toHaveText("1 ply");
    expect(server.socketRuntime.registry.roomCount).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await white?.close();
    await black?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("clipboard denial has a manual recovery path and clears when copy works", async ({ browser }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;
  const pageErrors: string[] = [];

  try {
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const clipboard = {
        writeText: async (text: string) => {
          if ((window as Window & { __denyClipboard?: boolean }).__denyClipboard === true) {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          (window as Window & { __copiedText?: string }).__copiedText = text;
        },
      };
      Object.defineProperty(window, "__denyClipboard", { value: true, writable: true });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    });
    await openOnlineMode(page, `http://127.0.0.1:${server.port}`);
    await page.getByTestId("online-nickname").fill("Clipboard Owner");
    await page.getByTestId("online-create").click();
    const code = await page.getByTestId("online-room-code").innerText();

    await page.getByTestId("copy-room-code").click();
    await expect(page.getByTestId("clipboard-feedback")).toHaveText("Could not copy the code. Select it and copy it manually.");
    await expect(page.getByTestId("copy-room-code")).toBeEnabled();
    await page.evaluate(() => { (window as Window & { __denyClipboard?: boolean }).__denyClipboard = false; });
    await page.getByTestId("copy-room-code").click();
    await expect(page.getByTestId("clipboard-feedback")).toHaveText("Room code copied.");
    expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(code);
    expect(pageErrors).toEqual([]);
  } finally {
    await page?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("unavailable storage reports the lost recovery option and clears after storage recovers", async ({ browser }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const context = await browser.newContext();
  let page: Page | undefined;
  const pageErrors: string[] = [];

  try {
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const nativeGet = Storage.prototype.getItem;
      const nativeSet = Storage.prototype.setItem;
      const nativeRemove = Storage.prototype.removeItem;
      Object.defineProperty(window, "__denyWebStorage", { value: true, writable: true });
      Storage.prototype.getItem = function (key) {
        if ((window as Window & { __denyWebStorage?: boolean }).__denyWebStorage === true) {
          throw new DOMException("Storage unavailable", "SecurityError");
        }
        return nativeGet.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if ((window as Window & { __denyWebStorage?: boolean }).__denyWebStorage === true) {
          throw new DOMException("Storage unavailable", "QuotaExceededError");
        }
        return nativeSet.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key) {
        if ((window as Window & { __denyWebStorage?: boolean }).__denyWebStorage === true) {
          throw new DOMException("Storage unavailable", "SecurityError");
        }
        return nativeRemove.call(this, key);
      };
    });
    await openOnlineMode(page, `http://127.0.0.1:${server.port}`);
    await page.getByTestId("online-nickname").fill("Storage Owner");
    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toBeVisible();
    await expect(page.getByTestId("online-feedback")).toContainText(
      "This room is active in this tab, but the browser could not save your reconnect identity or nickname. Keep this tab open; copy the room code or leave and rejoin after storage is available.",
    );
    await expect(page.getByTestId("online-pending-action")).toHaveCount(0);
    expect(server.socketRuntime.registry.sessionCount).toBe(1);

    await page.evaluate(() => { (window as Window & { __denyWebStorage?: boolean }).__denyWebStorage = false; });
    await page.getByTestId("online-leave-room").click();
    await page.getByRole("dialog", { name: "Leave this room?" }).getByRole("button", { name: "Leave room" }).click();
    await expect(page.getByTestId("online-nickname")).toHaveValue("Storage Owner");
    await expect(page.getByTestId("online-feedback")).toContainText("You left the room");

    await page.getByTestId("online-create").click();
    await expect(page.getByTestId("online-role")).toBeVisible();
    await expect(page.getByTestId("online-feedback")).toContainText("created");
    expect(await page.evaluate(() => sessionStorage.getItem("meydan.online-session.v1"))).not.toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("meydan.nickname.v1"))).toBe("Storage Owner");
    expect(server.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });
    expect(pageErrors).toEqual([]);
  } finally {
    await page?.close();
    await context.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});
