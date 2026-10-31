import { expect, test, type Page } from "@playwright/test";
import { startDevelopmentServer } from "../server/index.js";

declare global {
  interface Window {
    __meydanAudioProbe: {
      contexts: number;
      resumeCalls: number;
      oscillators: number;
    };
  }
}

async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { contexts: 0, resumeCalls: 0, oscillators: 0 };
    window.__meydanAudioProbe = probe;
    const NativeAudioContext = window.AudioContext;
    if (typeof NativeAudioContext !== "function") return;

    const originalResume = NativeAudioContext.prototype.resume;
    NativeAudioContext.prototype.resume = function (this: AudioContext) {
      probe.resumeCalls += 1;
      return originalResume.call(this);
    };
    const originalCreateOscillator = NativeAudioContext.prototype.createOscillator;
    NativeAudioContext.prototype.createOscillator = function (this: AudioContext) {
      probe.oscillators += 1;
      return originalCreateOscillator.call(this);
    };
    const observedConstructor = new Proxy(NativeAudioContext, {
      construct(target, argumentsList, newTarget) {
        probe.contexts += 1;
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: observedConstructor });
  });
}

async function playFirstLegalMove(page: Page): Promise<void> {
  const historyCount = page.getByTestId("history-count");
  const before = await historyCount.innerText();
  await page.locator(".square-control--source").first().click();
  for (let index = 0; index < 16; index += 1) {
    const landing = page.locator(".square-control--landing").first();
    await expect(landing).toBeVisible();
    await landing.click();
    if ((await historyCount.innerText()) !== before) return;
  }
  throw new Error("The legal move did not finish within its capture path.");
}

