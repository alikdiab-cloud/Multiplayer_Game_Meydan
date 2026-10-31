import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  CreateRoomAcknowledgmentSchema,
  CreateRoomInputSchema,
  DisplayNameSchema,
  JoinRoomAcknowledgmentSchema,
  JoinRoomInputSchema,
  LeaveRoomAcknowledgmentSchema,
  MoveRequestSchema,
  ProtocolErrorSchema,
  RevisionRequestSchema,
  RoomClosedNoticeSchema,
  RoomMutationAcknowledgmentSchema,
  RoomSnapshotSchema,
  RoomResumeInputSchema,
  ResumeRoomAcknowledgmentSchema,
  SessionCredentialsSchema,
  type Acknowledgment,
  type ClientToServerEvents,
  type CreateRoomAcknowledgment,
  type CreateRoomInput,
  type JoinRoomAcknowledgment,
  type JoinRoomInput,
  type LeaveRoomAcknowledgment,
  type MoveRequest,
  type ProtocolError,
  type RoomMutationAcknowledgment,
  type RoomResumeInput,
  type RoomSnapshot,
  type ServerToClientEvents,
  type SessionCredentials,
} from "../shared/protocol.js";

const SESSION_STORAGE_KEY = "meydan.online-session.v1";
const NICKNAME_STORAGE_KEY = "meydan.nickname.v1";
const ACK_TIMEOUT_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 5;

type OnlineSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type OnlineConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";
export type PendingOnlineCommand =
  | "create"
  | "join"
  | "resume"
  | "move"
  | "offer-draw"
  | "accept-draw"
  | "decline-draw"
  | "resign"
  | "rematch"
  | "leave";
export type SnapshotReceiptTime = {
  monotonicMs: number;
  ageAtReceiptMs: number;
};

export type UseOnlineRoomOptions = {
  /** Defaults to the current origin. Use this only for a deliberate same-site deployment setup. */
  url?: string;
  autoConnect?: boolean;
};

export type UseOnlineRoomResult = {
  connectionStatus: OnlineConnectionStatus;
  snapshot: RoomSnapshot | null;
  snapshotReceiptTime: SnapshotReceiptTime | null;
  roomCode: string | null;
  pendingCommand: PendingOnlineCommand | null;
  recoverableError: ProtocolError | null;
  rememberedNickname: string;
  connect: () => void;
  disconnect: () => void;
  createRoom: (input: CreateRoomInput) => Promise<CreateRoomAcknowledgment>;
  joinRoom: (input: JoinRoomInput) => Promise<JoinRoomAcknowledgment>;
  move: (move: MoveRequest) => Promise<RoomMutationAcknowledgment>;
  offerDraw: () => Promise<RoomMutationAcknowledgment>;
  acceptDraw: () => Promise<RoomMutationAcknowledgment>;
  declineDraw: () => Promise<RoomMutationAcknowledgment>;
  resign: () => Promise<RoomMutationAcknowledgment>;
  voteRematch: () => Promise<RoomMutationAcknowledgment>;
  leaveRoom: () => Promise<LeaveRoomAcknowledgment>;
  rememberNickname: (name: string) => boolean;
  clearRecoverableError: () => void;
};

type StoredRoomSession = RoomResumeInput;
type PendingRequest = { id: number; command: PendingOnlineCommand };

function errorValue(code: ProtocolError["code"], message: string): ProtocolError {
  return { code, message };
}

function failed<T>(error: ProtocolError): Acknowledgment<T> {
  return { ok: false, error };
}

function connectionError(): ProtocolError {
  return errorValue("conflict", "Connect to the game server before sending a command.");
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function readStoredRoomSession(): StoredRoomSession | null {
  if (typeof window === "undefined") return null;

  let rawValue: string | null;
  try {
    rawValue = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the tab can still create or join a room.
    return null;
  }
  if (rawValue === null) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawValue);
  } catch {
    removeStoredRoomSession();
    return null;
  }
  const parsed = RoomResumeInputSchema.safeParse(parsedJson);
  if (parsed.success) return parsed.data;
  removeStoredRoomSession();
  return null;
}

/** True when this tab has a syntactically valid private credential to resume. */
export function hasStoredRoomSession(): boolean {
  return readStoredRoomSession() !== null;
}

