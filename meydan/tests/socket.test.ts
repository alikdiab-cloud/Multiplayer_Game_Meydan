import { createServer } from "node:http";
import express from "express";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientToServerEvents,
  ProtocolError,
  RoomSnapshot,
  ServerToClientEvents,
  SessionCredentials,
} from "../shared/protocol.js";
import { attachSocketRuntime } from "../server/socket.js";
import { startDevelopmentServer } from "../server/index.js";
import { DEFAULT_ROOM_IDLE_TIMEOUT_MS } from "../server/rooms.js";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function waitForConnect(socket: TestSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timed out.")), 3_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForConnectFailure(socket: TestSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Expected the origin check to reject this connection.")), 3_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      reject(new Error("A connection from a rejected origin was accepted."));
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      resolve(error);
    });
  });
}

function waitForDisconnect(socket: TestSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket did not close after transport rejection.")), 3_000);
    socket.once("disconnect", (reason) => {
      clearTimeout(timeout);
      resolve(reason);
    });
  });
}

function waitForSnapshot(
  socket: TestSocket,
  predicate: (snapshot: RoomSnapshot) => boolean,
): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("room:snapshot", onSnapshot);
      reject(new Error("Timed out waiting for the expected room snapshot."));
    }, 3_000);
    const onSnapshot = (snapshot: RoomSnapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      socket.off("room:snapshot", onSnapshot);
      resolve(snapshot);
    };
    socket.on("room:snapshot", onSnapshot);
  });
}

function waitForCredential(socket: TestSocket): Promise<SessionCredentials> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a private session credential.")), 3_000);
    socket.once("session:credential", (credentials) => {
      clearTimeout(timeout);
      resolve(credentials);
    });
  });
}

function waitForRoomClosed(socket: TestSocket): Promise<{ reason: "host-left" | "idle-timeout" | "server-shutdown" }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for room expiry notification.")), 3_000);
    socket.once("room:closed", (notice) => {
      clearTimeout(timeout);
      resolve(notice);
    });
  });
}

function waitForServerError(socket: TestSocket): Promise<ProtocolError> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a server error.")), 3_000);
    socket.once("server:error", (error) => {
      clearTimeout(timeout);
      resolve(error);
    });
  });
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

