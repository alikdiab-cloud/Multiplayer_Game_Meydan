import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  CreateRoomInputSchema,
  JoinRoomInputSchema,
  MoveRequestSchema,
  RevisionRequestSchema,
  RoomResumeInputSchema,
  type Acknowledgment,
  type ClientToServerEvents,
  type CreateRoomAcknowledgment,
  type JoinRoomAcknowledgment,
  type LeaveRoomAcknowledgment,
  type ProtocolError,
  type RoomMutationAcknowledgment,
  type RoomResumeInput,
  type ResumeRoomAcknowledgment,
  type ServerToClientEvents,
  type Side,
} from "../shared/protocol.js";
import { RoomRegistry, RoomRegistryError, type RoomRegistryOptions } from "./rooms.js";

export type SocketServerData = {
  sessionToken?: string;
  roomCode?: string;
  viewerSide?: Side | null;
  rateWindowStartedAt?: number;
  rateEventCount?: number;
  transportRejected?: boolean;
};

type InterServerEvents = Record<string, never>;
export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketServerData>;
export type GameSocketServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketServerData>;

export type SocketRuntimeOptions = {
  registry?: RoomRegistry;
  registryOptions?: RoomRegistryOptions;
  clockTickMs?: number;
  /** Exact public HTTP(S) origin for reverse proxy deployments; null disables the environment override. */
  publicOrigin?: string | null;
  /** Missing Origin is permitted for non-browser clients by default. */
  allowMissingOrigin?: boolean;
  maxMessageBytes?: number;
  maxEventsPerWindow?: number;
  rateWindowMs?: number;
};

export type SocketRuntime = {
  io: GameSocketServer;
  registry: RoomRegistry;
  close: () => Promise<void>;
};

const attachedServers = new WeakMap<HttpServer, SocketRuntime>();
const INTERNAL_ERROR: ProtocolError = {
  code: "internal-error",
  message: "The request could not be completed.",
};
const MISSING_ACK_ERROR: ProtocolError = {
  code: "invalid-input",
  message: "An acknowledgment callback is required for this request.",
};
export const DEFAULT_SOCKET_LIMITS = {
  clockTickMs: 250,
  maxMessageBytes: 64 * 1024,
  maxEventsPerWindow: 60,
  rateWindowMs: 10_000,
} as const;

const MAX_SOCKET_MESSAGE_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_WINDOW = 10_000;
const MAX_RATE_WINDOW_MS = 60_000;
const SUPPORTED_EVENTS = new Set([
  "room:create",
  "room:join",
  "room:resume",
  "room:leave",
  "game:move",
  "match:resign",
  "draw:offer",
  "draw:accept",
  "draw:decline",
  "rematch:vote",
]);

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin === "null"
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredPublicOrigin(options: SocketRuntimeOptions): string | null {
  const configured = options.publicOrigin === undefined
    ? process.env.PUBLIC_ORIGIN
    : options.publicOrigin ?? undefined;
  if (configured === undefined || configured.trim() === "") {
    return null;
  }
  const origin = normalizeOrigin(configured.trim());
  if (origin === null) {
    throw new RangeError("PUBLIC_ORIGIN must be an exact HTTP(S) origin without a path, query, or fragment.");
  }
  return origin;
}

function requestOriginAllowed(
  request: IncomingMessage,
  expectedPublicOrigin: string | null,
  allowMissingOrigin: boolean,
): boolean {
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin === undefined) {
    return allowMissingOrigin;
  }
  if (typeof suppliedOrigin !== "string") {
    return false;
  }
  const normalizedSupplied = normalizeOrigin(suppliedOrigin);
  if (normalizedSupplied === null) {
    return false;
  }
  if (expectedPublicOrigin !== null) {
    return normalizedSupplied === expectedPublicOrigin;
  }

  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) {
    return false;
  }
  const encrypted = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true;
  const expectedOrigin = normalizeOrigin(`${encrypted ? "https" : "http"}://${host}`);
  return expectedOrigin !== null && normalizedSupplied === expectedOrigin;
}

