import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  Flag,
  FlipVertical2,
  Globe2,
  Handshake,
  RotateCcw,
  Undo2,
  UsersRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { BotDifficulty } from "../shared/bot.js";
import {
  DisplayNameSchema,
  RoomCodeSchema,
  TIME_CONTROL_PRESETS,
  type TimeControlKind,
} from "../shared/protocol.js";
import { Board, type BoardHandle } from "./components/Board.js";
import { Modal } from "./components/Modal.js";
import { OnlineClock } from "./components/OnlineClock.js";
import { Rules } from "./components/Rules.js";
import { Scorebook } from "./components/Scorebook.js";
import { useBotWorker } from "./useBotWorker.js";
import { committedSoundForChange } from "./gameSoundEvents.js";
import { useGameSounds } from "./useGameSounds.js";
import { hasStoredRoomSession, useOnlineRoom } from "./useOnlineRoom.js";
import {
  DamaMatch,
  resultDetail,
  resultText,
  sameMove,
  type GameResult,
  type GameView,
  type LegalMove,
  type MoveInput,
  type Side,
} from "../shared/game.js";

type PlayMode = "local" | "computer" | "online";

type MatchTransition = {
  mode?: PlayMode;
  humanSide?: Side;
  difficulty?: BotDifficulty;
  newGame?: true;
  leaveRoom?: true;
};

type PendingOnlineConfirmation = "accept-draw" | "resign" | "rematch";
type MatchIdentity = {
  mode: PlayMode;
  localMatch: DamaMatch | null;
  roomCode: string | null;
  matchNumber: number;
};
type ResultDialogState = { identity: MatchIdentity; endingId: number };

type AppProps = {
  initialMatch?: DamaMatch;
  initialPlayMode?: PlayMode;
  initialHumanSide?: Side;
  initialDifficulty?: BotDifficulty;
};

const DIFFICULTY_STORAGE_KEY = "meydan.difficulty.v1";

function readDifficultyPreference(): BotDifficulty {
  try {
    const stored = window.localStorage.getItem(DIFFICULTY_STORAGE_KEY);
    return stored === "easy" || stored === "medium" || stored === "hard" ? stored : "medium";
  } catch {
    return "medium";
  }
}

function writeDifficultyPreference(difficulty: BotDifficulty): void {
  try {
    window.localStorage.setItem(DIFFICULTY_STORAGE_KEY, difficulty);
  } catch {
    // The current tab still honors the chosen difficulty without storage.
  }
}

function sideName(side: Side): string {
  return side === "white" ? "White" : "Black";
}

function opposingSide(side: Side): Side {
  return side === "white" ? "black" : "white";
}