describe("Socket.IO room integration", () => {
  it("serves the development app and Socket.IO from one origin and closes cleanly", async () => {
    const server = await startDevelopmentServer({ port: 0, logUrls: false });
    let client: TestSocket | undefined;
    try {
      expect(() => attachSocketRuntime(server.httpServer)).toThrow("already attached");
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(await health.json()).toEqual({ status: "ok" });
      client = io(`http://127.0.0.1:${server.port}`, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
      }) as TestSocket;
      const connected = waitForConnect(client);
      client.connect();
      await connected;
      const ack = await client.timeout(3_000).emitWithAck("room:create", {
        name: "Development Smoke",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(ack.ok).toBe(true);
      expect(server.socketRuntime.io.sockets.sockets.size).toBe(1);
    } finally {
      client?.disconnect();
      await server.close();
      expect(server.socketRuntime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("notifies connected viewers on idle expiry, releases membership, and stops one maintenance loop on shutdown", async () => {
    let now = 1_000_000;
    const httpServer = createServer(express());
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const intervalsBeforeAttach = setIntervalSpy.mock.calls.length;
    const runtime = attachSocketRuntime(httpServer, {
      clockTickMs: 10,
      registryOptions: { now: () => now, limits: { rooms: 1, sessions: 2, spectatorsPerRoom: 1 } },
    });
    const maintenanceTimer = setIntervalSpy.mock.results.at(-1)?.value;
    let white: TestSocket | undefined;
    let spectator: TestSocket | undefined;

    try {
      expect(setIntervalSpy).toHaveBeenCalledTimes(intervalsBeforeAttach + 1);
      expect(() => attachSocketRuntime(httpServer)).toThrow("already attached");
      expect(setIntervalSpy).toHaveBeenCalledTimes(intervalsBeforeAttach + 1);

      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const clientOptions = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, clientOptions) as TestSocket;
      spectator = io(origin, clientOptions) as TestSocket;
      const connected = [waitForConnect(white), waitForConnect(spectator)];
      white.connect();
      spectator.connect();
      await Promise.all(connected);

      const whiteCredentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Expiry White",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      const whiteCredential = await whiteCredentialPromise;

      const spectatorCredentialPromise = waitForCredential(spectator);
      const spectatorAck = await spectator.timeout(3_000).emitWithAck("room:join", {
        name: "Expiry Viewer",
        code: createAck.data.code,
        role: "spectator",
      });
      expect(spectatorAck.ok).toBe(true);
      if (!spectatorAck.ok) throw new Error(spectatorAck.error.message);
      const spectatorCredential = await spectatorCredentialPromise;
      expect(runtime.registry).toMatchObject({ roomCount: 1, sessionCount: 2 });

      const whiteClosed = waitForRoomClosed(white);
      const spectatorClosed = waitForRoomClosed(spectator);
      now += DEFAULT_ROOM_IDLE_TIMEOUT_MS;
      await expect(Promise.all([whiteClosed, spectatorClosed])).resolves.toEqual([
        { reason: "idle-timeout" },
        { reason: "idle-timeout" },
      ]);
      expect(runtime.registry.roomCount).toBe(0);
      expect(runtime.registry.sessionCount).toBe(0);
      expect(white.connected).toBe(true);
      expect(spectator.connected).toBe(true);
      for (const [client, credential] of [[white, whiteCredential], [spectator, spectatorCredential]] as const) {
        const serverSocket = runtime.io.sockets.sockets.get(client.id!);
        expect(serverSocket?.data.sessionToken).toBeUndefined();
        expect(serverSocket?.data.roomCode).toBeUndefined();
        expect(serverSocket?.data.rateEventCount).toBeLessThanOrEqual(60);
        expect(serverSocket?.rooms.has(createAck.data.code)).toBe(false);
        expect(JSON.stringify({ reason: "idle-timeout" })).not.toContain(credential.sessionToken);
      }
      expect(runtime.io.sockets.adapter.rooms.has(createAck.data.code)).toBe(false);

      // Expiry has released both room and session capacity; the same live socket
      // is unbound and may deliberately create a fresh room.
      const replacementCredentialPromise = waitForCredential(white);
      const replacementAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Replacement White",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(replacementAck.ok).toBe(true);
      await replacementCredentialPromise;
      expect(runtime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });
    } finally {
      await runtime.close();
      white?.disconnect();
      spectator?.disconnect();
      await closeHttpServer(httpServer);
      expect(clearIntervalSpy).toHaveBeenCalledWith(maintenanceTimer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
      expect(runtime.registry.roomCount).toBe(0);
      expect(runtime.registry.sessionCount).toBe(0);
      expect(httpServer.listening).toBe(false);
    }
  });

  it("rolls back room and session allocations when transport room binding fails", async () => {
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, { clockTickMs: 20 });
    let failingSocketId: string | null = null;
    runtime.io.on("connection", (serverSocket) => {
      const join = serverSocket.join.bind(serverSocket);
      serverSocket.join = async (rooms) => {
        if (serverSocket.id === failingSocketId) throw new Error("Injected room adapter failure.");
        await join(rooms);
      };
    });
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const options = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, options) as TestSocket;
      const whiteConnected = waitForConnect(white);
      white.connect();
      await whiteConnected;

      failingSocketId = white.id ?? null;
      const failedCreate = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Failed Create",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(failedCreate).toMatchObject({ ok: false, error: { code: "internal-error" } });
      expect(runtime.registry.roomCount).toBe(0);
      expect(runtime.registry.sessionCount).toBe(0);
      expect([...runtime.io.sockets.adapter.rooms.keys()]).toEqual([white.id]);

      failingSocketId = null;
      const credentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Room Owner",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      await credentialPromise;
      expect(runtime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });

      black = io(origin, options) as TestSocket;
      const blackConnected = waitForConnect(black);
      black.connect();
      await blackConnected;
      failingSocketId = black.id ?? null;
      const failedJoin = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Failed Join",
        code: createAck.data.code,
      });
      expect(failedJoin).toMatchObject({ ok: false, error: { code: "internal-error" } });
      expect(runtime.registry.roomCount).toBe(1);
      expect(runtime.registry.sessionCount).toBe(1);
      expect(runtime.registry.snapshotForSession((await credentialPromise).sessionToken).players.black).toBeNull();
      expect(runtime.io.sockets.adapter.rooms.has(createAck.data.code)).toBe(true);
      expect(runtime.io.sockets.sockets.get(black.id!)?.rooms.has(createAck.data.code)).toBe(false);

      failingSocketId = null;
      const joinCredentialPromise = waitForCredential(black);
      const successfulJoin = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Black Player",
        code: createAck.data.code,
      });
      expect(successfulJoin.ok).toBe(true);
      await joinCredentialPromise;
      expect(runtime.registry).toMatchObject({ roomCount: 1, sessionCount: 2 });
      expect(successfulJoin.ok && successfulJoin.data.snapshot.phase).toBe("playing");
    } finally {
      await runtime.close();
      white?.disconnect();
      black?.disconnect();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
      expect(runtime.registry.roomCount).toBe(0);
      expect(runtime.registry.sessionCount).toBe(0);
    }
  });

  it("creates and joins a room, sends private credentials, and exchanges one canonical move", async () => {
    const app = express();
    app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
    const httpServer = createServer(app);
    const runtime = attachSocketRuntime(httpServer, { clockTickMs: 20 });
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;
    let spectator: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const clientOptions = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, clientOptions) as TestSocket;
      black = io(origin, clientOptions) as TestSocket;
      spectator = io(origin, clientOptions) as TestSocket;
      const whiteConnected = waitForConnect(white);
      const blackConnected = waitForConnect(black);
      const spectatorConnected = waitForConnect(spectator);
      white.connect();
      black.connect();
      spectator.connect();
      await Promise.all([whiteConnected, blackConnected, spectatorConnected]);
      const whiteCredentialsReceived: SessionCredentials[] = [];
      const blackCredentialsReceived: SessionCredentials[] = [];
      const spectatorCredentialsReceived: SessionCredentials[] = [];
      white.on("session:credential", (credentials) => whiteCredentialsReceived.push(credentials));
      black.on("session:credential", (credentials) => blackCredentialsReceived.push(credentials));
      spectator.on("session:credential", (credentials) => spectatorCredentialsReceived.push(credentials));

      const missingAckErrorPromise = waitForServerError(white);
      white.emit("room:create", {} as never, undefined as never);
      expect(await missingAckErrorPromise).toMatchObject({ code: "invalid-input" });
      const malformedCreate = await white.timeout(3_000).emitWithAck("room:create", {} as never);
      expect(malformedCreate).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(runtime.registry.roomCount).toBe(0);

      const whiteCredentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "White Player",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      const whiteCredential = await whiteCredentialPromise;
      expect(Object.keys(createAck.data).sort()).toEqual(["code", "snapshot"]);
      expect(createAck.data.snapshot.viewerSide).toBe("white");
      expect(JSON.stringify(createAck)).not.toContain(whiteCredential.sessionToken);

      const whitePlayingSnapshot = waitForSnapshot(white, (snapshot) => snapshot.phase === "playing");
      const blackCredentialPromise = waitForCredential(black);
      const joinAck = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Black Player",
        code: createAck.data.code,
      });
      expect(joinAck.ok).toBe(true);
      if (!joinAck.ok) throw new Error(joinAck.error.message);
      const blackCredential = await blackCredentialPromise;
      const whiteBroadcast = await whitePlayingSnapshot;
      expect(joinAck.data.snapshot.viewerSide).toBe("black");
      expect(whiteBroadcast.viewerSide).toBe("white");
      expect(whiteBroadcast.phase).toBe("playing");
      expect(whiteCredential.sessionToken).not.toBe(blackCredential.sessionToken);
      expect(JSON.stringify(joinAck)).not.toContain(blackCredential.sessionToken);

      const spectatorCredentialPromise = waitForCredential(spectator);
      const whiteAfterSpectatorPromise = waitForSnapshot(
        white,
        (snapshot) => snapshot.spectatorCount === 1,
      );
      const blackAfterSpectatorPromise = waitForSnapshot(
        black,
        (snapshot) => snapshot.spectatorCount === 1,
      );
      const spectatorJoinAck = await spectator.timeout(3_000).emitWithAck("room:join", {
        name: "Room Spectator",
        code: createAck.data.code,
        role: "spectator",
      });
      expect(spectatorJoinAck.ok).toBe(true);
      if (!spectatorJoinAck.ok) throw new Error(spectatorJoinAck.error.message);
      const spectatorCredential = await spectatorCredentialPromise;
      const [whiteAfterSpectator, blackAfterSpectator] = await Promise.all([
        whiteAfterSpectatorPromise,
        blackAfterSpectatorPromise,
      ]);
      expect(spectatorJoinAck.data.snapshot.viewerSide).toBeNull();
      expect(whiteAfterSpectator.revision).toBe(spectatorJoinAck.data.snapshot.revision);
      expect(blackAfterSpectator.revision).toBe(spectatorJoinAck.data.snapshot.revision);

      const legalMove = spectatorJoinAck.data.snapshot.gameView.legalMoves[0];
      if (legalMove === undefined) throw new Error("A new match must include a legal move.");
      const whiteMoveBroadcast = waitForSnapshot(white, (snapshot) => snapshot.gameView.history.length === 1);
      const blackMoveBroadcast = waitForSnapshot(black, (snapshot) => snapshot.gameView.history.length === 1);
      const spectatorMoveBroadcast = waitForSnapshot(spectator, (snapshot) => snapshot.gameView.history.length === 1);
      const whiteMoveRequest = {
        revision: spectatorJoinAck.data.snapshot.revision,
        from: legalMove.from,
        path: [...legalMove.path],
      };
      const moveAck = await white.timeout(3_000).emitWithAck("game:move", {
        ...whiteMoveRequest,
      });
      expect(moveAck.ok).toBe(true);
      if (!moveAck.ok) throw new Error(moveAck.error.message);
      const [whiteAfterMove, blackAfterMove, spectatorAfterMove] = await Promise.all([
        whiteMoveBroadcast,
        blackMoveBroadcast,
        spectatorMoveBroadcast,
      ]);
      expect(moveAck.data.snapshot.gameView.history).toHaveLength(1);
      expect(moveAck.data.snapshot.gameView.history[0]).toMatchObject(legalMove);
      expect(whiteAfterMove.viewerSide).toBe("white");
      expect(blackAfterMove.viewerSide).toBe("black");
      expect(spectatorAfterMove.viewerSide).toBeNull();
      expect(whiteAfterMove.gameView.position).toEqual(blackAfterMove.gameView.position);
      expect(whiteAfterMove.gameView.history).toEqual(blackAfterMove.gameView.history);
      expect(spectatorAfterMove.gameView.position).toEqual(whiteAfterMove.gameView.position);
      expect(spectatorAfterMove.gameView.history).toEqual(whiteAfterMove.gameView.history);

      const stateAfterWhiteMove = runtime.registry.snapshotForSession(whiteCredential.sessionToken);
      const duplicateWhiteMove = await white.timeout(3_000).emitWithAck("game:move", whiteMoveRequest);
      expect(duplicateWhiteMove).toMatchObject({
        ok: false,
        error: { code: "stale-revision" },
      });
      const stateAfterDuplicate = runtime.registry.snapshotForSession(whiteCredential.sessionToken);
      expect(stateAfterDuplicate.revision).toBe(stateAfterWhiteMove.revision);
      expect(stateAfterDuplicate.gameView).toEqual(stateAfterWhiteMove.gameView);

      const spectatorLegalMove = spectatorAfterMove.gameView.legalMoves[0];
      if (spectatorLegalMove === undefined) throw new Error("Black must have a legal reply in the opening.");
      const spectatorMoveRejected = await spectator.timeout(3_000).emitWithAck("game:move", {
        revision: spectatorAfterMove.revision,
        from: spectatorLegalMove.from,
        path: [...spectatorLegalMove.path],
      });
      expect(spectatorMoveRejected).toMatchObject({
        ok: false,
        error: { code: "not-your-turn" },
      });
      const stateAfterSpectatorAttempt = runtime.registry.snapshotForSession(spectatorCredential.sessionToken);
      expect(stateAfterSpectatorAttempt.revision).toBe(stateAfterWhiteMove.revision);
      expect(stateAfterSpectatorAttempt.gameView).toEqual(stateAfterWhiteMove.gameView);

      const legalBlackMove = spectatorAfterMove.gameView.legalMoves[0];
      if (legalBlackMove === undefined) throw new Error("Black must have a legal reply in the opening.");
      const blackMoveRequest = {
        revision: spectatorAfterMove.revision,
        from: legalBlackMove.from,
        path: [...legalBlackMove.path],
      };
      const whiteAfterBlackMovePromise = waitForSnapshot(white, (snapshot) => snapshot.gameView.history.length === 2);
      const blackAfterBlackMovePromise = waitForSnapshot(black, (snapshot) => snapshot.gameView.history.length === 2);
      const spectatorAfterBlackMovePromise = waitForSnapshot(spectator, (snapshot) => snapshot.gameView.history.length === 2);
      const blackMoveAck = await black.timeout(3_000).emitWithAck("game:move", blackMoveRequest);
      expect(blackMoveAck.ok).toBe(true);
      if (!blackMoveAck.ok) throw new Error(blackMoveAck.error.message);
      const [whiteAfterBlackMove, blackAfterBlackMove, spectatorAfterBlackMove] = await Promise.all([
        whiteAfterBlackMovePromise,
        blackAfterBlackMovePromise,
        spectatorAfterBlackMovePromise,
      ]);
      expect(whiteAfterBlackMove.revision).toBe(whiteAfterMove.revision + 1);
      expect(blackAfterBlackMove.revision).toBe(whiteAfterBlackMove.revision);
      expect(spectatorAfterBlackMove.revision).toBe(whiteAfterBlackMove.revision);
      expect(whiteAfterBlackMove.gameView.position).toEqual(blackAfterBlackMove.gameView.position);
      expect(whiteAfterBlackMove.gameView.position).toEqual(spectatorAfterBlackMove.gameView.position);
      expect(whiteAfterBlackMove.gameView.history).toEqual(blackAfterBlackMove.gameView.history);
      expect(whiteAfterBlackMove.gameView.history).toEqual(spectatorAfterBlackMove.gameView.history);

      const serializedSnapshots = [
        createAck.data.snapshot,
        joinAck.data.snapshot,
        whiteBroadcast,
        spectatorJoinAck.data.snapshot,
        moveAck.data.snapshot,
        whiteAfterMove,
        blackAfterMove,
        spectatorAfterMove,
        whiteAfterBlackMove,
        blackAfterBlackMove,
        spectatorAfterBlackMove,
      ].map((snapshot) => JSON.stringify(snapshot));
      expect(serializedSnapshots.every((serialized) =>
        !serialized.includes(whiteCredential.sessionToken) &&
        !serialized.includes(blackCredential.sessionToken) &&
        !serialized.includes(spectatorCredential.sessionToken),
      )).toBe(true);

      const whiteAfterLeavePromise = waitForSnapshot(
        white,
        (snapshot) => snapshot.phase === "finished" && snapshot.gameView.result?.reason === "disconnection",
      );
      const leaveAck = await black.timeout(3_000).emitWithAck("room:leave");
      expect(leaveAck).toEqual({ ok: true, data: { left: true } });
      const whiteAfterLeave = await whiteAfterLeavePromise;
      expect(whiteAfterLeave).toMatchObject({
        viewerSide: "white",
        phase: "finished",
        players: { black: null },
        gameView: { result: { state: "won", winner: "white", reason: "disconnection" } },
      });
      expect(whiteCredentialsReceived.map(({ sessionToken }) => sessionToken)).toEqual([
        whiteCredential.sessionToken,
      ]);
      expect(blackCredentialsReceived.map(({ sessionToken }) => sessionToken)).toEqual([
        blackCredential.sessionToken,
      ]);
      expect(spectatorCredentialsReceived.map(({ sessionToken }) => sessionToken)).toEqual([
        spectatorCredential.sessionToken,
      ]);
      expect(runtime.io.sockets.sockets.size).toBe(3);
    } finally {
      white?.disconnect();
      black?.disconnect();
      spectator?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("broadcasts draw offers and acceptance as revisioned authoritative room state", async () => {
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, { clockTickMs: 20 });
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;
    let spectator: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const clientOptions = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, clientOptions) as TestSocket;
      black = io(origin, clientOptions) as TestSocket;
      spectator = io(origin, clientOptions) as TestSocket;
      const sockets: [TestSocket, TestSocket, TestSocket] = [white, black, spectator];
      const connected = sockets.map(waitForConnect);
      white.connect();
      black.connect();
      spectator.connect();
      await Promise.all(connected);

      const whiteCredentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Draw White",
        side: "white",
        timeControl: { kind: "rapid", initialMs: 600_000, incrementMs: 5_000 },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      await whiteCredentialPromise;

      const blackCredentialPromise = waitForCredential(black);
      const joinAck = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Draw Black",
        code: createAck.data.code,
      });
      expect(joinAck.ok).toBe(true);
      if (!joinAck.ok) throw new Error(joinAck.error.message);
      await blackCredentialPromise;

      const spectatorCredentialPromise = waitForCredential(spectator);
      const spectatorJoinAck = await spectator.timeout(3_000).emitWithAck("room:join", {
        name: "Draw Viewer",
        code: createAck.data.code,
        role: "spectator",
      });
      expect(spectatorJoinAck.ok).toBe(true);
      if (!spectatorJoinAck.ok) throw new Error(spectatorJoinAck.error.message);
      await spectatorCredentialPromise;
      expect(spectatorJoinAck.data.snapshot.viewerSide).toBeNull();

      const initialRevision = spectatorJoinAck.data.snapshot.revision;
      const offerSnapshots = [
        waitForSnapshot(white, (snapshot) => snapshot.revision === initialRevision + 1),
        waitForSnapshot(black, (snapshot) => snapshot.revision === initialRevision + 1),
        waitForSnapshot(spectator, (snapshot) => snapshot.revision === initialRevision + 1),
      ] as const;
      const offerAck = await white.timeout(3_000).emitWithAck("draw:offer", { revision: initialRevision });
      expect(offerAck).toMatchObject({
        ok: true,
        data: { snapshot: { revision: initialRevision + 1, drawOffer: { offeredBy: "white" }, phase: "playing" } },
      });
      const [whiteOffered, blackOffered, spectatorOffered] = await Promise.all(offerSnapshots);
      expect([whiteOffered, blackOffered, spectatorOffered].map(({ revision, drawOffer }) => ({ revision, drawOffer })))
        .toEqual(Array(3).fill({ revision: initialRevision + 1, drawOffer: { offeredBy: "white" } }));

      const offerRevision = initialRevision + 1;
      const repeatedOffer = await white.timeout(3_000).emitWithAck("draw:offer", { revision: offerRevision });
      expect(repeatedOffer).toMatchObject({ ok: false, error: { code: "conflict" } });
      const selfAccept = await white.timeout(3_000).emitWithAck("draw:accept", { revision: offerRevision });
      expect(selfAccept).toMatchObject({ ok: false, error: { code: "not-your-turn" } });
      const spectatorResponse = await spectator.timeout(3_000).emitWithAck("draw:decline", { revision: offerRevision });
      expect(spectatorResponse).toMatchObject({ ok: false, error: { code: "not-your-turn" } });

      const declineSnapshots = sockets.map((socket) =>
        waitForSnapshot(socket, (snapshot) => snapshot.revision === offerRevision + 1),
      );
      const declineAck = await black.timeout(3_000).emitWithAck("draw:decline", { revision: offerRevision });
      expect(declineAck).toMatchObject({
        ok: true,
        data: { snapshot: { revision: offerRevision + 1, phase: "playing", drawOffer: null } },
      });
      await Promise.all(declineSnapshots);

      const beforeMoveRevision = offerRevision + 1;
      const nextOffer = await white.timeout(3_000).emitWithAck("draw:offer", { revision: beforeMoveRevision });
      expect(nextOffer.ok).toBe(true);
      if (!nextOffer.ok) throw new Error(nextOffer.error.message);
      const legal = nextOffer.data.snapshot.gameView.legalMoves[0];
      if (legal === undefined) throw new Error("The opening must contain a legal move.");
      const oldOfferRevision = nextOffer.data.snapshot.revision;
      const moveSnapshotPromises = [
        waitForSnapshot(white, (snapshot) => snapshot.revision === oldOfferRevision + 1),
        waitForSnapshot(black, (snapshot) => snapshot.revision === oldOfferRevision + 1),
        waitForSnapshot(spectator, (snapshot) => snapshot.revision === oldOfferRevision + 1),
      ] as const;
      const moveAck = await white.timeout(3_000).emitWithAck("game:move", {
        revision: oldOfferRevision,
        from: legal.from,
        path: [...legal.path],
      });
      expect(moveAck).toMatchObject({
        ok: true,
        data: { snapshot: { revision: oldOfferRevision + 1, drawOffer: null, gameView: { history: expect.any(Array) } } },
      });
      const [whiteAfterMove, blackAfterMove, spectatorAfterMove] = await Promise.all(moveSnapshotPromises);
      expect(whiteAfterMove.gameView).toEqual(blackAfterMove.gameView);
      expect(whiteAfterMove.gameView).toEqual(spectatorAfterMove.gameView);
      expect(whiteAfterMove.gameView.history).toHaveLength(1);
      const staleDecline = await black.timeout(3_000).emitWithAck("draw:decline", { revision: oldOfferRevision });
      expect(staleDecline).toMatchObject({ ok: false, error: { code: "stale-revision" } });

      const blackOffer = await black.timeout(3_000).emitWithAck("draw:offer", { revision: whiteAfterMove.revision });
      expect(blackOffer.ok).toBe(true);
      if (!blackOffer.ok) throw new Error(blackOffer.error.message);
      const blackOfferRevision = blackOffer.data.snapshot.revision;
      const blackSelfAccept = await black.timeout(3_000).emitWithAck("draw:accept", { revision: blackOfferRevision });
      expect(blackSelfAccept).toMatchObject({ ok: false, error: { code: "not-your-turn" } });

      const agreedSnapshots = [
        waitForSnapshot(white, (snapshot) => snapshot.revision === blackOfferRevision + 1),
        waitForSnapshot(black, (snapshot) => snapshot.revision === blackOfferRevision + 1),
        waitForSnapshot(spectator, (snapshot) => snapshot.revision === blackOfferRevision + 1),
      ] as const;
      const acceptAck = await white.timeout(3_000).emitWithAck("draw:accept", { revision: blackOfferRevision });
      expect(acceptAck).toMatchObject({
        ok: true,
        data: {
          snapshot: {
            revision: blackOfferRevision + 1,
            matchNumber: 1,
            phase: "finished",
            drawOffer: null,
            clock: { activeSide: null, running: false },
            gameView: { result: { state: "draw", reason: "agreement" }, history: expect.any(Array) },
          },
        },
      });
      const [whiteAgreed, blackAgreed, spectatorAgreed] = await Promise.all(agreedSnapshots);
      for (const snapshot of [whiteAgreed, blackAgreed, spectatorAgreed]) {
        expect(snapshot).toMatchObject({
          revision: blackOfferRevision + 1,
          phase: "finished",
          drawOffer: null,
          gameView: { result: { state: "draw", reason: "agreement" } },
        });
        expect(snapshot.gameView).toEqual(whiteAgreed.gameView);
      }

      const blackLegal = blackAfterMove.gameView.legalMoves[0];
      if (blackLegal === undefined) throw new Error("Black's current position should provide a move-shaped request.");
      const moveAfterDraw = await black.timeout(3_000).emitWithAck("game:move", {
        revision: blackAgreed.revision,
        from: blackLegal.from,
        path: [...blackLegal.path],
      });
      expect(moveAfterDraw).toMatchObject({ ok: false, error: { code: "game-finished" } });
    } finally {
      white?.disconnect();
      black?.disconnect();
      spectator?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("broadcasts resignation as a public terminal result and blocks later actions", async () => {
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, { clockTickMs: 20 });
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;
    let spectator: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const clientOptions = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, clientOptions) as TestSocket;
      black = io(origin, clientOptions) as TestSocket;
      spectator = io(origin, clientOptions) as TestSocket;
      const sockets: [TestSocket, TestSocket, TestSocket] = [white, black, spectator];
      const connected = sockets.map(waitForConnect);
      white.connect();
      black.connect();
      spectator.connect();
      await Promise.all(connected);

      const whiteCredentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Resign White",
        side: "white",
        timeControl: { kind: "rapid", initialMs: 600_000, incrementMs: 5_000 },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      await whiteCredentialPromise;

      const blackCredentialPromise = waitForCredential(black);
      const joinAck = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Resign Black",
        code: createAck.data.code,
      });
      expect(joinAck.ok).toBe(true);
      if (!joinAck.ok) throw new Error(joinAck.error.message);
      const blackCredential = await blackCredentialPromise;

      const spectatorCredentialPromise = waitForCredential(spectator);
      const spectatorJoinAck = await spectator.timeout(3_000).emitWithAck("room:join", {
        name: "Resign Viewer",
        code: createAck.data.code,
        role: "spectator",
      });
      expect(spectatorJoinAck.ok).toBe(true);
      if (!spectatorJoinAck.ok) throw new Error(spectatorJoinAck.error.message);
      await spectatorCredentialPromise;

      const offerRevision = spectatorJoinAck.data.snapshot.revision;
      const offerAck = await white.timeout(3_000).emitWithAck("draw:offer", { revision: offerRevision });
      expect(offerAck.ok).toBe(true);
      if (!offerAck.ok) throw new Error(offerAck.error.message);
      const offered = offerAck.data.snapshot;
      const legalBeforeResignation = offered.gameView.legalMoves[0];
      if (legalBeforeResignation === undefined) throw new Error("The active match must have a legal move.");
      const spectatorResignation = await spectator.timeout(3_000).emitWithAck("match:resign", {
        revision: offered.revision,
      });
      expect(spectatorResignation).toMatchObject({ ok: false, error: { code: "not-your-turn" } });

      const invalidAuthority = await black.timeout(3_000).emitWithAck("match:resign", {
        revision: offered.revision,
        result: { state: "won", winner: "black", reason: "resignation" },
      } as never);
      expect(invalidAuthority).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      const whiteTerminalPromise = waitForSnapshot(white, (snapshot) => snapshot.phase === "finished");
      const blackTerminalPromise = waitForSnapshot(black, (snapshot) => snapshot.phase === "finished");
      const spectatorTerminalPromise = waitForSnapshot(spectator, (snapshot) => snapshot.phase === "finished");
      const resignAck = await black.timeout(3_000).emitWithAck("match:resign", { revision: offered.revision });
      expect(resignAck).toMatchObject({
        ok: true,
        data: {
          snapshot: {
            revision: offered.revision + 1,
            matchNumber: 1,
            phase: "finished",
            drawOffer: null,
            clock: { activeSide: null, running: false },
            gameView: { legalMoves: [], result: { state: "won", winner: "white", reason: "resignation" } },
          },
        },
      });
      const [whiteTerminal, blackTerminal, spectatorTerminal] = await Promise.all([
        whiteTerminalPromise,
        blackTerminalPromise,
        spectatorTerminalPromise,
      ]);
      for (const snapshot of [whiteTerminal, blackTerminal, spectatorTerminal]) {
        expect(snapshot.gameView).toEqual(whiteTerminal.gameView);
        expect(snapshot).toMatchObject({
          revision: offered.revision + 1,
          phase: "finished",
          drawOffer: null,
          gameView: { legalMoves: [], result: { state: "won", winner: "white", reason: "resignation" } },
          clock: { activeSide: null, running: false },
        });
      }

      const repeatedResignation = await black.timeout(3_000).emitWithAck("match:resign", {
        revision: whiteTerminal.revision,
      });
      expect(repeatedResignation).toMatchObject({ ok: false, error: { code: "game-finished" } });
      const postResultMove = await white.timeout(3_000).emitWithAck("game:move", {
        revision: whiteTerminal.revision,
        from: legalBeforeResignation.from,
        path: [...legalBeforeResignation.path],
      });
      expect(postResultMove).toMatchObject({ ok: false, error: { code: "game-finished" } });
      expect(runtime.registry.snapshotForSession(blackCredential.sessionToken)).toMatchObject({
        revision: whiteTerminal.revision,
        gameView: { result: { state: "won", winner: "white", reason: "resignation" }, legalMoves: [] },
      });
    } finally {
      white?.disconnect();
      black?.disconnect();
      spectator?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("broadcasts rematch votes, waits for both players, swaps sides, and rejects old-match moves", async () => {
    let now = 100_000;
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, {
      clockTickMs: 60_000,
      registryOptions: { now: () => now },
    });
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;
    let spectator: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const clientOptions = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, clientOptions) as TestSocket;
      black = io(origin, clientOptions) as TestSocket;
      spectator = io(origin, clientOptions) as TestSocket;
      const sockets: [TestSocket, TestSocket, TestSocket] = [white, black, spectator];
      const connected = sockets.map(waitForConnect);
      white.connect();
      black.connect();
      spectator.connect();
      await Promise.all(connected);

      const whiteCredentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Rematch White",
        side: "white",
        timeControl: { kind: "rapid", initialMs: 600_000, incrementMs: 5_000 },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      await whiteCredentialPromise;

      const blackCredentialPromise = waitForCredential(black);
      const joinAck = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Rematch Black",
        code: createAck.data.code,
      });
      expect(joinAck.ok).toBe(true);
      if (!joinAck.ok) throw new Error(joinAck.error.message);
      await blackCredentialPromise;

      const spectatorCredentialPromise = waitForCredential(spectator);
      const spectatorJoinAck = await spectator.timeout(3_000).emitWithAck("room:join", {
        name: "Rematch Viewer",
        code: createAck.data.code,
        role: "spectator",
      });
      expect(spectatorJoinAck.ok).toBe(true);
      if (!spectatorJoinAck.ok) throw new Error(spectatorJoinAck.error.message);
      await spectatorCredentialPromise;
      const oldOpeningMove = spectatorJoinAck.data.snapshot.gameView.legalMoves[0];
      if (oldOpeningMove === undefined) throw new Error("The initial match must contain a legal move.");

      now += 15_000;
      const ended = await white.timeout(3_000).emitWithAck("match:resign", {
        revision: spectatorJoinAck.data.snapshot.revision,
      });
      expect(ended).toMatchObject({
        ok: true,
        data: {
          snapshot: {
            revision: spectatorJoinAck.data.snapshot.revision + 1,
            matchNumber: 1,
            phase: "finished",
            clock: { whiteMs: 585_000, blackMs: 600_000, activeSide: null, running: false },
          },
        },
      });
      if (!ended.ok) throw new Error(ended.error.message);
      const endedSnapshot = ended.data.snapshot;

      const firstVote = await black.timeout(3_000).emitWithAck("rematch:vote", { revision: endedSnapshot.revision });
      expect(firstVote).toMatchObject({
        ok: true,
        data: { snapshot: {
          revision: endedSnapshot.revision + 1,
          matchNumber: 1,
          phase: "finished",
          rematchVotes: { white: false, black: true },
        } },
      });
      if (!firstVote.ok) throw new Error(firstVote.error.message);

      const duplicateVote = await black.timeout(3_000).emitWithAck("rematch:vote", {
        revision: firstVote.data.snapshot.revision,
      });
      expect(duplicateVote).toMatchObject({
        ok: true,
        data: { snapshot: {
          revision: firstVote.data.snapshot.revision,
          matchNumber: 1,
          phase: "finished",
          rematchVotes: { white: false, black: true },
        } },
      });
      expect((await spectator.timeout(3_000).emitWithAck("rematch:vote", {
        revision: firstVote.data.snapshot.revision,
      }))).toMatchObject({ ok: false, error: { code: "not-your-turn" } });

      now += 5_000;
      const whiteRematchBroadcast = waitForSnapshot(white, (snapshot) => snapshot.matchNumber === 2);
      const blackRematchBroadcast = waitForSnapshot(black, (snapshot) => snapshot.matchNumber === 2);
      const spectatorRematchBroadcast = waitForSnapshot(spectator, (snapshot) => snapshot.matchNumber === 2);
      const secondVote = await white.timeout(3_000).emitWithAck("rematch:vote", {
        revision: firstVote.data.snapshot.revision,
      });
      expect(secondVote).toMatchObject({
        ok: true,
        data: { snapshot: {
          revision: firstVote.data.snapshot.revision + 1,
          matchNumber: 2,
          phase: "playing",
          viewerSide: "black",
          rematchVotes: { white: false, black: false },
          drawOffer: null,
          clock: { whiteMs: 600_000, blackMs: 600_000, activeSide: "white", running: true },
          gameView: { turn: "white", history: [], result: null },
          players: {
            white: { name: "Rematch Black", side: "white" },
            black: { name: "Rematch White", side: "black" },
          },
          spectatorCount: 1,
        } },
      });
      const [whiteAfterRematch, blackAfterRematch, spectatorAfterRematch] = await Promise.all([
        whiteRematchBroadcast,
        blackRematchBroadcast,
        spectatorRematchBroadcast,
      ]);
      expect(whiteAfterRematch.viewerSide).toBe("black");
      expect(blackAfterRematch.viewerSide).toBe("white");
      expect(spectatorAfterRematch).toMatchObject({
        matchNumber: 2,
        phase: "playing",
        viewerSide: null,
        spectatorCount: 1,
        clock: { whiteMs: 600_000, blackMs: 600_000, activeSide: "white", running: true },
      });
      expect(spectatorAfterRematch.gameView).toEqual(secondVote.ok ? secondVote.data.snapshot.gameView : null);

      const oldMove = await black.timeout(3_000).emitWithAck("game:move", {
        revision: spectatorJoinAck.data.snapshot.revision,
        from: oldOpeningMove.from,
        path: [...oldOpeningMove.path],
      });
      expect(oldMove).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      const extraVote = await black.timeout(3_000).emitWithAck("rematch:vote", {
        revision: secondVote.ok ? secondVote.data.snapshot.revision : -1,
      });
      expect(extraVote).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(runtime.registry.snapshotsForRoom(createAck.data.code).map((snapshot) => snapshot.matchNumber))
        .toEqual([2, 2, 2]);
    } finally {
      white?.disconnect();
      black?.disconnect();
      spectator?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("publishes an expired recovery seat from the regular maintenance tick", async () => {
    let now = 100_000;
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, {
      clockTickMs: 10,
      registryOptions: { now: () => now },
    });
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const clientOptions = {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
      };
      white = io(origin, clientOptions) as TestSocket;
      black = io(origin, clientOptions) as TestSocket;
      const whiteConnected = waitForConnect(white);
      const blackConnected = waitForConnect(black);
      white.connect();
      black.connect();
      await Promise.all([whiteConnected, blackConnected]);

      const credentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "Recovery White",
        side: "white",
        timeControl: { kind: "rapid", initialMs: 600_000, incrementMs: 5_000 },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      await credentialPromise;

      const blackCredentialPromise = waitForCredential(black);
      const joinAck = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Recovery Black",
        code: createAck.data.code,
      });
      expect(joinAck.ok).toBe(true);
      if (!joinAck.ok) throw new Error(joinAck.error.message);
      await blackCredentialPromise;

      const disconnectedUpdatePromise = waitForSnapshot(black, (snapshot) => snapshot.players.white?.connected === false);
      white.disconnect();
      const disconnected = await disconnectedUpdatePromise;
      expect(disconnected.players.white).toMatchObject({
        name: "Recovery White",
        connected: false,
        recoveryDeadlineMs: now + 120_000,
      });
      expect(disconnected.phase).toBe("playing");

      const expiredUpdatePromise = waitForSnapshot(black, (snapshot) => snapshot.phase === "finished");
      now += 120_000;
      const expired = await expiredUpdatePromise;
      expect(expired).toMatchObject({
        phase: "finished",
        players: { white: null, black: { name: "Recovery Black", connected: true } },
        gameView: { result: { state: "won", winner: "black", reason: "disconnection" } },
        clock: { whiteMs: 480_000, blackMs: 600_000, activeSide: null, running: false },
      });
    } finally {
      white?.disconnect();
      black?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("accepts a reconnect credential only through room:resume", async () => {
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, { clockTickMs: 20 });
    let original: TestSocket | undefined;
    let reconnect: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const options = { autoConnect: false, forceNew: true, reconnection: false, transports: ["websocket"] };
      original = io(origin, options) as TestSocket;
      const connected = waitForConnect(original);
      original.connect();
      await connected;

      const credentialPromise = waitForCredential(original);
      const createAck = await original.timeout(3_000).emitWithAck("room:create", {
        name: "Reconnecting Player",
        side: "black",
        timeControl: { kind: "untimed" },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      const credential = await credentialPromise;
      original.disconnect();

      reconnect = io(origin, { ...options, auth: { sessionToken: credential.sessionToken } }) as TestSocket;
      const reconnected = waitForConnect(reconnect);
      reconnect.connect();
      await reconnected;
      const unboundLeave = await reconnect.timeout(3_000).emitWithAck("room:leave");
      expect(unboundLeave).toMatchObject({
        ok: false,
        error: { code: "unauthorized" },
      });

      const renewedCredentialPromise = waitForCredential(reconnect);
      const resumeAck = await reconnect.timeout(3_000).emitWithAck("room:resume", {
        code: createAck.data.code,
        sessionToken: credential.sessionToken,
      });
      expect(resumeAck.ok).toBe(true);
      if (!resumeAck.ok) throw new Error(resumeAck.error.message);
      expect(resumeAck.data.snapshot.viewerSide).toBe("black");
      expect(resumeAck.data.snapshot.players.black?.connected).toBe(true);
      expect(JSON.stringify(resumeAck)).not.toContain(credential.sessionToken);
      expect((await renewedCredentialPromise).sessionToken).toBe(credential.sessionToken);
    } finally {
      original?.disconnect();
      reconnect?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("restores a reserved seat only with its credential and ignores the replaced socket's disconnect", async () => {
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, { clockTickMs: 20 });
    let original: TestSocket | undefined;
    let replacement: TestSocket | undefined;
    let observer: TestSocket | undefined;
    let claimant: TestSocket | undefined;
    let recovery: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const origin = `http://127.0.0.1:${address.port}`;
      const options = { autoConnect: false, forceNew: true, reconnection: false, transports: ["websocket"] };

      original = io(origin, options) as TestSocket;
      const originalConnected = waitForConnect(original);
      original.connect();
      await originalConnected;
      const originalCredentialPromise = waitForCredential(original);
      const created = await original.timeout(3_000).emitWithAck("room:create", {
        name: "Reserved White",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const credential = await originalCredentialPromise;

      observer = io(origin, options) as TestSocket;
      const observerConnected = waitForConnect(observer);
      observer.connect();
      await observerConnected;
      const observerCredentialPromise = waitForCredential(observer);
      const observed = await observer.timeout(3_000).emitWithAck("room:join", {
        name: "Room Observer",
        code: created.data.code,
        role: "spectator",
      });
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw new Error(observed.error.message);
      await observerCredentialPromise;
      expect(observed.data.snapshot.viewerSide).toBeNull();

      replacement = io(origin, options) as TestSocket;
      const replacementConnected = waitForConnect(replacement);
      replacement.connect();
      await replacementConnected;
      const replacedDisconnect = waitForDisconnect(original);
      const replacementCredentialPromise = waitForCredential(replacement);
      const resumedWhileConnected = await replacement.timeout(3_000).emitWithAck("room:resume", {
        code: created.data.code,
        sessionToken: credential.sessionToken,
      });
      expect(resumedWhileConnected.ok).toBe(true);
      if (!resumedWhileConnected.ok) throw new Error(resumedWhileConnected.error.message);
      expect(resumedWhileConnected.data.snapshot.viewerSide).toBe("white");
      await replacementCredentialPromise;
      await replacedDisconnect;
      expect(runtime.registry.snapshotForSession(credential.sessionToken)?.players.white).toMatchObject({
        name: "Reserved White",
        connected: true,
        recoveryDeadlineMs: null,
      });

      const offlineUpdate = waitForSnapshot(observer, (snapshot) => snapshot.players.white?.connected === false);
      replacement.disconnect();
      const reservedSnapshot = await offlineUpdate;
      expect(reservedSnapshot.phase).toBe("waiting");
      expect(reservedSnapshot.players.white).toMatchObject({
        name: "Reserved White",
        connected: false,
        recoveryDeadlineMs: expect.any(Number),
      });

      claimant = io(origin, options) as TestSocket;
      const claimantConnected = waitForConnect(claimant);
      claimant.connect();
      await claimantConnected;
      const claimantCredentialPromise = waitForCredential(claimant);
      const copiedNameAndRoom = await claimant.timeout(3_000).emitWithAck("room:join", {
        name: "Reserved White",
        code: created.data.code,
        role: "player",
      });
      expect(copiedNameAndRoom.ok).toBe(true);
      if (!copiedNameAndRoom.ok) throw new Error(copiedNameAndRoom.error.message);
      await claimantCredentialPromise;
      expect(copiedNameAndRoom.data.snapshot).toMatchObject({
        viewerSide: null,
        phase: "waiting",
        players: { white: { connected: false, name: "Reserved White" }, black: null },
      });

      recovery = io(origin, options) as TestSocket;
      const recoveryConnected = waitForConnect(recovery);
      recovery.connect();
      await recoveryConnected;
      const recoveryCredentialPromise = waitForCredential(recovery);
      const recoveryAck = await recovery.timeout(3_000).emitWithAck("room:resume", {
        code: created.data.code,
        sessionToken: credential.sessionToken,
      });
      expect(recoveryAck.ok).toBe(true);
      if (!recoveryAck.ok) throw new Error(recoveryAck.error.message);
      expect(recoveryAck.data.snapshot).toMatchObject({
        viewerSide: "white",
        phase: "waiting",
        players: { white: { connected: true, name: "Reserved White", recoveryDeadlineMs: null }, black: null },
      });
      await recoveryCredentialPromise;
    } finally {
      original?.disconnect();
      replacement?.disconnect();
      observer?.disconnect();
      claimant?.disconnect();
      recovery?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });

  it("enforces exact origin, missing-Origin, payload-size, rate, and registry limits over transport", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://games.example");
    const httpServer = createServer(express());
    const runtime = attachSocketRuntime(httpServer, {
      registryOptions: { limits: { rooms: 1, sessions: 3, spectatorsPerRoom: 0 } },
      maxMessageBytes: 1_024,
      maxEventsPerWindow: 2,
      rateWindowMs: 10_000,
      clockTickMs: 20,
    });
    let wrongOrigin: TestSocket | undefined;
    let white: TestSocket | undefined;
    let black: TestSocket | undefined;
    let spectator: TestSocket | undefined;
    let tooLarge: TestSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const baseOptions = { autoConnect: false, forceNew: true, reconnection: false, transports: ["websocket"] };

      wrongOrigin = io(endpoint, { ...baseOptions, extraHeaders: { Origin: "https://attacker.example" } }) as TestSocket;
      const wrongOriginRejected = waitForConnectFailure(wrongOrigin);
      wrongOrigin.connect();
      await wrongOriginRejected;
      expect(wrongOrigin.connected).toBe(false);

      // This exact configured origin is allowed even though a local reverse-proxy test
      // connects through a different Host header.
      white = io(endpoint, { ...baseOptions, extraHeaders: { Origin: "https://games.example" } }) as TestSocket;
      const whiteConnected = waitForConnect(white);
      white.connect();
      await whiteConnected;
      const whiteCredentialPromise = waitForCredential(white);
      const createAck = await white.timeout(3_000).emitWithAck("room:create", {
        name: "White",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(createAck.ok).toBe(true);
      if (!createAck.ok) throw new Error(createAck.error.message);
      await whiteCredentialPromise;

      // Missing Origin is the explicit non-browser policy: allow the connection and
      // apply the same room/session authorization and capacity checks afterward.
      black = io(endpoint, baseOptions) as TestSocket;
      const blackConnected = waitForConnect(black);
      black.connect();
      await blackConnected;
      const fullRooms = await black.timeout(3_000).emitWithAck("room:create", {
        name: "Extra Room",
        side: "white",
        timeControl: { kind: "untimed" },
      });
      expect(fullRooms).toMatchObject({ ok: false, error: { code: "room-capacity" } });
      const blackCredentialPromise = waitForCredential(black);
      const joinAck = await black.timeout(3_000).emitWithAck("room:join", {
        name: "Black",
        code: createAck.data.code,
      });
      expect(joinAck.ok).toBe(true);
      const blackCredential = await blackCredentialPromise;

      spectator = io(endpoint, baseOptions) as TestSocket;
      const spectatorConnected = waitForConnect(spectator);
      spectator.connect();
      await spectatorConnected;
      const noSpectatorSeat = await spectator.timeout(3_000).emitWithAck("room:join", {
        name: "Spectator",
        code: createAck.data.code,
        role: "spectator",
      });
      expect(noSpectatorSeat).toMatchObject({ ok: false, error: { code: "room-full" } });
      expect(runtime.registry.sessionCount).toBe(2);

      const rejectedSecret = "do-not-echo-this-secret";
      const malformedMove = await white.timeout(3_000).emitWithAck("game:move", {
        revision: -1,
        from: rejectedSecret,
        path: [],
        sessionToken: rejectedSecret,
      } as never);
      expect(malformedMove).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(JSON.stringify(malformedMove)).not.toContain(rejectedSecret);

      const rateLimitedError = waitForServerError(white);
      const rateLimitedDisconnect = waitForDisconnect(white);
      white.emit("room:leave", () => undefined);
      expect(await rateLimitedError).toMatchObject({ code: "rate-limited" });
      await rateLimitedDisconnect;
      expect(runtime.registry.snapshotForSession(blackCredential.sessionToken).phase).toBe("playing");

      // A packet larger than the configured 1 KiB Engine.IO limit is dropped by
      // the transport before its room handler can mutate registry state.
      tooLarge = io(endpoint, baseOptions) as TestSocket;
      const tooLargeConnected = waitForConnect(tooLarge);
      tooLarge.connect();
      await tooLargeConnected;
      const largePayloadDisconnect = waitForDisconnect(tooLarge);
      tooLarge.emit("room:create", {
        name: "x".repeat(5_000),
        side: "white",
        timeControl: { kind: "untimed" },
      } as never, () => undefined);
      await largePayloadDisconnect;
      expect(runtime.registry.roomCount).toBe(1);
      expect(runtime.registry.sessionCount).toBe(2);
    } finally {
      wrongOrigin?.disconnect();
      white?.disconnect();
      black?.disconnect();
      spectator?.disconnect();
      tooLarge?.disconnect();
      await runtime.close();
      await closeHttpServer(httpServer);
      expect(runtime.io.sockets.sockets.size).toBe(0);
    }
  });
});