test("game sounds require a gesture, follow committed events, and obey the toggle", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installAudioProbe(page);

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await expect(page.getByTestId("sound-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => window.__meydanAudioProbe)).toEqual({ contexts: 0, resumeCalls: 0, oscillators: 0 });

    await page.locator(".square-control--source").first().click();
    expect(await page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Turn sound on" }).click();
    await expect(page.getByRole("button", { name: "Turn sound off" })).toBeVisible();
    expect(await page.evaluate(() => window.__meydanAudioProbe)).toMatchObject({ contexts: 1, resumeCalls: 1, oscillators: 0 });

    // Selecting and previewing a legal landing are not committed moves.
    await page.locator(".square-control--source").first().click();
    await expect(page.locator(".square-control--landing").first()).toBeVisible();
    expect(await page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(0);
    await page.locator(".square-control--landing").first().click();
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    await expect.poll(() => page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(1);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(1);

    await page.getByRole("button", { name: "Turn sound off" }).click();
    await expect(page.getByTestId("sound-toggle")).toHaveAttribute("aria-pressed", "false");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("history-count")).toHaveText("2 plies");
    expect(await page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("a capture preview is quiet and the committed capture uses its distinct sound", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  await installAudioProbe(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.port}/tests/finished-board-harness.html?scenario=scorebook-capture`,
      { waitUntil: "load" },
    );
    await page.getByRole("button", { name: "Turn sound on" }).click();
    await page.getByRole("button", { name: "a8, White man, selectable piece" }).click();
    await page.getByRole("button", { name: "a6, empty, legal landing" }).click();
    expect(await page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(0);
    await page.getByRole("button", { name: "c6, empty, legal landing" }).click();
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    await expect.poll(() => page.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(2);
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("only harmless preferences persist and a reload waits for an audio gesture", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  await installAudioProbe(page);
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.getByTestId("mode-computer").click();
    await page.getByTestId("bot-difficulty").selectOption("hard");
    await page.getByRole("button", { name: "Turn sound on" }).click();
    await expect(page.getByTestId("sound-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({
      "meydan.difficulty.v1": "hard",
      "meydan.sound-enabled.v1": "true",
    });

    await page.reload({ waitUntil: "load" });
    await expect(page.getByTestId("sound-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("sound-status")).toContainText("Activate it in this tab");
    expect(await page.evaluate(() => window.__meydanAudioProbe)).toEqual({ contexts: 0, resumeCalls: 0, oscillators: 0 });
    await page.getByTestId("mode-computer").click();
    await expect(page.getByTestId("bot-difficulty")).toHaveValue("hard");
    await page.getByRole("button", { name: "Activate sound" }).click();
    await expect(page.getByRole("button", { name: "Turn sound off" })).toBeVisible();
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("an online reload restores the match without replay and later snapshots sound once", async ({ browser }) => {
  test.setTimeout(60_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageErrors: string[] = [];
  pageA.on("pageerror", (error) => pageErrors.push(error.message));
  pageB.on("pageerror", (error) => pageErrors.push(error.message));
  await installAudioProbe(pageA);
  await installAudioProbe(pageB);

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    await pageA.goto(origin, { waitUntil: "load" });
    await pageA.getByTestId("mode-online").click();
    await pageA.getByTestId("online-nickname").fill("Sound Alice");
    await pageA.getByTestId("online-create").click();
    await expect(pageA.getByTestId("online-room-code")).toBeVisible();
    const roomCode = await pageA.getByTestId("online-room-code").innerText();

    await pageB.goto(`${origin}/?room=${roomCode}`, { waitUntil: "load" });
    await pageB.getByTestId("online-nickname").fill("Sound Bob");
    await pageB.getByTestId("online-join-player").click();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
    await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");

    await pageA.getByRole("button", { name: "Turn sound on" }).click();
    await playFirstLegalMove(pageA);
    await expect(pageA.getByTestId("history-count")).toHaveText("1 ply");
    await expect.poll(() => pageA.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(1);
    const storedPreferences = await pageA.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    expect(storedPreferences).toEqual({
      "meydan.nickname.v1": "Sound Alice",
      "meydan.sound-enabled.v1": "true",
    });
    expect(await pageA.evaluate(() => Object.keys(sessionStorage))).toEqual(["meydan.online-session.v1"]);
    const privateCredential = await pageA.evaluate(() => {
      const stored = sessionStorage.getItem("meydan.online-session.v1");
      return stored === null ? null : (JSON.parse(stored) as { sessionToken: string }).sessionToken;
    });
    expect(privateCredential).not.toBeNull();
    expect(JSON.stringify(storedPreferences)).not.toContain(privateCredential!);

    await pageA.reload({ waitUntil: "load" });
    await expect(pageA.getByTestId("online-role")).toHaveText("You are playing as White.");
    await expect(pageA.getByTestId("history-count")).toHaveText("1 ply");
    expect(await pageA.evaluate(() => window.__meydanAudioProbe)).toEqual({ contexts: 0, resumeCalls: 0, oscillators: 0 });
    await pageA.waitForTimeout(800);
    expect(await pageA.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(0);

    await pageA.getByRole("button", { name: "Activate sound" }).click();
    await playFirstLegalMove(pageB);
    await expect(pageA.getByTestId("history-count")).toHaveText("2 plies");
    await expect.poll(() => pageA.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(1);
    await pageA.waitForTimeout(800);
    expect(await pageA.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(1);

    await pageB.getByTestId("online-resign").click();
    await expect(pageB.getByRole("dialog", { name: "Resign this match?" })).toBeVisible();
    await pageB.getByRole("dialog", { name: "Resign this match?" }).getByRole("button", { name: "Resign" }).click();
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
    await expect.poll(() => pageA.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(4);
    await pageA.waitForTimeout(800);
    expect(await pageA.evaluate(() => window.__meydanAudioProbe.oscillators)).toBe(4);
    expect(await pageA.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({
      "meydan.nickname.v1": "Sound Alice",
      "meydan.sound-enabled.v1": "true",
    });
    expect(await pageA.evaluate(() => Object.keys(sessionStorage))).toEqual(["meydan.online-session.v1"]);
    expect(pageErrors).toEqual([]);
  } finally {
    await contextA.close();
    await contextB.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("unavailable audio and persistent storage leave local play working", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage is blocked", "SecurityError"); },
    });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Turn sound on" }).click();
    await expect(page.getByTestId("sound-status")).toContainText("Audio is unavailable");
    await expect(page.getByTestId("sound-toggle")).toHaveAttribute("aria-pressed", "false");
    await playFirstLegalMove(page);
    await expect(page.getByTestId("history-count")).toHaveText("1 ply");
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});