function recoveryTimeLabel(deadlineMs: number): string {
  return new Date(deadlineMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sameMatchIdentity(first: MatchIdentity, second: MatchIdentity): boolean {
  return first.mode === second.mode &&
    first.localMatch === second.localMatch &&
    first.roomCode === second.roomCode &&
    first.matchNumber === second.matchNumber;
}

function MatchResultSummary({
  result,
  matchNumber,
  players,
  testId,
}: {
  result: GameResult | null;
  matchNumber: number;
  players: Record<Side, string>;
  testId: string;
}) {
  return (
    <div
      className="online-result"
      data-testid={testId}
      data-result-state={result?.state ?? "unknown"}
      data-result-reason={result?.reason ?? "unknown"}
    >
      <span className="online-result-label">Match {matchNumber} result</span>
      <strong>{result === null ? "Match finished" : resultText(result)}</strong>
      <span>{result === null ? "The server marked this match finished." : resultDetail(result)}</span>
      <p className="result-player-names">
        White: {players.white} <span aria-hidden="true">·</span> Black: {players.black}
      </p>
    </div>
  );
}

function seatStatus(view: GameView, side: Side): string | null {
  if (view.result === null) {
    return view.turn === side ? "To move" : null;
  }
  if (view.result.state === "draw") {
    return "Draw";
  }
  return view.result.winner === side ? "Winner" : "Finished";
}

function PlayerSeat({
  view,
  side,
  playerName,
}: {
  view: GameView;
  side: Side;
  playerName: string;
}) {
  const status = seatStatus(view, side);

  return (
    <div className={`seat-line seat-${side}`} data-testid={`${side}-seat`}>
      <img src={`/pieces/piece-${side}-man.svg`} alt="" aria-hidden="true" />
      <div className="seat-copy">
        <span className="seat-name">{sideName(side)}</span>
        <span className="seat-detail">{playerName}</span>
      </div>
      {status !== null && (
        <span className={`seat-turn${view.result === null ? "" : " seat-turn--finished"}`}>
          {status}
        </span>
      )}
    </div>
  );
}

function isSameLegalMove(first: LegalMove, second: LegalMove): boolean {
  return (
    sameMove(first, second) &&
    first.captured.length === second.captured.length &&
    first.captured.every((square, index) => square === second.captured[index])
  );
}

function undoToHumanTurn(match: DamaMatch, humanSide: Side): GameView {
  let restoredView = match.getView();
  const availablePlies = restoredView.history.length;

  for (let undonePlies = 0; undonePlies < availablePlies; undonePlies += 1) {
    restoredView = match.undo(1);
    if (restoredView.result === null && restoredView.turn === humanSide) {
      break;
    }
  }

  return restoredView;
}

function App({
  initialMatch,
  initialPlayMode,
  initialHumanSide,
  initialDifficulty,
}: AppProps = {}) {
  const [match, setMatch] = useState(() => initialMatch ?? new DamaMatch());
  const [revision, setRevision] = useState(0);
  const [playMode, setPlayMode] = useState<PlayMode>(() =>
    initialPlayMode ?? (hasStoredRoomSession() ? "online" : "local"),
  );
  const [humanSide, setHumanSide] = useState<Side>(() => initialHumanSide ?? "white");
  const [difficulty, setDifficulty] = useState<BotDifficulty>(
    () => initialDifficulty ?? readDifficultyPreference(),
  );
  const gameSounds = useGameSounds();
  const online = useOnlineRoom({ autoConnect: playMode === "online" });
  const [onlineName, setOnlineName] = useState("");
  const [createSide, setCreateSide] = useState<Side>("white");
  const [timeControlKind, setTimeControlKind] = useState<TimeControlKind>("untimed");
  const [joinCode, setJoinCode] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [onlineFeedback, setOnlineFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [clipboardFeedback, setClipboardFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [boardFlipped, setBoardFlipped] = useState(false);
  const [spectatorBoardFlipped, setSpectatorBoardFlipped] = useState(false);
  const [botThinking, setBotThinking] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [botRetryAttempt, setBotRetryAttempt] = useState(0);
  const [pendingTransition, setPendingTransition] = useState<MatchTransition | null>(null);
  const [pendingOnlineConfirmation, setPendingOnlineConfirmation] = useState<PendingOnlineConfirmation | null>(null);
  const [resultDialog, setResultDialog] = useState<ResultDialogState | null>(null);
  const { search: searchWithBot, cancel: cancelBotSearch } = useBotWorker();
  const boardRef = useRef<BoardHandle>(null);
  const newGameButtonRef = useRef<HTMLButtonElement>(null);
  const cancelNewGameRef = useRef<HTMLButtonElement>(null);
  const closeResultDialogRef = useRef<HTMLButtonElement>(null);
  const turnStatusRef = useRef<HTMLDivElement>(null);
  const onlineConfirmationInFlightRef = useRef(false);
  const positionVersionRef = useRef(0);
  const matchRef = useRef(match);
  const soundCursorRef = useRef<{
    identity: string;
    localMatch: DamaMatch | null;
    view: GameView;
  } | null>(null);
  const resultCursorRef = useRef<{ identity: MatchIdentity; hasResult: boolean } | null>(null);
  const resultEndingSequenceRef = useRef(0);
  const revisionRef = useRef(revision);
  const playModeRef = useRef(playMode);
  const humanSideRef = useRef(humanSide);
  const localView = useMemo(() => match.getView(), [match, revision]);
  const view = playMode === "online" && online.snapshot !== null
    ? online.snapshot.gameView
    : localView;
  const matchIdentity = useMemo<MatchIdentity>(() => ({
    mode: playMode,
    localMatch: playMode === "online" ? null : match,
    roomCode: playMode === "online" ? online.roomCode : null,
    matchNumber: playMode === "online" ? online.snapshot?.matchNumber ?? 0 : 1,
  }), [match, online.roomCode, online.snapshot?.matchNumber, playMode]);

  matchRef.current = match;
  revisionRef.current = revision;
  playModeRef.current = playMode;
  humanSideRef.current = humanSide;

  useEffect(() => {
    if (playMode === "online" && online.snapshot === null) return;
    const identity = playMode === "online"
      ? `online:${online.roomCode ?? ""}:${online.snapshot?.matchNumber ?? 0}`
      : playMode;
    const previous = soundCursorRef.current;
    if (
      previous === null ||
      previous.identity !== identity ||
      (playMode !== "online" && previous.localMatch !== match)
    ) {
      soundCursorRef.current = { identity, localMatch: playMode === "online" ? null : match, view };
      return;
    }

    const event = committedSoundForChange(previous.view, view);
    soundCursorRef.current = { identity, localMatch: playMode === "online" ? null : match, view };
    if (event !== null) gameSounds.play(event);
  }, [gameSounds.play, match, online.roomCode, online.snapshot, playMode, view]);

  useEffect(() => {
    if (playMode === "online" && online.snapshot === null) return;
    const cursor = resultCursorRef.current;
    if (cursor === null || !sameMatchIdentity(cursor.identity, matchIdentity)) {
      resultCursorRef.current = { identity: matchIdentity, hasResult: view.result !== null };
      setResultDialog(null);
      return;
    }

    if (view.result === null) {
      cursor.hasResult = false;
      setResultDialog(null);
      return;
    }
    if (cursor.hasResult) return;

    cursor.hasResult = true;
    // Spectators receive and announce the same authoritative result without an
    // automatic dialog taking focus from their read-only view.
    if (playMode === "online" && online.snapshot?.viewerSide === null) return;
    resultEndingSequenceRef.current += 1;
    setResultDialog({ identity: matchIdentity, endingId: resultEndingSequenceRef.current });
  }, [matchIdentity, online.snapshot, playMode, view.result]);

  useEffect(() => {
    if (online.rememberedNickname !== "") {
      setOnlineName((current) => current || online.rememberedNickname);
    }
  }, [online.rememberedNickname]);

  useEffect(() => {
    if (online.roomCode !== null) {
      setJoinCode((current) => current || online.roomCode || "");
    }
  }, [online.roomCode]);

  useEffect(() => {
    const inviteCode = new URLSearchParams(window.location.search).get("room");
    if (inviteCode === null) return;
    const parsedCode = RoomCodeSchema.safeParse(inviteCode);
    if (parsedCode.success) {
      setJoinCode(parsedCode.data);
      setOnlineFeedback({
        kind: "success",
        message: "Invite code filled in. Choose whether to join as a player or spectate.",
      });
    } else {
      setJoinCode(inviteCode);
      setCodeError("This invite has an invalid room code. Enter a six-character code.");
    }
    if (localView.history.length === 0 && localView.result === null) {
      setPlayMode("online");
    }
  }, []);

  useEffect(() => {
    boardRef.current?.cancelSelection();
  }, [
    playMode,
    online.roomCode,
    online.connectionStatus,
    online.snapshot?.matchNumber,
    online.snapshot?.revision,
  ]);

  const computerSide = opposingSide(humanSide);
  const isComputerTurn =
    playMode === "computer" && view.result === null && view.turn === computerSide;
  const onlineCanMove = playMode === "online" &&
    online.connectionStatus === "connected" &&
    online.pendingCommand === null &&
    online.snapshot?.phase === "playing" &&
    online.snapshot.viewerSide !== null &&
    online.snapshot.viewerSide === view.turn;
  const leavingActiveOnlineMatch = playMode === "online" &&
    online.snapshot?.phase === "playing" &&
    online.snapshot.viewerSide !== null;
  const switchingAwayFromOnlineRoom = playMode === "online" &&
    pendingTransition?.mode !== undefined &&
    pendingTransition.mode !== "online" &&
    online.roomCode !== null;
  const displayedBoardFlipped = playMode === "computer"
    ? humanSide === "black"
    : playMode === "online"
      ? online.snapshot?.viewerSide === "black" ||
        (online.snapshot?.viewerSide === null && spectatorBoardFlipped)
      : boardFlipped;
  const canFlipSpectatorBoard = playMode === "online" && online.snapshot?.viewerSide === null;
  const boardFlipPressed = canFlipSpectatorBoard ? spectatorBoardFlipped : boardFlipped;

  useEffect(() => {
    if (!isComputerTurn) {
      setBotThinking(false);
      setBotError(null);
      return;
    }

    let active = true;
    const requestedMatch = match;
    const requestedRevision = revision;
    const requestedVersion = positionVersionRef.current;
    const requestedMode = playMode;
    const requestedHumanSide = humanSide;
    const requestedComputerSide = computerSide;
    setBotThinking(true);
    setBotError(null);

    void searchWithBot(view, difficulty).then(
      (response) => {
        if (!active) {
          return;
        }

        if (response.kind === "cancelled") {
          setBotThinking(false);
          return;
        }

        if (
          matchRef.current !== requestedMatch ||
          revisionRef.current !== requestedRevision ||
          positionVersionRef.current !== requestedVersion ||
          playModeRef.current !== requestedMode ||
          humanSideRef.current !== requestedHumanSide
        ) {
          return;
        }

        if (response.kind === "failure") {
          setBotThinking(false);
          setBotError("Computer search failed. Retry or start a new game.");
          return;
        }

        const currentMatch = matchRef.current;
        const currentView = currentMatch.getView();
        if (
          currentView.result !== null ||
          currentView.turn !== requestedComputerSide ||
          playModeRef.current !== "computer"
        ) {
          setBotThinking(false);
          return;
        }

        const returnedMove = response.result.move;
        const canonicalMove = returnedMove === null
          ? undefined
          : currentView.legalMoves.find((legalMove) => isSameLegalMove(legalMove, returnedMove));
        if (canonicalMove === undefined) {
          setBotThinking(false);
          setBotError("Computer returned no legal move. Retry or start a new game.");
          return;
        }

        positionVersionRef.current += 1;
        try {
          currentMatch.play({ from: canonicalMove.from, path: [...canonicalMove.path] });
        } catch {
          setBotThinking(false);
          setBotError("Computer's move could not be applied. Retry or start a new game.");
          return;
        }
        setBotThinking(false);
        setRevision((current) => current + 1);
      },
    ).catch(() => {
      if (
        active &&
        matchRef.current === requestedMatch &&
        revisionRef.current === requestedRevision &&
        positionVersionRef.current === requestedVersion
      ) {
        setBotThinking(false);
        setBotError("Computer search failed. Retry or start a new game.");
      }
    });

    return () => {
      active = false;
      cancelBotSearch();
    };
  }, [
    cancelBotSearch,
    botRetryAttempt,
    computerSide,
    difficulty,
    humanSide,
    isComputerTurn,
    match,
    playMode,
    revision,
    searchWithBot,
    view,
  ]);

  function invalidateComputerSearch(): void {
    positionVersionRef.current += 1;
    if (playMode === "computer") {
      cancelBotSearch();
    }
    setBotThinking(false);
    setBotError(null);
  }

  function retryComputerSearch(): void {
    if (!isComputerTurn || botThinking || botError === null) {
      return;
    }
    setBotError(null);
    setBotRetryAttempt((attempt) => attempt + 1);
  }

  function handleMove(move: MoveInput): void {
    if (playMode === "online") {
      if (!onlineCanMove || online.snapshot === null) return;
      void online.move({
        revision: online.snapshot.revision,
        from: move.from,
        path: [...move.path],
      }).then((response) => {
        if (!response.ok) {
          setOnlineFeedback({ kind: "error", message: response.error.message });
        } else {
          setOnlineFeedback(null);
        }
      });
      return;
    }

    if (
      view.result !== null ||
      (playMode === "computer" && (isComputerTurn || view.turn !== humanSide))
    ) {
      return;
    }

    if (playMode === "computer") {
      invalidateComputerSearch();
    } else {
      positionVersionRef.current += 1;
    }
    match.play(move);
    setRevision((current) => current + 1);
  }

  const canUndo = playMode === "local"
    ? view.history.length > 0
    : playMode === "computer"
      ? view.history.some((record) => record.side === humanSide)
      : false;

  function handleUndo(): void {
    if (!canUndo || playMode === "online") {
      return;
    }

    boardRef.current?.cancelSelection();
    if (playMode === "computer") {
      invalidateComputerSearch();
    } else {
      positionVersionRef.current += 1;
    }
    if (view.history.length === 1) {
      newGameButtonRef.current?.focus({ preventScroll: true });
    }

    if (playMode === "computer") {
      undoToHumanTurn(match, humanSide);
    } else {
      match.undo(1);
    }
    setRevision((current) => current + 1);
  }

  function applyTransition(transition: MatchTransition): void {
    if (playMode === "computer" || transition.mode === "computer") {
      cancelBotSearch();
    }
    positionVersionRef.current += 1;
    boardRef.current?.cancelSelection();
    if (transition.mode !== undefined) {
      setPlayMode(transition.mode);
    }
    if (transition.humanSide !== undefined) {
      setHumanSide(transition.humanSide);
    }
    if (transition.difficulty !== undefined) {
      setDifficulty(transition.difficulty);
      writeDifficultyPreference(transition.difficulty);
    }
    setMatch(new DamaMatch());
    setRevision(0);
    setBotThinking(false);
    setBotError(null);
    setPendingTransition(null);
  }

  function requestTransition(transition: MatchTransition): void {
    if (playMode === "online" && online.pendingCommand !== null) return;
    if (
      transition.mode === playMode &&
      transition.humanSide === undefined &&
      transition.difficulty === undefined &&
      transition.newGame !== true &&
      transition.leaveRoom !== true
    ) {
      return;
    }

    const hasPlayedGame = view.history.length > 0 || view.result !== null;
    const isLeavingOnlineRoom = playMode === "online" &&
      transition.mode !== "online" &&
      online.roomCode !== null;
    if (hasPlayedGame || isLeavingOnlineRoom) {
      setPendingTransition(transition);
      return;
    }
    applyTransition(transition);
  }

  function handleNewGame(): void {
    if (playMode === "online") return;
    requestTransition({ newGame: true });
  }

  async function confirmTransition(): Promise<void> {
    if (pendingOnlineConfirmation !== null) {
      if (onlineConfirmationInFlightRef.current) return;
      onlineConfirmationInFlightRef.current = true;
      const action = pendingOnlineConfirmation;
      const previousMatchNumber = online.snapshot?.matchNumber ?? 0;
      setPendingOnlineConfirmation(null);
      setOnlineFeedback(null);
      try {
        const response = action === "accept-draw"
          ? await online.acceptDraw()
          : action === "resign"
            ? await online.resign()
            : await online.voteRematch();
        if (!response.ok) {
          setOnlineFeedback({ kind: "error", message: response.error.message });
          return;
        }
        if (action === "accept-draw") {
          setOnlineFeedback({ kind: "success", message: "The server recorded the draw agreement." });
        } else if (action === "resign") {
          setOnlineFeedback({ kind: "success", message: "The server recorded your resignation." });
        } else if (response.data.snapshot.matchNumber > previousMatchNumber) {
          setOnlineFeedback({
            kind: "success",
            message: `The server started match ${response.data.snapshot.matchNumber} with sides swapped.`,
          });
        } else {
          setOnlineFeedback({ kind: "success", message: "Your rematch consent was recorded. Waiting for the other player." });
        }
      } finally {
        onlineConfirmationInFlightRef.current = false;
      }
      return;
    }

    if (pendingTransition !== null) {
      if (pendingTransition.leaveRoom === true || switchingAwayFromOnlineRoom) {
        const response = await online.leaveRoom();
        if (!response.ok) {
          setOnlineFeedback({ kind: "error", message: response.error.message });
          return;
        }
        if (pendingTransition.leaveRoom === true) {
          setOnlineFeedback({
            kind: "success",
            message: leavingActiveOnlineMatch
              ? "You left the match. The server awarded the win to your opponent and released your seat."
              : "You left the room and released your seat.",
          });
          setPendingTransition(null);
        } else {
          const transition = pendingTransition;
          applyTransition(transition);
        }
        return;
      }
      applyTransition(pendingTransition);
    }
  }

  function requestOnlineLeave(): void {
    if (online.pendingCommand !== null || online.roomCode === null) return;
    setOnlineFeedback(null);
    setPendingTransition({ leaveRoom: true });
  }

  async function submitOnlineDrawAction(action: "offer" | "decline"): Promise<void> {
    if (
      online.pendingCommand !== null ||
      online.connectionStatus !== "connected" ||
      online.snapshot?.phase !== "playing" ||
      online.snapshot.viewerSide === null
    ) {
      return;
    }
    setOnlineFeedback(null);
    const response = action === "offer" ? await online.offerDraw() : await online.declineDraw();
    if (!response.ok) {
      setOnlineFeedback({ kind: "error", message: response.error.message });
    } else {
      setOnlineFeedback({
        kind: "success",
        message: action === "offer" ? "Draw offer sent to the other player." : "Draw offer declined. The match continues.",
      });
    }
  }

  function requestOnlineConfirmation(action: PendingOnlineConfirmation): void {
    if (
      online.pendingCommand !== null ||
      online.connectionStatus !== "connected" ||
      online.snapshot?.viewerSide === null ||
      online.snapshot === null
    ) {
      return;
    }
    if (action === "accept-draw" && (online.snapshot.phase !== "playing" || online.snapshot.drawOffer === null)) return;
    if (action === "resign" && online.snapshot.phase !== "playing") return;
    if (action === "rematch" && online.snapshot.phase !== "finished") return;
    setOnlineFeedback(null);
    setPendingOnlineConfirmation(action);
  }

  async function requestOnlineRematch(): Promise<void> {
    requestOnlineConfirmation("rematch");
  }

  function closeTransitionDialog(): void {
    setPendingTransition(null);
    setPendingOnlineConfirmation(null);
    setResultDialog(null);
  }

  function validateOnlineName(): string | null {
    const parsed = DisplayNameSchema.safeParse(onlineName);
    if (!parsed.success) {
      setNameError("Enter a name of 1–24 letters, numbers, spaces, or . ' - _ characters.");
      return null;
    }
    setNameError(null);
    return parsed.data;
  }

  async function handleCreateOnlineRoom(): Promise<void> {
    setOnlineFeedback(null);
    setClipboardFeedback(null);
    const name = validateOnlineName();
    if (name === null) return;
    const response = await online.createRoom({
      name,
      side: createSide,
      timeControl: TIME_CONTROL_PRESETS[timeControlKind],
    });
    setOnlineFeedback(response.ok
      ? { kind: "success", message: `Room ${response.data.code} created. Share its invite when you are ready.` }
      : { kind: "error", message: response.error.message });
  }

  async function handleJoinOnlineRoom(role: "player" | "spectator"): Promise<void> {
    setOnlineFeedback(null);
    setClipboardFeedback(null);
    const name = validateOnlineName();
    if (name === null) return;
    const parsedCode = RoomCodeSchema.safeParse(joinCode);
    if (!parsedCode.success) {
      setCodeError("Enter a six-character code using A–Z and 2–9.");
      return;
    }
    setCodeError(null);
    const response = await online.joinRoom({ name, code: parsedCode.data, role });
    setOnlineFeedback(response.ok
      ? {
          kind: "success",
          message: response.data.snapshot.viewerSide === null
            ? "You are spectating the room."
            : `Joined as ${sideName(response.data.snapshot.viewerSide)}.`,
        }
      : { kind: "error", message: response.error.message });
  }

  async function copyLobbyText(text: string, successMessage: string, failureMessage: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(text);
      setClipboardFeedback({ kind: "success", message: successMessage });
    } catch {
      setClipboardFeedback({ kind: "error", message: failureMessage });
    }
  }

  function copyRoomCode(): void {
    if (online.roomCode === null) return;
    void copyLobbyText(online.roomCode, "Room code copied.", "Could not copy the code. Select it and copy it manually.");
  }

  function copyRoomInvite(): void {
    if (online.roomCode === null) return;
    const inviteUrl = new URL(window.location.pathname, window.location.origin);
    inviteUrl.searchParams.set("room", online.roomCode);
    void copyLobbyText(
      inviteUrl.toString(),
      "Invite link copied.",
      "Could not copy the invite. You can copy the room code instead.",
    );
  }

  const turnName = view.result === null ? `${sideName(view.turn)} to move` : null;
  const players: Record<Side, string> = playMode === "online"
    ? {
        white: online.snapshot?.players.white?.name ?? "Waiting for player",
        black: online.snapshot?.players.black?.name ?? "Waiting for player",
      }
    : playMode === "local"
      ? { white: "Local player", black: "Local player" }
      : humanSide === "white"
        ? { white: "You", black: "Computer" }
        : { white: "Computer", black: "You" };
  const scorebookMode = playMode === "local"
    ? "Local two-player"
    : playMode === "computer"
      ? `Computer · ${difficulty}`
      : online.snapshot === null
        ? "Online"
        : online.snapshot.viewerSide === null
          ? "Online spectator"
          : "Online player";
  const scorebookTimeControl = playMode === "online"
    ? online.snapshot?.timeControl ?? TIME_CONTROL_PRESETS.untimed
    : TIME_CONTROL_PRESETS.untimed;
  const transitionTitle = pendingOnlineConfirmation === "accept-draw"
    ? "Accept this draw?"
    : pendingOnlineConfirmation === "resign"
      ? "Resign this match?"
      : pendingOnlineConfirmation === "rematch"
        ? "Agree to a rematch?"
        : pendingTransition?.leaveRoom === true
    ? "Leave this room?"
    : switchingAwayFromOnlineRoom
      ? "Leave online room and switch?"
    : pendingTransition?.newGame === true
    ? "Start a new game?"
    : pendingTransition?.mode !== undefined
      ? "Change play mode?"
      : "Change game settings?";
  const transitionAction = pendingOnlineConfirmation === "accept-draw"
    ? "Accept draw"
    : pendingOnlineConfirmation === "resign"
      ? "Resign"
      : pendingOnlineConfirmation === "rematch"
        ? "Agree to rematch"
        : pendingTransition?.leaveRoom === true
    ? online.pendingCommand === "leave" ? "Leaving room…" : "Leave room"
    : switchingAwayFromOnlineRoom
      ? online.pendingCommand === "leave" ? "Leaving room…" : "Leave room and switch"
    : pendingTransition?.newGame === true
    ? "Start new game"
    : pendingTransition?.mode !== undefined
      ? "Change mode"
      : "Apply settings";
  const onlineStatusText = online.snapshot === null
    ? online.connectionStatus === "connected"
      ? "Create or join a room"
      : online.connectionStatus === "connecting" || online.connectionStatus === "reconnecting"
        ? "Connecting…"
        : "Disconnected"
    : online.connectionStatus !== "connected"
      ? online.connectionStatus === "connecting" || online.connectionStatus === "reconnecting"
        ? "Reconnecting…"
        : "Disconnected"
      : online.snapshot.phase === "finished"
        ? online.snapshot.viewerSide === null
          ? "Spectating · Match finished"
          : "Match finished"
      : online.snapshot.phase === "waiting"
        ? online.snapshot.viewerSide === null ? "Waiting for players" : "Waiting for opponent"
        : online.snapshot.viewerSide === null
          ? `Spectating · ${turnName ?? "Match finished"}`
          : online.snapshot.viewerSide === view.turn
            ? "Your turn"
            : `${sideName(view.turn)} to move`;
  const onlineRoomDetailText = online.snapshot === null
    ? null
    : (() => {
        const spectatorCount = `${online.snapshot.spectatorCount} spectator${online.snapshot.spectatorCount === 1 ? "" : "s"}`;
        if (online.snapshot.phase === "waiting") {
          return online.snapshot.viewerSide === null
            ? `Waiting room · ${spectatorCount}`
            : `Waiting for opponent · ${online.snapshot.timeControl.kind} · ${spectatorCount}`;
        }
        if (online.snapshot.phase === "finished") {
          return `Finished match · ${spectatorCount}`;
        }
        return `Live match · ${online.snapshot.timeControl.kind} · ${spectatorCount}`;
      })();
  const visibleOnlineFeedback = online.recoverableError === null
    ? onlineFeedback
    : { kind: "error" as const, message: online.recoverableError.message };
  const turnStatusText = playMode === "online"
    ? onlineStatusText
    : isComputerTurn
      ? botThinking
        ? "Computer thinking…"
        : botError ?? "Computer to move"
      : turnName ?? "";
  const boardInputDisabled = playMode === "computer"
    ? isComputerTurn
    : playMode === "online"
      ? !onlineCanMove
      : false;
  const onlineFinishedRoom = playMode === "online" && online.snapshot?.phase === "finished"
    ? online.snapshot
    : null;
  const onlineFinishedViewerSide = onlineFinishedRoom?.viewerSide ?? null;
  const myRematchVote = onlineFinishedViewerSide === null || onlineFinishedRoom === null
    ? false
    : onlineFinishedRoom.rematchVotes[onlineFinishedViewerSide];
  const opponentRematchVote = onlineFinishedViewerSide === null || onlineFinishedRoom === null
    ? false
    : onlineFinishedRoom.rematchVotes[opposingSide(onlineFinishedViewerSide)];
  const onlineCanSendAction = online.connectionStatus === "connected" &&
    online.pendingCommand === null &&
    online.snapshot?.viewerSide !== null &&
    online.snapshot?.viewerSide !== undefined;
  const resultDialogIsOpen = resultDialog !== null &&
    sameMatchIdentity(resultDialog.identity, matchIdentity) &&
    view.result !== null;
  const modalFocusKey = resultDialogIsOpen
    ? `result:${resultDialog.endingId}`
    : pendingOnlineConfirmation ?? (pendingTransition?.leaveRoom === true
      ? "leave-room"
      : pendingTransition?.newGame === true
        ? "new-game"
        : pendingTransition?.mode ?? "settings");

  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="brand-lockup" aria-label="Meydan | The Dama Club">
          <img className="club-mark" src="/art/club-mark.svg" alt="" />
          <span className="brand-name">
            Meydan <span className="brand-divider">|</span> <span>The Dama Club</span>
          </span>
        </div>
        <div className="preview-label">
          <span className="preview-dot" aria-hidden="true" />
          <span>
            {playMode === "local" ? "Local table" : playMode === "computer" ? "Computer table" : "Online table"}
          </span>
        </div>
      </header>

      <section className="game-heading" aria-labelledby="game-title">
        <div>
          <p className="eyebrow">Orthogonal Dama · 8 × 8</p>
          <h1 id="game-title">Dama</h1>
        </div>
        <div
          ref={turnStatusRef}
          className={`turn-status${view.result === null ? "" : " turn-status--finished"}`}
          tabIndex={-1}
          data-testid="turn-status"
        >
          <div className="turn-status-live" role="status" aria-live="polite" aria-atomic="true">
            {view.result === null ? (
              <>
                <span className="turn-indicator" aria-hidden="true" />
                <span data-testid={playMode === "computer" ? "computer-status" : "turn-label"}>
                  {turnStatusText}
                </span>
              </>
            ) : (
              <>
                <span className="finished-title">{resultText(view.result)}</span>
                <span className="finished-detail">{resultDetail(view.result)}</span>
              </>
            )}
          </div>
          {isComputerTurn && botError !== null && !botThinking && (
            <button
              type="button"
              className="match-action computer-retry"
              data-testid="computer-retry"
              onClick={retryComputerSearch}
            >
              Retry
            </button>
          )}
        </div>
      </section>

      <div className="game-layout">
        <section
          className="board-column"
          aria-label="Dama board and players"
          data-testid={playMode === "online" ? "online-board-state" : undefined}
          data-revision={playMode === "online" ? online.snapshot?.revision : undefined}
          data-match-number={playMode === "online" ? online.snapshot?.matchNumber : undefined}
          data-phase={playMode === "online" ? online.snapshot?.phase : undefined}
          data-viewer-side={playMode === "online" ? online.snapshot?.viewerSide ?? "spectator" : undefined}
        >
          <PlayerSeat
            view={view}
            side={displayedBoardFlipped ? "black" : "white"}
            playerName={players[displayedBoardFlipped ? "black" : "white"]}
          />

          <Board
            ref={boardRef}
            view={view}
            onMove={handleMove}
            flipped={displayedBoardFlipped}
            inputDisabled={boardInputDisabled}
            readOnly={canFlipSpectatorBoard}
          />

          <PlayerSeat
            view={view}
            side={displayedBoardFlipped ? "white" : "black"}
            playerName={players[displayedBoardFlipped ? "white" : "black"]}
          />
          <div className="board-caption-row">
            <p className="board-caption">
              {playMode === "computer"
                ? `You play ${sideName(humanSide)}`
                : playMode === "online"
                  ? online.snapshot === null
                    ? "Join a room to play or spectate"
                    : online.snapshot.viewerSide === null
                      ? "Spectating · read only"
                      : online.snapshot.phase === "waiting"
                        ? "Waiting for opponent"
                        : online.snapshot.phase === "finished"
                          ? "Match finished"
                          : onlineCanMove
                            ? "Select a piece and highlighted square"
                            : `${sideName(view.turn)} to move`
                  : "Select a piece and highlighted square"}
            </p>
            {(playMode === "local" || canFlipSpectatorBoard) && (
              <button
                type="button"
                className="board-flip-button"
                aria-label="Flip board orientation"
                aria-pressed={boardFlipPressed}
                title={
                  boardFlipPressed
                    ? "Return to the default board perspective"
                    : canFlipSpectatorBoard
                      ? "Flip the spectator board perspective"
                      : "Flip to the other player's perspective"
                }
                data-testid="board-flip"
                onClick={() => {
                  if (canFlipSpectatorBoard) {
                    setSpectatorBoardFlipped((flipped) => !flipped);
                  } else {
                    setBoardFlipped((flipped) => !flipped);
                  }
                }}
              >
                <FlipVertical2 size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>

        <aside className="table-notes" aria-label="Match information">
          <section className="note-section match-controls" aria-label="Match controls">
            <Rules />
            <button
              type="button"
              className="match-action"
              data-testid="sound-toggle"
              aria-pressed={gameSounds.enabled}
              aria-label={gameSounds.enabled && !gameSounds.ready ? "Activate sound" : gameSounds.enabled ? "Turn sound off" : "Turn sound on"}
              title={gameSounds.enabled && !gameSounds.ready
                ? "Activate browser audio from this tab"
                : gameSounds.enabled ? "Turn game sounds off" : "Turn game sounds on"}
              disabled={gameSounds.activating}
              onClick={() => void gameSounds.toggle()}
            >
              {gameSounds.enabled
                ? <Volume2 size={17} strokeWidth={1.8} aria-hidden="true" />
                : <VolumeX size={17} strokeWidth={1.8} aria-hidden="true" />}
              <span>Sound {gameSounds.enabled ? "on" : "off"}</span>
            </button>
            {gameSounds.statusMessage !== null && (
              <span className="sound-status" role="status" data-testid="sound-status">
                {gameSounds.statusMessage}
              </span>
            )}
            {playMode !== "online" && (
              <>
                <button
                  type="button"
                  className="match-action"
                  onClick={handleUndo}
                  disabled={!canUndo}
                  aria-label={playMode === "local" ? "Undo last local ply" : "Undo to your turn"}
                  title={playMode === "local"
                    ? "Undo exactly one committed local ply. Any capture preview is canceled first."
                    : "Return play to your turn and cancel any pending computer reply."}
                  data-testid="undo-button"
                >
                  <Undo2 size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span>Undo</span>
                </button>
                <button
                  type="button"
                  className="match-action"
                  ref={newGameButtonRef}
                  onClick={handleNewGame}
                  aria-label={playMode === "local"
                    ? "Start a new local Dama game"
                    : "Start a new computer Dama game"}
                  title="Start a fresh game. Moves will be confirmed before they are discarded."
                  data-testid="new-game-button"
                >
                  <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
                  <span>New game</span>
                </button>
              </>
            )}
          </section>

          <Scorebook
            history={view.history}
            result={view.result}
            mode={scorebookMode}
            players={players}
            roomCode={playMode === "online" ? online.roomCode : null}
            matchNumber={playMode === "online" ? online.snapshot?.matchNumber ?? 1 : 1}
            timeControl={scorebookTimeControl}
          />

          <section className="note-section modes-section" aria-labelledby="modes-heading">
            <div className="section-heading">
              <h2 id="modes-heading">Play modes</h2>
            </div>
            <div className="mode-list" role="group" aria-label="Play mode">
              <button
                type="button"
                className={`mode-row${playMode === "local" ? " mode-row--active" : ""}`}
                aria-pressed={playMode === "local"}
                disabled={online.pendingCommand !== null}
                data-testid="mode-local"
                onClick={() => requestTransition({ mode: "local" })}
              >
                <UsersRound size={18} strokeWidth={1.8} aria-hidden="true" />
                <span className="mode-name">Local two-player</span>
                <span className={`mode-status${playMode === "local" ? " mode-active" : ""}`}>
                  {playMode === "local" ? "Playing" : "Available"}
                </span>
              </button>
              <button
                type="button"
                className={`mode-row${playMode === "computer" ? " mode-row--active" : ""}`}
                aria-pressed={playMode === "computer"}
                disabled={online.pendingCommand !== null}
                data-testid="mode-computer"
                onClick={() => requestTransition({ mode: "computer" })}
              >
                <Bot size={18} strokeWidth={1.8} aria-hidden="true" />
                <span className="mode-name">Play against computer</span>
                <span className={`mode-status${playMode === "computer" ? " mode-active" : ""}`}>
                  {playMode === "computer" ? "Playing" : "Available"}
                </span>
              </button>
              <button
                type="button"
                className={`mode-row${playMode === "online" ? " mode-row--active" : ""}`}
                aria-pressed={playMode === "online"}
                disabled={online.pendingCommand !== null}
                data-testid="mode-online"
                onClick={() => requestTransition({ mode: "online" })}
              >
                <Globe2 size={18} strokeWidth={1.8} aria-hidden="true" />
                <span className="mode-name">Play online</span>
                <span className={`mode-status${playMode === "online" ? " mode-active" : ""}`}>
                  {playMode === "online" ? "Selected" : "Available"}
                </span>
              </button>
            </div>

            {playMode === "computer" && (
              <div
                className="computer-settings"
                role="group"
                aria-label="Computer game settings"
              >
                <label className="computer-setting">
                  <span>Play as</span>
                  <select
                    aria-label="Play as"
                    data-testid="human-side"
                    value={humanSide}
                    onChange={(event) =>
                      requestTransition({ humanSide: event.currentTarget.value as Side })
                    }
                  >
                    <option value="white">White</option>
                    <option value="black">Black</option>
                  </select>
                </label>
                <label className="computer-setting">
                  <span>Difficulty</span>
                  <select
                    aria-label="Difficulty"
                    data-testid="bot-difficulty"
                    value={difficulty}
                    onChange={(event) =>
                      requestTransition({ difficulty: event.currentTarget.value as BotDifficulty })
                    }
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
              </div>
            )}

            {playMode === "online" && (
              <section className="online-lobby" aria-label="Online room lobby">
                <div className="online-lobby-heading">
                  <Globe2 size={17} strokeWidth={1.8} aria-hidden="true" />
                  <h3>{online.snapshot === null ? "Create or join a room" : "Online room"}</h3>
                </div>

                {online.snapshot === null && online.pendingCommand === "resume" ? (
                  <p className="online-room-detail" data-testid="online-resuming" role="status" aria-live="polite">
                    Restoring your saved room…
                  </p>
                ) : online.snapshot === null ? (
                  <>
                    <label className="online-field" htmlFor="online-nickname">
                      <span>Nickname</span>
                      <input
                        id="online-nickname"
                        data-testid="online-nickname"
                        autoComplete="nickname"
                        maxLength={24}
                        value={onlineName}
                        aria-invalid={nameError !== null}
                        aria-describedby={nameError === null ? undefined : "online-name-error"}
                        onChange={(event) => {
                          setOnlineName(event.currentTarget.value);
                          setNameError(null);
                        }}
                      />
                      {nameError !== null && (
                        <span id="online-name-error" className="online-field-error" role="alert">
                          {nameError}
                        </span>
                      )}
                    </label>

                    <div className="online-create-options">
                      <label className="online-field">
                        <span>Your side</span>
                        <select
                          aria-label="Online side"
                          data-testid="online-side"
                          value={createSide}
                          onChange={(event) => setCreateSide(event.currentTarget.value as Side)}
                        >
                          <option value="white">White</option>
                          <option value="black">Black</option>
                        </select>
                      </label>
                      <label className="online-field">
                        <span>Time control</span>
                        <select
                          aria-label="Time control"
                          data-testid="online-time-control"
                          value={timeControlKind}
                          onChange={(event) => setTimeControlKind(event.currentTarget.value as TimeControlKind)}
                        >
                          <option value="untimed">Untimed</option>
                          <option value="rapid">Rapid · 10 + 5</option>
                          <option value="blitz">Blitz · 5 + 3</option>
                        </select>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="match-action online-primary"
                      data-testid="online-create"
                      disabled={online.connectionStatus !== "connected" || online.pendingCommand !== null}
                      onClick={() => void handleCreateOnlineRoom()}
                    >
                      {online.pendingCommand === "create" ? "Creating room…" : "Create room"}
                    </button>

                    <div className="online-separator"><span>or join a room</span></div>
                    <label className="online-field" htmlFor="online-room-code">
                      <span>Six-character room code</span>
                      <input
                        id="online-room-code"
                        data-testid="online-room-code-input"
                        autoCapitalize="characters"
                        autoComplete="off"
                        maxLength={6}
                        value={joinCode}
                        aria-invalid={codeError !== null}
                        aria-describedby={codeError === null ? undefined : "online-code-error"}
                        onChange={(event) => {
                          setJoinCode(event.currentTarget.value.toUpperCase());
                          setCodeError(null);
                        }}
                      />
                      {codeError !== null && (
                        <span id="online-code-error" className="online-field-error" role="alert">
                          {codeError}
                        </span>
                      )}
                    </label>
                    <div className="online-join-actions">
                      <button
                        type="button"
                        className="match-action"
                        data-testid="online-join-player"
                        disabled={online.connectionStatus !== "connected" || online.pendingCommand !== null}
                        onClick={() => void handleJoinOnlineRoom("player")}
                      >
                        {online.pendingCommand === "join" ? "Joining…" : "Join as player"}
                      </button>
                      <button
                        type="button"
                        className="match-action"
                        data-testid="online-join-spectator"
                        disabled={online.connectionStatus !== "connected" || online.pendingCommand !== null}
                        onClick={() => void handleJoinOnlineRoom("spectator")}
                      >
                        Spectate
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="online-room-code-block">
                      <span>Room code</span>
                      <strong data-testid="online-room-code">
                        {online.roomCode ?? "Unavailable"}
                      </strong>
                    </div>
                    <p className="online-room-players">
                      White: {players.white} <span aria-hidden="true">·</span> Black: {players.black}
                    </p>
                    <div className="online-player-connections" aria-label="Public player connection states" data-testid="online-player-connections">
                      {(["white", "black"] as const).map((side) => {
                        const player = online.snapshot?.players[side] ?? null;
                        const status = player === null
                          ? "Waiting for player"
                          : player.connected
                            ? "Connected"
                            : player.recoveryDeadlineMs === null
                              ? "Disconnected · seat reserved"
                              : `Disconnected · seat reserved until ${recoveryTimeLabel(player.recoveryDeadlineMs)}`;
                        return (
                          <p key={side} data-testid={`player-connection-${side}`} data-connected={player?.connected === true ? "true" : "false"}>
                            <span>{sideName(side)}</span>
                            <span>{status}</span>
                          </p>
                        );
                      })}
                    </div>
                    <OnlineClock snapshot={online.snapshot} receiptTime={online.snapshotReceiptTime} />
                    <p className="online-room-detail" data-testid="online-role">
                      {online.snapshot.viewerSide === null
                        ? "You are spectating."
                        : `You are playing as ${sideName(online.snapshot.viewerSide)}.`}
                    </p>
                    <p className="online-room-detail" data-testid="online-room-detail">
                      {onlineRoomDetailText}
                    </p>
                    {online.snapshot.phase === "playing" && (
                      <div className="online-lifecycle-controls" data-testid="online-lifecycle-controls">
                        <p
                          className="online-action-status"
                          data-testid="draw-offer-status"
                          data-offer-direction={online.snapshot.drawOffer === null
                            ? "none"
                            : online.snapshot.viewerSide === null
                              ? "spectator-view"
                              : online.snapshot.viewerSide === online.snapshot.drawOffer.offeredBy
                                ? "outgoing"
                                : "incoming"}
                          role="status"
                          aria-live="polite"
                        >
                          {online.snapshot.drawOffer === null
                            ? "No draw offer"
                            : online.snapshot.viewerSide === null
                              ? `${sideName(online.snapshot.drawOffer.offeredBy)} offered a draw`
                              : online.snapshot.viewerSide === online.snapshot.drawOffer.offeredBy
                                ? `Outgoing draw offer · waiting for ${sideName(opposingSide(online.snapshot.viewerSide))}`
                                : `Incoming draw offer · ${sideName(online.snapshot.drawOffer.offeredBy)}`}
                        </p>
                        {online.snapshot.viewerSide === null ? (
                          <p className="online-room-detail" data-testid="spectator-action-status">
                            Read-only spectator
                          </p>
                        ) : (
                          <div className="online-join-actions online-lifecycle-actions">
                            {online.snapshot.drawOffer === null ? (
                              <button
                                type="button"
                                className="match-action"
                                data-testid="draw-offer"
                                disabled={!onlineCanSendAction}
                                onClick={() => void submitOnlineDrawAction("offer")}
                              >
                                <Handshake size={16} strokeWidth={1.8} aria-hidden="true" />
                                <span>{online.pendingCommand === "offer-draw" ? "Sending offer…" : "Offer draw"}</span>
                              </button>
                            ) : online.snapshot.viewerSide !== online.snapshot.drawOffer.offeredBy ? (
                              <>
                                <button
                                  type="button"
                                  className="match-action online-primary"
                                  data-testid="draw-accept"
                                  disabled={!onlineCanSendAction}
                                  onClick={() => requestOnlineConfirmation("accept-draw")}
                                >
                                  <Check size={16} strokeWidth={1.8} aria-hidden="true" />
                                  <span>{online.pendingCommand === "accept-draw" ? "Accepting…" : "Accept draw"}</span>
                                </button>
                                <button
                                  type="button"
                                  className="match-action"
                                  data-testid="draw-decline"
                                  disabled={!onlineCanSendAction}
                                  onClick={() => void submitOnlineDrawAction("decline")}
                                >
                                  <X size={16} strokeWidth={1.8} aria-hidden="true" />
                                  <span>{online.pendingCommand === "decline-draw" ? "Declining…" : "Decline draw"}</span>
                                </button>
                              </>
                            ) : null}
                            <button
                              type="button"
                              className="match-action"
                              data-testid="online-resign"
                              disabled={!onlineCanSendAction}
                              onClick={() => requestOnlineConfirmation("resign")}
                            >
                              <Flag size={16} strokeWidth={1.8} aria-hidden="true" />
                              <span>{online.pendingCommand === "resign" ? "Resigning…" : "Resign"}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {onlineFinishedRoom !== null && (
                      <section className="online-finished-controls" data-testid="online-finished-controls">
                        <MatchResultSummary
                          result={onlineFinishedRoom.gameView.result}
                          matchNumber={onlineFinishedRoom.matchNumber}
                          players={players}
                          testId="online-result"
                        />
                        <div className="online-rematch" data-testid="online-rematch">
                          <div className="rematch-heading">
                            <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
                            <strong>Rematch consent</strong>
                          </div>
                          <p className="online-room-detail" data-testid="rematch-status" role="status" aria-live="polite">
                            {onlineFinishedRoom.viewerSide === null
                              ? "Players only · both votes needed"
                              : online.connectionStatus !== "connected"
                                ? "Reconnect to vote"
                                : myRematchVote
                                  ? "You agreed · waiting for opponent"
                                  : opponentRematchVote
                                    ? "Opponent agreed · your vote needed"
                                    : "Both votes needed"}
                          </p>
                          <dl className="rematch-consents">
                            {(["white", "black"] as const).map((side) => (
                              <div key={side} data-testid={`rematch-${side}-consent`}>
                                <dt>{sideName(side)}</dt>
                                <dd>
                                  <span>{onlineFinishedRoom.players[side]?.name ?? "Seat unavailable"}</span>
                                  <span>{onlineFinishedRoom.rematchVotes[side] ? "Agreed" : "Waiting"}</span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                          {onlineFinishedRoom.viewerSide !== null &&
                            onlineFinishedRoom.players.white !== null &&
                            onlineFinishedRoom.players.black !== null && (
                              <button
                                type="button"
                                className="match-action online-primary"
                                data-testid="rematch-vote"
                                disabled={online.connectionStatus !== "connected" || online.pendingCommand !== null || myRematchVote}
                                onClick={() => void requestOnlineRematch()}
                              >
                                <RotateCcw size={15} strokeWidth={1.8} aria-hidden="true" />
                                <span>{online.pendingCommand === "rematch"
                                  ? "Sending consent…"
                                  : myRematchVote
                                    ? "Consent recorded"
                                    : opponentRematchVote
                                      ? "Agree to rematch"
                                      : "Request rematch"}</span>
                              </button>
                            )}
                        </div>
                      </section>
                    )}
                    <div className="online-join-actions">
                      <button type="button" className="match-action" data-testid="copy-room-code" onClick={copyRoomCode}>
                        Copy code
                      </button>
                      <button type="button" className="match-action" data-testid="copy-room-invite" onClick={copyRoomInvite}>
                        Copy invite
                      </button>
                    </div>
                    <button
                      type="button"
                      className="online-leave-button"
                      data-testid="online-leave-room"
                      disabled={online.pendingCommand !== null}
                      onClick={requestOnlineLeave}
                    >
                      Leave room
                    </button>
                  </>
                )}

                {online.pendingCommand !== null && online.pendingCommand !== "resume" && (
                  <p className="online-pending" data-testid="online-pending-action" role="status" aria-live="polite">
                    {online.pendingCommand === "create" ? "Creating room…" :
                      online.pendingCommand === "join" ? "Joining room…" :
                        online.pendingCommand === "move" ? "Sending move…" :
                          online.pendingCommand === "offer-draw" ? "Sending draw offer…" :
                            online.pendingCommand === "accept-draw" ? "Accepting draw offer…" :
                              online.pendingCommand === "decline-draw" ? "Declining draw offer…" :
                                online.pendingCommand === "resign" ? "Sending resignation…" :
                                  online.pendingCommand === "rematch" ? "Sending rematch consent…" : "Leaving room…"}
                  </p>
                )}
                {visibleOnlineFeedback !== null && pendingTransition === null && (
                  <p
                    className={`online-feedback online-feedback--${visibleOnlineFeedback.kind}`}
                    role={visibleOnlineFeedback.kind === "error" ? "alert" : "status"}
                    aria-live={visibleOnlineFeedback.kind === "error" ? "assertive" : "polite"}
                    data-testid="online-feedback"
                  >
                    {visibleOnlineFeedback.message}
                  </p>
                )}
                {clipboardFeedback !== null && (
                  <p
                    className={`online-feedback online-feedback--${clipboardFeedback.kind}`}
                    role={clipboardFeedback.kind === "error" ? "alert" : "status"}
                    aria-live={clipboardFeedback.kind === "error" ? "assertive" : "polite"}
                    data-testid="clipboard-feedback"
                  >
                    {clipboardFeedback.message}
                  </p>
                )}
                {online.connectionStatus !== "connected" && (
                  <div className="online-connection" data-testid="online-connection" role="status">
                    <p>{online.connectionStatus === "connecting" || online.connectionStatus === "reconnecting"
                      ? "Reconnecting…"
                      : "Disconnected"}</p>
                    {online.connectionStatus === "disconnected" && (
                      <button
                        type="button"
                        className="match-action"
                        data-testid="online-retry-connection"
                        onClick={online.connect}
                      >
                        Retry connection
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
          </section>
        </aside>
      </div>

      <footer className="page-footer">
        <span>Meydan | The Dama Club</span>
        <span>
          {playMode === "local"
            ? "Local two-player · moves and results follow Dama rules"
            : playMode === "computer"
              ? `You are ${sideName(humanSide)} · ${difficulty} computer`
              : "Online play · room snapshots are provided by the game server"}
        </span>
      </footer>

      <Modal
        open={pendingTransition !== null || pendingOnlineConfirmation !== null || resultDialogIsOpen}
        title={resultDialogIsOpen ? "Match result" : transitionTitle}
        onClose={closeTransitionDialog}
        initialFocusRef={resultDialogIsOpen ? closeResultDialogRef : cancelNewGameRef}
        returnFocusRef={turnStatusRef}
        focusKey={modalFocusKey}
      >
        {resultDialogIsOpen ? (
          <>
            <MatchResultSummary
              result={view.result}
              matchNumber={matchIdentity.matchNumber}
              players={players}
              testId="result-dialog-summary"
            />
            <div className="modal-actions">
              <button
                ref={closeResultDialogRef}
                type="button"
                className="match-action modal-primary"
                data-testid="result-dialog-dismiss"
                onClick={closeTransitionDialog}
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
        {pendingTransition !== null && onlineFeedback?.kind === "error" && (
          <p className="online-feedback online-feedback--error" data-testid="transition-error" role="alert">
            {onlineFeedback.message}
          </p>
        )}
        {pendingTransition !== null && onlineFeedback === null && online.recoverableError !== null && (
          <p className="online-feedback online-feedback--error" data-testid="transition-error" role="alert">
            {online.recoverableError.message}
          </p>
        )}
        <p className="modal-message">
          {pendingOnlineConfirmation === "accept-draw"
            ? "Accepting the other player's offer ends this online match as a draw. The server will record the result."
            : pendingOnlineConfirmation === "resign"
              ? "Resigning ends this online match and awards the win to your opponent. The server will record the result."
              : pendingOnlineConfirmation === "rematch"
                ? "This records your consent. The current match stays in place until both players agree; your vote may start the rematch if the other player has already agreed."
                : pendingTransition?.leaveRoom === true || switchingAwayFromOnlineRoom
            ? leavingActiveOnlineMatch
              ? "Leaving an active match is a forfeit: the server records a disconnection win for your opponent, releases your seat immediately, and invalidates this room session."
              : online.snapshot?.viewerSide === null
                ? "Leaving removes your spectator presence and this room session. The players' match continues unchanged."
                : "Leaving releases your seat and this room session. A waiting or finished match is not changed."
            : pendingTransition?.mode === "online"
              ? "Switching to online play will start a separate room view. Your current local or computer game will be discarded."
              : pendingTransition?.mode !== undefined && playMode === "online"
                ? "Switching away leaves the online room using the server's departure policy before opening local or computer play."
                : pendingTransition?.newGame === true && playMode === "local"
                  ? "Starting a new local Dama match will discard the current moves and history."
                  : "Starting a fresh game will discard the current moves and history before applying this change."}
        </p>
        <div className="modal-actions">
          <button
            ref={cancelNewGameRef}
            type="button"
            className="match-action"
            disabled={online.pendingCommand !== null}
            onClick={closeTransitionDialog}
          >
            {pendingOnlineConfirmation !== null
              ? "Cancel"
              : pendingTransition?.leaveRoom === true || switchingAwayFromOnlineRoom
                ? "Stay in room"
                : "Keep current game"}
          </button>
          {(pendingTransition?.leaveRoom === true || switchingAwayFromOnlineRoom) &&
            online.connectionStatus === "disconnected" && (
              <button type="button" className="match-action" onClick={online.connect}>
                Retry connection
              </button>
            )}
          <button
            type="button"
            className="match-action modal-primary"
            disabled={online.pendingCommand !== null}
            onClick={() => void confirmTransition()}
          >
            {transitionAction}
          </button>
        </div>
          </>
        )}
      </Modal>
    </main>
  );
}

export default App;
