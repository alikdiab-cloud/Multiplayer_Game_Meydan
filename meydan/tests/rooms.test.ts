import { describe, expect, it } from "vitest";
import { CheckersGame, CHECKERS_WHITE, TurkishBoard, type CheckersPosition } from "@ymir-js/checkers";
import { DamaMatch } from "../shared/game.js";
import {
  TIME_CONTROL_PRESETS,
  type CreateRoomInput,
  type JoinRoomInput,
  RoomSnapshotSchema,
} from "../shared/protocol.js";
import {
  DEFAULT_RECOVERY_GRACE_MS,
  DEFAULT_ROOM_IDLE_TIMEOUT_MS,
  RoomRegistry,
  RoomRegistryError,
  type RoomRegistryOptions,
} from "../server/rooms.js";

function makeRegistry(options: RoomRegistryOptions = {}): RoomRegistry {
  let sessionSequence = 0;
  let playerSequence = 0;
  return new RoomRegistry({
    ...options,
    now: options.now ?? (() => 100_000),
    generateSessionToken: options.generateSessionToken ?? (() => {
      sessionSequence += 1;
      return `session-token-${String(sessionSequence).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`;
    }),
    generatePlayerId: options.generatePlayerId ?? (() => {
      playerSequence += 1;
      return `public-player-${String(playerSequence).padStart(4, "0")}`;
    }),
  });
}

function createMatch(position?: CheckersPosition): DamaMatch {
  if (position === undefined) {
    return new DamaMatch();
  }
  return new DamaMatch(new CheckersGame(new TurkishBoard().setPosition(position), { turn: CHECKERS_WHITE }));
}

function createInput(
  name: string,
  side: "white" | "black" = "white",
  timeControl: CreateRoomInput["timeControl"] = TIME_CONTROL_PRESETS.untimed,
): CreateRoomInput {
  return { name, side, timeControl };
}

function joinInput(code: string, name: string, role?: JoinRoomInput["role"]): JoinRoomInput {
  return role === undefined ? { code, name } : { code, name, role };
}

function expectRegistryError(action: () => unknown, code: RoomRegistryError["code"], message?: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RoomRegistryError);
  expect((thrown as RoomRegistryError).code).toBe(code);
  if (message !== undefined) expect((thrown as RoomRegistryError).message).toBe(message);
}

function expectMoveErrorAndPreserve(
  registry: RoomRegistry,
  sessionToken: string,
  allSessionTokens: string[],
  request: unknown,
  code: RoomRegistryError["code"],
  message?: string,
): void {
  const before = allSessionTokens.map((token) => registry.snapshotForSession(token));
  expectRegistryError(() => registry.move(sessionToken, request), code, message);
  expect(allSessionTokens.map((token) => registry.snapshotForSession(token))).toEqual(before);
}

function expectDrawErrorAndPreserve(
  registry: RoomRegistry,
  sessionToken: string,
  allSessionTokens: string[],
  action: (token: string, request: unknown) => unknown,
  request: unknown,
  code: RoomRegistryError["code"],
): void {
  const before = allSessionTokens.map((token) => registry.snapshotForSession(token));
  expectRegistryError(() => action(sessionToken, request), code);
  expect(allSessionTokens.map((token) => registry.snapshotForSession(token))).toEqual(before);
}