function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof RoomRegistryError) {
    return { code: error.code, message: error.message };
  }
  return INTERNAL_ERROR;
}

function requireAck(socket: GameSocket, acknowledge: unknown): boolean {
  if (socket.data.transportRejected === true) {
    return false;
  }
  if (typeof acknowledge === "function") {
    return true;
  }
  try { socket.emit("server:error", MISSING_ACK_ERROR); } catch { /* socket closed */ }
  return false;
}

function safeAcknowledge<T extends { ok: boolean }>(
  socket: GameSocket,
  acknowledge: unknown,
  response: T,
): void {
  if (typeof acknowledge === "function") {
    try {
      (acknowledge as (value: T) => void)(response);
    } catch {
      // A disconnected or malformed peer must not escape the event boundary.
    }
    return;
  }

  if (!response.ok && "error" in response) {
    try { socket.emit("server:error", response.error as ProtocolError); } catch { /* socket closed */ }
  }
}

function success<T>(data: T): Acknowledgment<T> {
  return { ok: true, data };
}

function failure(error: unknown): Acknowledgment<never> {
  return { ok: false, error: toProtocolError(error) };
}

function assertUnbound(socket: GameSocket): void {
  if (socket.data.sessionToken !== undefined) {
    throw new RoomRegistryError("session-conflict", "Leave the current room before joining another.");
  }
}

function clearSocketSession(socket: GameSocket): void {
  delete socket.data.sessionToken;
  delete socket.data.roomCode;
  delete socket.data.viewerSide;
}

