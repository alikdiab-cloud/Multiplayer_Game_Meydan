import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { DamaMatch, sameMove, type ApplicationResult, type Side } from "../shared/game.js";
import {
  CreateRoomInputSchema,
  JoinRoomInputSchema,
  MoveRequestSchema,
  RevisionRequestSchema,
  RoomCodeSchema,
  RoomResumeInputSchema,
  SessionCredentialsSchema,
  type CreateRoomInput,
  type JoinRoomInput,
  type ProtocolErrorCode,
  type PublicPlayerRecord,
  type RoomClock,
  type RoomResumeInput,
  type RoomSnapshot,
  type SessionCredentials,
  type TimeControl,
} from "../shared/protocol.js";

export const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
export const DEFAULT_ROOM_LIMITS = {
  rooms: 1_000,
  sessions: 5_000,
  spectatorsPerRoom: 128,
  generationAttempts: 32,
} as const;
export const DEFAULT_RECOVERY_GRACE_MS = 120_000;
export const DEFAULT_ROOM_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export type RoomRegistryLimits = {
  rooms: number;
  sessions: number;
  spectatorsPerRoom: number;
  generationAttempts: number;
};

export type RoomRegistryOptions = {
  /** Injectable wall clock for deterministic snapshot and clock tests. */
  now?: () => number;
  /** Override only in deterministic tests; production uses cryptographic randomness. */
  generateRoomCode?: () => string;
  /** Override only in deterministic tests; production uses cryptographic randomness. */
  generateSessionToken?: () => string;
  /** Public player IDs are separate from reconnect credentials. */
  generatePlayerId?: () => string;
  /** Test seam for deterministic tactical and terminal room fixtures. */
  createMatch?: () => DamaMatch;
  recoveryGraceMs?: number;
  /** Room idle age; production expires rooms after six hours without accepted activity. */
  roomIdleTimeoutMs?: number;
  limits?: Partial<RoomRegistryLimits>;
};

export type RoomAccess = {
  code: string;
  credentials: SessionCredentials;
  snapshot: RoomSnapshot;
};

/** Viewer-specific snapshots or a private list of sessions to notify when a room expires. */
export type RoomMaintenanceUpdate =
  | { roomCode: string; snapshots: RoomSnapshot[] }
  | {
      roomCode: string;
      snapshots: [];
      closed: { reason: "idle-timeout"; sessionTokens: string[] };
    };

export type RoomLeaveResult = {
  left: true;
  roomCode: string;
  roomClosed: boolean;
};

type InternalSession = {
  token: string;
  roomCode: string;
  name: string;
  side: Side | null;
  player: InternalPlayerRecord | null;
  disconnectedAt: number | null;
};

type InternalPlayerRecord = Omit<PublicPlayerRecord, "recoveryDeadlineMs">;

type MutableClock = {
  /** Remaining time at anchorAtMs, before elapsed time since that anchor. */
  whiteMs: number | null;
  blackMs: number | null;
  activeSide: Side | null;
  running: boolean;
  anchorAtMs: number | null;
};

type RoomRecord = {
  code: string;
  /** Last accepted state-changing action or membership/presence transition; passive reads/ticks do not refresh it. */
  lastActivityAt: number;
  /** Room-wide sequence; it is never reset when a rematch replaces the match. */
  revision: number;
  matchNumber: number;
  phase: RoomSnapshot["phase"];
  match: DamaMatch;
  timeControl: TimeControl;
  players: Record<Side, InternalSession | null>;
  spectators: Set<string>;
  clock: MutableClock;
  drawOffer: RoomSnapshot["drawOffer"];
  rematchVotes: RoomSnapshot["rematchVotes"];
};

type DrawActionContext = {
  room: RoomRecord;
  session: InternalSession;
  side: Side;
  now: number;
};

function otherSide(side: Side): Side {
  return side === "white" ? "black" : "white";
}

export class RoomRegistryError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "RoomRegistryError";
    this.code = code;
  }
}

function cryptographicRoomCode(): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function cryptographicSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function copyTimeControl(timeControl: TimeControl): TimeControl {
  return { ...timeControl } as TimeControl;
}

function initialClock(timeControl: TimeControl): MutableClock {
  if (timeControl.kind === "untimed") {
    return {
      whiteMs: null,
      blackMs: null,
      activeSide: null,
      running: false,
      anchorAtMs: null,
    };
  }

  return {
    whiteMs: timeControl.initialMs,
    blackMs: timeControl.initialMs,
    activeSide: null,
    running: false,
    anchorAtMs: null,
  };
}

export class RoomRegistry {
  readonly #rooms = new Map<string, RoomRecord>();
  readonly #sessions = new Map<string, InternalSession>();
  readonly #pendingRoomUpdates = new Set<string>();
  readonly #now: () => number;
  readonly #generateRoomCode: () => string;
  readonly #generateSessionToken: () => string;
  readonly #generatePlayerId: () => string;
  readonly #createMatch: () => DamaMatch;
  readonly #recoveryGraceMs: number;
  readonly #roomIdleTimeoutMs: number;
  readonly #limits: RoomRegistryLimits;

