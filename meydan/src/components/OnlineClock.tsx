import { useEffect, useState } from "react";
import type { RoomSnapshot, Side } from "../../shared/protocol.js";
import type { SnapshotReceiptTime } from "../useOnlineRoom.js";

type OnlineClockProps = {
  snapshot: RoomSnapshot;
  receiptTime: SnapshotReceiptTime | null;
  elapsedOverrideMs?: number;
};

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function formatClock(milliseconds: number): string {
  const tenths = Math.ceil(Math.max(0, milliseconds) / 100);
  const seconds = Math.floor(tenths / 10);
  const minutes = Math.floor(seconds / 60);
  const secondPart = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${secondPart}.${tenths % 10}`;
}

function sideLabel(side: Side): string {
  return side === "white" ? "White" : "Black";
}

function recoveryDeadlineLabel(deadlineMs: number): string {
  return new Date(deadlineMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function OnlineClock({ snapshot, receiptTime, elapsedOverrideMs }: OnlineClockProps) {
  const [monotonicTimeMs, setMonotonicTimeMs] = useState(monotonicNow);
  const isRunning = snapshot.phase === "playing" &&
    snapshot.gameView.result === null &&
    snapshot.clock.running &&
    snapshot.clock.activeSide !== null;

  useEffect(() => {
    const refresh = () => setMonotonicTimeMs(monotonicNow());
    refresh();
    document.addEventListener("visibilitychange", refresh);
    if (!isRunning) {
      return () => document.removeEventListener("visibilitychange", refresh);
    }

    const interval = window.setInterval(refresh, 100);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isRunning, receiptTime, snapshot.clock.activeSide, snapshot.clock.running, snapshot.matchNumber, snapshot.revision, snapshot.serverNow]);

  const receiptMonotonicMs = receiptTime?.monotonicMs ?? monotonicTimeMs;
  const receiptAgeMs = receiptTime?.ageAtReceiptMs ?? 0;
  const elapsedSinceReceiptMs = elapsedOverrideMs ?? Math.max(0, monotonicTimeMs - receiptMonotonicMs);
  const elapsedSinceSnapshotMs = isRunning
    ? receiptAgeMs + elapsedSinceReceiptMs
    : 0;
  const isUntimed = snapshot.timeControl.kind === "untimed";
  const values: Record<Side, number | null> = {
    white: snapshot.clock.whiteMs,
    black: snapshot.clock.blackMs,
  };
  const disconnectedPlayers = (["white", "black"] as const).flatMap((side) => {
    const player = snapshot.players[side];
    return player !== null && !player.connected
      ? [{ side, deadlineMs: player.recoveryDeadlineMs }]
      : [];
  });

  return (
    <section className="online-clock-panel" aria-label="Online match clock" aria-live="off" data-testid="online-clocks">
      <h4 className="online-clock-title">Match clock</h4>
      {isUntimed ? (
        <div className="online-clock-grid" data-time-control="untimed">
          {(["white", "black"] as const).map((side) => (
            <div className="online-clock-card" key={side} data-testid={`${side}-display-clock`}>
              <span className="online-clock-side">{sideLabel(side)}</span>
              <strong className="online-clock-value">Untimed</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="online-clock-grid" data-time-control={snapshot.timeControl.kind}>
          {(["white", "black"] as const).map((side) => {
            const baseMs = values[side];
            const remainingMs = baseMs === null
              ? null
              : Math.max(0, baseMs - (snapshot.clock.activeSide === side ? elapsedSinceSnapshotMs : 0));
            const active = isRunning && snapshot.clock.activeSide === side;
            const status = active
              ? "Running"
              : snapshot.phase === "waiting"
                ? "Starts when the match starts"
                : snapshot.phase === "finished"
                  ? "Final"
                  : "Paused";

            return (
              <div
                className="online-clock-card"
                key={side}
                data-active={active ? "true" : "false"}
                data-testid={`${side}-display-clock`}
              >
                <span className="online-clock-side">{sideLabel(side)}</span>
                <span className="online-clock-reading">
                  <strong
                    className="online-clock-value"
                    data-remaining-ms={remainingMs === null ? "none" : String(Math.floor(remainingMs))}
                  >
                    {remainingMs === null ? "—" : formatClock(remainingMs)}
                  </strong>
                  <span className="online-clock-state">{status}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {snapshot.phase === "waiting" && !isUntimed && (
        <p className="online-clock-note">Clocks start when both players are connected.</p>
      )}
      {disconnectedPlayers.length > 0 && (
        <div className="online-recovery-status" role="status" aria-live="polite" data-testid="online-recovery-status">
          {disconnectedPlayers.map(({ side, deadlineMs }) => (
            <p key={side}>
              <strong>{sideLabel(side)} disconnected.</strong>{" "}
              {deadlineMs === null
                ? "The seat is reserved during recovery."
                : `Seat reserved until ${recoveryDeadlineLabel(deadlineMs)}.`}{" "}
              {isRunning && "The active clock continues."}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