export function attachSocketRuntime(httpServer: HttpServer, options: SocketRuntimeOptions = {}): SocketRuntime {
  if (attachedServers.has(httpServer)) {
    throw new Error("A Socket.IO room runtime is already attached to this HTTP server.");
  }

  const clockTickMs = options.clockTickMs ?? DEFAULT_SOCKET_LIMITS.clockTickMs;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_SOCKET_LIMITS.maxMessageBytes;
  const maxEventsPerWindow = options.maxEventsPerWindow ?? DEFAULT_SOCKET_LIMITS.maxEventsPerWindow;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_SOCKET_LIMITS.rateWindowMs;
  if (!Number.isSafeInteger(clockTickMs) || clockTickMs < 10 || clockTickMs > 60_000) {
    throw new RangeError("The socket clock tick must be between 10 and 60000 milliseconds.");
  }
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 256 || maxMessageBytes > MAX_SOCKET_MESSAGE_BYTES) {
    throw new RangeError("The socket message limit must be between 256 bytes and 1 MiB.");
  }
  if (!Number.isSafeInteger(maxEventsPerWindow) || maxEventsPerWindow < 1 || maxEventsPerWindow > MAX_EVENTS_PER_WINDOW) {
    throw new RangeError("The socket event limit must be between 1 and 10000 per window.");
  }
  if (!Number.isSafeInteger(rateWindowMs) || rateWindowMs < 100 || rateWindowMs > MAX_RATE_WINDOW_MS) {
    throw new RangeError("The socket rate window must be between 100 and 60000 milliseconds.");
  }

  const publicOrigin = configuredPublicOrigin(options);
  const allowMissingOrigin = options.allowMissingOrigin ?? true;
  const registry = options.registry ?? new RoomRegistry(options.registryOptions);
  const io: GameSocketServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketServerData
  >(httpServer, {
    serveClient: false,
    maxHttpBufferSize: maxMessageBytes,
    allowRequest: (request, callback) => {
      callback(null, requestOriginAllowed(request, publicOrigin, allowMissingOrigin));
    },
  });
  const activeSockets = new Map<string, GameSocket>();
  const requireActiveSession = (socket: GameSocket): string => {
    const sessionToken = socket.data.sessionToken;
    if (sessionToken === undefined || activeSockets.get(sessionToken) !== socket) {
      throw new RoomRegistryError("unauthorized", "This connection no longer owns the room session.");
    }
    return sessionToken;
  };

  const broadcastRoom = (roomCode: string): void => {
    try {
      const snapshots = registry.snapshotsForRoom(roomCode);
      const snapshotsByViewer = new Map<Side | null, (typeof snapshots)[number]>();
      for (const snapshot of snapshots) {
        // Spectator projections are identical, so one is sufficient for every spectator.
        if (!snapshotsByViewer.has(snapshot.viewerSide)) {
          snapshotsByViewer.set(snapshot.viewerSide, snapshot);
        }
      }
      for (const client of io.sockets.sockets.values()) {
        const sessionToken = client.data.sessionToken;
        if (
          client.data.roomCode !== roomCode ||
          sessionToken === undefined ||
          activeSockets.get(sessionToken) !== client
        ) {
          continue;
        }
        try {
          const viewerSide = registry.viewerSideForSession(sessionToken);
          client.data.viewerSide = viewerSide;
          const snapshot = snapshotsByViewer.get(viewerSide);
          if (snapshot !== undefined) {
            client.emit("room:snapshot", snapshot);
          }
        } catch {
          // A session may have left while this room snapshot was being dispatched.
        }
      }
    } catch {
      // The room may have closed between a disconnect and this broadcast.
    }
  };

  const broadcastMaintenanceUpdates = (): void => {
    for (const update of registry.advanceClocks()) {
      if ("closed" in update) {
        for (const sessionToken of update.closed.sessionTokens) {
          const client = activeSockets.get(sessionToken);
          if (client === undefined || client.data.roomCode !== update.roomCode) continue;
          client.emit("room:closed", { reason: update.closed.reason });
          activeSockets.delete(sessionToken);
          clearSocketSession(client);
          // Rate-limit counters remain on the live connection so a room expiry
          // cannot reset its fixed window. They are bounded scalars and disappear
          // naturally when the socket closes.
          void Promise.resolve(client.leave(update.roomCode)).catch(() => undefined);
        }
        continue;
      }

      const snapshotsByViewer = new Map<Side | null, (typeof update.snapshots)[number]>();
      for (const snapshot of update.snapshots) {
        if (!snapshotsByViewer.has(snapshot.viewerSide)) {
          snapshotsByViewer.set(snapshot.viewerSide, snapshot);
        }
      }
      for (const client of io.sockets.sockets.values()) {
        const sessionToken = client.data.sessionToken;
        if (
          client.data.roomCode !== update.roomCode ||
          sessionToken === undefined ||
          activeSockets.get(sessionToken) !== client
        ) {
          continue;
        }
        try {
          const viewerSide = registry.viewerSideForSession(sessionToken);
          client.data.viewerSide = viewerSide;
          const snapshot = snapshotsByViewer.get(viewerSide);
          if (snapshot !== undefined) {
            client.emit("room:snapshot", snapshot);
          }
        } catch {
          // A session may have left while timeout snapshots were dispatched.
        }
      }
    }
  };

  const bindSocket = async (
    socket: GameSocket,
    access: ReturnType<RoomRegistry["createRoom"]>,
    alreadyJoined = false,
  ): Promise<void> => {
    const previous = activeSockets.get(access.credentials.sessionToken);
    socket.data.sessionToken = access.credentials.sessionToken;
    socket.data.roomCode = access.code;
    socket.data.viewerSide = access.snapshot.viewerSide;
    activeSockets.set(access.credentials.sessionToken, socket);

    try {
      if (!alreadyJoined) await Promise.resolve(socket.join(access.code));
      if (!socket.connected) throw new Error("The socket disconnected before its room bind completed.");
    } catch (error) {
      if (activeSockets.get(access.credentials.sessionToken) === socket) {
        activeSockets.delete(access.credentials.sessionToken);
      }
      clearSocketSession(socket);
      throw error;
    }

    // A second valid resume can take ownership while socket.join is pending.
    // Recheck ownership before acknowledging this bind so an older connection
    // cannot remain usable after the replacement has claimed the session.
    if (activeSockets.get(access.credentials.sessionToken) !== socket) {
      clearSocketSession(socket);
      await Promise.resolve(socket.leave(access.code)).catch(() => undefined);
      socket.disconnect(true);
      throw new RoomRegistryError("session-conflict", "Another connection resumed this session first.");
    }

    if (previous !== undefined && previous !== socket) {
      clearSocketSession(previous);
      await Promise.resolve(previous.leave(access.code)).catch(() => undefined);
      previous.disconnect(true);
    }
  };

  const emitAccess = (
    socket: GameSocket,
    access: ReturnType<RoomRegistry["createRoom"]>,
  ): void => {
    socket.emit("session:credential", access.credentials);
  };

  io.on("connection", (socket) => {
    // A fixed-window counter lives only on its socket and is bounded to the
    // configured maximum plus one, so disconnected clients leave no map entry.
    socket.onAny((event, ...args) => {
      if (socket.data.transportRejected === true) return;
      const now = Date.now();
      const windowStartedAt = socket.data.rateWindowStartedAt;
      if (windowStartedAt === undefined || now < windowStartedAt || now - windowStartedAt >= rateWindowMs) {
        socket.data.rateWindowStartedAt = now;
        socket.data.rateEventCount = 0;
      }
      const eventCount = Math.min((socket.data.rateEventCount ?? 0) + 1, maxEventsPerWindow + 1);
      socket.data.rateEventCount = eventCount;

      if (eventCount > maxEventsPerWindow) {
        socket.data.transportRejected = true;
        const error: ProtocolError = {
          code: "rate-limited",
          message: "Too many events were sent in a short period.",
        };
        const maybeAcknowledge = args[args.length - 1];
        if (typeof maybeAcknowledge === "function") {
          try {
            (maybeAcknowledge as (response: unknown) => void)({ ok: false, error });
          } catch {
            // The callback can be gone if the peer disconnected concurrently.
          }
        }
        try { socket.emit("server:error", error); } catch { /* socket closed */ }
        socket.disconnect(true);
        return;
      }

      if (!SUPPORTED_EVENTS.has(event)) {
        const error: ProtocolError = { code: "invalid-input", message: "This event is not supported." };
        const maybeAcknowledge = args[args.length - 1];
        if (typeof maybeAcknowledge === "function") {
          try {
            (maybeAcknowledge as (response: unknown) => void)({ ok: false, error });
          } catch {
            // The callback can be gone if the peer disconnected concurrently.
          }
        }
        try { socket.emit("server:error", error); } catch { /* socket closed */ }
      }
    });

    socket.on("room:create", (input, acknowledge) => {
      if (!requireAck(socket, acknowledge)) return;
      void (async () => {
        let createdToken: string | undefined;
        try {
          assertUnbound(socket);
          const parsed = CreateRoomInputSchema.safeParse(input);
          if (!parsed.success) throw new RoomRegistryError("invalid-input", "Room creation details are invalid.");
          const access = registry.createRoom(parsed.data);
          createdToken = access.credentials.sessionToken;
          await bindSocket(socket, access);
          emitAccess(socket, access);
          safeAcknowledge<CreateRoomAcknowledgment>(socket, acknowledge, success({
            code: access.code,
            snapshot: access.snapshot,
          }));
          broadcastRoom(access.code);
        } catch (error) {
          if (createdToken !== undefined) {
            try { registry.leaveRoom(createdToken); } catch { /* best-effort rollback */ }
            activeSockets.delete(createdToken);
            clearSocketSession(socket);
          }
          safeAcknowledge<CreateRoomAcknowledgment>(socket, acknowledge, failure(error));
        }
      })().catch(() => {
        safeAcknowledge<CreateRoomAcknowledgment>(socket, acknowledge, failure(INTERNAL_ERROR));
      });
    });

    socket.on("room:join", (input, acknowledge) => {
      if (!requireAck(socket, acknowledge)) return;
      void (async () => {
        let joinedToken: string | undefined;
        let preparedRoomCode: string | undefined;
        try {
          assertUnbound(socket);
          const parsed = JoinRoomInputSchema.safeParse(input);
          if (!parsed.success) throw new RoomRegistryError("invalid-input", "Room join details are invalid.");
          // Join the private Socket.IO channel before committing registry membership.
          // Room broadcasts are separately authenticated, so the still-unbound socket
          // cannot observe snapshots if registry admission later fails.
          preparedRoomCode = parsed.data.code;
          await Promise.resolve(socket.join(preparedRoomCode));
          if (!socket.connected) throw new RoomRegistryError("conflict", "The connection closed before the room could be joined.");
          const access = registry.joinRoom(parsed.data);
          joinedToken = access.credentials.sessionToken;
          await bindSocket(socket, access, true);
          preparedRoomCode = undefined;
          emitAccess(socket, access);
          safeAcknowledge<JoinRoomAcknowledgment>(socket, acknowledge, success({
            code: access.code,
            snapshot: access.snapshot,
          }));
          broadcastRoom(access.code);
        } catch (error) {
          if (joinedToken !== undefined) {
            try { registry.leaveRoom(joinedToken); } catch { /* best-effort rollback */ }
            activeSockets.delete(joinedToken);
            clearSocketSession(socket);
          }
          if (preparedRoomCode !== undefined) {
            await Promise.resolve(socket.leave(preparedRoomCode)).catch(() => undefined);
          }
          safeAcknowledge<JoinRoomAcknowledgment>(socket, acknowledge, failure(error));
        }
      })().catch(() => {
        safeAcknowledge<JoinRoomAcknowledgment>(socket, acknowledge, failure(INTERNAL_ERROR));
      });
    });

    socket.on("room:resume", (input: RoomResumeInput, acknowledge) => {
      if (!requireAck(socket, acknowledge)) return;
      void (async () => {
        let preparedRoomCode: string | undefined;
        try {
          const parsed = RoomResumeInputSchema.safeParse(input);
          if (!parsed.success) throw new RoomRegistryError("invalid-input", "Reconnect details are invalid.");
          const currentToken = socket.data.sessionToken;
          if (currentToken !== undefined && currentToken !== parsed.data.sessionToken) {
            throw new RoomRegistryError("session-conflict", "This connection is already bound to another session.");
          }
          preparedRoomCode = parsed.data.code;
          await Promise.resolve(socket.join(preparedRoomCode));
          if (!socket.connected) throw new RoomRegistryError("conflict", "The connection closed before the room could be resumed.");
          const access = registry.resumeRoom(parsed.data);
          await bindSocket(socket, access, true);
          preparedRoomCode = undefined;
          emitAccess(socket, access);
          safeAcknowledge<ResumeRoomAcknowledgment>(socket, acknowledge, success({
            code: access.code,
            snapshot: access.snapshot,
          }));
          broadcastRoom(access.code);
        } catch (error) {
          if (preparedRoomCode !== undefined && socket.data.roomCode !== preparedRoomCode) {
            await Promise.resolve(socket.leave(preparedRoomCode)).catch(() => undefined);
          }
          safeAcknowledge<ResumeRoomAcknowledgment>(socket, acknowledge, failure(error));
        }
      })().catch(() => {
        safeAcknowledge<ResumeRoomAcknowledgment>(socket, acknowledge, failure(INTERNAL_ERROR));
      });
    });

    socket.on("room:leave", (acknowledge) => {
      if (!requireAck(socket, acknowledge)) return;
      try {
        const sessionToken = requireActiveSession(socket);
        const result = registry.leaveRoom(sessionToken);
        activeSockets.delete(sessionToken);
        clearSocketSession(socket);
        void Promise.resolve(socket.leave(result.roomCode)).catch(() => undefined);
        safeAcknowledge<LeaveRoomAcknowledgment>(socket, acknowledge, success({ left: true }));
        if (!result.roomClosed) broadcastRoom(result.roomCode);
      } catch (error) {
        safeAcknowledge<LeaveRoomAcknowledgment>(socket, acknowledge, failure(error));
      }
    });

    socket.on("game:move", (input, acknowledge) => {
      if (!requireAck(socket, acknowledge)) return;
      try {
        const sessionToken = requireActiveSession(socket);
        const parsed = MoveRequestSchema.safeParse(input);
        if (!parsed.success) throw new RoomRegistryError("invalid-input", "The move request is invalid.");
        const snapshot = registry.move(sessionToken, parsed.data);
        safeAcknowledge<RoomMutationAcknowledgment>(socket, acknowledge, success({ snapshot }));
        broadcastRoom(socket.data.roomCode ?? "");
      } catch (error) {
        safeAcknowledge<RoomMutationAcknowledgment>(socket, acknowledge, failure(error));
      }
    });

    const handleRevisionAction = (
      input: unknown,
      acknowledge: unknown,
      action: (sessionToken: string, request: unknown) => ReturnType<RoomRegistry["offerDraw"]>,
    ): void => {
      if (!requireAck(socket, acknowledge)) return;
      try {
        const sessionToken = requireActiveSession(socket);
        const parsed = RevisionRequestSchema.safeParse(input);
        if (!parsed.success) throw new RoomRegistryError("invalid-input", "The action request is invalid.");
        const snapshot = action(sessionToken, parsed.data);
        safeAcknowledge<RoomMutationAcknowledgment>(socket, acknowledge, success({ snapshot }));
        broadcastRoom(socket.data.roomCode ?? "");
      } catch (error) {
        safeAcknowledge<RoomMutationAcknowledgment>(socket, acknowledge, failure(error));
      }
    };

    socket.on("draw:offer", (input, acknowledge) => {
      handleRevisionAction(input, acknowledge, (sessionToken, request) => registry.offerDraw(sessionToken, request));
    });
    socket.on("draw:accept", (input, acknowledge) => {
      handleRevisionAction(input, acknowledge, (sessionToken, request) => registry.acceptDraw(sessionToken, request));
    });
    socket.on("draw:decline", (input, acknowledge) => {
      handleRevisionAction(input, acknowledge, (sessionToken, request) => registry.declineDraw(sessionToken, request));
    });
    socket.on("match:resign", (input, acknowledge) => {
      handleRevisionAction(input, acknowledge, (sessionToken, request) => registry.resign(sessionToken, request));
    });
    socket.on("rematch:vote", (input, acknowledge) => {
      handleRevisionAction(input, acknowledge, (sessionToken, request) => registry.voteRematch(sessionToken, request));
    });

    socket.on("disconnect", () => {
      const sessionToken = socket.data.sessionToken;
      const roomCode = socket.data.roomCode;
      if (sessionToken === undefined || activeSockets.get(sessionToken) !== socket) {
        return;
      }
      activeSockets.delete(sessionToken);
      clearSocketSession(socket);
      try {
        registry.disconnectSession(sessionToken);
        if (roomCode !== undefined) broadcastRoom(roomCode);
      } catch {
        // Expired sessions and shutdown races are expected disconnect conditions.
      }
    });
  });

  const maintenanceTimer = setInterval(() => {
    try {
      broadcastMaintenanceUpdates();
    } catch {
      // A timer failure must not terminate the server process.
    }
  }, clockTickMs);
  maintenanceTimer.unref?.();

  let closePromise: Promise<void> | undefined;
  const runtime: SocketRuntime = {
    io,
    registry,
    close: () => {
      if (closePromise === undefined) {
        clearInterval(maintenanceTimer);
        attachedServers.delete(httpServer);
        for (const client of io.sockets.sockets.values()) {
          const sessionToken = client.data.sessionToken;
          if (sessionToken !== undefined && activeSockets.get(sessionToken) === client) {
            client.emit("room:closed", { reason: "server-shutdown" });
          }
          clearSocketSession(client);
        }
        activeSockets.clear();
        registry.shutdown();
        closePromise = new Promise<void>((resolve, reject) => {
          io.close((error?: Error) => error === undefined ? resolve() : reject(error));
        });
      }
      return closePromise;
    },
  };
  attachedServers.set(httpServer, runtime);
  return runtime;
}
