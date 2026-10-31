import {
  resultDetail,
  resultText,
  type GameResult,
  type MoveRecord,
  type Side,
} from "../shared/game.js";
import type { TimeControl } from "../shared/protocol.js";

export type ScorebookPlayers = Readonly<Record<Side, string>>;

type FullMove = {
  number: number;
  white?: MoveRecord;
  black?: MoveRecord;
};

export function groupScorebookHistory(history: readonly MoveRecord[]): FullMove[] {
  const moves = new Map<number, FullMove>();
  const startsWithWhite = history[0]?.side !== "black";
  for (const record of history) {
    const number = startsWithWhite
      ? Math.ceil(record.ply / 2)
      : Math.ceil((record.ply + 1) / 2);
    const move = moves.get(number) ?? { number };
    if (record.side === "white") {
      move.white = record;
    } else {
      move.black = record;
    }
    moves.set(number, move);
  }
  return Array.from(moves.values()).sort((left, right) => left.number - right.number);
}

export function normalizeScorebookLine(value: string): string {
  return value.replace(/\r\n|\r|\n|\u2028|\u2029/g, " ");
}

export function formatTimeControlLabel(timeControl: TimeControl): string {
  if (timeControl.kind === "untimed") return "Untimed";
  const initialMinutes = timeControl.initialMs / 60_000;
  const incrementSeconds = timeControl.incrementMs / 1_000;
  const label = timeControl.kind === "rapid" ? "Rapid" : "Blitz";
  return `${label} · ${initialMinutes} min + ${incrementSeconds} sec increment`;
}

export function createScorebookText(
  history: readonly MoveRecord[],
  result: GameResult | null,
  mode: string,
  players: ScorebookPlayers,
  roomCode: string | null,
  matchNumber: number,
  timeControl: TimeControl,
): string {
  const moves = groupScorebookHistory(history);
  const lines = [
    "Meydan | The Dama Club",
    "Dama scorebook",
    "",
    `Mode: ${normalizeScorebookLine(mode)}`,
    `Match number: ${matchNumber}`,
    `Time control: ${formatTimeControlLabel(timeControl)}`,
    ...(roomCode === null ? [] : [`Room code: ${normalizeScorebookLine(roomCode)}`]),
    `White player: ${normalizeScorebookLine(players.white)}`,
    `Black player: ${normalizeScorebookLine(players.black)}`,
    "",
    "Moves:",
  ];

  if (moves.length === 0) {
    lines.push("No moves recorded.");
  } else {
    for (const move of moves) {
      lines.push(
        `${move.number}. White: ${move.white === undefined ? "—" : normalizeScorebookLine(move.white.notation)} | Black: ${move.black === undefined ? "—" : normalizeScorebookLine(move.black.notation)}`,
      );
    }
  }

  if (result !== null) {
    lines.push("", `Result: ${resultText(result)}`, `Details: ${resultDetail(result)}`);
  }

  return `${lines.join("\n")}\n`;
}
