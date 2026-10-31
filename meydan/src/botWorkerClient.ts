import type { BotDifficulty, BotSearchResult } from "../shared/bot.js";
import type { GameView } from "../shared/game.js";
import type { BotWorkerRequest, BotWorkerResponse } from "../shared/botProtocol.js";

export type BotSearchOutcome = BotWorkerResponse | {
  kind: "cancelled";
  requestId: number;
  generation: number;
};

/** Search bounds leave headroom over observed completion time while preventing a stuck UI. */
export const BOT_WORKER_WATCHDOG_MS: Readonly<Record<BotDifficulty, number>> = {
  easy: 8_000,
  medium: 20_000,
  hard: 60_000,
};

type PendingSearch = {
  requestId: number;
  generation: number;
  worker: Worker;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
  resolve: (response: BotSearchOutcome) => void;
};

function copyGameView(view: GameView): GameView {
  return {
    position: { ...view.position },
    turn: view.turn,
    legalMoves: view.legalMoves.map((move) => ({
      from: move.from,
      path: [...move.path],
      captured: [...move.captured],
    })),
    history: view.history.map((record) => ({
      ply: record.ply,
      side: record.side,
      from: record.from,
      path: [...record.path],
      captured: [...record.captured],
      notation: record.notation,
    })),
    result: view.result === null ? null : { ...view.result },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isLegalMove(value: unknown): value is NonNullable<BotSearchResult["move"]> {
  return (
    isRecord(value) &&
    typeof value.from === "string" &&
    isStringArray(value.path) &&
    value.path.length > 0 &&
    isStringArray(value.captured)
  );
}

function isResponse(value: unknown): value is BotWorkerResponse {
  if (!isRecord(value) || !Number.isSafeInteger(value.requestId) || !Number.isSafeInteger(value.generation)) {
    return false;
  }
  if (value.kind === "failure") {
    return typeof value.error === "string";
  }
  if (value.kind !== "success" || !isRecord(value.result)) {
    return false;
  }
  const result = value.result;
  const stopReasons = ["depth", "node-budget", "terminal", "no-legal-moves"];
  return (
    (result.move === null || isLegalMove(result.move)) &&
    typeof result.score === "number" && Number.isFinite(result.score) &&
    typeof result.completedDepth === "number" &&
    Number.isSafeInteger(result.completedDepth) && result.completedDepth >= 0 &&
    typeof result.nodesSearched === "number" &&
    Number.isSafeInteger(result.nodesSearched) && result.nodesSearched >= 0 &&
    typeof result.elapsedMs === "number" && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 &&
    typeof result.stopReason === "string" && stopReasons.includes(result.stopReason)
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function terminateWorker(worker: Worker): void {
  try {
    worker.terminate();
  } catch {
    // A worker may already have stopped after an error or timeout.
  }
}

/** Owns a module worker and rejects late replies after cancel or a newer request. */
export class BotWorkerClient {
  #generation = 0;
  #nextRequestId = 0;
  #pending: PendingSearch | undefined;

  search(view: GameView, difficulty: BotDifficulty): Promise<BotSearchOutcome> {
    this.cancel();
    const generation = this.#generation;
    const requestId = ++this.#nextRequestId;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./bot.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      return Promise.resolve({
        kind: "failure",
        requestId,
        generation,
        error: errorMessage(error, "The computer worker could not start."),
      });
    }

    return new Promise<BotSearchOutcome>((resolve) => {
      const pending: PendingSearch = {
        requestId,
        generation,
        worker,
        timeoutId: undefined,
        resolve,
      };
      this.#pending = pending;

      const finish = (response: BotSearchOutcome): void => {
        if (
          this.#pending !== pending ||
          this.#generation !== generation ||
          response.requestId !== requestId ||
          response.generation !== generation
        ) {
          return;
        }
        this.#pending = undefined;
        if (pending.timeoutId !== undefined) {
          clearTimeout(pending.timeoutId);
        }
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        terminateWorker(worker);
        resolve(response);
      };

      const fail = (error: string): void => {
        finish({ kind: "failure", requestId, generation, error });
      };

      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (!isResponse(event.data)) {
          fail("The computer returned an invalid response.");
          return;
        }
        if (event.data.requestId !== requestId || event.data.generation !== generation) {
          fail("The computer response did not match the current search.");
          return;
        }
        finish(event.data);
      };

      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        fail(event.message || "The computer worker could not run.");
      };

      worker.onmessageerror = () => fail("The computer worker sent an unreadable response.");

      pending.timeoutId = setTimeout(() => {
        fail("Computer search timed out. Retry the search or start a new game.");
      }, BOT_WORKER_WATCHDOG_MS[difficulty]);

      const request: BotWorkerRequest = {
        kind: "search",
        requestId,
        generation,
        difficulty,
        view: copyGameView(view),
      };
      try {
        worker.postMessage(request);
      } catch (error) {
        fail(errorMessage(error, "The search request could not be sent."));
      }
    });
  }

  /** Cancels CPU work and resolves the outstanding request as cancelled. */
  cancel(): void {
    this.#generation += 1;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) {
      return;
    }

    if (pending.timeoutId !== undefined) {
      clearTimeout(pending.timeoutId);
    }
    pending.worker.onmessage = null;
    pending.worker.onerror = null;
    pending.worker.onmessageerror = null;
    terminateWorker(pending.worker);
    pending.resolve({
      kind: "cancelled",
      requestId: pending.requestId,
      generation: pending.generation,
    });
  }

  /** Safe to call on reset, undo, mode changes, or component unmount. */
  dispose(): void {
    this.cancel();
  }
}

export type { BotSearchResult };

