import { CheckersGame, CHECKERS_WHITE, TurkishBoard, type CheckersPosition } from "@ymir-js/checkers";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DamaMatch } from "../shared/game.js";
import { startDevelopmentServer } from "../server/index.js";

function terminalOpeningMatch(): DamaMatch {
  const position: CheckersPosition = {
    "4|0": "W",
    "4|4": "b",
    "7|7": "w",
  };
  return new DamaMatch(
    new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }),
  );
}

async function createPlayerPair(
  pageA: Page,
  pageB: Page,
  origin: string,
  names: [string, string],
  timeControl: "untimed" | "rapid" = "untimed",
): Promise<string> {
  await pageA.goto(origin, { waitUntil: "load" });
  await pageA.getByTestId("mode-online").click();
  await pageA.getByTestId("online-nickname").fill(names[0]);
  if (timeControl === "rapid") await pageA.getByTestId("online-time-control").selectOption("rapid");
  await pageA.getByTestId("online-create").click();
  await expect(pageA.getByTestId("online-room-code")).toBeVisible();
  const roomCode = await pageA.getByTestId("online-room-code").innerText();

  await pageB.goto(`${origin}/?room=${roomCode}`, { waitUntil: "load" });
  await pageB.getByTestId("online-nickname").fill(names[1]);
  await pageB.getByTestId("online-join-player").click();
  await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
  await expect(pageB.getByTestId("online-board-state")).toHaveAttribute("data-phase", "playing");
  await expect(pageA.locator(".turn-status-live")).toHaveAttribute("role", "status");
  await expect(pageA.getByTestId("online-clocks")).toHaveAttribute("aria-live", "off");
  return roomCode;
}

async function playTerminalMove(page: Page): Promise<void> {
  await page.getByRole("button", { name: "a4, White king, selectable piece" }).click();
  await page.getByRole("button", { name: "f4, empty, legal landing" }).click();
}

async function confirm(page: Page, title: string, action: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: action, exact: true }).click();
}

async function closeContexts(contexts: BrowserContext[], pages: Page[], server: Awaited<ReturnType<typeof startDevelopmentServer>>): Promise<void> {
  for (const page of pages) await page.close();
  for (const context of contexts) await context.close();
  await server.close();
  expect(server.httpServer.listening).toBe(false);
}

test("a natural result opens once with current sides and stays dismissed after reconnect", async ({ browser }) => {
  test.setTimeout(60_000);
  const server = await startDevelopmentServer({
    port: 0,
    logUrls: false,
    socketRuntimeOptions: { registryOptions: { createMatch: terminalOpeningMatch } },
  });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageErrors: string[] = [];
  pageA.on("pageerror", (error) => pageErrors.push(error.message));
  pageB.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    await createPlayerPair(pageA, pageB, origin, ["Natural White", "Natural Black"]);
    await playTerminalMove(pageA);

    for (const page of [pageA, pageB]) {
      await expect(page.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished");
      await expect(page.getByTestId("online-result")).toHaveAttribute("data-result-reason", "no-moves");
      const resultDialog = page.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Match 1 result");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("White wins");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Black has no legal moves.");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("White: Natural White");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Black: Natural Black");
      await expect(page.getByRole("dialog")).toHaveCount(1);
    }

    const resultDialogA = pageA.getByRole("dialog", { name: "Match result" });
    await resultDialogA.getByTestId("result-dialog-dismiss").click();
    await expect(resultDialogA).toBeHidden();
    await expect.poll(() => pageA.evaluate(() => {
      const active = document.activeElement;
      return active?.closest(".board-column") !== null || active?.getAttribute("data-testid") === "turn-status";
    })).toBe(true);

    await pageA.getByTestId("sound-toggle").focus();
    await contextA.setOffline(true);
    await expect(pageA.getByTestId("online-connection")).toBeVisible({ timeout: 15_000 });
    await contextA.setOffline(false);
    await expect(pageA.getByTestId("online-connection")).toBeHidden({ timeout: 20_000 });
    await expect(resultDialogA).toBeHidden();
    await expect.poll(() => pageA.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null))
      .toBe("sound-toggle");
    expect(pageErrors).toEqual([]);
  } finally {
    await closeContexts([contextA, contextB], [pageA, pageB], server);
  }
});

