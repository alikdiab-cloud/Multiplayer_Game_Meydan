import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClientToServerEvents,
  RoomSnapshot,
  ServerToClientEvents,
  SessionCredentials,
} from "../shared/protocol.js";
import { startDevelopmentServer, type RunningDevelopmentServer } from "../server/index.js";
import { startProductionServer, type RunningProductionServer } from "../server/production.js";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const PUBLIC_ORIGIN = "https://dama.example";
const LOOPBACK_ORIGIN = "http://127.0.0.1";
const ACK_TIMEOUT_MS = 3_000;

let developmentServer: RunningDevelopmentServer | undefined;
let productionServer: RunningProductionServer | undefined;
const clients: TestSocket[] = [];
const pendingWaitCleanups = new Set<() => void>();

afterEach(async () => {
  for (const cleanup of pendingWaitCleanups) cleanup();
  pendingWaitCleanups.clear();
  for (const client of clients.splice(0)) client.disconnect();

  const development = developmentServer;
  developmentServer = undefined;
  const production = productionServer;
  productionServer = undefined;
  if (development !== undefined) {
    await development.close();
    expect(development.httpServer.listening).toBe(false);
    expect(development.socketRuntime.io.sockets.sockets.size).toBe(0);
    expect(development.socketRuntime.registry.roomCount).toBe(0);
    expect(development.socketRuntime.registry.sessionCount).toBe(0);
  }
  if (production !== undefined) {
    await production.close();
    expect(production.httpServer.listening).toBe(false);
    expect(production.socketRuntime.io.sockets.sockets.size).toBe(0);
  }
});

function socketFor(server: RunningDevelopmentServer, origin = PUBLIC_ORIGIN): TestSocket {
  const socket = io(`${LOOPBACK_ORIGIN}:${server.port}`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    timeout: ACK_TIMEOUT_MS,
    extraHeaders: { Origin: origin },
  }) as TestSocket;
  clients.push(socket);
  return socket;
}

function waitForConnect(socket: TestSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      pendingWaitCleanups.delete(cancel);
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      pendingWaitCleanups.delete(cancel);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const timeout = setTimeout(() => finish(new Error("Socket connection timed out.")), ACK_TIMEOUT_MS);
    pendingWaitCleanups.add(cancel);
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });
}

function waitForConnectFailure(socket: TestSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      pendingWaitCleanups.delete(cancel);
    };
    const finish = (error: Error, accepted: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      pendingWaitCleanups.delete(cancel);
      if (accepted) reject(new Error("A connection from a rejected origin was accepted."));
      else resolve(error);
    };
    const onConnect = () => finish(new Error("Origin policy unexpectedly allowed this client."), true);
    const onError = (error: Error) => finish(error, false);
    const timeout = setTimeout(
      () => finish(new Error("Origin policy did not reject the connection."), true),
      ACK_TIMEOUT_MS,
    );
    pendingWaitCleanups.add(cancel);
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });
}

function waitForCredential(socket: TestSocket): Promise<SessionCredentials> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timeout);
      socket.off("session:credential", onCredential);
      pendingWaitCleanups.delete(cancel);
    };
    const finish = (credential?: SessionCredentials) => {
      clearTimeout(timeout);
      socket.off("session:credential", onCredential);
      pendingWaitCleanups.delete(cancel);
      if (credential === undefined) reject(new Error("Credential wait cancelled during test cleanup."));
      else resolve(credential);
    };
    const onCredential = (credential: SessionCredentials) => finish(credential);
    const timeout = setTimeout(
      () => finish(undefined),
      ACK_TIMEOUT_MS,
    );
    pendingWaitCleanups.add(cancel);
    socket.once("session:credential", onCredential);
  });
}

function waitForSnapshot(socket: TestSocket, predicate: (snapshot: RoomSnapshot) => boolean): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timeout);
      socket.off("room:snapshot", onSnapshot);
      pendingWaitCleanups.delete(cancel);
    };
    const finish = (snapshot?: RoomSnapshot) => {
      clearTimeout(timeout);
      socket.off("room:snapshot", onSnapshot);
      pendingWaitCleanups.delete(cancel);
      if (snapshot === undefined) reject(new Error("Snapshot wait cancelled or timed out."));
      else resolve(snapshot);
    };
    const onSnapshot = (snapshot: RoomSnapshot) => {
      if (predicate(snapshot)) finish(snapshot);
    };
    const timeout = setTimeout(() => finish(undefined), ACK_TIMEOUT_MS);
    pendingWaitCleanups.add(cancel);
    socket.on("room:snapshot", onSnapshot);
  });
}

