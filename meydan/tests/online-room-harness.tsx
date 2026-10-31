import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TIME_CONTROL_PRESETS } from "../shared/protocol.js";
import { OnlineClock } from "../src/components/OnlineClock.js";
import { useOnlineRoom } from "../src/useOnlineRoom.js";

function OnlineRoomHarness() {
  const online = useOnlineRoom();
  const [name, setName] = useState("Browser Player");
  const [joinCode, setJoinCode] = useState("");
  const [commandResult, setCommandResult] = useState("none");
  const [displayElapsedMs, setDisplayElapsedMs] = useState<number | null>(null);
  const view = online.snapshot?.gameView;

  useEffect(() => {
    setDisplayElapsedMs(null);
  }, [online.snapshot?.matchNumber, online.snapshot?.revision, online.snapshot?.serverNow]);

  return (
    <main>
      <h1>Online room test</h1>
      <p data-testid="online-status">{online.connectionStatus}</p>
      <p data-testid="room-code">{online.roomCode ?? "none"}</p>
      <p data-testid="viewer-side">{online.snapshot?.viewerSide ?? "none"}</p>
      <p data-testid="room-phase">{online.snapshot?.phase ?? "none"}</p>
      <p data-testid="revision">{online.snapshot?.revision ?? "none"}</p>
      <p data-testid="match-number">{online.snapshot?.matchNumber ?? "none"}</p>
      <p data-testid="white-clock-ms">{online.snapshot?.clock.whiteMs ?? "none"}</p>
      <p data-testid="black-clock-ms">{online.snapshot?.clock.blackMs ?? "none"}</p>
      <p data-testid="clock-active-side">{online.snapshot?.clock.activeSide ?? "none"}</p>
      {online.snapshot !== null && (
        <OnlineClock
          snapshot={online.snapshot}
          receiptTime={online.snapshotReceiptTime}
          elapsedOverrideMs={displayElapsedMs ?? undefined}
        />
      )}
      <p data-testid="spectator-count">{online.snapshot?.spectatorCount ?? "none"}</p>
      <p data-testid="history-count">{view?.history.length ?? 0}</p>
      <p data-testid="turn-side">{view?.turn ?? "none"}</p>
      <p data-testid="white-connected">{online.snapshot?.players.white?.connected ? "yes" : "no"}</p>
      <p data-testid="black-connected">{online.snapshot?.players.black?.connected ? "yes" : "no"}</p>
      <p data-testid="pending-command">{online.pendingCommand ?? "none"}</p>
      <p data-testid="command-result">{commandResult}</p>
      <p data-testid="recoverable-error">{online.recoverableError?.code ?? "none"}</p>
      <p data-testid="remembered-nickname">{online.rememberedNickname}</p>

      <label>
        Display name
        <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <button
        type="button"
        data-testid="create-room"
        disabled={online.connectionStatus !== "connected" || online.pendingCommand !== null}
        onClick={() => {
          void online.createRoom({ name, side: "white", timeControl: TIME_CONTROL_PRESETS.rapid }).then((result) => {
            setCommandResult(result.ok ? "created" : result.error.code);
          });
        }}
      >Create room</button>
      <label>
        Room code
        <input value={joinCode} onChange={(event) => setJoinCode(event.currentTarget.value)} />
      </label>
      <button
        type="button"
        data-testid="join-room"
        disabled={online.connectionStatus !== "connected" || online.pendingCommand !== null}
        onClick={() => {
          void online.joinRoom({ name, code: joinCode }).then((result) => {
            setCommandResult(result.ok ? "joined" : result.error.code);
          });
        }}
      >Join room</button>
      <button
        type="button"
        data-testid="invalid-move"
        disabled={online.pendingCommand !== null}
        onClick={() => {
          void online.move({ revision: online.snapshot?.revision ?? 0, from: "0|0", path: ["0|0"] }).then((result) => {
            setCommandResult(result.ok ? "unexpected-success" : result.error.code);
          });
        }}
      >Send illegal move</button>
      <button
        type="button"
        data-testid="legal-move"
        disabled={online.pendingCommand !== null || view?.legalMoves[0] === undefined}
        onClick={() => {
          const move = online.snapshot?.gameView.legalMoves[0];
          const revision = online.snapshot?.revision;
          if (move === undefined || revision === undefined) return;
          void online.move({ revision, from: move.from, path: [...move.path] }).then((result) => {
            setCommandResult(result.ok ? "moved" : result.error.code);
          });
        }}
      >Make legal move</button>
      <button
        type="button"
        data-testid="advance-display-clock"
        onClick={() => setDisplayElapsedMs((elapsed) => (elapsed ?? 0) + 500)}
      >Advance display clock by 500 ms</button>
      <button
        type="button"
        data-testid="leave-room"
        disabled={online.pendingCommand !== null || online.roomCode === null}
        onClick={() => {
          void online.leaveRoom().then((result) => {
            setCommandResult(result.ok ? "left" : result.error.code);
          });
        }}
      >Leave room</button>
    </main>
  );
}

const rootElement = document.getElementById("online-room-root");
if (rootElement === null) throw new Error("Online room test root is missing.");
createRoot(rootElement).render(<OnlineRoomHarness />);