describe("RoomRegistry", () => {
  it("expires at six inactive hours and refreshes activity only for accepted actions", () => {
    let now = 100_000;
    const registry = makeRegistry({ now: () => now });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));

    now += DEFAULT_ROOM_IDLE_TIMEOUT_MS - 1;
    const spectator = registry.joinRoom(joinInput(white.code, "Viewer", "spectator"));
    const legalMove = black.snapshot.gameView.legalMoves[0];
    if (legalMove === undefined) throw new Error("Fresh match must have a legal move.");
    expectRegistryError(() => registry.move(black.credentials.sessionToken, {
      revision: spectator.snapshot.revision,
      from: legalMove.from,
      path: [...legalMove.path],
    }), "not-your-turn");
    expect(registry.advanceClocks()).toEqual([]);

    const acceptedMove = registry.move(white.credentials.sessionToken, {
      revision: spectator.snapshot.revision,
      from: legalMove.from,
      path: [...legalMove.path],
    });
    now += DEFAULT_ROOM_IDLE_TIMEOUT_MS - 1;
    expect(registry.advanceClocks()).toEqual([]);
    expect(registry.snapshotForSession(white.credentials.sessionToken).revision).toBe(acceptedMove.revision);

    now += 1;
    const expiry = registry.advanceClocks();
    expect(expiry).toHaveLength(1);
    expect(expiry[0]).toMatchObject({
      roomCode: white.code,
      snapshots: [],
      closed: {
        reason: "idle-timeout",
        sessionTokens: [white.credentials.sessionToken, black.credentials.sessionToken, spectator.credentials.sessionToken],
      },
    });
    expect(registry.roomCount).toBe(0);
    expect(registry.sessionCount).toBe(0);
  });

  it("does not let passive maintenance ticks keep an inactive room alive", () => {
    let now = 300_000;
    const registry = makeRegistry({ now: () => now });
    const room = registry.createRoom(createInput("Idle"));

    for (let elapsed = 0; elapsed < DEFAULT_ROOM_IDLE_TIMEOUT_MS; elapsed += 60 * 60 * 1_000) {
      now += 60 * 60 * 1_000;
      const updates = registry.advanceClocks();
      if (elapsed < DEFAULT_ROOM_IDLE_TIMEOUT_MS - 60 * 60 * 1_000) {
        expect(updates).toEqual([]);
        expect(registry.roomCount).toBe(1);
      } else {
        expect(updates).toMatchObject([{
          roomCode: room.code,
          closed: { reason: "idle-timeout" },
        }]);
      }
    }
    expect(registry.roomCount).toBe(0);
    expect(registry.sessionCount).toBe(0);
  });

  it("cleans player, spectator, and expired reconnect records so room and session capacity recover", () => {
    let now = 500_000;
    const registry = makeRegistry({
      now: () => now,
      generateRoomCode: () => "CLEAN3",
      limits: { rooms: 1, sessions: 3, spectatorsPerRoom: 1 },
    });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const spectator = registry.joinRoom(joinInput(white.code, "Viewer", "spectator"));
    registry.disconnectSession(black.credentials.sessionToken);
    expect(registry.sessionCount).toBe(3);

    now += DEFAULT_ROOM_IDLE_TIMEOUT_MS;
    const [expired] = registry.advanceClocks();
    expect(expired).toMatchObject({
      closed: {
        reason: "idle-timeout",
        sessionTokens: [white.credentials.sessionToken, black.credentials.sessionToken, spectator.credentials.sessionToken],
      },
    });
    expect(registry.roomCount).toBe(0);
    expect(registry.sessionCount).toBe(0);
    expectRegistryError(() => registry.resumeRoom({
      code: white.code,
      sessionToken: black.credentials.sessionToken,
    }), "unauthorized");

    const replacement = registry.createRoom(createInput("Replacement"));
    expect(replacement.code).toBe(white.code);
    expect(registry.roomCount).toBe(1);
    expect(registry.sessionCount).toBe(1);
  });

  it("creates a cryptographic room code and a separate reconnect identity", () => {
    const registry = new RoomRegistry({
      generateRoomCode: () => "ab2cd9",
      now: () => 123_000,
    });
    const access = registry.createRoom(createInput("  Ada  ", "black", TIME_CONTROL_PRESETS.blitz));

    expect(access.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(access.code).toBe("AB2CD9");
    expect(access.credentials.sessionToken).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(access.credentials.sessionToken).not.toBe(access.code);
    expect(access.credentials.sessionToken).not.toBe("Ada");
    expect(access.snapshot.players.black).toMatchObject({ name: "Ada", side: "black", connected: true });
    expect(JSON.stringify(access.snapshot)).not.toContain(access.credentials.sessionToken);
    expect(registry.snapshotForSession(access.credentials.sessionToken)).toEqual(access.snapshot);
    expect(registry.roomCount).toBe(1);
    expect(registry.sessionCount).toBe(1);
  });

  it("keeps one-player rooms waiting with a fresh match and stopped preset clock", () => {
    const registry = makeRegistry({
      generateRoomCode: () => "WAIT23",
      now: () => 1_000,
    });
    const created = registry.createRoom(createInput("Creator", "black", TIME_CONTROL_PRESETS.rapid));

    expect(created.snapshot.phase).toBe("waiting");
    expect(created.snapshot.matchNumber).toBe(1);
    expect(created.snapshot.revision).toBe(0);
    expect(created.snapshot.gameView.turn).toBe("white");
    expect(created.snapshot.gameView.history).toEqual([]);
    expect(created.snapshot.gameView.result).toBeNull();
    expect(created.snapshot.players.white).toBeNull();
    expect(created.snapshot.players.black?.name).toBe("Creator");
    expect(created.snapshot.viewerSide).toBe("black");
    expect(created.snapshot.timeControl).toEqual({ kind: "rapid", initialMs: 600_000, incrementMs: 5_000 });
    expect(created.snapshot.clock).toEqual({
      whiteMs: 600_000,
      blackMs: 600_000,
      activeSide: null,
      running: false,
    });
  });

  it("retries colliding codes and returns a unique normalized code", () => {
    const generatedCodes = ["ABC234", "ABC234", "XYZ789"];
    let index = 0;
    const registry = makeRegistry({
      generateRoomCode: () => generatedCodes[index++] ?? "ZZZZZZ",
    });

    expect(registry.createRoom(createInput("One")).code).toBe("ABC234");
    expect(registry.createRoom(createInput("Two")).code).toBe("XYZ789");
    expect(registry.roomCount).toBe(2);
    expect(registry.sessionCount).toBe(2);
  });

  it("does not keep partial state when room-code collisions exhaust the retry bound", () => {
    const registry = makeRegistry({
      generateRoomCode: () => "AAAAAA",
      limits: { generationAttempts: 2 },
    });
    registry.createRoom(createInput("One"));

    expectRegistryError(() => registry.createRoom(createInput("Two")), "code-generation-failed");
    expect(registry.roomCount).toBe(1);
    expect(registry.sessionCount).toBe(1);
  });

  it("assigns the joiner to the opposite seat and starts only after both players join", () => {
    const registry = makeRegistry({ generateRoomCode: () => "SEAT23" });
    const creator = registry.createRoom(createInput("Creator", "black"));
    const joiner = registry.joinRoom(joinInput(creator.code.toLowerCase(), "Joiner"));

    expect(joiner.snapshot.phase).toBe("playing");
    expect(joiner.snapshot.revision).toBe(1);
    expect(joiner.snapshot.players.white?.name).toBe("Joiner");
    expect(joiner.snapshot.players.black?.name).toBe("Creator");
    expect(joiner.snapshot.viewerSide).toBe("white");
    expect(creator.snapshot.phase).toBe("waiting");
    expect(registry.snapshotForSession(creator.credentials.sessionToken).phase).toBe("playing");
  });

  it("keeps an explicit spectator out of a free player seat and rejects their move request", () => {
    const registry = makeRegistry({ generateRoomCode: () => "SPECT2" });
    const creator = registry.createRoom(createInput("Creator", "white"));
    const spectator = registry.joinRoom(joinInput(creator.code, "Viewer", "spectator"));
    const legalMove = spectator.snapshot.gameView.legalMoves[0];
    if (legalMove === undefined) {
      throw new Error("The fresh fixture must have a legal move-shaped request.");
    }

    expect(spectator.snapshot.phase).toBe("waiting");
    expect(spectator.snapshot.players.black).toBeNull();
    expect(spectator.snapshot.viewerSide).toBeNull();
    expect(spectator.snapshot.spectatorCount).toBe(1);
    expectMoveErrorAndPreserve(registry, spectator.credentials.sessionToken, [
      creator.credentials.sessionToken,
      spectator.credentials.sessionToken,
    ], {
      revision: spectator.snapshot.revision,
      from: legalMove.from,
      path: [...legalMove.path],
    }, "not-your-turn");

    const unchanged = registry.snapshotForSession(spectator.credentials.sessionToken);
    expect(unchanged.viewerSide).toBeNull();
    expect(unchanged.players.black).toBeNull();
    expect(unchanged.spectatorCount).toBe(1);
    expect(registry.sessionCount).toBe(2);
  });

  it("applies one canonical move and increments its revision exactly once", () => {
    const registry = makeRegistry({ generateRoomCode: () => "MOVE23" });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const canonical = white.snapshot.gameView.legalMoves[0];
    if (canonical === undefined) throw new Error("Fresh match must have a legal move.");
    const request = { revision: black.snapshot.revision, from: canonical.from, path: [...canonical.path] };

    const moved = registry.move(white.credentials.sessionToken, request);
    expect(moved.revision).toBe(black.snapshot.revision + 1);
    expect(moved.phase).toBe("playing");
    expect(moved.gameView.turn).toBe("black");
    expect(moved.gameView.history).toHaveLength(1);
    expect(moved.gameView.history[0]).toMatchObject(canonical);

    expectMoveErrorAndPreserve(registry, white.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
    ], request, "stale-revision");
  });

  it("expires offers on accepted moves and lets only the opponent agree or decline", () => {
    // UI lifecycle contract: an offer remains pending until the opponent
    // accepts/declines, a legal move is accepted, or any result ends the match.
    let now = 100_000;
    const registry = makeRegistry({
      generateRoomCode: () => "DRAW23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    expectRegistryError(() => registry.offerDraw(white.credentials.sessionToken, { revision: white.snapshot.revision }), "conflict");
    expectRegistryError(() => registry.acceptDraw(white.credentials.sessionToken, { revision: white.snapshot.revision }), "conflict");
    expectRegistryError(() => registry.declineDraw(white.credentials.sessionToken, { revision: white.snapshot.revision }), "conflict");
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const spectator = registry.joinRoom(joinInput(white.code, "Spectator", "spectator"));
    const tokens = [white.credentials.sessionToken, black.credentials.sessionToken, spectator.credentials.sessionToken];
    const currentRevision = spectator.snapshot.revision;

    const firstOffer = registry.offerDraw(white.credentials.sessionToken, { revision: currentRevision });
    expect(firstOffer).toMatchObject({ revision: currentRevision + 1, phase: "playing", drawOffer: { offeredBy: "white" } });
    expect(firstOffer.clock).toMatchObject({ activeSide: "white", running: true });

    expectDrawErrorAndPreserve(registry, white.credentials.sessionToken, tokens, (token, request) => registry.offerDraw(token, request), {
      revision: firstOffer.revision,
    }, "conflict");
    expectDrawErrorAndPreserve(registry, white.credentials.sessionToken, tokens, (token, request) => registry.acceptDraw(token, request), {
      revision: firstOffer.revision,
    }, "not-your-turn");
    expectDrawErrorAndPreserve(registry, spectator.credentials.sessionToken, tokens, (token, request) => registry.offerDraw(token, request), {
      revision: firstOffer.revision,
    }, "not-your-turn");
    expectDrawErrorAndPreserve(registry, spectator.credentials.sessionToken, tokens, (token, request) => registry.declineDraw(token, request), {
      revision: firstOffer.revision,
    }, "not-your-turn");

    const declined = registry.declineDraw(black.credentials.sessionToken, { revision: firstOffer.revision });
    expect(declined).toMatchObject({ revision: firstOffer.revision + 1, phase: "playing", drawOffer: null });
    expect(declined.clock).toMatchObject({ activeSide: "white", running: true });
    expectDrawErrorAndPreserve(registry, black.credentials.sessionToken, tokens, (token, request) => registry.declineDraw(token, request), {
      revision: firstOffer.revision,
    }, "stale-revision");
    expectDrawErrorAndPreserve(registry, black.credentials.sessionToken, tokens, (token, request) => registry.acceptDraw(token, request), {
      revision: declined.revision,
    }, "conflict");

    const secondOffer = registry.offerDraw(white.credentials.sessionToken, { revision: declined.revision });
    now += 5_000;
    const legal = secondOffer.gameView.legalMoves[0];
    if (legal === undefined) throw new Error("The opening position must contain a legal move.");
    const moved = registry.move(white.credentials.sessionToken, {
      revision: secondOffer.revision,
      from: legal.from,
      path: [...legal.path],
    });
    expect(moved).toMatchObject({ revision: secondOffer.revision + 1, phase: "playing", drawOffer: null });
    expect(moved.gameView.history).toHaveLength(1);
    expectDrawErrorAndPreserve(registry, black.credentials.sessionToken, tokens, (token, request) => registry.declineDraw(token, request), {
      revision: secondOffer.revision,
    }, "stale-revision");

    const thirdOffer = registry.offerDraw(black.credentials.sessionToken, { revision: moved.revision });
    now += 3_000;
    expectDrawErrorAndPreserve(registry, black.credentials.sessionToken, tokens, (token, request) => registry.acceptDraw(token, request), {
      revision: thirdOffer.revision,
    }, "not-your-turn");
    const agreed = registry.acceptDraw(white.credentials.sessionToken, { revision: thirdOffer.revision });
    expect(agreed).toMatchObject({
      revision: thirdOffer.revision + 1,
      matchNumber: 1,
      phase: "finished",
      drawOffer: null,
      rematchVotes: { white: false, black: false },
      gameView: { legalMoves: [], result: { state: "draw", reason: "agreement" }, history: moved.gameView.history },
      clock: { whiteMs: 600_000, blackMs: 597_000, activeSide: null, running: false },
    });
    expect(registry.snapshotForSession(black.credentials.sessionToken)).toMatchObject({
      revision: agreed.revision,
      matchNumber: agreed.matchNumber,
      phase: "finished",
      gameView: agreed.gameView,
      drawOffer: null,
    });
    expectRegistryError(() => registry.move(white.credentials.sessionToken, {
      revision: agreed.revision,
      from: agreed.gameView.legalMoves[0]?.from ?? "0|0",
      path: agreed.gameView.legalMoves[0]?.path ?? ["0|1"],
    }), "game-finished");
    expectRegistryError(() => registry.acceptDraw(black.credentials.sessionToken, { revision: agreed.revision }), "game-finished");
  });

  it("clears a pending offer when a clock result ends the match", () => {
    let now = 20_000;
    const registry = makeRegistry({
      generateRoomCode: () => "DEND23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const offered = registry.offerDraw(white.credentials.sessionToken, { revision: black.snapshot.revision });
    now += TIME_CONTROL_PRESETS.rapid.initialMs;

    const [timeout] = registry.advanceClocks();
    expect(timeout?.snapshots).toHaveLength(2);
    expect(timeout?.snapshots[0]).toMatchObject({
      revision: offered.revision + 1,
      phase: "finished",
      drawOffer: null,
      rematchVotes: { white: false, black: false },
      gameView: { legalMoves: [], result: { state: "won", winner: "black", reason: "timeout" } },
      clock: { whiteMs: 0, activeSide: null, running: false },
    });
  });

  it("lets either player resign once and preserves the first terminal result", () => {
    for (const resigningSide of ["white", "black"] as const) {
      let now = 50_000;
      const registry = makeRegistry({
        generateRoomCode: () => resigningSide === "white" ? "RSGW23" : "RSGB23",
        now: () => now,
      });
      const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
      const black = registry.joinRoom(joinInput(white.code, "Black"));
      const spectator = registry.joinRoom(joinInput(white.code, "Viewer", "spectator"));
      const player = resigningSide === "white" ? white : black;
      const opponent = resigningSide === "white" ? black : white;
      const currentRevision = spectator.snapshot.revision;
      const legalBeforeResignation = spectator.snapshot.gameView.legalMoves[0];
      if (legalBeforeResignation === undefined) throw new Error("The active match must have a legal move.");
      const offered = registry.offerDraw(white.credentials.sessionToken, { revision: currentRevision });

      expectRegistryError(() => registry.resign(player.credentials.sessionToken, {
        revision: offered.revision,
        result: { state: "draw", reason: "agreement" },
      }), "invalid-input");
      expectRegistryError(() => registry.resign("unknown-session-token", { revision: offered.revision }), "unauthorized");
      expectDrawErrorAndPreserve(registry, spectator.credentials.sessionToken, [
        white.credentials.sessionToken,
        black.credentials.sessionToken,
        spectator.credentials.sessionToken,
      ], (token, request) => registry.resign(token, request), { revision: offered.revision }, "not-your-turn");

      const ended = registry.resign(player.credentials.sessionToken, { revision: offered.revision });
      const winner = resigningSide === "white" ? "black" : "white";
      expect(ended).toMatchObject({
        revision: offered.revision + 1,
        matchNumber: 1,
        phase: "finished",
        drawOffer: null,
        rematchVotes: { white: false, black: false },
        gameView: { turn: "white", legalMoves: [], result: { state: "won", winner, reason: "resignation" } },
        clock: { whiteMs: 600_000, blackMs: 600_000, activeSide: null, running: false },
      });

      const beforeLateActions = registry.snapshotForSession(opponent.credentials.sessionToken);
      expectRegistryError(() => registry.resign(opponent.credentials.sessionToken, { revision: ended.revision }), "game-finished");
      expectRegistryError(() => registry.resign(player.credentials.sessionToken, { revision: ended.revision }), "game-finished");
      expectRegistryError(() => registry.move(opponent.credentials.sessionToken, {
        revision: ended.revision,
        from: legalBeforeResignation.from,
        path: [...legalBeforeResignation.path],
      }), "game-finished");
      expectRegistryError(() => registry.offerDraw(opponent.credentials.sessionToken, { revision: ended.revision }), "game-finished");
      now += TIME_CONTROL_PRESETS.rapid.initialMs;
      expect(registry.advanceClocks()).toEqual([]);
      expect(registry.snapshotForSession(opponent.credentials.sessionToken)).toMatchObject({
        revision: ended.revision,
        phase: "finished",
        gameView: { result: { state: "won", winner, reason: "resignation" }, legalMoves: [] },
        clock: beforeLateActions.clock,
      });
    }
  });

  it("settles timeout before a resignation at the exact clock boundary", () => {
    let now = 7_000;
    const registry = makeRegistry({ generateRoomCode: () => "RSGE23", now: () => now });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.blitz));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const offered = registry.offerDraw(white.credentials.sessionToken, { revision: black.snapshot.revision });
    now += TIME_CONTROL_PRESETS.blitz.initialMs;

    expectRegistryError(() => registry.resign(white.credentials.sessionToken, { revision: offered.revision }), "game-finished");
    const timedOut = registry.snapshotForSession(white.credentials.sessionToken);
    expect(timedOut).toMatchObject({
      revision: offered.revision + 1,
      phase: "finished",
      drawOffer: null,
      gameView: { legalMoves: [], result: { state: "won", winner: "black", reason: "timeout" } },
      clock: { whiteMs: 0, blackMs: 300_000, activeSide: null, running: false },
    });
    expect(registry.advanceClocks()).toHaveLength(1);
    expect(registry.advanceClocks()).toEqual([]);
    expectRegistryError(() => registry.resign(black.credentials.sessionToken, { revision: timedOut.revision }), "game-finished");
    expect(registry.snapshotForSession(black.credentials.sessionToken).gameView.result).toEqual(timedOut.gameView.result);
  });

  it("starts one fresh rematch after both seated players vote and swaps their sides", () => {
    let now = 30_000;
    const registry = makeRegistry({ generateRoomCode: () => "REMT23", now: () => now });
    const white = registry.createRoom(createInput("White Player", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black Player"));
    const spectator = registry.joinRoom(joinInput(white.code, "Room Viewer", "spectator"));
    const oldOpeningMove = spectator.snapshot.gameView.legalMoves[0];
    if (oldOpeningMove === undefined) throw new Error("The initial match must contain a legal move.");
    const ended = registry.resign(white.credentials.sessionToken, { revision: spectator.snapshot.revision });
    now += 5_000;

    const firstVote = registry.voteRematch(white.credentials.sessionToken, { revision: ended.revision });
    expect(firstVote).toMatchObject({
      revision: ended.revision + 1,
      matchNumber: 1,
      phase: "finished",
      rematchVotes: { white: true, black: false },
      gameView: ended.gameView,
    });
    const repeatedVote = registry.voteRematch(white.credentials.sessionToken, { revision: firstVote.revision });
    expect(repeatedVote).toMatchObject({
      revision: firstVote.revision,
      matchNumber: 1,
      phase: "finished",
      rematchVotes: { white: true, black: false },
    });
    expectRegistryError(() => registry.voteRematch(spectator.credentials.sessionToken, {
      revision: firstVote.revision,
    }), "not-your-turn");

    const nextMatch = registry.voteRematch(black.credentials.sessionToken, { revision: firstVote.revision });
    expect(nextMatch).toMatchObject({
      revision: firstVote.revision + 1,
      matchNumber: 2,
      phase: "playing",
      viewerSide: "white",
      spectatorCount: 1,
      rematchVotes: { white: false, black: false },
      drawOffer: null,
      players: {
        white: { name: "Black Player", side: "white", connected: true },
        black: { name: "White Player", side: "black", connected: true },
      },
      gameView: { turn: "white", history: [], result: null },
      clock: { whiteMs: 600_000, blackMs: 600_000, activeSide: "white", running: true },
    });
    expect(nextMatch.gameView.position).toEqual(white.snapshot.gameView.position);
    const whiteAfterSwap = registry.snapshotForSession(white.credentials.sessionToken);
    const spectatorAfterSwap = registry.snapshotForSession(spectator.credentials.sessionToken);
    expect(whiteAfterSwap.viewerSide).toBe("black");
    expect(spectatorAfterSwap).toMatchObject({
      revision: nextMatch.revision,
      matchNumber: 2,
      viewerSide: null,
      spectatorCount: 1,
      phase: "playing",
    });
    expect(whiteAfterSwap.gameView).toEqual(nextMatch.gameView);
    expect(spectatorAfterSwap.gameView).toEqual(nextMatch.gameView);

    expectMoveErrorAndPreserve(registry, black.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
      spectator.credentials.sessionToken,
    ], {
      revision: ended.revision,
      from: oldOpeningMove.from,
      path: [...oldOpeningMove.path],
    }, "stale-revision");
    expectRegistryError(() => registry.voteRematch(black.credentials.sessionToken, {
      revision: nextMatch.revision,
    }), "conflict");
    expect(registry.snapshotForSession(black.credentials.sessionToken).matchNumber).toBe(2);
  });

  it("clears rematch consent on disconnect and requires that player to vote again after recovery", () => {
    const registry = makeRegistry({ generateRoomCode: () => "RECD23" });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const ended = registry.resign(white.credentials.sessionToken, { revision: black.snapshot.revision });
    const blackVote = registry.voteRematch(black.credentials.sessionToken, { revision: ended.revision });
    expect(blackVote.rematchVotes).toEqual({ white: false, black: true });

    registry.disconnectSession(black.credentials.sessionToken);
    const afterDisconnect = registry.snapshotForSession(white.credentials.sessionToken);
    expect(afterDisconnect).toMatchObject({
      matchNumber: 1,
      phase: "finished",
      rematchVotes: { white: false, black: false },
      players: { black: { connected: false } },
    });
    const whiteVote = registry.voteRematch(white.credentials.sessionToken, { revision: afterDisconnect.revision });
    expect(whiteVote).toMatchObject({
      matchNumber: 1,
      phase: "finished",
      rematchVotes: { white: true, black: false },
    });

    const recoveredBlack = registry.resumeRoom({ code: white.code, sessionToken: black.credentials.sessionToken });
    expect(recoveredBlack.snapshot).toMatchObject({
      matchNumber: 1,
      phase: "finished",
      rematchVotes: { white: true, black: false },
      viewerSide: "black",
    });
    const blackVotesAgain = registry.voteRematch(black.credentials.sessionToken, {
      revision: recoveredBlack.snapshot.revision,
    });
    expect(blackVotesAgain).toMatchObject({ matchNumber: 2, phase: "playing", rematchVotes: { white: false, black: false } });
  });

  it("clears departed-player rematch votes and requires both seats to be filled again", () => {
    const registry = makeRegistry({ generateRoomCode: () => "RELV23" });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const ended = registry.resign(white.credentials.sessionToken, { revision: black.snapshot.revision });
    const blackVote = registry.voteRematch(black.credentials.sessionToken, { revision: ended.revision });
    expect(blackVote.rematchVotes).toEqual({ white: false, black: true });

    const leave = registry.leaveRoom(black.credentials.sessionToken);
    expect(leave.roomClosed).toBe(false);
    const afterDeparture = registry.snapshotForSession(white.credentials.sessionToken);
    expect(afterDeparture).toMatchObject({
      phase: "finished",
      rematchVotes: { white: false, black: false },
      players: { black: null },
    });
    expectRegistryError(() => registry.voteRematch(white.credentials.sessionToken, {
      revision: afterDeparture.revision,
    }), "conflict");

    const replacement = registry.joinRoom(joinInput(white.code, "Replacement"));
    expect(replacement.snapshot).toMatchObject({
      phase: "finished",
      matchNumber: 1,
      rematchVotes: { white: false, black: false },
      players: { black: { name: "Replacement", side: "black" } },
    });
    const replacementVote = registry.voteRematch(replacement.credentials.sessionToken, {
      revision: replacement.snapshot.revision,
    });
    expect(replacementVote).toMatchObject({ phase: "finished", matchNumber: 1, rematchVotes: { white: false, black: true } });
    const bothAgree = registry.voteRematch(white.credentials.sessionToken, { revision: replacementVote.revision });
    expect(bothAgree).toMatchObject({ phase: "playing", matchNumber: 2, rematchVotes: { white: false, black: false } });
  });

  it("derives timed move clocks from server time and the room preset", () => {
    let now = 10_000;
    const registry = makeRegistry({
      generateRoomCode: () => "TICK23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const legalMove = black.snapshot.gameView.legalMoves[0];
    if (legalMove === undefined) throw new Error("Fresh match must have a legal move.");
    now += 2_500;

    const moved = registry.move(white.credentials.sessionToken, {
      revision: black.snapshot.revision,
      from: legalMove.from,
      path: [...legalMove.path],
    });
    expect(moved.clock).toEqual({
      whiteMs: 602_500,
      blackMs: 600_000,
      activeSide: "black",
      running: true,
    });
  });

  it("rejects wrong-turn, stale, and client-supplied authority without changing the room", () => {
    const registry = makeRegistry({ generateRoomCode: () => "AUTH23" });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const legal = black.snapshot.gameView.legalMoves[0];
    if (legal === undefined) throw new Error("Fresh match must have a legal move.");
    const currentRequest = { revision: black.snapshot.revision, from: legal.from, path: [...legal.path] };

    expectMoveErrorAndPreserve(registry, black.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
    ], currentRequest, "not-your-turn");
    expectMoveErrorAndPreserve(registry, white.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
    ], { ...currentRequest, revision: 0 }, "stale-revision");

    for (const forbiddenAuthority of ["board", "captured", "promotion", "result", "clock"]) {
      expectMoveErrorAndPreserve(registry, white.credentials.sessionToken, [
        white.credentials.sessionToken,
        black.credentials.sessionToken,
      ], { ...currentRequest, [forbiddenAuthority]: {} }, "invalid-input");
    }
  });

  it("requires the full canonical forced-capture path", () => {
    const position: CheckersPosition = {
      "2|0": "w",
      "2|4": "w",
      "1|7": "w",
      "3|0": "b",
      "3|4": "b",
      "5|4": "b",
    };
    const registry = makeRegistry({
      generateRoomCode: () => "CAPT23",
      createMatch: () => createMatch(position),
    });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const forced = white.snapshot.gameView.legalMoves[0];
    if (forced === undefined) throw new Error("Capture fixture must have a legal move.");
    expect(forced.path).toEqual(["4|4", "6|4"]);
    const request = { revision: black.snapshot.revision, from: forced.from, path: [...forced.path] };

    expectMoveErrorAndPreserve(registry, white.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
    ], { ...request, path: request.path.slice(0, 1) }, "invalid-move",
    "That move is no longer legal. Choose a current legal move and try again.");

    const moved = registry.move(white.credentials.sessionToken, request);
    expect(moved.revision).toBe(black.snapshot.revision + 1);
    expect(moved.gameView.history).toHaveLength(1);
    expect(moved.gameView.history[0]).toMatchObject({ from: "2|4", path: ["4|4", "6|4"], captured: ["3|4", "5|4"] });
    expect(Object.values(moved.gameView.position).filter((piece) => piece.toLowerCase() === "b")).toHaveLength(1);
  });

  it("rejects moves while waiting and after a terminal match without changing state", () => {
    const waitingRegistry = makeRegistry({ generateRoomCode: () => "WAIT23" });
    const waiting = waitingRegistry.createRoom(createInput("White"));
    const waitingMove = waiting.snapshot.gameView.legalMoves[0];
    if (waitingMove === undefined) throw new Error("Fresh match must have a legal move.");
    expectRegistryError(() => waitingRegistry.resign(waiting.credentials.sessionToken, { revision: waiting.snapshot.revision }), "conflict");
    expectMoveErrorAndPreserve(waitingRegistry, waiting.credentials.sessionToken, [waiting.credentials.sessionToken], {
      revision: waiting.snapshot.revision,
      from: waitingMove.from,
      path: [...waitingMove.path],
    }, "conflict");

    const terminalPosition: CheckersPosition = {
      "7|0": "w", "7|1": "w", "7|2": "w", "7|3": "w",
      "7|4": "w", "7|5": "w", "7|6": "w", "7|7": "w",
      "0|0": "b", "0|7": "b",
    };
    const terminalRegistry = makeRegistry({
      generateRoomCode: () => "DONE23",
      createMatch: () => createMatch(terminalPosition),
    });
    const terminalWhite = terminalRegistry.createRoom(createInput("White"));
    const terminalBlack = terminalRegistry.joinRoom(joinInput(terminalWhite.code, "Black"));
    expect(terminalBlack.snapshot.phase).toBe("finished");
    expect(terminalBlack.snapshot.gameView.result).not.toBeNull();
    expectRegistryError(() => terminalRegistry.resign(terminalWhite.credentials.sessionToken, {
      revision: terminalBlack.snapshot.revision,
    }), "game-finished");
    expectMoveErrorAndPreserve(terminalRegistry, terminalWhite.credentials.sessionToken, [
      terminalWhite.credentials.sessionToken,
      terminalBlack.credentials.sessionToken,
    ], { revision: terminalBlack.snapshot.revision, from: "0|0", path: ["0|1"] }, "game-finished");
  });

  it("falls back to spectating rather than displacing players in a full room", () => {
    const registry = makeRegistry({ generateRoomCode: () => "FULL23" });
    const white = registry.createRoom(createInput("White", "white"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const spectator = registry.joinRoom(joinInput(white.code, "Extra Player", "player"));

    expect(spectator.snapshot.phase).toBe("playing");
    expect(spectator.snapshot.viewerSide).toBeNull();
    expect(spectator.snapshot.spectatorCount).toBe(1);
    expect(spectator.snapshot.players.white?.name).toBe("White");
    expect(spectator.snapshot.players.black?.name).toBe("Black");
    expect(registry.snapshotForSession(white.credentials.sessionToken).players.black?.name).toBe("Black");
    expect(registry.snapshotForSession(black.credentials.sessionToken).players.white?.name).toBe("White");
  });

  it("treats deliberate active leave as an immediate disconnection result and releases waiting seats without recovery", () => {
    const registry = makeRegistry({ generateRoomCode: () => "LEAVE3" });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const activeRevision = black.snapshot.revision;

    const activeLeave = registry.leaveRoom(white.credentials.sessionToken);
    const afterActiveLeave = registry.snapshotForSession(black.credentials.sessionToken);
    expect(activeLeave).toMatchObject({ left: true, roomClosed: false });
    expect(afterActiveLeave).toMatchObject({
      phase: "finished",
      revision: activeRevision + 1,
      players: { white: null, black: { name: "Black", connected: true } },
      rematchVotes: { white: false, black: false },
      gameView: { result: { state: "won", winner: "black", reason: "disconnection" } },
    });
    expect(registry.sessionCount).toBe(1);
    expectRegistryError(() => registry.resumeRoom({
      code: white.code,
      sessionToken: white.credentials.sessionToken,
    }), "unauthorized");

    const replacement = registry.joinRoom(joinInput(white.code, "Replacement"));
    expect(replacement.snapshot).toMatchObject({
      phase: "finished",
      matchNumber: 1,
      players: { white: { name: "Replacement", connected: true } },
    });

    const waitingRegistry = makeRegistry({ generateRoomCode: () => "WAITLV" });
    const waitingPlayer = waitingRegistry.createRoom(createInput("Waiting"));
    expect(waitingRegistry.leaveRoom(waitingPlayer.credentials.sessionToken)).toMatchObject({
      left: true,
      roomClosed: true,
    });
    expect(waitingRegistry.roomCount).toBe(0);
    expect(waitingRegistry.sessionCount).toBe(0);
  });

  it("preserves a clock timeout that settles before a deliberate leave", () => {
    let now = 5_000;
    const registry = makeRegistry({
      generateRoomCode: () => "LEAVE4",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const openingMove = black.snapshot.gameView.legalMoves[0];
    if (openingMove === undefined) throw new Error("The match must provide an opening move.");
    registry.move(white.credentials.sessionToken, {
      revision: black.snapshot.revision,
      from: openingMove.from,
      path: [...openingMove.path],
    });

    now += TIME_CONTROL_PRESETS.rapid.initialMs;
    registry.leaveRoom(white.credentials.sessionToken);
    const afterTimeoutAndLeave = registry.snapshotForSession(black.credentials.sessionToken);
    expect(afterTimeoutAndLeave).toMatchObject({
      phase: "finished",
      players: { white: null },
      gameView: { result: { state: "won", winner: "white", reason: "timeout" } },
    });
  });

  it("reserves waiting-room seats for the authenticated session until grace expiry", () => {
    let now = 50_000;
    const registry = makeRegistry({
      generateRoomCode: () => "RESV23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white"));
    expect(DEFAULT_RECOVERY_GRACE_MS).toBe(120_000);
    registry.disconnectSession(white.credentials.sessionToken);
    const disconnected = registry.snapshotForSession(white.credentials.sessionToken);
    expect(disconnected).toMatchObject({
      phase: "waiting",
      players: { white: { name: "White", connected: false, recoveryDeadlineMs: now + 120_000 } },
    });

    now += DEFAULT_RECOVERY_GRACE_MS - 1;
    expect(registry.advanceClocks()).toEqual([]);
    const duringGrace = registry.joinRoom(joinInput(white.code, "White", "player"));
    expect(duringGrace.snapshot.viewerSide).toBeNull();
    expect(duringGrace.snapshot.phase).toBe("waiting");
    expect(duringGrace.snapshot.players.white).toMatchObject({ name: "White", connected: false });
    expect(duringGrace.snapshot.players.black).toBeNull();
    expect(duringGrace.snapshot.spectatorCount).toBe(1);

    const restored = registry.resumeRoom({ code: white.code, sessionToken: white.credentials.sessionToken });
    expect(restored.snapshot.viewerSide).toBe("white");
    expect(restored.snapshot.players.white).toMatchObject({ name: "White", connected: true, recoveryDeadlineMs: null });

    registry.disconnectSession(white.credentials.sessionToken);
    now += DEFAULT_RECOVERY_GRACE_MS;
    const expiryUpdates = registry.advanceClocks();
    expect(expiryUpdates).toHaveLength(1);
    const waitingAfterExpiry = expiryUpdates[0]?.snapshots.find((snapshot) => snapshot.viewerSide === null);
    expect(waitingAfterExpiry).toMatchObject({
      phase: "waiting",
      players: { white: null, black: null },
      spectatorCount: 1,
    });
    expectRegistryError(
      () => registry.resumeRoom({ code: white.code, sessionToken: white.credentials.sessionToken }),
      "unauthorized",
    );
    const replacement = registry.joinRoom(joinInput(white.code, "Replacement"));
    expect(replacement.snapshot.viewerSide).toBe("white");
    expect(replacement.snapshot.players.white?.name).toBe("Replacement");
    expect(replacement.snapshot.spectatorCount).toBe(1);
    expect(replacement.snapshot.phase).toBe("waiting");
  });

  it("removes a disconnected spectator without changing the match", () => {
    const registry = makeRegistry({ generateRoomCode: () => "SPECD2" });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const spectator = registry.joinRoom(joinInput(white.code, "Viewer", "spectator"));
    const before = registry.snapshotForSession(white.credentials.sessionToken);

    registry.disconnectSession(spectator.credentials.sessionToken);

    const after = registry.snapshotForSession(white.credentials.sessionToken);
    expect(after).toMatchObject({
      revision: before.revision + 1,
      matchNumber: before.matchNumber,
      phase: "playing",
      spectatorCount: 0,
      players: { white: { connected: true }, black: { connected: true } },
    });
    expect(after.gameView).toEqual(before.gameView);
    expect(after.clock).toEqual(before.clock);
    expectRegistryError(() => registry.snapshotForSession(spectator.credentials.sessionToken), "unauthorized");
    expect(registry.snapshotForSession(black.credentials.sessionToken).spectatorCount).toBe(0);
  });

  it("releases a deliberately departing spectator and recovers session and spectator capacity", () => {
    const registry = makeRegistry({
      generateRoomCode: () => "SPLEAV",
      limits: { sessions: 3, spectatorsPerRoom: 1 },
    });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const viewer = registry.joinRoom(joinInput(white.code, "Viewer", "spectator"));
    const beforeLeave = registry.snapshotForSession(black.credentials.sessionToken);

    expectRegistryError(
      () => registry.joinRoom(joinInput(white.code, "Extra viewer", "spectator")),
      "session-capacity",
    );
    expect(registry.leaveRoom(viewer.credentials.sessionToken)).toEqual({
      left: true,
      roomCode: white.code,
      roomClosed: false,
    });
    expect(registry.sessionCount).toBe(2);
    expectRegistryError(() => registry.snapshotForSession(viewer.credentials.sessionToken), "unauthorized");
    expect(registry.snapshotForSession(black.credentials.sessionToken)).toMatchObject({
      revision: beforeLeave.revision + 1,
      phase: "playing",
      matchNumber: beforeLeave.matchNumber,
      spectatorCount: 0,
      gameView: beforeLeave.gameView,
      clock: beforeLeave.clock,
    });

    const nextViewer = registry.joinRoom(joinInput(white.code, "Next viewer", "spectator"));
    expect(nextViewer.snapshot).toMatchObject({
      phase: "playing",
      viewerSide: null,
      spectatorCount: 1,
      gameView: beforeLeave.gameView,
    });
    expect(registry.sessionCount).toBe(3);
  });

  it("awards an active match when one player's recovery grace expires", () => {
    let now = 20_000;
    const registry = makeRegistry({
      generateRoomCode: () => "GRAC23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    registry.disconnectSession(white.credentials.sessionToken);

    now += DEFAULT_RECOVERY_GRACE_MS - 1;
    expect(registry.advanceClocks()).toEqual([]);
    expect(registry.snapshotForSession(black.credentials.sessionToken)).toMatchObject({
      phase: "playing",
      players: { white: { connected: false, recoveryDeadlineMs: now + 1 } },
      clock: { whiteMs: 480_001, activeSide: "white", running: true },
    });

    now += 1;
    const [update] = registry.advanceClocks();
    expect(update?.snapshots).toHaveLength(1);
    expect(update?.snapshots[0]).toMatchObject({
      revision: black.snapshot.revision + 2,
      phase: "finished",
      players: { white: null, black: { name: "Black", connected: true } },
      gameView: { result: { state: "won", winner: "black", reason: "disconnection" } },
      clock: { whiteMs: 480_000, blackMs: 600_000, activeSide: null, running: false },
    });
    expectRegistryError(() => registry.resumeRoom({ code: white.code, sessionToken: white.credentials.sessionToken }), "unauthorized");
  });

  it("expires a reconnect attempted exactly at the grace deadline and publishes the forfeiture once", () => {
    let now = 80_000;
    const registry = makeRegistry({
      generateRoomCode: () => "GRACE7",
      now: () => now,
      recoveryGraceMs: 10,
    });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    registry.disconnectSession(white.credentials.sessionToken);
    const beforeDeadline = registry.snapshotForSession(black.credentials.sessionToken);
    expect(beforeDeadline.players.white).toMatchObject({ connected: false, recoveryDeadlineMs: now + 10 });

    now += 10;
    expectRegistryError(() => registry.resumeRoom({
      code: white.code,
      sessionToken: white.credentials.sessionToken,
    }), "unauthorized", "The reconnect identity has expired.");

    expect(registry.sessionCount).toBe(1);
    const [expiryUpdate] = registry.advanceClocks();
    expect(expiryUpdate?.snapshots).toHaveLength(1);
    expect(expiryUpdate?.snapshots[0]).toMatchObject({
      revision: beforeDeadline.revision + 1,
      phase: "finished",
      matchNumber: 1,
      players: { white: null, black: { name: "Black", connected: true } },
      gameView: { result: { state: "won", winner: "black", reason: "disconnection" } },
    });
    expect(registry.advanceClocks()).toEqual([]);

    const replacement = registry.joinRoom(joinInput(white.code, "Replacement"));
    expect(replacement.snapshot).toMatchObject({
      phase: "finished",
      matchNumber: 1,
      players: { white: { name: "Replacement" }, black: { name: "Black" } },
      gameView: { result: { state: "won", winner: "black", reason: "disconnection" } },
    });
  });

  it("draws when both active players disconnect at the same recovery boundary", () => {
    let now = 30_000;
    const registry = makeRegistry({ generateRoomCode: () => "BOTH23", now: () => now });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const spectator = registry.joinRoom(joinInput(white.code, "Viewer", "spectator"));
    registry.disconnectSession(white.credentials.sessionToken);
    registry.disconnectSession(black.credentials.sessionToken);

    now += DEFAULT_RECOVERY_GRACE_MS;
    const updates = registry.advanceClocks();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.snapshots).toHaveLength(1);
    expect(updates[0]?.snapshots[0]).toMatchObject({
      phase: "finished",
      players: { white: null, black: null },
      spectatorCount: 1,
      gameView: { result: { state: "draw", reason: "mutual-disconnection" } },
    });
    expect(registry.snapshotForSession(spectator.credentials.sessionToken).gameView.result)
      .toEqual({ state: "draw", reason: "mutual-disconnection" });
  });

  it("settles timeout before grace expiry and never overwrites an earlier result", () => {
    let lateMaintenanceNow = 35_000;
    const graceFirstRegistry = makeRegistry({
      generateRoomCode: () => "GRAC24",
      now: () => lateMaintenanceNow,
    });
    const graceFirstWhite = graceFirstRegistry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const graceFirstBlack = graceFirstRegistry.joinRoom(joinInput(graceFirstWhite.code, "Black"));
    const graceFirstSpectator = graceFirstRegistry.joinRoom(joinInput(graceFirstWhite.code, "Viewer", "spectator"));
    graceFirstRegistry.disconnectSession(graceFirstWhite.credentials.sessionToken);
    lateMaintenanceNow += TIME_CONTROL_PRESETS.rapid.initialMs;
    const [graceFirstUpdate] = graceFirstRegistry.advanceClocks();
    expect(graceFirstUpdate?.snapshots.find((snapshot) => snapshot.viewerSide === null)).toMatchObject({
      phase: "finished",
      gameView: { result: { state: "won", winner: "black", reason: "disconnection" } },
      clock: { whiteMs: 480_000, activeSide: null, running: false },
    });
    expect(graceFirstRegistry.snapshotForSession(graceFirstBlack.credentials.sessionToken).gameView.result)
      .toEqual({ state: "won", winner: "black", reason: "disconnection" });
    expect(graceFirstRegistry.snapshotForSession(graceFirstSpectator.credentials.sessionToken).phase).toBe("finished");

    let now = 40_000;
    const tiedRegistry = makeRegistry({
      generateRoomCode: () => "TIE223",
      now: () => now,
      recoveryGraceMs: TIME_CONTROL_PRESETS.blitz.initialMs,
    });
    const tiedWhite = tiedRegistry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.blitz));
    const tiedBlack = tiedRegistry.joinRoom(joinInput(tiedWhite.code, "Black"));
    const tiedSpectator = tiedRegistry.joinRoom(joinInput(tiedWhite.code, "Viewer", "spectator"));
    tiedRegistry.disconnectSession(tiedWhite.credentials.sessionToken);
    now += TIME_CONTROL_PRESETS.blitz.initialMs;
    const [tieUpdate] = tiedRegistry.advanceClocks();
    expect(tieUpdate?.snapshots.find((snapshot) => snapshot.viewerSide === null)).toMatchObject({
      phase: "finished",
      players: { white: null },
      gameView: { result: { state: "won", winner: "black", reason: "timeout" } },
    });

    let timeoutFirstNow = 45_000;
    const timeoutFirstRegistry = makeRegistry({
      generateRoomCode: () => "TOUT23",
      now: () => timeoutFirstNow,
      recoveryGraceMs: TIME_CONTROL_PRESETS.blitz.initialMs + 1,
    });
    const timeoutFirstWhite = timeoutFirstRegistry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.blitz));
    const timeoutFirstBlack = timeoutFirstRegistry.joinRoom(joinInput(timeoutFirstWhite.code, "Black"));
    const timeoutFirstSpectator = timeoutFirstRegistry.joinRoom(joinInput(timeoutFirstWhite.code, "Viewer", "spectator"));
    timeoutFirstRegistry.disconnectSession(timeoutFirstWhite.credentials.sessionToken);
    timeoutFirstNow += TIME_CONTROL_PRESETS.blitz.initialMs + 1;
    const [timeoutFirstUpdate] = timeoutFirstRegistry.advanceClocks();
    expect(timeoutFirstUpdate?.snapshots.find((snapshot) => snapshot.viewerSide === null)).toMatchObject({
      phase: "finished",
      players: { white: null },
      gameView: { result: { state: "won", winner: "black", reason: "timeout" } },
    });
    expect(timeoutFirstRegistry.snapshotForSession(timeoutFirstBlack.credentials.sessionToken).gameView.result)
      .toEqual({ state: "won", winner: "black", reason: "timeout" });
    expect(timeoutFirstRegistry.snapshotForSession(timeoutFirstSpectator.credentials.sessionToken).phase).toBe("finished");

    now = 50_000;
    const resignedRegistry = makeRegistry({
      generateRoomCode: () => "OTHR23",
      now: () => now,
    });
    const resignedWhite = resignedRegistry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const resignedBlack = resignedRegistry.joinRoom(joinInput(resignedWhite.code, "Black"));
    const resignedSpectator = resignedRegistry.joinRoom(joinInput(resignedWhite.code, "Viewer", "spectator"));
    resignedRegistry.disconnectSession(resignedWhite.credentials.sessionToken);
    const resigned = resignedRegistry.resign(resignedBlack.credentials.sessionToken, {
      revision: resignedSpectator.snapshot.revision + 1,
    });
    now += DEFAULT_RECOVERY_GRACE_MS;
    const [resignationUpdate] = resignedRegistry.advanceClocks();
    expect(resignationUpdate?.snapshots.find((snapshot) => snapshot.viewerSide === null)).toMatchObject({
      phase: "finished",
      players: { white: null },
      gameView: resigned.gameView,
    });
    expect(resignationUpdate?.snapshots.find((snapshot) => snapshot.viewerSide === null)?.gameView.result)
      .toEqual({ state: "won", winner: "white", reason: "resignation" });
    expect(tiedRegistry.snapshotForSession(tiedBlack.credentials.sessionToken).gameView.result)
      .toEqual({ state: "won", winner: "black", reason: "timeout" });
    expect(tiedRegistry.snapshotForSession(tiedSpectator.credentials.sessionToken).phase).toBe("finished");
  });

  it("projects coherent per-viewer snapshots without leaking secrets or mutable state", () => {
    const now = 75_000;
    const registry = makeRegistry({
      generateRoomCode: () => "VIEWS2",
      now: () => now,
    });
    const whiteAccess = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const blackAccess = registry.joinRoom(joinInput(whiteAccess.code, "Black"));
    const spectatorAccess = registry.joinRoom(joinInput(whiteAccess.code, "Viewer", "spectator"));
    registry.disconnectSession(blackAccess.credentials.sessionToken);

    const whiteSnapshot = registry.snapshotForSession(whiteAccess.credentials.sessionToken);
    const blackSnapshot = registry.snapshotForSession(blackAccess.credentials.sessionToken);
    const spectatorSnapshot = registry.snapshotForSession(spectatorAccess.credentials.sessionToken);
    expect(whiteSnapshot.viewerSide).toBe("white");
    expect(blackSnapshot.viewerSide).toBe("black");
    expect(spectatorSnapshot.viewerSide).toBeNull();
    expect(whiteSnapshot.players.black).toMatchObject({
      name: "Black",
      side: "black",
      connected: false,
      recoveryDeadlineMs: now + DEFAULT_RECOVERY_GRACE_MS,
    });
    expect(whiteSnapshot.spectatorCount).toBe(1);
    expect(RoomSnapshotSchema.parse(whiteSnapshot)).toEqual(whiteSnapshot);

    for (const snapshot of [blackSnapshot, spectatorSnapshot]) {
      expect(snapshot.revision).toBe(whiteSnapshot.revision);
      expect(snapshot.matchNumber).toBe(whiteSnapshot.matchNumber);
      expect(snapshot.phase).toBe(whiteSnapshot.phase);
      expect(snapshot.gameView).toEqual(whiteSnapshot.gameView);
      expect(snapshot.players).toEqual(whiteSnapshot.players);
      expect(snapshot.clock).toEqual(whiteSnapshot.clock);
      expect(snapshot.serverNow).toBe(whiteSnapshot.serverNow);
    }

    const expectedSnapshotKeys = [
      "revision",
      "matchNumber",
      "phase",
      "gameView",
      "players",
      "viewerSide",
      "spectatorCount",
      "timeControl",
      "clock",
      "serverNow",
      "drawOffer",
      "rematchVotes",
    ].sort();
    expect(Object.keys(whiteSnapshot).sort()).toEqual(expectedSnapshotKeys);
    const serializedSnapshots = [
      whiteAccess.snapshot,
      blackAccess.snapshot,
      spectatorAccess.snapshot,
      whiteSnapshot,
      blackSnapshot,
      spectatorSnapshot,
    ].map((snapshot) => JSON.stringify(snapshot));
    for (const secretToken of [
      whiteAccess.credentials.sessionToken,
      blackAccess.credentials.sessionToken,
      spectatorAccess.credentials.sessionToken,
    ]) {
      expect(serializedSnapshots.every((serialized) => !serialized.includes(secretToken))).toBe(true);
    }

    const mutableWhitePlayer = whiteSnapshot.players.white;
    const mutableLegalMove = whiteSnapshot.gameView.legalMoves[0];
    if (mutableWhitePlayer === null || mutableLegalMove === undefined) {
      throw new Error("The snapshot fixture must include a player and legal moves.");
    }
    mutableWhitePlayer.name = "Mutated outside the registry";
    whiteSnapshot.gameView.position["1|0"] = "B";
    mutableLegalMove.path[0] = "7|7";
    whiteSnapshot.clock.whiteMs = 1;
    whiteSnapshot.rematchVotes.white = true;

    const isolatedAgain = registry.snapshotForSession(whiteAccess.credentials.sessionToken);
    expect(isolatedAgain.players.white?.name).toBe("White");
    expect(isolatedAgain.gameView.position["1|0"]).toBe("w");
    expect(isolatedAgain.gameView.legalMoves[0]?.path[0]).not.toBe("7|7");
    expect(isolatedAgain.clock.whiteMs).toBe(600_000);
    expect(isolatedAgain.rematchVotes.white).toBe(false);
  });

  it.each([
    ["rapid", TIME_CONTROL_PRESETS.rapid, 600_000],
    ["blitz", TIME_CONTROL_PRESETS.blitz, 300_000],
  ] as const)("starts the %s clock only when both seats are ready and anchors reads", (_kind, preset, initialMs) => {
    let now = 10_000;
    const registry = makeRegistry({
      generateRoomCode: () => "CLOCK2",
      now: () => now,
    });
    const creator = registry.createRoom(createInput("White", "white", preset));
    expect(creator.snapshot.clock).toEqual({
      whiteMs: initialMs,
      blackMs: initialMs,
      activeSide: null,
      running: false,
    });

    now += 5_000;
    const stillWaiting = registry.snapshotForSession(creator.credentials.sessionToken);
    expect(stillWaiting.clock).toEqual(creator.snapshot.clock);
    expect(stillWaiting.serverNow).toBe(now);

    const joiner = registry.joinRoom(joinInput(creator.code, "Black"));
    expect(joiner.snapshot.clock).toEqual({
      whiteMs: initialMs,
      blackMs: initialMs,
      activeSide: "white",
      running: true,
    });
    expect(joiner.snapshot.serverNow).toBe(now);

    now += 2_500;
    const firstRead = registry.snapshotForSession(creator.credentials.sessionToken);
    const secondRead = registry.snapshotForSession(creator.credentials.sessionToken);
    expect(firstRead.clock).toEqual({
      whiteMs: initialMs - 2_500,
      blackMs: initialMs,
      activeSide: "white",
      running: true,
    });
    expect(firstRead.serverNow).toBe(now);
    expect(secondRead).toEqual(firstRead);
  });

  it("keeps untimed clocks null and does not start or advance them", () => {
    let now = 20_000;
    const registry = makeRegistry({
      generateRoomCode: () => "UNTIME",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    expect(black.snapshot.clock).toEqual({ whiteMs: null, blackMs: null, activeSide: null, running: false });

    now += 10_000_000;
    expect(registry.advanceClocks()).toEqual([]);
    expect(registry.snapshotForSession(white.credentials.sessionToken)).toMatchObject({
      phase: "playing",
      clock: { whiteMs: null, blackMs: null, activeSide: null, running: false },
      serverNow: now,
    });
  });

  it.each([
    ["rapid", TIME_CONTROL_PRESETS.rapid, 600_000, 5_000],
    ["blitz", TIME_CONTROL_PRESETS.blitz, 300_000, 3_000],
  ] as const)("charges elapsed %s time and grants its increment only after an accepted move", (_kind, preset, initialMs, incrementMs) => {
    let now = 10_000;
    const registry = makeRegistry({
      generateRoomCode: () => "TICK23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", preset));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const legalMove = black.snapshot.gameView.legalMoves[0];
    if (legalMove === undefined) throw new Error("Fresh match must have a legal move.");
    now += 2_500;

    const moved = registry.move(white.credentials.sessionToken, {
      revision: black.snapshot.revision,
      from: legalMove.from,
      path: [...legalMove.path],
    });
    expect(moved.clock).toEqual({
      whiteMs: initialMs - 2_500 + incrementMs,
      blackMs: initialMs,
      activeSide: "black",
      running: true,
    });
    expect(moved.serverNow).toBe(now);
  });

  it("does not reset or increment time for stale or invalid moves", () => {
    let now = 10_000;
    const registry = makeRegistry({
      generateRoomCode: () => "STALE2",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const legalMove = black.snapshot.gameView.legalMoves[0];
    if (legalMove === undefined) throw new Error("Fresh match must have a legal move.");
    const current = { revision: black.snapshot.revision, from: legalMove.from, path: [...legalMove.path] };

    now += 1_000;
    expectMoveErrorAndPreserve(registry, white.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
    ], { ...current, revision: 0 }, "stale-revision");
    expectMoveErrorAndPreserve(registry, white.credentials.sessionToken, [
      white.credentials.sessionToken,
      black.credentials.sessionToken,
    ], { ...current, path: ["7|7"] }, "invalid-move");

    now += 1_000;
    const moved = registry.move(white.credentials.sessionToken, current);
    expect(moved.clock.whiteMs).toBe(603_000);
    expect(moved.clock.activeSide).toBe("black");
  });

  it("settles an exact timeout without a move and stops all later clock progression", () => {
    let now = 10_000;
    const registry = makeRegistry({
      generateRoomCode: () => "TIME23",
      now: () => now,
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));

    now += 599_999;
    expect(registry.advanceClocks()).toEqual([]);
    expect(registry.snapshotForSession(white.credentials.sessionToken).clock.whiteMs).toBe(1);
    now += 1;

    const updates = registry.advanceClocks();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.roomCode).toBe(white.code);
    expect(updates[0]?.snapshots).toHaveLength(2);
    expect(updates[0]?.snapshots.map((snapshot) => snapshot.viewerSide).sort()).toEqual(["black", "white"]);
    for (const snapshot of updates[0]?.snapshots ?? []) {
      expect(snapshot).toMatchObject({
        revision: black.snapshot.revision + 1,
        phase: "finished",
        drawOffer: null,
        rematchVotes: { white: false, black: false },
        serverNow: now,
        gameView: { legalMoves: [], result: { state: "won", winner: "black", reason: "timeout" } },
        clock: { whiteMs: 0, blackMs: 600_000, activeSide: null, running: false },
      });
    }

    now += 50_000;
    expect(registry.advanceClocks()).toEqual([]);
    expect(registry.snapshotForSession(black.credentials.sessionToken).clock).toEqual({
      whiteMs: 0,
      blackMs: 600_000,
      activeSide: null,
      running: false,
    });
  });

  it("declares timeout before a legal move at the boundary and queues terminal snapshots", () => {
    let now = 10_000;
    const registry = makeRegistry({ generateRoomCode: () => "EDGE23", now: () => now });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.blitz));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const legalMove = black.snapshot.gameView.legalMoves[0];
    if (legalMove === undefined) throw new Error("Fresh match must have a legal move.");
    now += 300_000;

    expectRegistryError(() => registry.move(white.credentials.sessionToken, {
      revision: black.snapshot.revision,
      from: legalMove.from,
      path: [...legalMove.path],
    }), "game-finished");
    const timedOut = registry.snapshotForSession(white.credentials.sessionToken);
    expect(timedOut).toMatchObject({
      phase: "finished",
      revision: black.snapshot.revision + 1,
      gameView: { history: [], result: { state: "won", winner: "black", reason: "timeout" } },
      clock: { whiteMs: 0, blackMs: 300_000, activeSide: null, running: false },
      serverNow: now,
    });
    expect(registry.advanceClocks()).toHaveLength(1);
    expect(registry.advanceClocks()).toEqual([]);
  });

  it("stops timed clocks when a legal move ends the match naturally", () => {
    let now = 10_000;
    const terminalMovePosition: CheckersPosition = { "2|4": "w", "3|4": "b", "0|0": "b" };
    const registry = makeRegistry({
      generateRoomCode: () => "NATU23",
      now: () => now,
      createMatch: () => createMatch(terminalMovePosition),
    });
    const white = registry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    expect(black.snapshot.phase).toBe("playing");
    const capture = black.snapshot.gameView.legalMoves[0];
    if (capture === undefined) throw new Error("Terminal-move fixture must have a legal capture.");
    now += 1_000;

    const ended = registry.move(white.credentials.sessionToken, {
      revision: black.snapshot.revision,
      from: capture.from,
      path: [...capture.path],
    });
    expect(ended).toMatchObject({
      phase: "finished",
      drawOffer: null,
      rematchVotes: { white: false, black: false },
      gameView: { legalMoves: [], result: { state: "draw", reason: "one-piece-each" } },
      clock: { whiteMs: 604_000, blackMs: 600_000, activeSide: null, running: false },
    });

    now += 100_000;
    expect(registry.advanceClocks()).toEqual([]);
    expect(registry.snapshotForSession(black.credentials.sessionToken).clock).toEqual(ended.clock);
  });

  it("keeps disconnected players' clocks running and never starts a finished match clock", () => {
    let now = 10_000;
    const runningRegistry = makeRegistry({ generateRoomCode: () => "DISC23", now: () => now });
    const white = runningRegistry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.rapid));
    const black = runningRegistry.joinRoom(joinInput(white.code, "Black"));
    runningRegistry.disconnectSession(white.credentials.sessionToken);
    now += 1_000;
    expect(runningRegistry.snapshotForSession(black.credentials.sessionToken).clock.whiteMs).toBe(599_000);

    const terminalPosition: CheckersPosition = {
      "7|0": "w", "7|1": "w", "7|2": "w", "7|3": "w",
      "7|4": "w", "7|5": "w", "7|6": "w", "7|7": "w",
      "0|0": "b", "0|7": "b",
    };
    const terminalRegistry = makeRegistry({
      generateRoomCode: () => "FINI23",
      now: () => now,
      createMatch: () => createMatch(terminalPosition),
    });
    const terminalWhite = terminalRegistry.createRoom(createInput("White", "white", TIME_CONTROL_PRESETS.blitz));
    const terminalBlack = terminalRegistry.joinRoom(joinInput(terminalWhite.code, "Black"));
    expect(terminalBlack.snapshot.phase).toBe("finished");
    expect(terminalBlack.snapshot.clock).toEqual({
      whiteMs: 300_000,
      blackMs: 300_000,
      activeSide: null,
      running: false,
    });
    now += 1_000_000;
    expect(terminalRegistry.advanceClocks()).toEqual([]);
    expect(terminalRegistry.snapshotForSession(terminalWhite.credentials.sessionToken).clock.whiteMs).toBe(300_000);
  });

  it("fails room and session capacity checks without partially creating or joining", () => {
    const roomLimited = makeRegistry({
      generateRoomCode: (() => {
        let value = 0;
        return () => value++ === 0 ? "ROOM23" : "ROOM24";
      })(),
      limits: { rooms: 1 },
    });
    roomLimited.createRoom(createInput("First"));
    expectRegistryError(
      () => roomLimited.createRoom(createInput("Second")),
      "room-capacity",
      "The service is at capacity. Try again when a room is available.",
    );
    expect(roomLimited.roomCount).toBe(1);
    expect(roomLimited.sessionCount).toBe(1);

    const sessionLimited = makeRegistry({
      generateRoomCode: () => "FULL23",
      limits: { sessions: 1 },
    });
    const room = sessionLimited.createRoom(createInput("First"));
    expectRegistryError(
      () => sessionLimited.joinRoom(joinInput(room.code, "Second")),
      "session-capacity",
      "The service is at capacity. Try again when a player slot opens.",
    );
    expect(sessionLimited.roomCount).toBe(1);
    expect(sessionLimited.sessionCount).toBe(1);
    expect(sessionLimited.snapshotForSession(room.credentials.sessionToken)).toMatchObject({
      phase: "waiting",
      revision: 0,
      players: { white: { name: "First" }, black: null },
    });

    const zeroSessionCapacity = makeRegistry({ limits: { sessions: 0 } });
    expectRegistryError(() => zeroSessionCapacity.createRoom(createInput("Nobody")), "session-capacity");
    expect(zeroSessionCapacity.roomCount).toBe(0);
    expect(zeroSessionCapacity.sessionCount).toBe(0);
  });

  it("keeps one session in one room role while treating names as display labels", () => {
    const codes = ["FIRST2", "SECOND"];
    let index = 0;
    const registry = makeRegistry({ generateRoomCode: () => codes[index++] ?? "THIRD2" });
    const first = registry.createRoom(createInput("Same Name"));
    const second = registry.createRoom(createInput("Other"));

    expectRegistryError(
      () => registry.joinRoom(joinInput(second.code, "Same Name"), first.credentials.sessionToken),
      "session-conflict",
    );
    expectRegistryError(
      () => registry.resumeRoom({ code: second.code, sessionToken: first.credentials.sessionToken }),
      "session-conflict",
    );
    const relabeled = registry.joinRoom(
      joinInput(first.code, "Renamed", "player"),
      first.credentials.sessionToken,
    );
    expect(relabeled.snapshot.players.white?.name).toBe("Renamed");
    expectRegistryError(() => registry.joinRoom(
      joinInput(first.code, "Renamed", "spectator"),
      first.credentials.sessionToken,
    ), "session-conflict");
    expect(registry.roomCount).toBe(2);
    expect(registry.sessionCount).toBe(2);
    expect(registry.snapshotForSession(first.credentials.sessionToken)).toMatchObject({
      phase: "waiting",
      players: { white: { name: "Renamed" }, black: null },
    });
    expect(registry.snapshotForSession(second.credentials.sessionToken)).toMatchObject({
      phase: "waiting",
      players: { white: { name: "Other" }, black: null },
    });
  });

  it("rejects invalid or missing rooms without creating orphan sessions", () => {
    const registry = makeRegistry();
    expectRegistryError(() => registry.joinRoom(joinInput("BAD0DE", "Viewer")), "invalid-input");
    expectRegistryError(
      () => registry.joinRoom(joinInput("MISS23", "Viewer")),
      "room-not-found",
      "No room has that code. Check the code or create a room.",
    );
    expect(registry.roomCount).toBe(0);
    expect(registry.sessionCount).toBe(0);
  });

  it("allows spectators only up to the room's configured session capacity", () => {
    const registry = makeRegistry({
      generateRoomCode: () => "SPEC23",
      limits: { spectatorsPerRoom: 1 },
    });
    const white = registry.createRoom(createInput("White"));
    const black = registry.joinRoom(joinInput(white.code, "Black"));
    const spectator = registry.joinRoom(joinInput(white.code, "Viewer"));

    expect(spectator.snapshot.viewerSide).toBeNull();
    expect(spectator.snapshot.spectatorCount).toBe(1);
    expectRegistryError(
      () => registry.joinRoom(joinInput(white.code, "Extra")),
      "room-full",
      "This room is full. Ask the host for another code or try again later.",
    );
    expect(registry.sessionCount).toBe(3);
    expect(registry.snapshotForSession(black.credentials.sessionToken).spectatorCount).toBe(1);
  });
});