function writeStoredRoomSession(code: string, credentials: SessionCredentials): boolean {
  try {
    const parsedCredentials = SessionCredentialsSchema.safeParse(credentials);
    const parsedSession = RoomResumeInputSchema.safeParse({ code, sessionToken: credentials.sessionToken });
    if (!parsedCredentials.success || !parsedSession.success) return false;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(parsedSession.data));
    return true;
  } catch {
    return false;
  }
}

function removeStoredRoomSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // In-memory leave still succeeds when browser storage is unavailable.
  }
}

function readRememberedNickname(): string {
  try {
    const stored = window.localStorage.getItem(NICKNAME_STORAGE_KEY);
    const parsed = DisplayNameSchema.safeParse(stored);
    return parsed.success ? parsed.data : "";
  } catch {
    return "";
  }
}

function writeRememberedNickname(name: string): boolean {
  const parsed = DisplayNameSchema.safeParse(name);
  if (!parsed.success) return false;
  try {
    window.localStorage.setItem(NICKNAME_STORAGE_KEY, parsed.data);
    return true;
  } catch {
    return false;
  }
}

function isSnapshotAtLeastAsNew(next: RoomSnapshot, current: RoomSnapshot): boolean {
  if (next.matchNumber !== current.matchNumber) {
    return next.matchNumber > current.matchNumber;
  }
  if (next.revision !== current.revision) {
    return next.revision > current.revision;
  }
  return next.serverNow >= current.serverNow;
}

function makeSocket(url: string | undefined): OnlineSocket {
  const socketOptions = {
    autoConnect: false,
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3_000,
  };
  return (url === undefined ? io(socketOptions) : io(url, socketOptions)) as OnlineSocket;
}

function resumeError(error: ProtocolError): ProtocolError {
  if (error.code === "room-not-found") {
    return {
      ...error,
      message: "This room is no longer available. It may have closed or the server restarted; create a room or join an available one.",
    };
  }
  if (error.code === "unauthorized") {
    return {
      ...error,
      message: "This saved room session expired or became invalid, possibly because the server restarted. In-memory matches do not survive a restart. Join an available room or create a new one.",
    };
  }
  return error;
}

/**
 * Client boundary for online matches. The server snapshot is the only game state
 * this hook exposes; commands never change the board or clock optimistically.
 */