  constructor(options: RoomRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#generateRoomCode = options.generateRoomCode ?? cryptographicRoomCode;
    this.#generateSessionToken = options.generateSessionToken ?? cryptographicSessionToken;
    this.#generatePlayerId = options.generatePlayerId ?? randomUUID;
    this.#createMatch = options.createMatch ?? (() => new DamaMatch());
    this.#recoveryGraceMs = options.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
    assertLimit("Recovery grace", this.#recoveryGraceMs);
    this.#roomIdleTimeoutMs = options.roomIdleTimeoutMs ?? DEFAULT_ROOM_IDLE_TIMEOUT_MS;
    assertLimit("Room idle timeout", this.#roomIdleTimeoutMs);
    this.#limits = { ...DEFAULT_ROOM_LIMITS, ...options.limits };
    assertLimit("Room capacity", this.#limits.rooms);
    assertLimit("Session capacity", this.#limits.sessions);
    assertLimit("Per-room spectator capacity", this.#limits.spectatorsPerRoom);
    if (!Number.isSafeInteger(this.#limits.generationAttempts) || this.#limits.generationAttempts < 1) {
      throw new RangeError("Generation attempts must be a positive safe integer.");
    }
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Clears all in-memory room and reconnect state as the server shuts down. */
  shutdown(): void {
    this.#rooms.clear();
    this.#sessions.clear();
    this.#pendingRoomUpdates.clear();
  }

  createRoom(input: CreateRoomInput): RoomAccess {
    const parsed = CreateRoomInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RoomRegistryError("invalid-input", "Room creation details are invalid.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    if (this.#rooms.size >= this.#limits.rooms) {
      throw new RoomRegistryError("room-capacity", "The service is at capacity. Try again when a room is available.");
    }
    if (this.#sessions.size >= this.#limits.sessions) {
      throw new RoomRegistryError("session-capacity", "The service is at capacity. Try again when a player slot opens.");
    }

    const code = this.#newRoomCode();
    const token = this.#newSessionToken(parsed.data.name, code);
    const playerId = this.#newPlayerId();
    const player: InternalPlayerRecord = {
      playerId,
      name: parsed.data.name,
      side: parsed.data.side,
      connected: true,
    };
    const session: InternalSession = {
      token,
      roomCode: code,
      name: parsed.data.name,
      side: parsed.data.side,
      player,
      disconnectedAt: null,
    };
    const timeControl = copyTimeControl(parsed.data.timeControl);
    const room: RoomRecord = {
      code,
      lastActivityAt: now,
      revision: 0,
      matchNumber: 1,
      phase: "waiting",
      match: this.#createMatch(),
      timeControl,
      players: { white: null, black: null },
      spectators: new Set(),
      clock: initialClock(timeControl),
      drawOffer: null,
      rematchVotes: { white: false, black: false },
    };
    room.players[parsed.data.side] = session;

    const access = this.#makeAccess(room, session, now);
    this.#rooms.set(code, room);
    this.#sessions.set(token, session);
    return access;
  }

  /**
   * Joins using a fresh server session, or idempotently reuses an authenticated
   * session from the same room. The optional token is transport context, not input data.
   */
  joinRoom(input: JoinRoomInput, authenticatedSessionToken?: string): RoomAccess {
    const parsed = JoinRoomInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RoomRegistryError("invalid-input", "Room join details are invalid.");
    }
    const room = this.#rooms.get(parsed.data.code);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "No room has that code. Check the code or create a room.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);

    if (authenticatedSessionToken !== undefined) {
      const session = this.#sessions.get(authenticatedSessionToken);
      if (session === undefined) {
        throw new RoomRegistryError("unauthorized", "The session is not recognized.");
      }
      if (session.roomCode !== room.code) {
        throw new RoomRegistryError("session-conflict", "This session already belongs to a different room identity.");
      }
      const currentRole = session.side === null ? "spectator" : "player";
      if (parsed.data.role !== undefined && parsed.data.role !== currentRole) {
        throw new RoomRegistryError("session-conflict", "This session already has a different room role.");
      }
      let changed = false;
      if (session.name !== parsed.data.name) {
        session.name = parsed.data.name;
        if (session.player !== null) {
          session.player = { ...session.player, name: parsed.data.name };
        }
        changed = true;
      }
      if (this.#restoreSession(session)) {
        changed = true;
      }
      this.#touch(room, now);
      if (changed) {
        room.revision += 1;
      }
      return this.#makeAccess(room, session, now);
    }

    if (this.#sessions.size >= this.#limits.sessions) {
      throw new RoomRegistryError("session-capacity", "The service is at capacity. Try again when a player slot opens.");
    }

    const explicitlySpectating = parsed.data.role === "spectator";
    // A waiting player who is offline keeps the room from starting against an empty connection.
    const waitingPlayerRecovering = room.phase === "waiting" &&
      ((room.players.white !== null && room.players.white.disconnectedAt !== null) ||
        (room.players.black !== null && room.players.black.disconnectedAt !== null));
    const side = explicitlySpectating || waitingPlayerRecovering
      ? null
      : room.players.white === null
        ? "white"
        : room.players.black === null
          ? "black"
          : null;
    if (side === null && room.spectators.size >= this.#limits.spectatorsPerRoom) {
      throw new RoomRegistryError("room-full", "This room is full. Ask the host for another code or try again later.");
    }

    const token = this.#newSessionToken(parsed.data.name, room.code);
    const player = side === null
      ? null
      : {
          playerId: this.#newPlayerId(),
          name: parsed.data.name,
          side,
          connected: true,
        } satisfies InternalPlayerRecord;
    const session: InternalSession = {
      token,
      roomCode: room.code,
      name: parsed.data.name,
      side,
      player,
      disconnectedAt: null,
    };

    const previousState = {
      revision: room.revision,
      phase: room.phase,
      clock: { ...room.clock },
      drawOffer: room.drawOffer,
      rematchVotes: { ...room.rematchVotes },
      lastActivityAt: room.lastActivityAt,
    };
    try {
      if (side === null) {
        room.spectators.add(token);
      } else {
        room.players[side] = session;
        room.revision += 1;
        if (
          room.phase === "waiting" &&
          room.players.white !== null &&
          room.players.black !== null
        ) {
          const initialView = room.match.getView();
          if (initialView.result !== null) {
            room.phase = "finished";
          } else {
            room.phase = "playing";
            this.#startClock(room, now);
          }
        }
      }
      if (side === null) {
        room.revision += 1;
      }
      this.#touch(room, now);
      this.#sessions.set(token, session);
      return this.#makeAccess(room, session, now);
    } catch (error) {
      this.#sessions.delete(token);
      room.spectators.delete(token);
      if (side !== null && room.players[side] === session) room.players[side] = null;
      room.revision = previousState.revision;
      room.phase = previousState.phase;
      room.clock = previousState.clock;
      room.drawOffer = previousState.drawOffer;
      room.rematchVotes = previousState.rematchVotes;
      room.lastActivityAt = previousState.lastActivityAt;
      throw error;
    }
  }

  resumeRoom(input: RoomResumeInput): RoomAccess {
    const parsed = RoomResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RoomRegistryError("invalid-input", "Room reconnect details are invalid.");
    }
    let session = this.#sessions.get(parsed.data.sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The reconnect identity is not recognized.");
    }
    if (session.roomCode !== parsed.data.code) {
      throw new RoomRegistryError("session-conflict", "This reconnect identity belongs to a different room.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this reconnect identity no longer exists.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    session = this.#sessions.get(parsed.data.sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The reconnect identity has expired.");
    }
    if (this.#restoreSession(session)) {
      room.revision += 1;
    }
    this.#touch(room, now);
    return this.#makeAccess(room, session, now);
  }

  /**
   * Processes a deliberate departure, distinct from disconnectSession's recovery grace.
   * An active player's leave first settles the clock, preserves any timeout that
   * already happened, otherwise awards a disconnection win to the opponent, then
   * immediately releases the seat and deletes the session. Waiting/finished player
   * seats and spectator presence are released without changing an existing result.
   */
  leaveRoom(sessionToken: string): RoomLeaveResult {
    const session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    const now = this.#timeNow();
    if (session.side !== null) {
      this.#pruneExpiredReservations(now);
      if (this.#sessions.get(sessionToken) !== session) {
        throw new RoomRegistryError("unauthorized", "The session recovery grace has expired.");
      }
    }
    const isMember = session.side === null
      ? room.spectators.has(session.token)
      : room.players[session.side] === session;
    if (!isMember) {
      throw new RoomRegistryError("unauthorized", "The session is not a member of this room.");
    }

    this.#touch(room, now);

    if (session.side !== null) {
      this.#settleClock(room, now);
    }
    if (session.side === null) {
      room.spectators.delete(session.token);
    } else {
      // Votes are consent between the current pair of seats; a departing seat
      // invalidates any consent already recorded for the pair.
      room.rematchVotes = { white: false, black: false };
      if (room.phase === "playing" && room.match.getView().result === null) {
        const winner: Side = session.side === "white" ? "black" : "white";
        this.#finishWithResult(room, { state: "won", winner, reason: "disconnection" }, now);
      }
      room.players[session.side] = null;
    }
    this.#sessions.delete(session.token);
    room.revision += 1;

    const roomClosed = room.players.white === null && room.players.black === null && room.spectators.size === 0;
    if (roomClosed) {
      this.#rooms.delete(room.code);
      this.#pendingRoomUpdates.delete(room.code);
    }
    return { left: true, roomCode: room.code, roomClosed };
  }

  /**
   * The single public projection for player, spectator, acknowledgment, and broadcast state.
   * Callers receive only a fresh per-viewer snapshot; credentials remain in RoomAccess.
   */
  snapshotForSession(sessionToken: string): RoomSnapshot {
    let session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session recovery grace has expired.");
    }
    this.#settleClock(room, now);
    return this.#projectSnapshot(room, session, now);
  }

  /** Returns one coherent per-viewer projection set for room broadcasts. */
  snapshotsForRoom(code: string): RoomSnapshot[] {
    const parsedCode = RoomCodeSchema.safeParse(code);
    if (!parsedCode.success) {
      throw new RoomRegistryError("invalid-input", "The room code is invalid.");
    }
    const room = this.#rooms.get(parsedCode.data);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "No room has that code. Check the code or create a room.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    this.#settleClock(room, now);
    const sessions = [
      room.players.white,
      room.players.black,
      ...Array.from(room.spectators, (token) => this.#sessions.get(token) ?? null),
    ];
    return sessions
      .filter((session): session is InternalSession => session !== null)
      .map((session) => this.#projectSnapshot(room, session, now));
  }

  /**
   * Server maintenance hook: compare clock and recovery deadlines, then return
   * per-viewer snapshots for each changed room. A timeout wins an exact tie.
   */
  advanceClocks(): RoomMaintenanceUpdate[] {
    const now = this.#timeNow();
    const updates: RoomMaintenanceUpdate[] = [];
    for (const room of [...this.#rooms.values()]) {
      if (
        now < room.lastActivityAt ||
        now - room.lastActivityAt < this.#roomIdleTimeoutMs
      ) {
        continue;
      }
      const sessionTokens = [
        room.players.white?.token,
        room.players.black?.token,
        ...room.spectators,
      ].filter((token): token is string => token !== undefined);
      for (const token of sessionTokens) {
        const session = this.#sessions.get(token);
        if (session?.roomCode === room.code) this.#sessions.delete(token);
      }
      this.#rooms.delete(room.code);
      this.#pendingRoomUpdates.delete(room.code);
      updates.push({
        roomCode: room.code,
        snapshots: [],
        closed: { reason: "idle-timeout", sessionTokens },
      });
    }
    this.#pruneExpiredReservations(now);
    for (const roomCode of this.#pendingRoomUpdates) {
      const room = this.#rooms.get(roomCode);
      this.#pendingRoomUpdates.delete(roomCode);
      if (room === undefined) {
        continue;
      }
      const sessions = [
        room.players.white,
        room.players.black,
        ...Array.from(room.spectators, (token) => this.#sessions.get(token) ?? null),
      ];
      updates.push({
        roomCode,
        snapshots: sessions
          .filter((session): session is InternalSession => session !== null)
          .map((session) => this.#projectSnapshot(room, session, now)),
      });
    }
    return updates;
  }

  /**
   * Marks a player offline while keeping their seat reserved for the recovery
   * grace. Waiting rooms stay open without a result; clocks keep running in
   * active matches until a result or recovery deadline is reached.
   */
  disconnectSession(sessionToken: string): void {
    const now = this.#timeNow();
    let session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    if (session.side === null) {
      room.spectators.delete(session.token);
      this.#sessions.delete(session.token);
      this.#touch(room, now);
      room.revision += 1;
      return;
    }
    this.#pruneExpiredReservations(now);
    session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session recovery grace has expired.");
    }
    if (session.disconnectedAt !== null) {
      return;
    }
    // A vote made before a disconnect cannot authorize a rematch after recovery.
    room.rematchVotes = { white: false, black: false };
    session.disconnectedAt = now;
    this.#touch(room, now);
    if (session.player !== null) {
      session.player = { ...session.player, connected: false };
    }
    room.revision += 1;
  }

  /**
   * Applies one complete canonical legal move for the authenticated player.
   * This method is deliberately synchronous: the revision check, engine move,
   * clock update, and revision increment form one atomic registry operation.
   */
  move(sessionToken: string, request: unknown): RoomSnapshot {
    const parsed = MoveRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new RoomRegistryError("invalid-input", "The move request is invalid.");
    }

    const session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }

    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    if (this.#sessions.get(sessionToken) !== session) {
      throw new RoomRegistryError("unauthorized", "The session recovery grace has expired.");
    }

    const isMember = session.side === null
      ? room.spectators.has(session.token)
      : room.players[session.side] === session;
    if (!isMember) {
      throw new RoomRegistryError("unauthorized", "The session is not a member of this room.");
    }
    if (session.side === null) {
      throw new RoomRegistryError("not-your-turn", "Spectators cannot submit moves.");
    }
    if (session.disconnectedAt !== null) {
      throw new RoomRegistryError("unauthorized", "Disconnected sessions cannot submit moves.");
    }

    if (room.phase === "finished") {
      throw new RoomRegistryError("game-finished", "The match has already ended.");
    }
    if (room.phase !== "playing") {
      throw new RoomRegistryError("conflict", "The match has not started.");
    }

    const view = room.match.getView();
    if (view.result !== null) {
      throw new RoomRegistryError("game-finished", "The match has already ended.");
    }
    if (parsed.data.revision !== room.revision) {
      throw new RoomRegistryError("stale-revision", "The room changed before your action was sent. The latest match is shown; check it and try again.");
    }
    if (view.turn !== session.side) {
      throw new RoomRegistryError("not-your-turn", "It is not this player's turn.");
    }

    const canonicalMove = view.legalMoves.find((move) => sameMove(move, parsed.data));
    if (canonicalMove === undefined) {
      throw new RoomRegistryError("invalid-move", "That move is no longer legal. Choose a current legal move and try again.");
    }

    let nextClock: MutableClock | null = null;
    if (room.timeControl.kind !== "untimed") {
      if (!room.clock.running || room.clock.activeSide !== session.side) {
        throw new RoomRegistryError("conflict", "The server clock is not active for this turn.");
      }
      if (this.#settleClock(room, now)) {
        throw new RoomRegistryError("game-finished", "The player's clock expired before the move was accepted.");
      }
      const clock = this.#clockSnapshot(room, now);
      const moverMs = session.side === "white" ? clock.whiteMs : clock.blackMs;
      if (moverMs === null || moverMs <= 0) {
        throw new RoomRegistryError("conflict", "The player's clock has expired.");
      }
      const incrementedMs = moverMs + room.timeControl.incrementMs;
      nextClock = {
        whiteMs: session.side === "white" ? incrementedMs : clock.whiteMs,
        blackMs: session.side === "black" ? incrementedMs : clock.blackMs,
        activeSide: null,
        running: false,
        anchorAtMs: null,
      };
    }

    // Only the source and full path cross the engine boundary. The captured
    // squares and all other consequences are derived from its canonical move.
    const nextView = room.match.play({ from: canonicalMove.from, path: [...canonicalMove.path] });
    if (nextClock !== null) {
      if (nextView.result === null) {
        nextClock.activeSide = nextView.turn;
        nextClock.running = true;
        nextClock.anchorAtMs = now;
      }
      room.clock = nextClock;
    }
    room.phase = nextView.result === null ? "playing" : "finished";
    room.drawOffer = null;
    if (nextView.result !== null) {
      this.#completeTerminalState(room, now);
    }
    room.revision += 1;
    this.#touch(room, now);

    return this.#projectSnapshot(room, session, now);
  }

  /** Concedes an active match for the authenticated player. */
  resign(sessionToken: string, request: unknown): RoomSnapshot {
    const { room, session, side, now } = this.#activePlayerActionContext(sessionToken, request, "resignation");
    const winner: Side = side === "white" ? "black" : "white";
    if (!this.#finishWithResult(room, { state: "won", winner, reason: "resignation" }, now)) {
      throw new RoomRegistryError("game-finished", "The match has already ended.");
    }
    this.#touch(room, now);
    room.revision += 1;
    return this.#projectSnapshot(room, session, now);
  }

  /** Places one revisioned draw offer for the active match. */
  offerDraw(sessionToken: string, request: unknown): RoomSnapshot {
    const { room, session, side, now } = this.#activePlayerActionContext(sessionToken, request, "draw action");
    if (room.drawOffer !== null) {
      throw new RoomRegistryError("conflict", "A draw offer is already pending.");
    }

    room.drawOffer = { offeredBy: side };
    this.#touch(room, now);
    room.revision += 1;
    return this.#projectSnapshot(room, session, now);
  }

  /** Accepts the opponent's current draw offer and finishes this same match. */
  acceptDraw(sessionToken: string, request: unknown): RoomSnapshot {
    const { room, session, side, now } = this.#activePlayerActionContext(sessionToken, request, "draw action");
    this.#requireOpponentDrawOffer(room, side);

    if (!this.#finishWithResult(room, { state: "draw", reason: "agreement" }, now)) {
      throw new RoomRegistryError("game-finished", "The match has already ended.");
    }
    this.#touch(room, now);
    room.revision += 1;
    return this.#projectSnapshot(room, session, now);
  }

  /** Declines the opponent's offer and leaves the active match running. */
  declineDraw(sessionToken: string, request: unknown): RoomSnapshot {
    const { room, session, side, now } = this.#activePlayerActionContext(sessionToken, request, "draw action");
    this.#requireOpponentDrawOffer(room, side);

    room.drawOffer = null;
    this.#touch(room, now);
    room.revision += 1;
    return this.#projectSnapshot(room, session, now);
  }

  /** Records one player's consent and starts exactly one swapped-side rematch when both agree. */
  voteRematch(sessionToken: string, request: unknown): RoomSnapshot {
    const { room, session, side, now } = this.#rematchVoteContext(sessionToken, request);
    if (room.rematchVotes[side]) {
      // Repeating the current vote is idempotent and does not advance revision.
      return this.#projectSnapshot(room, session, now);
    }

    const opponentSide = otherSide(side);
    const opponent = room.players[opponentSide];
    const opponentHasCurrentVote = room.rematchVotes[opponentSide] && opponent?.disconnectedAt === null;
    const nextMatch = opponentHasCurrentVote ? this.#createMatch() : null;
    const nextMatchResult = nextMatch?.getView().result ?? null;

    room.rematchVotes[side] = true;
    this.#touch(room, now);
    if (nextMatch !== null && room.players.white !== null && room.players.black !== null) {
      const previousWhite = room.players.white;
      const previousBlack = room.players.black;
      this.#setPlayerSide(previousWhite, "black");
      this.#setPlayerSide(previousBlack, "white");
      room.players.white = previousBlack;
      room.players.black = previousWhite;
      room.match = nextMatch;
      room.matchNumber += 1;
      room.phase = nextMatchResult === null ? "playing" : "finished";
      room.clock = initialClock(room.timeControl);
      room.drawOffer = null;
      room.rematchVotes = { white: false, black: false };
      if (room.phase === "playing") {
        this.#startClock(room, now);
      }
    }

    room.revision += 1;
    return this.#projectSnapshot(room, session, now);
  }

  /** The current authenticated seat can be queried without a clock read for broadcasts after side swaps. */
  viewerSideForSession(sessionToken: string): Side | null {
    const session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    const isMember = session.side === null
      ? room.spectators.has(session.token)
      : room.players[session.side] === session;
    if (!isMember) {
      throw new RoomRegistryError("unauthorized", "The session is not a member of this room.");
    }
    return session.side;
  }

  #activePlayerActionContext(
    sessionToken: string,
    request: unknown,
    action: "draw action" | "resignation",
  ): DrawActionContext {
    const parsed = RevisionRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new RoomRegistryError("invalid-input", `The ${action} request is invalid.`);
    }

    const session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    if (this.#sessions.get(sessionToken) !== session) {
      throw new RoomRegistryError("unauthorized", "The session recovery grace has expired.");
    }
    const isMember = session.side === null
      ? room.spectators.has(session.token)
      : room.players[session.side] === session;
    if (!isMember) {
      throw new RoomRegistryError("unauthorized", "The session is not a member of this room.");
    }
    if (session.side === null) {
      throw new RoomRegistryError("not-your-turn", "Spectators cannot act on an active match.");
    }
    if (session.disconnectedAt !== null) {
      throw new RoomRegistryError("unauthorized", "Disconnected sessions cannot act.");
    }
    if (room.phase === "finished" || room.match.getView().result !== null) {
      throw new RoomRegistryError("game-finished", "The match has already ended.");
    }
    if (room.phase !== "playing") {
      throw new RoomRegistryError("conflict", `A ${action} is available only during an active match.`);
    }
    if (parsed.data.revision !== room.revision) {
      throw new RoomRegistryError("stale-revision", "The room changed before your action was sent. The latest match is shown; check it and try again.");
    }

    if (this.#settleClock(room, now)) {
      throw new RoomRegistryError("game-finished", "The match ended before this action was accepted.");
    }
    return { room, session, side: session.side, now };
  }

  #requireOpponentDrawOffer(room: RoomRecord, side: Side): void {
    if (room.drawOffer === null) {
      throw new RoomRegistryError("conflict", "There is no pending draw offer.");
    }
    if (room.drawOffer.offeredBy === side) {
      throw new RoomRegistryError("not-your-turn", "Only the other player may respond to this draw offer.");
    }
  }

  #rematchVoteContext(sessionToken: string, request: unknown): DrawActionContext {
    const parsed = RevisionRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new RoomRegistryError("invalid-input", "The rematch vote request is invalid.");
    }
    const session = this.#sessions.get(sessionToken);
    if (session === undefined) {
      throw new RoomRegistryError("unauthorized", "The session is not recognized.");
    }
    const room = this.#rooms.get(session.roomCode);
    if (room === undefined) {
      throw new RoomRegistryError("room-not-found", "The room for this session no longer exists.");
    }
    const now = this.#timeNow();
    this.#pruneExpiredReservations(now);
    if (this.#sessions.get(sessionToken) !== session) {
      throw new RoomRegistryError("unauthorized", "The session recovery grace has expired.");
    }
    const isMember = session.side === null
      ? room.spectators.has(session.token)
      : room.players[session.side] === session;
    if (!isMember) {
      throw new RoomRegistryError("unauthorized", "The session is not a member of this room.");
    }
    if (session.side === null) {
      throw new RoomRegistryError("not-your-turn", "Spectators cannot vote for a rematch.");
    }
    if (session.disconnectedAt !== null) {
      throw new RoomRegistryError("unauthorized", "Disconnected sessions cannot vote for a rematch.");
    }
    if (room.phase !== "finished" || room.match.getView().result === null) {
      throw new RoomRegistryError("conflict", "Rematch votes are available only after a match ends.");
    }
    if (room.players.white === null || room.players.black === null) {
      throw new RoomRegistryError("conflict", "Both player seats must be occupied for a rematch.");
    }
    if (parsed.data.revision !== room.revision) {
      throw new RoomRegistryError("stale-revision", "The room changed before your action was sent. The latest match is shown; check it and try again.");
    }
    return { room, session, side: session.side, now };
  }

