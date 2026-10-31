import { ArrowLeft, X } from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  previewSelection,
  resultText,
  sameMove,
  selectionMoves,
  squareName,
  type GameView,
  type MoveInput,
  type MoveSelection,
  type Side,
} from "../../shared/game.js";

const coordinates = Array.from({ length: 8 }, (_, index) => index);

type PieceDescription = {
  side: Side;
  kind: "man" | "king";
  label: string;
};

type BoardProps = {
  view: GameView;
  onMove: (move: MoveInput) => void;
  flipped?: boolean;
  inputDisabled?: boolean;
  readOnly?: boolean;
};

export type BoardHandle = {
  cancelSelection: () => void;
};

function describePiece(code: string): PieceDescription {
  const side: Side = code.toLowerCase() === "w" ? "white" : "black";
  const kind = code === code.toLowerCase() ? "man" : "king";
  const sideLabel = side === "white" ? "White" : "Black";

  return { side, kind, label: `${sideLabel} ${kind}` };
}

function boardLabel(view: GameView): string {
  if (view.result !== null) {
    return `Dama board. ${resultText(view.result)}.`;
  }

  return `Dama board. ${view.turn === "white" ? "White" : "Black"} to move.`;
}

function nextLandings(view: GameView, selection: MoveSelection | null): Set<string> {
  if (selection === null) {
    return new Set();
  }

  const landingIndex = selection.path.length;
  return new Set(
    selectionMoves(view, selection)
      .map((move) => move.path[landingIndex])
      .filter((landing): landing is string => landing !== undefined),
  );
}