export function useOnlineRoom(options: UseOnlineRoomOptions = {}): UseOnlineRoomResult {
  const { url, autoConnect = true } = options;
  const [connectionStatus, setConnectionStatus] = useState<OnlineConnectionStatus>("idle");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [snapshotReceiptTime, setSnapshotReceiptTime] = useState<SnapshotReceiptTime | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingOnlineCommand | null>(null);
  const [recoverableError, setRecoverableError] = useState<ProtocolError | null>(null);
  const [rememberedNickname, setRememberedNickname] = useState("");

  const socketRef = useRef<OnlineSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const snapshotReceiptTimeRef = useRef<SnapshotReceiptTime | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  const requestIdRef = useRef(0);
  const issuedCredentialRef = useRef<SessionCredentials | null>(null);

  const applySnapshot = useCallback((next: RoomSnapshot, force = false, requestStartedAtMs?: number) => {
    const current = snapshotRef.current;
    if (!force && current !== null && !isSnapshotAtLeastAsNew(next, current)) return;
    const receivedAtMonotonicMs = monotonicNow();
    const previousReceipt = snapshotReceiptTimeRef.current;
    // Estimate packet age from receipt-to-receipt monotonic time and serverNow
    // deltas. This avoids relying on a client's potentially skewed wall clock.
    const ageAtReceiptMs = current !== null &&
      previousReceipt !== null &&
      next.serverNow >= current.serverNow
      ? Math.max(
          0,
          previousReceipt.ageAtReceiptMs +
            Math.max(0, receivedAtMonotonicMs - previousReceipt.monotonicMs) -
            (next.serverNow - current.serverNow),
        )
      : requestStartedAtMs === undefined
        ? 0
        : Math.max(0, (receivedAtMonotonicMs - requestStartedAtMs) / 2);
    const receiptTime = { monotonicMs: receivedAtMonotonicMs, ageAtReceiptMs };
    // Server clock broadcasts advance serverNow without changing the position.
    // Keep the immutable view identity stable for board capture previews while
    // still publishing the fresh snapshot and clock values.
    const snapshotToApply = !force &&
      current !== null &&
      current.matchNumber === next.matchNumber &&
      current.revision === next.revision
      ? { ...next, gameView: current.gameView }
      : next;
    snapshotRef.current = snapshotToApply;
    setSnapshot(snapshotToApply);
    snapshotReceiptTimeRef.current = receiptTime;
    setSnapshotReceiptTime(receiptTime);
  }, []);

  const beginPending = useCallback((command: PendingOnlineCommand): number | null => {
    if (pendingRef.current !== null) return null;
    requestIdRef.current += 1;
    const id = requestIdRef.current;
    pendingRef.current = { id, command };
    setPendingCommand(command);
    return id;
  }, []);

  const finishPending = useCallback((id: number) => {
    if (pendingRef.current?.id !== id) return;
    pendingRef.current = null;
    setPendingCommand(null);
  }, []);

  const rememberNickname = useCallback((name: string): boolean => {
    const parsed = DisplayNameSchema.safeParse(name);
    if (!parsed.success) {
      setRecoverableError(errorValue("invalid-input", "Enter a valid display name."));
      return false;
    }
    if (!writeRememberedNickname(parsed.data)) {
      setRecoverableError(errorValue("internal-error", "This browser could not save your display name. You can keep playing; enter it again next time."));
      return false;
    }
    setRememberedNickname(parsed.data);
    return true;
  }, []);

  const clearRecoverableError = useCallback(() => setRecoverableError(null), []);

  useEffect(() => {
    let active = true;
    const socket = makeSocket(url);
    const generation = socketGenerationRef.current + 1;
    socketGenerationRef.current = generation;
    socketRef.current = socket;
    setRememberedNickname(readRememberedNickname());

    const isCurrent = () => active && socketRef.current === socket && socketGenerationRef.current === generation;
    const setSnapshotFromWire = (wireValue: unknown) => {
      const parsed = RoomSnapshotSchema.safeParse(wireValue);
      if (!parsed.success) {
        setRecoverableError(errorValue("internal-error", "The server sent an invalid match snapshot."));
        return;
      }
      if (roomCodeRef.current !== null) applySnapshot(parsed.data);
    };

    const onCredential = (wireCredentials: SessionCredentials) => {
      const parsed = SessionCredentialsSchema.safeParse(wireCredentials);
      if (!parsed.success) {
        setRecoverableError(errorValue("internal-error", "The server sent invalid session credentials."));
        return;
      }
      // Keep it in memory until the matching access acknowledgment supplies its room code.
      issuedCredentialRef.current = parsed.data;
    };

    const onSnapshot = (wireSnapshot: RoomSnapshot) => {
      if (isCurrent()) setSnapshotFromWire(wireSnapshot);
    };

    const onServerError = (wireError: ProtocolError) => {
      if (!isCurrent()) return;
      const parsed = ProtocolErrorSchema.safeParse(wireError);
      setRecoverableError(parsed.success
        ? parsed.data
        : errorValue("internal-error", "The server returned an invalid error response."));
    };

    const onRoomClosed = (wireNotice: unknown) => {
      if (!isCurrent()) return;
      const parsedNotice = RoomClosedNoticeSchema.safeParse(wireNotice);
      removeStoredRoomSession();
      roomCodeRef.current = null;
      setRoomCode(null);
      snapshotRef.current = null;
      setSnapshot(null);
      snapshotReceiptTimeRef.current = null;
      setSnapshotReceiptTime(null);
      issuedCredentialRef.current = null;
      if (pendingRef.current !== null) {
        pendingRef.current = null;
        setPendingCommand(null);
      }
      setRecoverableError(errorValue(
        "room-not-found",
        parsedNotice.success && parsedNotice.data.reason === "server-shutdown"
          ? "The server restarted, so this in-memory room is no longer available. Create a room or join an available one."
          : parsedNotice.success && parsedNotice.data.reason === "idle-timeout"
            ? "This room expired after six hours without activity. Its seats and reconnect sessions were released. Create a room or join an available one."
          : "This room is no longer available. It may have closed or the server restarted; create a room or join an available one.",
      ));
    };

    const onConnect = () => {
      if (!isCurrent()) return;
      setConnectionStatus("connected");
      setRecoverableError(null);
      const storedSession = readStoredRoomSession();
      if (storedSession === null) return;
      roomCodeRef.current = storedSession.code;
      setRoomCode(storedSession.code);
      if (pendingRef.current !== null) return;

      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      pendingRef.current = { id: requestId, command: "resume" };
      setPendingCommand("resume");
      issuedCredentialRef.current = null;
      const requestStartedAtMs = monotonicNow();
      const resumeInput = RoomResumeInputSchema.safeParse(storedSession);
      if (!resumeInput.success) {
        removeStoredRoomSession();
        pendingRef.current = null;
        setPendingCommand(null);
        setRoomCode(null);
        roomCodeRef.current = null;
        return;
      }

      void socket.timeout(ACK_TIMEOUT_MS).emitWithAck("room:resume", resumeInput.data).then(
        (wireResponse) => {
          if (!isCurrent()) return;
          const parsed = ResumeRoomAcknowledgmentSchema.safeParse(wireResponse);
          if (!parsed.success) {
            setRecoverableError(errorValue("internal-error", "The server returned an invalid reconnect response."));
            return;
          }
          if (!parsed.data.ok) {
            setRecoverableError(resumeError(parsed.data.error));
            if (["unauthorized", "room-not-found", "session-conflict", "invalid-input"].includes(parsed.data.error.code)) {
              removeStoredRoomSession();
              issuedCredentialRef.current = null;
              roomCodeRef.current = null;
              setRoomCode(null);
              snapshotRef.current = null;
              setSnapshot(null);
              snapshotReceiptTimeRef.current = null;
              setSnapshotReceiptTime(null);
            }
            return;
          }

          const credential = issuedCredentialRef.current ?? { sessionToken: storedSession.sessionToken };
          if (!writeStoredRoomSession(parsed.data.data.code, credential)) {
            setRecoverableError(errorValue(
              "internal-error",
              "This tab could not save its reconnect identity. Keep it open; after a refresh, you may need to rejoin with the room code.",
            ));
          }
          roomCodeRef.current = parsed.data.data.code;
          setRoomCode(parsed.data.data.code);
          applySnapshot(parsed.data.data.snapshot, true, requestStartedAtMs);
          setRecoverableError(null);
        },
      ).catch(() => {
        if (isCurrent()) {
          setRecoverableError(errorValue("internal-error", "Reconnect did not complete. The tab will retry when connected."));
        }
      }).finally(() => finishPending(requestId));
    };

    const onDisconnect = () => {
      if (!isCurrent()) return;
      setConnectionStatus(socket.active ? "reconnecting" : "disconnected");
      if (!socket.active && roomCodeRef.current !== null) {
        setRecoverableError(errorValue(
          "internal-error",
          "The connection closed. Retry connection to check whether the room is still available.",
        ));
      }
      const pending = pendingRef.current;
      if (pending !== null) {
        pendingRef.current = null;
        setPendingCommand(null);
        setRecoverableError(errorValue("conflict", "The connection closed before the command was confirmed."));
      }
    };

    const onConnectError = () => {
      if (!isCurrent()) return;
      setConnectionStatus(socket.active ? "reconnecting" : "disconnected");
      if (!socket.active) {
        setRecoverableError(errorValue("internal-error", "Could not connect to the game server. Retry when the server is available."));
      }
    };

    const onReconnectFailed = () => {
      if (!isCurrent()) return;
      setConnectionStatus("disconnected");
      setRecoverableError(errorValue(
        "internal-error",
        roomCodeRef.current === null
          ? "Automatic connection attempts stopped. Retry connection when the server is available."
          : "Automatic reconnect stopped after several attempts. Retry connection to check whether this room is still available.",
      ));
    };

    socket.on("session:credential", onCredential);
    socket.on("room:snapshot", onSnapshot);
    socket.on("room:closed", onRoomClosed);
    socket.on("server:error", onServerError);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.io.on("reconnect_failed", onReconnectFailed);

    if (autoConnect) {
      setConnectionStatus("connecting");
      socket.connect();
    }

    return () => {
      active = false;
      socket.off("session:credential", onCredential);
      socket.off("room:snapshot", onSnapshot);
      socket.off("room:closed", onRoomClosed);
      socket.off("server:error", onServerError);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.io.off("reconnect_failed", onReconnectFailed);
      if (socketRef.current === socket) {
        socketRef.current = null;
        socketGenerationRef.current += 1;
      }
      if (pendingRef.current !== null) {
        pendingRef.current = null;
        setPendingCommand(null);
      }
      socket.disconnect();
    };
  }, [applySnapshot, autoConnect, finishPending, url]);

  const connect = useCallback(() => {
    const socket = socketRef.current;
    if (socket === null || socket.connected) return;
    setConnectionStatus("connecting");
    setRecoverableError(null);
    socket.connect();
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
  }, []);

  const createRoom = useCallback(async (input: CreateRoomInput): Promise<CreateRoomAcknowledgment> => {
    const parsedInput = CreateRoomInputSchema.safeParse(input);
    if (!parsedInput.success) {
      const error = errorValue("invalid-input", "Room creation details are invalid.");
      setRecoverableError(error);
      return failed(error);
    }
    const socket = socketRef.current;
    if (socket === null || !socket.connected) {
      const error = connectionError();
      setRecoverableError(error);
      return failed(error);
    }
    const requestId = beginPending("create");
    if (requestId === null) {
      const error = errorValue("conflict", "Another room command is still pending.");
      setRecoverableError(error);
      return failed(error);
    }
    const generation = socketGenerationRef.current;
    issuedCredentialRef.current = null;
    try {
      const requestStartedAtMs = monotonicNow();
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("room:create", parsedInput.data);
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) {
        return failed(errorValue("conflict", "The connection changed before the command completed."));
      }
      const parsedResponse = CreateRoomAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        const error = errorValue("internal-error", "The server returned an invalid room response.");
        setRecoverableError(error);
        return failed(error);
      }
      if (!parsedResponse.data.ok) {
        setRecoverableError(parsedResponse.data.error);
        return parsedResponse.data;
      }
      const access = parsedResponse.data.data;
      roomCodeRef.current = access.code;
      setRoomCode(access.code);
      applySnapshot(access.snapshot, true, requestStartedAtMs);
      const credentials = issuedCredentialRef.current;
      const reconnectIdentitySaved = credentials !== null && writeStoredRoomSession(access.code, credentials);
      const nicknameSaved = rememberNickname(parsedInput.data.name);
      if (!reconnectIdentitySaved && !nicknameSaved) {
        setRecoverableError(errorValue(
          "internal-error",
          "This room is active in this tab, but the browser could not save your reconnect identity or nickname. Keep this tab open; copy the room code or leave and rejoin after storage is available.",
        ));
      } else if (!reconnectIdentitySaved) {
        setRecoverableError(errorValue(
          "internal-error",
          "This tab could not save its reconnect identity. Keep it open; after a refresh, you may need to rejoin with the room code.",
        ));
      } else if (nicknameSaved) {
        setRecoverableError(null);
      }
      return parsedResponse.data;
    } catch {
      const error = errorValue("internal-error", "The room could not be created. Check the connection and try again.");
      if (socketRef.current === socket && socketGenerationRef.current === generation) setRecoverableError(error);
      return failed(error);
    } finally {
      finishPending(requestId);
    }
  }, [applySnapshot, beginPending, finishPending, rememberNickname]);

  const joinRoom = useCallback(async (input: JoinRoomInput): Promise<JoinRoomAcknowledgment> => {
    const parsedInput = JoinRoomInputSchema.safeParse(input);
    if (!parsedInput.success) {
      const error = errorValue("invalid-input", "Room join details are invalid.");
      setRecoverableError(error);
      return failed(error);
    }
    const socket = socketRef.current;
    if (socket === null || !socket.connected) {
      const error = connectionError();
      setRecoverableError(error);
      return failed(error);
    }
    const requestId = beginPending("join");
    if (requestId === null) {
      const error = errorValue("conflict", "Another room command is still pending.");
      setRecoverableError(error);
      return failed(error);
    }
    const generation = socketGenerationRef.current;
    issuedCredentialRef.current = null;
    try {
      const requestStartedAtMs = monotonicNow();
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("room:join", parsedInput.data);
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) {
        return failed(errorValue("conflict", "The connection changed before the command completed."));
      }
      const parsedResponse = JoinRoomAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        const error = errorValue("internal-error", "The server returned an invalid room response.");
        setRecoverableError(error);
        return failed(error);
      }
      if (!parsedResponse.data.ok) {
        setRecoverableError(parsedResponse.data.error);
        return parsedResponse.data;
      }
      const access = parsedResponse.data.data;
      roomCodeRef.current = access.code;
      setRoomCode(access.code);
      applySnapshot(access.snapshot, true, requestStartedAtMs);
      const credentials = issuedCredentialRef.current;
      const reconnectIdentitySaved = credentials !== null && writeStoredRoomSession(access.code, credentials);
      const nicknameSaved = rememberNickname(parsedInput.data.name);
      if (!reconnectIdentitySaved && !nicknameSaved) {
        setRecoverableError(errorValue(
          "internal-error",
          "This room is active in this tab, but the browser could not save your reconnect identity or nickname. Keep this tab open; copy the room code or leave and rejoin after storage is available.",
        ));
      } else if (!reconnectIdentitySaved) {
        setRecoverableError(errorValue(
          "internal-error",
          "This tab could not save its reconnect identity. Keep it open; after a refresh, you may need to rejoin with the room code.",
        ));
      } else if (nicknameSaved) {
        setRecoverableError(null);
      }
      return parsedResponse.data;
    } catch {
      const error = errorValue("internal-error", "The room could not be joined. Check the code and connection.");
      if (socketRef.current === socket && socketGenerationRef.current === generation) setRecoverableError(error);
      return failed(error);
    } finally {
      finishPending(requestId);
    }
  }, [applySnapshot, beginPending, finishPending, rememberNickname]);

  const refreshCurrentRoomSnapshot = useCallback(async (
    socket: OnlineSocket,
    generation: number,
  ): Promise<boolean> => {
    const storedSession = readStoredRoomSession();
    if (
      socketRef.current !== socket ||
      socketGenerationRef.current !== generation ||
      !socket.connected ||
      storedSession === null ||
      storedSession.code !== roomCodeRef.current
    ) {
      return false;
    }

    issuedCredentialRef.current = null;
    try {
      const input = RoomResumeInputSchema.safeParse(storedSession);
      if (!input.success) {
        setRecoverableError(errorValue("internal-error", "The saved room identity is invalid."));
        return false;
      }
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("room:resume", input.data);
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) return false;
      const parsedResponse = ResumeRoomAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        setRecoverableError(errorValue("internal-error", "The server returned an invalid refreshed snapshot."));
        return false;
      }
      if (!parsedResponse.data.ok) {
        setRecoverableError(parsedResponse.data.error);
        return false;
      }

      const access = parsedResponse.data.data;
      const credentials = issuedCredentialRef.current ?? { sessionToken: storedSession.sessionToken };
      if (!writeStoredRoomSession(access.code, credentials)) {
        setRecoverableError(errorValue(
          "internal-error",
          "This tab could not save its reconnect identity. Keep it open; after a refresh, you may need to rejoin with the room code.",
        ));
      } else {
        setRecoverableError(null);
      }
      roomCodeRef.current = access.code;
      setRoomCode(access.code);
      applySnapshot(access.snapshot);
      return true;
    } catch {
      if (socketRef.current === socket && socketGenerationRef.current === generation) {
        setRecoverableError(errorValue("internal-error", "The current room snapshot could not be refreshed."));
      }
      return false;
    }
  }, [applySnapshot]);

  const move = useCallback(async (moveInput: MoveRequest): Promise<RoomMutationAcknowledgment> => {
    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot === null || currentSnapshot.phase !== "playing") {
      const error = errorValue("conflict", "There is no active online match.");
      setRecoverableError(error);
      return failed(error);
    }
    if (currentSnapshot.viewerSide === null || currentSnapshot.gameView.turn !== currentSnapshot.viewerSide) {
      const error = errorValue("not-your-turn", "It is not your turn to move.");
      setRecoverableError(error);
      return failed(error);
    }
    const parsedInput = MoveRequestSchema.safeParse(moveInput);
    if (!parsedInput.success) {
      const error = errorValue("invalid-input", "The move request is invalid.");
      setRecoverableError(error);
      return failed(error);
    }
    const socket = socketRef.current;
    if (socket === null || !socket.connected) {
      const error = connectionError();
      setRecoverableError(error);
      return failed(error);
    }
    const requestId = beginPending("move");
    if (requestId === null) {
      const error = errorValue("conflict", "Another room command is still pending.");
      setRecoverableError(error);
      return failed(error);
    }
    const generation = socketGenerationRef.current;
    try {
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("game:move", parsedInput.data);
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) {
        return failed(errorValue("conflict", "The connection changed before the move was confirmed."));
      }
      const parsedResponse = RoomMutationAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        const error = errorValue("internal-error", "The server returned an invalid move response.");
        setRecoverableError(error);
        return failed(error);
      }
      if (!parsedResponse.data.ok) {
        setRecoverableError(parsedResponse.data.error);
        if (parsedResponse.data.error.code === "stale-revision") {
          await refreshCurrentRoomSnapshot(socket, generation);
        }
        return parsedResponse.data;
      }
      setRecoverableError(null);
      applySnapshot(parsedResponse.data.data.snapshot);
      return parsedResponse.data;
    } catch {
      const error = errorValue("internal-error", "The move was not confirmed. The server state was not changed locally.");
      if (socketRef.current === socket && socketGenerationRef.current === generation) setRecoverableError(error);
      return failed(error);
    } finally {
      finishPending(requestId);
    }
  }, [applySnapshot, beginPending, finishPending, refreshCurrentRoomSnapshot]);

  const performRevisionAction = useCallback(async (
    command: Extract<PendingOnlineCommand, "offer-draw" | "accept-draw" | "decline-draw" | "resign">,
    event: "draw:offer" | "draw:accept" | "draw:decline" | "match:resign",
  ): Promise<RoomMutationAcknowledgment> => {
    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot === null || currentSnapshot.phase !== "playing") {
      const error = errorValue("conflict", "This action is available only during an active online match.");
      setRecoverableError(error);
      return failed(error);
    }
    if (currentSnapshot.viewerSide === null) {
      const error = errorValue("not-your-turn", "Spectators cannot act on an online match.");
      setRecoverableError(error);
      return failed(error);
    }
    const request = RevisionRequestSchema.safeParse({ revision: currentSnapshot.revision });
    if (!request.success) {
      const error = errorValue("internal-error", "The current room revision is invalid.");
      setRecoverableError(error);
      return failed(error);
    }
    const socket = socketRef.current;
    if (socket === null || !socket.connected) {
      const error = connectionError();
      setRecoverableError(error);
      return failed(error);
    }
    const requestId = beginPending(command);
    if (requestId === null) {
      const error = errorValue("conflict", "Another room command is still pending.");
      setRecoverableError(error);
      return failed(error);
    }
    const generation = socketGenerationRef.current;
    try {
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, request.data);
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) {
        return failed(errorValue("conflict", "The connection changed before the action was confirmed."));
      }
      const parsedResponse = RoomMutationAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        const error = errorValue("internal-error", "The server returned an invalid match-action response.");
        setRecoverableError(error);
        return failed(error);
      }
      if (!parsedResponse.data.ok) {
        setRecoverableError(parsedResponse.data.error);
        if (parsedResponse.data.error.code === "stale-revision") {
          await refreshCurrentRoomSnapshot(socket, generation);
        }
        return parsedResponse.data;
      }
      setRecoverableError(null);
      applySnapshot(parsedResponse.data.data.snapshot);
      return parsedResponse.data;
    } catch {
      const actionName = command === "offer-draw"
        ? "Draw offer"
        : command === "accept-draw"
          ? "Draw acceptance"
          : command === "decline-draw"
            ? "Draw decline"
            : "Resignation";
      const error = errorValue("internal-error", `${actionName} was not confirmed. The server state was not changed locally.`);
      if (socketRef.current === socket && socketGenerationRef.current === generation) setRecoverableError(error);
      return failed(error);
    } finally {
      finishPending(requestId);
    }
  }, [applySnapshot, beginPending, finishPending, refreshCurrentRoomSnapshot]);

  const offerDraw = useCallback(
    () => performRevisionAction("offer-draw", "draw:offer"),
    [performRevisionAction],
  );
  const acceptDraw = useCallback(
    () => performRevisionAction("accept-draw", "draw:accept"),
    [performRevisionAction],
  );
  const declineDraw = useCallback(
    () => performRevisionAction("decline-draw", "draw:decline"),
    [performRevisionAction],
  );
  const resign = useCallback(
    () => performRevisionAction("resign", "match:resign"),
    [performRevisionAction],
  );

  const voteRematch = useCallback(async (): Promise<RoomMutationAcknowledgment> => {
    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot === null || currentSnapshot.phase !== "finished") {
      const error = errorValue("conflict", "There is no finished online match to rematch.");
      setRecoverableError(error);
      return failed(error);
    }
    if (currentSnapshot.viewerSide === null) {
      const error = errorValue("not-your-turn", "Spectators cannot vote for a rematch.");
      setRecoverableError(error);
      return failed(error);
    }
    const request = RevisionRequestSchema.safeParse({ revision: currentSnapshot.revision });
    if (!request.success) {
      const error = errorValue("internal-error", "The current room revision is invalid.");
      setRecoverableError(error);
      return failed(error);
    }
    const socket = socketRef.current;
    if (socket === null || !socket.connected) {
      const error = connectionError();
      setRecoverableError(error);
      return failed(error);
    }
    const requestId = beginPending("rematch");
    if (requestId === null) {
      const error = errorValue("conflict", "Another room command is still pending.");
      setRecoverableError(error);
      return failed(error);
    }
    const generation = socketGenerationRef.current;
    try {
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("rematch:vote", request.data);
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) {
        return failed(errorValue("conflict", "The connection changed before the rematch vote was confirmed."));
      }
      const parsedResponse = RoomMutationAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        const error = errorValue("internal-error", "The server returned an invalid rematch response.");
        setRecoverableError(error);
        return failed(error);
      }
      if (!parsedResponse.data.ok) {
        setRecoverableError(parsedResponse.data.error);
        if (parsedResponse.data.error.code === "stale-revision") {
          await refreshCurrentRoomSnapshot(socket, generation);
        }
        return parsedResponse.data;
      }
      setRecoverableError(null);
      applySnapshot(parsedResponse.data.data.snapshot);
      return parsedResponse.data;
    } catch {
      const error = errorValue("internal-error", "The rematch vote was not confirmed. The server state was not changed locally.");
      if (socketRef.current === socket && socketGenerationRef.current === generation) setRecoverableError(error);
      return failed(error);
    } finally {
      finishPending(requestId);
    }
  }, [applySnapshot, beginPending, finishPending, refreshCurrentRoomSnapshot]);

  const leaveRoom = useCallback(async (): Promise<LeaveRoomAcknowledgment> => {
    const socket = socketRef.current;
    if (socket === null || !socket.connected) {
      const error = connectionError();
      setRecoverableError(error);
      return failed(error);
    }
    const requestId = beginPending("leave");
    if (requestId === null) {
      const error = errorValue("conflict", "Another room command is still pending.");
      setRecoverableError(error);
      return failed(error);
    }
    const generation = socketGenerationRef.current;
    try {
      const wireResponse = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("room:leave");
      if (socketRef.current !== socket || socketGenerationRef.current !== generation) {
        return failed(errorValue("conflict", "The connection changed before leaving was confirmed."));
      }
      const parsedResponse = LeaveRoomAcknowledgmentSchema.safeParse(wireResponse);
      if (!parsedResponse.success) {
        const error = errorValue("internal-error", "The server returned an invalid leave response.");
        setRecoverableError(error);
        return failed(error);
      }
      if (!parsedResponse.data.ok) {
        const error = resumeError(parsedResponse.data.error);
        setRecoverableError(error);
        if (["unauthorized", "room-not-found"].includes(parsedResponse.data.error.code)) {
          removeStoredRoomSession();
          issuedCredentialRef.current = null;
          roomCodeRef.current = null;
          setRoomCode(null);
          snapshotRef.current = null;
          setSnapshot(null);
          snapshotReceiptTimeRef.current = null;
          setSnapshotReceiptTime(null);
        }
        return { ok: false, error };
      }
      removeStoredRoomSession();
      issuedCredentialRef.current = null;
      roomCodeRef.current = null;
      setRoomCode(null);
      snapshotRef.current = null;
      setSnapshot(null);
      snapshotReceiptTimeRef.current = null;
      setSnapshotReceiptTime(null);
      setRecoverableError(null);
      return parsedResponse.data;
    } catch {
      const error = errorValue("internal-error", "Leaving the room was not confirmed.");
      if (socketRef.current === socket && socketGenerationRef.current === generation) setRecoverableError(error);
      return failed(error);
    } finally {
      finishPending(requestId);
    }
  }, [beginPending, finishPending]);

  return {
    connectionStatus,
    snapshot,
    snapshotReceiptTime,
    roomCode,
    pendingCommand,
    recoverableError,
    rememberedNickname,
    connect,
    disconnect,
    createRoom,
    joinRoom,
    move,
    offerDraw,
    acceptDraw,
    declineDraw,
    resign,
    voteRematch,
    leaveRoom,
    rememberNickname,
    clearRecoverableError,
  };
}