  #setPlayerSide(session: InternalSession, side: Side): void {
    session.side = side;
    if (session.player !== null) {
      session.player = { ...session.player, side };
    }
  }

  #finishWithResult(room: RoomRecord, result: ApplicationResult, now: number): boolean {
    if (room.phase === "finished" || room.match.getView().result !== null) {
      return false;
    }
    room.match.setApplicationResult(result);
    this.#completeTerminalState(room, now);
    return true;
  }

  #completeTerminalState(room: RoomRecord, now: number): void {
    const remaining = this.#clockSnapshot(room, now);
    room.phase = "finished";
    room.clock = {
      whiteMs: remaining.whiteMs,
      blackMs: remaining.blackMs,
      activeSide: null,
      running: false,
      anchorAtMs: null,
    };
    room.drawOffer = null;
    room.rematchVotes = { white: false, black: false };
  }

  #newRoomCode(): string {
    for (let attempt = 0; attempt < this.#limits.generationAttempts; attempt += 1) {
      try {
        const parsedCode = RoomCodeSchema.safeParse(this.#generateRoomCode());
        if (parsedCode.success && !this.#rooms.has(parsedCode.data)) {
          return parsedCode.data;
        }
      } catch {
        // Invalid generated values and generator failures are retried within a fixed bound.
      }
    }
    throw new RoomRegistryError("code-generation-failed", "A unique room code could not be generated.");
  }

  #newSessionToken(name: string, roomCode: string): string {
    for (let attempt = 0; attempt < this.#limits.generationAttempts; attempt += 1) {
      try {
        const candidate = this.#generateSessionToken();
        const parsed = SessionCredentialsSchema.safeParse({ sessionToken: candidate });
        if (
          parsed.success &&
          candidate !== roomCode &&
          candidate !== name &&
          !this.#sessions.has(candidate)
        ) {
          return candidate;
        }
      } catch {
        // Invalid generated values and generator failures are retried within a fixed bound.
      }
    }
    throw new RoomRegistryError("session-generation-failed", "A unique reconnect identity could not be generated.");
  }

  #newPlayerId(): string {
    const existingIds = new Set(
      Array.from(this.#sessions.values(), (session) => session.player?.playerId)
        .filter((playerId): playerId is string => playerId !== undefined),
    );
    for (let attempt = 0; attempt < this.#limits.generationAttempts; attempt += 1) {
      try {
        const playerId = this.#generatePlayerId();
        if (/^[A-Za-z0-9_-]{1,64}$/.test(playerId) && !existingIds.has(playerId)) {
          return playerId;
        }
      } catch {
        // Public identities are retried within the same bound as other generated IDs.
      }
    }
    throw new RoomRegistryError("session-generation-failed", "A unique player identity could not be generated.");
  }

  #timeNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("The registry time source must return a non-negative safe integer.");
    }
    return now;
  }

  #touch(room: RoomRecord, now: number): void {
    room.lastActivityAt = now;
  }

  #restoreSession(session: InternalSession): boolean {
    if (session.disconnectedAt === null) {
      return false;
    }
    session.disconnectedAt = null;
    if (session.player !== null) {
      session.player = { ...session.player, connected: true };
    }
    return true;
  }

  #pruneExpiredReservations(now: number): void {
    for (const room of this.#rooms.values()) {
      const expiredSides: Side[] = [];
      for (const side of ["white", "black"] as const) {
        const session = room.players[side];
        if (
          session === null ||
          session.disconnectedAt === null ||
          now < session.disconnectedAt ||
          now - session.disconnectedAt < this.#recoveryGraceMs
        ) {
          continue;
        }
        expiredSides.push(side);
      }

      const firstExpiredSide = expiredSides.reduce<Side | null>((first, side) => {
        const firstSession = first === null ? null : room.players[first];
        const sideSession = room.players[side];
        if (sideSession === null) return first;
        if (firstSession === null) return side;
        const firstDeadline = this.#recoveryDeadline(firstSession.disconnectedAt);
        const sideDeadline = this.#recoveryDeadline(sideSession.disconnectedAt);
        return sideDeadline < firstDeadline ? side : first;
      }, null);
      const firstExpiredSession = firstExpiredSide === null ? null : room.players[firstExpiredSide];
      const firstRecoveryDeadline = firstExpiredSession === null
        ? null
        : this.#recoveryDeadline(firstExpiredSession.disconnectedAt);
      const clockDeadline = room.phase === "playing" ? this.#clockDeadline(room) : null;
      const timeoutIsDue = clockDeadline !== null && clockDeadline <= now;
      const gracePrecedesTimeout = firstRecoveryDeadline !== null &&
        (!timeoutIsDue || clockDeadline === null || firstRecoveryDeadline < clockDeadline);

      if (expiredSides.length > 0 && room.phase === "playing" && room.match.getView().result === null) {
        if (gracePrecedesTimeout && firstExpiredSide !== null && firstRecoveryDeadline !== null) {
          const secondExpiredSession = room.players[otherSide(firstExpiredSide)];
          const simultaneousExpiry = expiredSides.length === 2 &&
            firstExpiredSession !== null &&
            secondExpiredSession !== null &&
            this.#recoveryDeadline(firstExpiredSession.disconnectedAt) ===
              this.#recoveryDeadline(secondExpiredSession.disconnectedAt);
          // Equal deadlines mean both players left together, so adjudicate a
          // mutual-disconnection draw. Otherwise the earliest expired seat
          // forfeits to the opponent; an already finished game is never changed.
          const result: ApplicationResult = simultaneousExpiry
            ? { state: "draw", reason: "mutual-disconnection" }
            : { state: "won", winner: otherSide(firstExpiredSide), reason: "disconnection" };
          this.#finishWithResult(room, result, firstRecoveryDeadline);
        } else {
          // If the timeout deadline is earlier or tied, it takes precedence.
          this.#settleClock(room, now);
        }
      } else {
        this.#settleClock(room, now);
      }

      for (const side of expiredSides) {
        const session = room.players[side];
        if (session === null) continue;
        room.players[side] = null;
        this.#sessions.delete(session.token);
        room.revision += 1;
        this.#pendingRoomUpdates.add(room.code);
      }
    }
  }

  #startClock(room: RoomRecord, now: number): void {
    if (room.timeControl.kind === "untimed") {
      return;
    }
    room.clock.activeSide = room.match.getView().turn;
    room.clock.running = true;
    room.clock.anchorAtMs = now;
  }

  #clockSnapshot(room: RoomRecord, now: number): RoomClock {
    if (room.timeControl.kind === "untimed") {
      return { whiteMs: null, blackMs: null, activeSide: null, running: false };
    }

    const elapsed = room.clock.running && room.clock.anchorAtMs !== null
      ? Math.max(0, now - room.clock.anchorAtMs)
      : 0;
    return {
      whiteMs: Math.max(0, (room.clock.whiteMs ?? 0) - (room.clock.activeSide === "white" ? elapsed : 0)),
      blackMs: Math.max(0, (room.clock.blackMs ?? 0) - (room.clock.activeSide === "black" ? elapsed : 0)),
      activeSide: room.clock.activeSide,
      running: room.clock.running,
    };
  }

  #clockDeadline(room: RoomRecord): number | null {
    if (
      room.timeControl.kind === "untimed" ||
      !room.clock.running ||
      room.clock.activeSide === null ||
      room.clock.anchorAtMs === null
    ) {
      return null;
    }
    const remainingMs = room.clock.activeSide === "white" ? room.clock.whiteMs : room.clock.blackMs;
    if (remainingMs === null) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, room.clock.anchorAtMs + remainingMs);
  }

  #recoveryDeadline(disconnectedAt: number | null): number {
    if (disconnectedAt === null) return Number.MAX_SAFE_INTEGER;
    return Math.min(Number.MAX_SAFE_INTEGER, disconnectedAt + this.#recoveryGraceMs);
  }

  #settleClock(room: RoomRecord, now: number): boolean {
    if (
      room.phase !== "playing" ||
      room.match.getView().result !== null ||
      room.timeControl.kind === "untimed" ||
      !room.clock.running ||
      room.clock.activeSide === null
    ) {
      return false;
    }

    const remaining = this.#clockSnapshot(room, now);
    const timedOutSide = room.clock.activeSide;
    const activeRemaining = timedOutSide === "white" ? remaining.whiteMs : remaining.blackMs;
    if (activeRemaining === null || activeRemaining > 0) {
      return false;
    }

    const winner: Side = timedOutSide === "white" ? "black" : "white";
    if (!this.#finishWithResult(room, { state: "won", winner, reason: "timeout" }, now)) {
      return false;
    }
    room.revision += 1;
    this.#pendingRoomUpdates.add(room.code);
    return true;
  }

  #projectSnapshot(room: RoomRecord, viewer: InternalSession, now: number): RoomSnapshot {
    const revision = room.revision;
    const matchNumber = room.matchNumber;
    const phase = room.phase;
    const gameView = room.match.getView();
    const whitePlayer = this.#publicPlayer(room.players.white);
    const blackPlayer = this.#publicPlayer(room.players.black);
    const spectatorCount = room.spectators.size;
    const timeControl = copyTimeControl(room.timeControl);
    const clock = this.#clockSnapshot(room, now);
    const drawOffer = room.drawOffer === null ? null : { ...room.drawOffer };
    const rematchVotes = { ...room.rematchVotes };

    return {
      revision,
      matchNumber,
      phase,
      gameView,
      players: {
        white: whitePlayer,
        black: blackPlayer,
      },
      viewerSide: viewer.side,
      spectatorCount,
      timeControl,
      clock,
      serverNow: now,
      drawOffer,
      rematchVotes,
    };
  }

  #publicPlayer(session: InternalSession | null): PublicPlayerRecord | null {
    if (session?.player === null || session?.player === undefined) {
      return null;
    }
    const recoveryDeadlineMs = session.disconnectedAt === null
      ? null
      : session.disconnectedAt + this.#recoveryGraceMs;
    return { ...session.player, recoveryDeadlineMs };
  }

  #makeAccess(room: RoomRecord, session: InternalSession, now: number): RoomAccess {
    this.#settleClock(room, now);
    return {
      code: room.code,
      credentials: { sessionToken: session.token },
      // Access acknowledgments and per-session broadcast snapshots share this projection.
      snapshot: this.#projectSnapshot(room, session, now),
    };
  }
}
