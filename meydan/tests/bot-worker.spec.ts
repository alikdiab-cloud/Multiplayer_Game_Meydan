import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { DamaMatch, type LegalMove } from "../shared/game.js";
import type { BotWorkerResponse } from "../shared/botProtocol.js";
import { startDevelopmentServer } from "../server/index.js";
import { startProductionServer } from "../server/production.js";

async function startSourceWorkerSearch(
  page: import("@playwright/test").Page,
  difficulty: "easy" | "medium" | "hard",
): Promise<LegalMove[]> {
  return page.evaluate(async (searchDifficulty) => {
    const clientModulePath = "/src/botWorkerClient.ts";
    const gameModulePath = "/shared/game.ts";
    const clientModule = (await import(clientModulePath)) as typeof import("../src/botWorkerClient.js");
    const gameModule = (await import(gameModulePath)) as typeof import("../shared/game.js");
    const match = new gameModule.DamaMatch();
    const view = match.getView();
    const output = document.createElement("output");
    output.dataset.testid = "bot-worker-result";
    output.dataset.state = "pending";
    document.body.append(output);

    const client = new clientModule.BotWorkerClient();
    void client.search(view, searchDifficulty).then((response) => {
      output.dataset.state = response.kind;
      output.dataset.response = JSON.stringify(response);
      output.textContent = response.kind;
      client.dispose();
    });
    return view.legalMoves;
  }, difficulty);
}

function isSameMove(first: LegalMove | null, second: LegalMove): boolean {
  return (
    first !== null &&
    first.from === second.from &&
    first.path.length === second.path.length &&
    first.path.every((square, index) => square === second.path[index]) &&
    first.captured.length === second.captured.length &&
    first.captured.every((square, index) => square === second.captured[index])
  );
}

test("runs hard search in a module worker while browser controls stay responsive", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const legalMoves = await startSourceWorkerSearch(page, "hard");
    const result = page.getByTestId("bot-worker-result");
    await expect(result).toHaveAttribute("data-state", "pending");

    const flip = page.getByRole("button", { name: "Flip board orientation" });
    await flip.click();
    await expect(flip).toHaveAttribute("aria-pressed", "true");
    await expect(result).toHaveAttribute("data-state", "success", { timeout: 30_000 });

    const rawResponse = await result.getAttribute("data-response");
    expect(rawResponse).not.toBeNull();
    const response = JSON.parse(rawResponse!) as BotWorkerResponse;
    expect(response.kind).toBe("success");
    if (response.kind !== "success") {
      throw new Error(response.kind === "failure" ? response.error : "Unexpected worker response.");
    }
    expect(response.requestId).toBe(1);
    expect(response.generation).toBeGreaterThan(0);
    expect(legalMoves.some((move) => isSameMove(response.result.move, move))).toBe(true);
    expect(response.result.move?.path.length).toBeGreaterThan(0);
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

test("reports a malformed worker reply as a recoverable failure", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const response = await page.evaluate(async () => {
      const clientModulePath = "/src/botWorkerClient.ts";
      const gameModulePath = "/shared/game.ts";
      const { BotWorkerClient } = await import(clientModulePath);
      const { DamaMatch } = await import(gameModulePath);
      class MalformedWorker {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
        postMessage(message: unknown): void {
          const request = message as { requestId: number; generation: number };
          queueMicrotask(() => this.onmessage?.({
            data: {
              kind: "success",
              requestId: request.requestId,
              generation: request.generation,
              result: {
                move: { from: "not-a-move" },
                score: 0,
                completedDepth: 1,
                nodesSearched: 1,
                elapsedMs: 0,
                stopReason: "depth",
              },
            },
          } as MessageEvent<unknown>));
        }
        terminate(): void {}
      }
      window.Worker = MalformedWorker as unknown as typeof Worker;
      const client = new BotWorkerClient();
      const result = await client.search(new DamaMatch().getView(), "easy");
      client.dispose();
      return result;
    });

    expect(response.kind).toBe("failure");
    if (response.kind === "failure") {
      expect(response.error).toContain("invalid response");
    }
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("reports a worker runtime exception as a recoverable search failure", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const response = await page.evaluate(async () => {
      const clientModulePath = "/src/botWorkerClient.ts";
      const gameModulePath = "/shared/game.ts";
      const { BotWorkerClient } = await import(clientModulePath);
      const { DamaMatch } = await import(gameModulePath);
      class CrashingWorker {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
        postMessage(): void {
          queueMicrotask(() => this.onerror?.({
            message: "forced worker search exception",
            preventDefault() {},
          } as ErrorEvent));
        }
        terminate(): void {}
      }
      window.Worker = CrashingWorker as unknown as typeof Worker;
      const client = new BotWorkerClient();
      const result = await client.search(new DamaMatch().getView(), "easy");
      client.dispose();
      return result;
    });

    expect(response.kind).toBe("failure");
    if (response.kind === "failure") {
      expect(response.error).toBe("forced worker search exception");
    }
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("the watchdog ends a worker request that never replies", async ({ page }) => {
  const server = await startDevelopmentServer({ port: 0, logUrls: false });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const response = await page.evaluate(async () => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: any[]) =>
        nativeSetTimeout(handler, Math.min(timeout, 25), ...args)) as typeof window.setTimeout;
      const clientModulePath = "/src/botWorkerClient.ts";
      const gameModulePath = "/shared/game.ts";
      const { BotWorkerClient } = await import(clientModulePath);
      const { DamaMatch } = await import(gameModulePath);
      class SilentWorker {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
        postMessage(): void {}
        terminate(): void {}
      }
      window.Worker = SilentWorker as unknown as typeof Worker;
      const client = new BotWorkerClient();
      const result = await client.search(new DamaMatch().getView(), "easy");
      client.dispose();
      return result;
    });

    expect(response.kind).toBe("failure");
    if (response.kind === "failure") {
      expect(response.error).toContain("timed out");
    }
  } finally {
    await page.close();
    await server.close();
    expect(server.httpServer.listening).toBe(false);
  }
});