test("draw, rematch, and resignation summaries follow the current match and swapped sides", async ({ browser }) => {
  test.setTimeout(60_000);
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageC = await contextC.newPage();

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const roomCode = await createPlayerPair(pageA, pageB, origin, ["Match White", "Match Black"]);
    await pageC.goto(`${origin}/?room=${roomCode}`, { waitUntil: "load" });
    await pageC.getByTestId("online-nickname").fill("Result Spectator");
    await pageC.getByTestId("online-join-spectator").click();
    await expect(pageC.getByTestId("online-role")).toHaveText("You are spectating.");
    await expect(pageC.getByTestId("turn-status")).toContainText("Spectating");
    await expect(pageC.getByTestId("spectator-action-status")).toHaveText("Read-only spectator");
    await pageA.getByTestId("draw-offer").click();
    await expect(pageB.getByTestId("draw-offer-status")).toContainText("Incoming draw offer");
    await pageB.getByTestId("draw-accept").click();
    await confirm(pageB, "Accept this draw?", "Accept draw");

    for (const page of [pageA, pageB]) {
      const resultDialog = page.getByRole("dialog", { name: "Match result" });
      await expect(resultDialog).toBeVisible();
      await expect(resultDialog.getByTestId("result-dialog-summary")).toHaveAttribute("data-result-reason", "agreement");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Draw");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("White: Match White");
      await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Black: Match Black");
      await resultDialog.getByTestId("result-dialog-dismiss").click();
      await expect(resultDialog).toBeHidden();
    }
    await expect(pageC.getByTestId("online-result")).toHaveAttribute("data-result-reason", "agreement");
    await expect(pageC.getByRole("dialog", { name: "Match result" })).toBeHidden();

    await expect(pageA.getByTestId("rematch-status")).toHaveText("Both votes needed");
    await expect(pageC.getByTestId("rematch-status")).toHaveText("Players only · both votes needed");
    await pageA.getByTestId("rematch-vote").click();
    await confirm(pageA, "Agree to a rematch?", "Agree to rematch");
    await expect(pageA.getByTestId("rematch-status")).toHaveText("You agreed · waiting for opponent");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "1");
    await pageB.getByTestId("rematch-vote").click();
    await confirm(pageB, "Agree to a rematch?", "Agree to rematch");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-match-number", "2");
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-viewer-side", "black");
    await expect(pageA.locator('[data-testid="black-seat"] .seat-detail')).toHaveText("Match White");
    await expect(pageA.locator('[data-testid="white-seat"] .seat-detail')).toHaveText("Match Black");
    await expect(pageA.getByRole("dialog", { name: "Match result" })).toBeHidden();
    await expect(pageC.getByTestId("online-board-state")).toHaveAttribute("data-viewer-side", "spectator");

    await pageA.getByTestId("online-resign").click();
    await confirm(pageA, "Resign this match?", "Resign");
    const resignation = pageA.getByRole("dialog", { name: "Match result" });
    await expect(resignation).toBeVisible();
    await expect(resignation.getByTestId("result-dialog-summary")).toHaveAttribute("data-result-reason", "resignation");
    await expect(resignation.getByTestId("result-dialog-summary")).toContainText("Match 2 result");
    await expect(resignation.getByTestId("result-dialog-summary")).toContainText("White wins");
    await expect(resignation.getByTestId("result-dialog-summary")).toContainText("Black resigned.");
    await expect(resignation.getByTestId("result-dialog-summary")).toContainText("White: Match Black");
    await expect(resignation.getByTestId("result-dialog-summary")).toContainText("Black: Match White");
    await expect(pageA.getByTestId("rematch-black-consent")).toContainText("Waiting");
    await expect(pageC.getByTestId("online-result")).toHaveAttribute("data-result-reason", "resignation");
    await expect(pageC.getByRole("dialog", { name: "Match result" })).toBeHidden();
  } finally {
    await closeContexts([contextA, contextB, contextC], [pageA, pageB, pageC], server);
  }
});

test("timeout result uses the server clock and opens once", async ({ browser }) => {
  test.setTimeout(45_000);
  let now = 50_000;
  const server = await startDevelopmentServer({
    port: 0,
    logUrls: false,
    socketRuntimeOptions: { registryOptions: { now: () => now } },
  });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    await createPlayerPair(pageA, pageB, origin, ["Clock White", "Clock Black"], "rapid");
    now += 600_000;
    await expect(pageA.getByTestId("online-board-state")).toHaveAttribute("data-phase", "finished", { timeout: 15_000 });
    const resultDialog = pageA.getByRole("dialog", { name: "Match result" });
    await expect(resultDialog).toBeVisible();
    await expect(resultDialog.getByTestId("result-dialog-summary")).toHaveAttribute("data-result-reason", "timeout");
    await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Black wins");
    await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("White ran out of time.");
    await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("White: Clock White");
    await expect(resultDialog.getByTestId("result-dialog-summary")).toContainText("Black: Clock Black");
    await expect.poll(() => pageA.getByRole("dialog", { name: "Match result" }).count()).toBe(1);
    await pageA.waitForTimeout(600);
    await expect(pageA.getByRole("dialog", { name: "Match result" })).toBeVisible();
  } finally {
    await closeContexts([contextA, contextB], [pageA, pageB], server);
  }
});