async function connect(socket: TestSocket): Promise<void> {
  const connected = waitForConnect(socket);
  socket.connect();
  await connected;
}

function expectSuccess<T extends { ok: boolean }>(
  acknowledgment: T,
): asserts acknowledgment is Extract<T, { ok: true }> {
  expect(acknowledgment.ok).toBe(true);
  if (!acknowledgment.ok) throw new Error("Expected the server to acknowledge this request.");
}

describe("loopback transport", () => {
  it("serves health and exercises authenticated room commands through HTTP and Socket.IO", async () => {
    let nextToken = 0;
    developmentServer = await startDevelopmentServer({
      port: 0,
      logUrls: false,
      socketRuntimeOptions: {
        publicOrigin: PUBLIC_ORIGIN,
        allowMissingOrigin: false,
        clockTickMs: 60_000,
        registryOptions: {
          generateRoomCode: () => "TRNS23",
          generateSessionToken: () => `transport-session-${++nextToken}-abcdefghijklmnopqrstuvwxyz`,
          limits: { rooms: 1, sessions: 4, spectatorsPerRoom: 1 },
        },
      },
    });

    const health = await fetch(`${LOOPBACK_ORIGIN}:${developmentServer.port}/api/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const white = socketFor(developmentServer);
    const black = socketFor(developmentServer);
    const spectator = socketFor(developmentServer);
    await Promise.all([connect(white), connect(black), connect(spectator)]);
    const credentialsByViewer = new Map<TestSocket, SessionCredentials[]>([
      [white, []],
      [black, []],
      [spectator, []],
    ]);
    for (const [socket, received] of credentialsByViewer) {
      socket.on("session:credential", (credential) => received.push(credential));
    }

    const whiteCredentialPromise = waitForCredential(white);
    const malformedCreate = await white.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", {
      name: "",
      side: "white",
      timeControl: { kind: "untimed" },
    });
    expect(malformedCreate).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(developmentServer.socketRuntime.registry.roomCount).toBe(0);

    const createAck = await white.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", {
      name: "Dama White",
      side: "white",
      timeControl: { kind: "untimed" },
    });
    expectSuccess(createAck);
    const whiteCredential = await whiteCredentialPromise;
    expect(createAck.data.code).toBe("TRNS23");
    expect(createAck.data.snapshot.viewerSide).toBe("white");
    expect(JSON.stringify(createAck)).not.toContain(whiteCredential.sessionToken);

    const whitePlayingSnapshotPromise = waitForSnapshot(white, (snapshot) => snapshot.phase === "playing");
    const blackCredentialPromise = waitForCredential(black);
    const joinAck = await black.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", {
      name: "Dama Black",
      code: createAck.data.code,
    });
    expectSuccess(joinAck);
    const blackCredential = await blackCredentialPromise;
    const whitePlayingSnapshot = await whitePlayingSnapshotPromise;
    expect(joinAck.data.snapshot.viewerSide).toBe("black");
    expect(whitePlayingSnapshot.viewerSide).toBe("white");

    const spectatorCredentialPromise = waitForCredential(spectator);
    const spectatorAck = await spectator.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", {
      name: "Dama Viewer",
      code: createAck.data.code,
      role: "spectator",
    });
    expectSuccess(spectatorAck);
    const spectatorCredential = await spectatorCredentialPromise;
    expect(spectatorAck.data.snapshot.viewerSide).toBeNull();
    expect(spectatorAck.data.snapshot.spectatorCount).toBe(1);

    const activeMove = spectatorAck.data.snapshot.gameView.legalMoves[0];
    if (activeMove === undefined) throw new Error("The initial position did not provide a legal move.");
    const spectatorRequest = {
      revision: spectatorAck.data.snapshot.revision,
      from: activeMove.from,
      path: [...activeMove.path],
    };
    const beforeRejectedCommands = developmentServer.socketRuntime.registry.snapshotForSession(
      whiteCredential.sessionToken,
    );

    // Send the attacks as real socket events. This proves server-side checks do
    // not depend on disabled or hidden client controls.
    const spectatorMoveAck = await spectator.timeout(ACK_TIMEOUT_MS).emitWithAck(
      "game:move",
      spectatorRequest,
    );
    expect(spectatorMoveAck).toMatchObject({ ok: false, error: { code: "not-your-turn" } });
    const malformedMoveAck = await white.timeout(ACK_TIMEOUT_MS).emitWithAck("game:move", {
      revision: "wrong-type",
      from: activeMove.from,
      path: [...activeMove.path],
    } as never);
    expect(malformedMoveAck).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const illegalMoveAck = await white.timeout(ACK_TIMEOUT_MS).emitWithAck("game:move", {
      revision: spectatorAck.data.snapshot.revision,
      from: activeMove.from,
      path: ["7|7"],
    });
    expect(illegalMoveAck).toMatchObject({ ok: false, error: { code: "invalid-move" } });
    const afterRejectedCommands = developmentServer.socketRuntime.registry.snapshotForSession(
      whiteCredential.sessionToken,
    );
    expect(afterRejectedCommands.revision).toBe(beforeRejectedCommands.revision);
    expect(afterRejectedCommands.gameView).toEqual(beforeRejectedCommands.gameView);

    const whiteMoveBroadcast = waitForSnapshot(white, (snapshot) => snapshot.gameView.history.length === 1);
    const blackMoveBroadcast = waitForSnapshot(black, (snapshot) => snapshot.gameView.history.length === 1);
    const spectatorMoveBroadcast = waitForSnapshot(spectator, (snapshot) => snapshot.gameView.history.length === 1);
    const whiteMoveAck = await white.timeout(ACK_TIMEOUT_MS).emitWithAck("game:move", spectatorRequest);
    expectSuccess(whiteMoveAck);
    const [whiteAfterMove, blackAfterMove, spectatorAfterMove] = await Promise.all([
      whiteMoveBroadcast,
      blackMoveBroadcast,
      spectatorMoveBroadcast,
    ]);
    expect(whiteAfterMove.viewerSide).toBe("white");
    expect(blackAfterMove.viewerSide).toBe("black");
    expect(spectatorAfterMove.viewerSide).toBeNull();
    expect(whiteAfterMove.gameView.history).toHaveLength(1);
    expect(whiteAfterMove.gameView.position).toEqual(blackAfterMove.gameView.position);
    expect(whiteAfterMove.gameView.position).toEqual(spectatorAfterMove.gameView.position);

    const staleMoveAck = await white.timeout(ACK_TIMEOUT_MS).emitWithAck("game:move", spectatorRequest);
    expect(staleMoveAck).toMatchObject({ ok: false, error: { code: "stale-revision" } });
    const blackLegalMove = blackAfterMove.gameView.legalMoves[0];
    if (blackLegalMove === undefined) throw new Error("Black did not receive a legal reply.");
    const blackMoveSnapshot = waitForSnapshot(white, (snapshot) => snapshot.gameView.history.length === 2);
    const blackMoveAck = await black.timeout(ACK_TIMEOUT_MS).emitWithAck("game:move", {
      revision: blackAfterMove.revision,
      from: blackLegalMove.from,
      path: [...blackLegalMove.path],
    });
    expectSuccess(blackMoveAck);
    const whiteAfterBlackMove = await blackMoveSnapshot;
    expect(whiteAfterBlackMove.gameView.history).toHaveLength(2);

    const replacementWhite = socketFor(developmentServer);
    await connect(replacementWhite);
    const resumeAck = await replacementWhite.timeout(ACK_TIMEOUT_MS).emitWithAck("room:resume", {
      code: createAck.data.code,
      sessionToken: whiteCredential.sessionToken,
    });
    expectSuccess(resumeAck);
    expect(resumeAck.data.snapshot.viewerSide).toBe("white");
    expect(white.connected).toBe(false);
    expect(developmentServer.socketRuntime.registry.sessionCount).toBe(3);

    black.disconnect();
    const reconnectBlack = socketFor(developmentServer);
    await connect(reconnectBlack);
    const reconnectAck = await reconnectBlack.timeout(ACK_TIMEOUT_MS).emitWithAck("room:resume", {
      code: createAck.data.code,
      sessionToken: blackCredential.sessionToken,
    });
    expectSuccess(reconnectAck);
    expect(reconnectAck.data.snapshot.viewerSide).toBe("black");
    expect(reconnectAck.data.snapshot.phase).toBe("playing");
    expect(developmentServer.socketRuntime.registry.sessionCount).toBe(3);

    const serializedSnapshots = [
      createAck.data.snapshot,
      joinAck.data.snapshot,
      spectatorAck.data.snapshot,
      whiteAfterMove,
      blackAfterMove,
      spectatorAfterMove,
      whiteAfterBlackMove,
      resumeAck.data.snapshot,
      reconnectAck.data.snapshot,
    ].map((snapshot) => JSON.stringify(snapshot));
    for (const credential of [whiteCredential, blackCredential, spectatorCredential]) {
      expect(serializedSnapshots.every((serialized) => !serialized.includes(credential.sessionToken))).toBe(true);
    }
    const serializedPublicPayloads = [
      createAck,
      joinAck,
      spectatorAck,
      whiteMoveAck,
      blackMoveAck,
      ...serializedSnapshots,
    ].map((payload) => typeof payload === "string" ? payload : JSON.stringify(payload));
    for (const credential of [whiteCredential, blackCredential, spectatorCredential]) {
      expect(serializedPublicPayloads.every((serialized) => !serialized.includes(credential.sessionToken))).toBe(true);
    }
    expect(credentialsByViewer.get(white)).toEqual([whiteCredential]);
    expect(credentialsByViewer.get(black)).toEqual([blackCredential]);
    expect(credentialsByViewer.get(spectator)).toEqual([spectatorCredential]);
  });

  it("rejects foreign and missing origins without relaxing the configured policy", async () => {
    developmentServer = await startDevelopmentServer({
      port: 0,
      logUrls: false,
      socketRuntimeOptions: {
        publicOrigin: PUBLIC_ORIGIN,
        allowMissingOrigin: false,
        clockTickMs: 60_000,
      },
    });

    const accepted = socketFor(developmentServer);
    await connect(accepted);

    const foreignOrigin = socketFor(developmentServer, "https://attacker.example");
    const rejectedForeignOrigin = waitForConnectFailure(foreignOrigin);
    foreignOrigin.connect();
    await expect(rejectedForeignOrigin).resolves.toBeInstanceOf(Error);
    expect(foreignOrigin.connected).toBe(false);

    const missingOrigin = io(`${LOOPBACK_ORIGIN}:${developmentServer.port}`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      timeout: ACK_TIMEOUT_MS,
    }) as TestSocket;
    clients.push(missingOrigin);
    const rejectedMissingOrigin = waitForConnectFailure(missingOrigin);
    missingOrigin.connect();
    await expect(rejectedMissingOrigin).resolves.toBeInstanceOf(Error);
    expect(missingOrigin.connected).toBe(false);

    const health = await fetch(`${LOOPBACK_ORIGIN}:${developmentServer.port}/api/health`);
    expect(health.status).toBe(200);
  });

  it("enforces configured room and spectator limits through socket acknowledgments", async () => {
    developmentServer = await startDevelopmentServer({
      port: 0,
      logUrls: false,
      socketRuntimeOptions: {
        publicOrigin: PUBLIC_ORIGIN,
        allowMissingOrigin: false,
        clockTickMs: 60_000,
        registryOptions: {
          generateRoomCode: (() => {
            let nextCode = 0;
            return () => ["LIMIT2", "LIMIT3", "LIMIT4"][nextCode++] ?? "LIMIT4";
          })(),
          limits: { rooms: 1, sessions: 4, spectatorsPerRoom: 1 },
        },
      },
    });
    const [white, black, viewer, overflowViewer] = Array.from({ length: 4 }, () => socketFor(developmentServer!));
    await Promise.all([connect(white!), connect(black!), connect(viewer!), connect(overflowViewer!)]);

    const createAck = await white!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", {
      name: "Limit White",
      side: "white",
      timeControl: { kind: "untimed" },
    });
    expectSuccess(createAck);
    const joinAck = await black!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", {
      name: "Limit Black",
      code: createAck.data.code,
    });
    expectSuccess(joinAck);
    const spectatorAck = await viewer!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", {
      name: "Limit Viewer",
      code: createAck.data.code,
      role: "spectator",
    });
    expectSuccess(spectatorAck);

    const extraSpectatorAck = await overflowViewer!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", {
      name: "Overflow Viewer",
      code: createAck.data.code,
      role: "spectator",
    });
    expect(extraSpectatorAck).toMatchObject({ ok: false, error: { code: "room-full" } });
    const roomCapacityAck = await overflowViewer!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", {
      name: "Capacity Probe",
      side: "white",
      timeControl: { kind: "untimed" },
    });
    expect(roomCapacityAck).toMatchObject({ ok: false, error: { code: "room-capacity" } });
    expect(developmentServer.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 3 });

    const leaveAck = await viewer!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:leave");
    expect(leaveAck).toEqual({ ok: true, data: { left: true } });
    const capacityRecoveryAck = await overflowViewer!.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", {
      name: "Recovered Viewer",
      code: createAck.data.code,
      role: "spectator",
    });
    expectSuccess(capacityRecoveryAck);
    expect(capacityRecoveryAck.data.snapshot.spectatorCount).toBe(1);
    expect(developmentServer.socketRuntime.registry.sessionCount).toBe(3);
  });

  it("rejects an additional room when configured session capacity is full", async () => {
    developmentServer = await startDevelopmentServer({
      port: 0,
      logUrls: false,
      socketRuntimeOptions: {
        publicOrigin: PUBLIC_ORIGIN,
        allowMissingOrigin: false,
        clockTickMs: 60_000,
        registryOptions: { limits: { rooms: 2, sessions: 1, spectatorsPerRoom: 1 } },
      },
    });
    const owner = socketFor(developmentServer);
    const overflow = socketFor(developmentServer);
    await Promise.all([connect(owner), connect(overflow)]);

    const createAck = await owner.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", {
      name: "Session Owner",
      side: "white",
      timeControl: { kind: "untimed" },
    });
    expectSuccess(createAck);
    const capacityAck = await overflow.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", {
      name: "Session Overflow",
      side: "white",
      timeControl: { kind: "untimed" },
    });
    expect(capacityAck).toMatchObject({ ok: false, error: { code: "session-capacity" } });
    expect(developmentServer.socketRuntime.registry).toMatchObject({ roomCount: 1, sessionCount: 1 });
  });
});

describe("production static-serving boundary", () => {
  it("serves only the client directory and API health, not source, environment, or parent documents", async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const parentDirectory = await mkdtemp(join(tmpdir(), "meydan-transport-static-"));
    const clientDirectory = join(parentDirectory, "client");
    const sentinel = "PARENT_WORKSPACE_SECRET_SENTINEL";
    await mkdir(join(clientDirectory, "assets"), { recursive: true });
    await mkdir(join(parentDirectory, "server"), { recursive: true });
    await mkdir(join(parentDirectory, "src"), { recursive: true });
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html><title>Dama</title><main>CLIENT_ROOT</main>");
    await writeFile(join(clientDirectory, "assets", "app.js"), "console.log('CLIENT_ASSET');");
    await writeFile(join(clientDirectory, ".env"), `CLIENT_SECRET=${sentinel}`);
    await writeFile(join(parentDirectory, "README.md"), sentinel);
    await writeFile(join(parentDirectory, ".env"), `SECRET=${sentinel}`);
    await writeFile(join(parentDirectory, ".env.local"), `SECRET=${sentinel}`);
    await writeFile(join(parentDirectory, "server", "production.ts"), `export const secret = "${sentinel}";`);
    await writeFile(join(parentDirectory, "src", "main.tsx"), `export const secret = "${sentinel}";`);
    await writeFile(join(parentDirectory, "package.json"), JSON.stringify({ name: sentinel }));
    await writeFile(join(parentDirectory, "WORKSPACE.md"), sentinel);

    try {
      productionServer = await startProductionServer({ port: 0, clientDirectory, logUrls: false });
      const baseUrl = `${LOOPBACK_ORIGIN}:${productionServer.port}`;

      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok" });
      const apiMiss = await fetch(`${baseUrl}/api/internal`);
      expect(apiMiss.status).toBe(404);

      const root = await fetch(baseUrl, { headers: { Accept: "text/html" } });
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("CLIENT_ROOT");
      const asset = await fetch(`${baseUrl}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("CLIENT_ASSET");

      for (const path of [
        "/README.md",
        "/WORKSPACE.md",
        "/server/production.ts",
        "/package.json",
        "/.env",
        "/.env.local",
        "/src/main.tsx",
        "/%2e%2e/README.md",
      ]) {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        const body = await response.text();
        expect(response.status, `${path} must not be served`).toBe(404);
        expect(body).not.toContain(sentinel);
      }
      expect(await readFile(join(parentDirectory, "README.md"), "utf8")).toContain(sentinel);
    } finally {
      const server = productionServer;
      productionServer = undefined;
      if (server !== undefined) {
        await server.close();
        expect(server.httpServer.listening).toBe(false);
        expect(server.socketRuntime.io.sockets.sockets.size).toBe(0);
      }
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });
});