test("loads and runs the emitted production worker bundle", async ({ page }) => {
  const clientDirectory = resolve(process.cwd(), "dist/client");
  const assetsDirectory = join(clientDirectory, "assets");
  test.skip(!existsSync(join(clientDirectory, "index.html")), "Run the production build first.");

  const workerFilename = readdirSync(assetsDirectory).find((name) => /^bot\.worker-.*\.js$/.test(name));
  expect(workerFilename).toBeDefined();

  const server = await startProductionServer({
    port: 0,
    clientDirectory,
    logUrls: false,
  });
  const pageErrors: string[] = [];
  const workerResponses: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().endsWith(workerFilename!)) {
      workerResponses.push(response.status());
    }
  });

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const view = new DamaMatch().getView();
    const legalMoves = await page.evaluate((data) => {
      const output = document.createElement("output");
      output.dataset.testid = "production-bot-worker-result";
      output.dataset.state = "pending";
      document.body.append(output);
      const worker = new Worker(`/assets/${data.workerFilename}`, { type: "module" });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        output.dataset.state = "complete";
        output.dataset.response = JSON.stringify(event.data);
        output.textContent = "complete";
        worker.terminate();
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        output.dataset.state = "error";
        output.textContent = event.message;
        worker.terminate();
      };
      worker.postMessage({
        kind: "search",
        requestId: 71,
        generation: 4,
        difficulty: "hard",
        view: data.view,
      });
      return data.view.legalMoves;
    }, { workerFilename: workerFilename!, view });

    const flip = page.getByRole("button", { name: "Flip board orientation" });
    await flip.click();
    await expect(flip).toHaveAttribute("aria-pressed", "true");
    const output = page.getByTestId("production-bot-worker-result");
    await expect(output).toHaveAttribute("data-state", "complete", { timeout: 30_000 });

    const rawResponse = await output.getAttribute("data-response");
    expect(rawResponse).not.toBeNull();
    const response = JSON.parse(rawResponse!) as BotWorkerResponse;
    expect(response).toMatchObject({ kind: "success", requestId: 71, generation: 4 });
    if (response.kind !== "success") {
      throw new Error(response.kind === "failure" ? response.error : "Unexpected worker response.");
    }
    expect(legalMoves.some((move) => isSameMove(response.result.move, move))).toBe(true);
    expect(workerResponses).toEqual([200]);
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
