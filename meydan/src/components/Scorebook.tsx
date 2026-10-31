import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  resultDetail,
  resultText,
  type GameResult,
  type MoveRecord,
  type Side,
} from "../../shared/game.js";
import type { TimeControl } from "../../shared/protocol.js";
import {
  createScorebookText,
  formatTimeControlLabel,
  groupScorebookHistory,
  normalizeScorebookLine,
} from "../scorebook.js";

type ScorebookProps = {
  history: readonly MoveRecord[];
  result: GameResult | null;
  mode: string;
  players: Readonly<Record<Side, string>>;
  roomCode: string | null;
  matchNumber: number;
  timeControl: TimeControl;
};

function filenameForToday(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `meydan-dama-scorebook-${date}.txt`;
}

export function Scorebook({ history, result, mode, players, roomCode, matchNumber, timeControl }: ScorebookProps) {
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const objectUrlsRef = useRef(new Map<string, number>());
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const moves = groupScorebookHistory(history);
  const scorebookText = createScorebookText(history, result, mode, players, roomCode, matchNumber, timeControl);

  useEffect(() => () => {
    for (const [objectUrl, timeoutId] of objectUrlsRef.current) {
      window.clearTimeout(timeoutId);
      URL.revokeObjectURL(objectUrl);
    }
    objectUrlsRef.current.clear();
  }, [scorebookText]);

  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    if (scrollRegion !== null) {
      scrollRegion.scrollTop = scrollRegion.scrollHeight;
    }
  }, [history, result]);

  function handleDownload(): void {
    let objectUrl: string | null = null;
    const link = document.createElement("a");
    try {
      const blob = new Blob([scorebookText], {
        type: "text/plain;charset=utf-8",
      });
      objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = filenameForToday();
      link.hidden = true;
      document.body.append(link);
      link.click();
      setDownloadError(null);
    } catch {
      setDownloadError("Could not start the scorebook download. Check your browser’s download settings and try again.");
    } finally {
      link.remove();
      if (objectUrl !== null) {
        const timeoutId = window.setTimeout(() => {
          objectUrlsRef.current.delete(objectUrl!);
          URL.revokeObjectURL(objectUrl!);
        }, 1000);
        objectUrlsRef.current.set(objectUrl, timeoutId);
      }
    }
  }

  return (
    <section className="note-section scorebook-section" aria-labelledby="history-heading">
      <div className="section-heading scorebook-heading">
        <h2 id="history-heading">Move history</h2>
        <span className="history-count" data-testid="history-count">
          {history.length} {history.length === 1 ? "ply" : "plies"}
        </span>
        <button
          type="button"
          className="scorebook-download"
          aria-label="Download scorebook"
          title="Download the current Dama scorebook as a text file"
          onClick={handleDownload}
        >
          <Download size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {downloadError !== null && (
        <p className="online-feedback online-feedback--error" data-testid="scorebook-download-error" role="alert">
          {downloadError}
        </p>
      )}

      <dl className="scorebook-metadata" data-testid="scorebook-metadata">
        <div><dt>Mode</dt><dd data-testid="scorebook-mode">{normalizeScorebookLine(mode)}</dd></div>
        <div><dt>Match</dt><dd data-testid="scorebook-match-number">{matchNumber}</dd></div>
        <div><dt>Time control</dt><dd data-testid="scorebook-time-control">{formatTimeControlLabel(timeControl)}</dd></div>
        {roomCode !== null && <div><dt>Room</dt><dd data-testid="scorebook-room-code">{normalizeScorebookLine(roomCode)}</dd></div>}
        <div><dt>White</dt><dd data-testid="scorebook-white-player">{normalizeScorebookLine(players.white)}</dd></div>
        <div><dt>Black</dt><dd data-testid="scorebook-black-player">{normalizeScorebookLine(players.black)}</dd></div>
      </dl>

      <div className="scorebook-scroll" ref={scrollRegionRef} data-testid="scorebook-scroll">
        {history.length === 0 ? (
          <p className="history-empty" data-testid="empty-history">
            No moves recorded.
          </p>
        ) : (
          <table
            className="scorebook-table"
            aria-label="Move history"
            data-testid="move-history"
            data-ply-count={history.length}
          >
            <thead>
              <tr>
                <th scope="col">Move</th>
                <th scope="col">White</th>
                <th scope="col">Black</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((move) => (
                <tr key={move.number}>
                  <th className="scorebook-number" scope="row">
                    {move.number}.
                  </th>
                  <td
                    className={`scorebook-cell${move.white === undefined ? "" : " history-row"}`}
                    data-side={move.white === undefined ? undefined : "white"}
                  >
                    {move.white === undefined ? (
                      <span className="scorebook-empty-cell">—</span>
                    ) : (
                      <span className="history-notation">{normalizeScorebookLine(move.white.notation)}</span>
                    )}
                  </td>
                  <td
                    className={`scorebook-cell${move.black === undefined ? "" : " history-row"}`}
                    data-side={move.black === undefined ? undefined : "black"}
                  >
                    {move.black === undefined ? (
                      <span className="scorebook-empty-cell">—</span>
                    ) : (
                      <span className="history-notation">{normalizeScorebookLine(move.black.notation)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {result !== null && (
          <div className="scorebook-result" aria-label="Game result" data-testid="scorebook-result">
            <strong>{resultText(result)}</strong>
            <span>{resultDetail(result)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