function isActionableSource(view: GameView, coordinate: string, inputDisabled: boolean): boolean {
  if (inputDisabled || view.result !== null) {
    return false;
  }

  const piece = view.position[coordinate];
  if (piece === undefined) {
    return false;
  }

  const pieceSide: Side = piece.toLowerCase() === "w" ? "white" : "black";
  return pieceSide === view.turn && selectionMoves(view, { from: coordinate, path: [] }).length > 0;
}

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(
  { view, onMove, flipped = false, inputDisabled = false, readOnly = false },
  ref,
) {
  const initialFocus = view.legalMoves[0]?.from ?? "0|0";
  const focusedCoordinateRef = useRef(initialFocus);
  const [focusedCoordinate, setFocusedCoordinate] = useState(initialFocus);
  const [selectionState, setSelectionState] = useState<{
    view: GameView;
    selection: MoveSelection;
  } | null>(null);
  const boardRootRef = useRef<HTMLDivElement>(null);
  const squareButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const previousViewRef = useRef(view);
  const previousFlippedRef = useRef(flipped);
  useImperativeHandle(
    ref,
    () => ({ cancelSelection: () => setSelectionState(null) }),
    [],
  );
  const selection = selectionState?.view === view ? selectionState.selection : null;
  const isFinished = view.result !== null;
  const visualRows = flipped ? [...coordinates].reverse() : coordinates;
  const visualColumns = flipped ? [...coordinates].reverse() : coordinates;

  function updateSelection(nextSelection: MoveSelection | null): void {
    setSelectionState(
      nextSelection === null ? null : { view, selection: nextSelection },
    );
  }

  function focusSquare(coordinate: string): void {
    focusedCoordinateRef.current = coordinate;
    setFocusedCoordinate(coordinate);
    squareButtonsRef.current.get(coordinate)?.focus({ preventScroll: true });
  }

  function handleSquareKeyDown(event: KeyboardEvent<HTMLButtonElement>, coordinate: string): void {
    if (event.key === "Escape") {
      if (selection !== null) {
        event.preventDefault();
        updateSelection(null);
      }
      return;
    }

    let rowDelta = 0;
    let columnDelta = 0;
    switch (event.key) {
      case "ArrowUp":
        rowDelta = -1;
        break;
      case "ArrowDown":
        rowDelta = 1;
        break;
      case "ArrowLeft":
        columnDelta = -1;
        break;
      case "ArrowRight":
        columnDelta = 1;
        break;
      default:
        return;
    }

    const [rowText, columnText] = coordinate.split("|");
    if (rowText === undefined || columnText === undefined) {
      return;
    }

    const rowIndex = visualRows.indexOf(Number(rowText));
    const columnIndex = visualColumns.indexOf(Number(columnText));
    const nextRowIndex = rowIndex + rowDelta;
    const nextColumnIndex = columnIndex + columnDelta;
    const nextRow = visualRows[nextRowIndex];
    const nextColumn = visualColumns[nextColumnIndex];
    if (nextRow === undefined || nextColumn === undefined) {
      return;
    }

    event.preventDefault();
    focusSquare(`${nextRow}|${nextColumn}`);
  }

  useLayoutEffect(() => {
    const viewChanged = previousViewRef.current !== view;
    const orientationChanged = previousFlippedRef.current !== flipped;
    previousViewRef.current = view;
    previousFlippedRef.current = flipped;

    if (
      (viewChanged || orientationChanged) &&
      boardRootRef.current?.contains(document.activeElement)
    ) {
      squareButtonsRef.current.get(focusedCoordinateRef.current)?.focus({ preventScroll: true });
    }
  }, [flipped, view]);

  const visibleView = selection === null ? view : previewSelection(view, selection);
  const legalLandings = nextLandings(view, selection);

  function handleSquareClick(coordinate: string): void {
    if (readOnly) {
      return;
    }
    focusSquare(coordinate);
    if (isFinished || inputDisabled) {
      return;
    }

    if (selection !== null) {
      const candidates = selectionMoves(view, selection);
      const isNextLanding = candidates.some(
        (move) => move.path[selection.path.length] === coordinate,
      );

      if (isNextLanding) {
        const nextSelection: MoveSelection = {
          from: selection.from,
          path: [...selection.path, coordinate],
        };
        const continuations = selectionMoves(view, nextSelection);
        const hasFurtherLanding = continuations.some(
          (move) => move.path.length > nextSelection.path.length,
        );
        const completeMove = continuations.find((move) => sameMove(move, nextSelection));

        if (completeMove !== undefined && !hasFurtherLanding) {
          onMove({ from: completeMove.from, path: [...completeMove.path] });
          updateSelection(null);
        } else {
          updateSelection(nextSelection);
        }
        return;
      }

      if (coordinate === selection.from) {
        updateSelection(null);
        return;
      }
    }

    if (isActionableSource(view, coordinate, inputDisabled)) {
      updateSelection({ from: coordinate, path: [] });
      return;
    }

    updateSelection(null);
  }

  return (
    <div className="board-interaction" ref={boardRootRef}>
      <div className="board-coordinate-wrap">
        <div className="rank-labels" aria-hidden="true">
          {visualRows.map((row) => (
            <span key={row}>{squareName(`${row}|0`).slice(1)}</span>
          ))}
        </div>

        <div className="board-plane">
          <table className="board-grid" aria-label={boardLabel(view)}>
            <tbody>
              {visualRows.map((row) => (
                <tr key={row}>
                  {visualColumns.map((column) => {
                    const coordinate = `${row}|${column}`;
                    const piece = visibleView.position[coordinate];
                    const description = piece === undefined ? undefined : describePiece(piece);
                    const isCurrentPiece =
                      selection !== null &&
                      coordinate === (selection.path.at(-1) ?? selection.from);
                    const isSelectable =
                      selection === null && isActionableSource(view, coordinate, inputDisabled);
                    const isLanding = legalLandings.has(coordinate);
                    const accessibleName = [
                      squareName(coordinate),
                      description?.label ?? "empty",
                      isSelectable ? "selectable piece" : "",
                      isLanding ? "legal landing" : "",
                      isCurrentPiece ? "selected" : "",
                    ]
                      .filter(Boolean)
                      .join(", ");

                    return (
                      <td
                        key={coordinate}
                        className={`board-square ${(row + column) % 2 === 0 ? "square-pine" : "square-sage"}`}
                      >
                        <button
                          type="button"
                          ref={(button) => {
                            if (button === null) {
                              squareButtonsRef.current.delete(coordinate);
                            } else {
                              squareButtonsRef.current.set(coordinate, button);
                            }
                          }}
                          className={[
                            "square-control",
                            isSelectable ? "square-control--source" : "",
                            isCurrentPiece ? "square-control--selected" : "",
                            isLanding ? "square-control--landing" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          aria-label={accessibleName}
                          aria-current={isCurrentPiece ? "true" : undefined}
                          aria-disabled={readOnly || isFinished || inputDisabled}
                          tabIndex={coordinate === focusedCoordinate ? 0 : -1}
                          onFocus={() => {
                            focusedCoordinateRef.current = coordinate;
                            setFocusedCoordinate(coordinate);
                          }}
                          onKeyDown={(event) => handleSquareKeyDown(event, coordinate)}
                          onClick={() => handleSquareClick(coordinate)}
                        >
                          {description !== undefined && (
                            <img
                              className={`piece-art piece-art--${description.kind}`}
                              src={`/pieces/piece-${description.side}-${description.kind}.svg`}
                              alt={description.label}
                              draggable={false}
                            />
                          )}
                          {isLanding && <span className="landing-marker" aria-hidden="true" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="file-labels" aria-hidden="true">
          {visualColumns.map((column) => (
            <span key={column}>{squareName(`0|${column}`).charAt(0)}</span>
          ))}
        </div>
      </div>

      {selection !== null && (
        <div className="selection-controls" aria-label="Move preview controls">
          {selection.path.length > 0 && (
            <button
              type="button"
              className="selection-action"
              onClick={() =>
                updateSelection({ from: selection.from, path: selection.path.slice(0, -1) })
              }
            >
              <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>Back</span>
            </button>
          )}
          <button type="button" className="selection-action" onClick={() => updateSelection(null)}>
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>Cancel</span>
          </button>
        </div>
      )}
    </div>
  );
});
