import { describe, expect, it } from "vitest";
import { DamaMatch } from "../shared/game.js";
import {
  CreateRoomInputSchema,
  DisplayNameSchema,
  JoinRoomInputSchema,
  LeaveRoomAcknowledgmentSchema,
  MAX_MOVE_PATH_LENGTH,
  MoveRequestSchema,
  PublicPlayerRecordSchema,
  RoomAccessAcknowledgmentSchema,
  RoomCodeSchema,
  RoomSnapshotSchema,
  TIME_CONTROL_PRESETS,
  TimeControlSchema,
} from "../shared/protocol.js";

function validSnapshot() {
  const gameView = new DamaMatch().getView();
  return {
    revision: 7,
    matchNumber: 2,
    phase: "playing" as const,
    gameView,
    players: {
      white: {
        playerId: "player_white_1",
        name: "Ada",
        side: "white" as const,
        connected: true,
        recoveryDeadlineMs: null,
      },
      black: {
        playerId: "player_black_2",
        name: "Turing",
        side: "black" as const,
        connected: true,
        recoveryDeadlineMs: null,
      },
    },
    viewerSide: "white" as const,
    spectatorCount: 0,
    timeControl: TIME_CONTROL_PRESETS.rapid,
    clock: { whiteMs: 598_000, blackMs: 600_000, activeSide: "white" as const, running: true },
    serverNow: 1_800_000_000_000,
    drawOffer: null,
    rematchVotes: { white: false, black: false },
  };
}

describe("shared room protocol schemas", () => {
  it("trims safe names and accepts create and join inputs", () => {
    const create = CreateRoomInputSchema.parse({
      name: "  Zoë M.  ",
      side: "black",
      timeControl: TIME_CONTROL_PRESETS.rapid,
    });
    const join = JoinRoomInputSchema.parse({ name: "  Sam_2  ", code: "ab2cd9" });

    expect(create.name).toBe("Zoë M.");
    expect(create.side).toBe("black");
    expect(create.timeControl).toEqual({ kind: "rapid", initialMs: 600_000, incrementMs: 5_000 });
    expect(join).toEqual({ name: "Sam_2", code: "AB2CD9" });
  });

  it("accepts only the defined clock presets", () => {
    expect(TimeControlSchema.parse(TIME_CONTROL_PRESETS.untimed)).toEqual({ kind: "untimed" });
    expect(TimeControlSchema.parse(TIME_CONTROL_PRESETS.rapid)).toEqual({
      kind: "rapid",
      initialMs: 600_000,
      incrementMs: 5_000,
    });
    expect(TimeControlSchema.parse(TIME_CONTROL_PRESETS.blitz)).toEqual({
      kind: "blitz",
      initialMs: 300_000,
      incrementMs: 3_000,
    });
    expect(TimeControlSchema.safeParse({ kind: "rapid", initialMs: 600_001, incrementMs: 5_000 }).success)
      .toBe(false);
  });

  it.each([
    "",
    "   ",
    "Name<script>",
    "This display name is too long",
  ])("rejects unsafe or oversized name %j", (name) => {
    expect(DisplayNameSchema.safeParse(name).success).toBe(false);
  });

  it.each(["ABC123", "ABCDE1", "ABCD0F", "AB-2CD", "ABC2D"])(
    "rejects malformed room code %s",
    (code) => {
      expect(RoomCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  it("accepts a complete coordinate path and rejects coordinates outside the board", () => {
    expect(MoveRequestSchema.parse({ revision: 0, from: "0|0", path: ["7|7"] })).toEqual({
      revision: 0,
      from: "0|0",
      path: ["7|7"],
    });
    expect(MoveRequestSchema.safeParse({ revision: 1, from: "8|0", path: ["7|7"] }).success)
      .toBe(false);
    expect(MoveRequestSchema.safeParse({ revision: 1, from: "0|0", path: ["7|8"] }).success)
      .toBe(false);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects malformed move revision %s",
    (revision) => {
      expect(MoveRequestSchema.safeParse({ revision, from: "0|0", path: ["1|0"] }).success)
        .toBe(false);
    },
  );

  it("bounds full move paths and excludes client board or clock fields", () => {
    const maximumPath = Array.from({ length: MAX_MOVE_PATH_LENGTH }, () => "1|0");
    expect(MoveRequestSchema.safeParse({ revision: 3, from: "0|0", path: maximumPath }).success)
      .toBe(true);
    expect(MoveRequestSchema.safeParse({
      revision: 3,
      from: "0|0",
      path: [...maximumPath, "2|0"],
    }).success).toBe(false);
    expect(MoveRequestSchema.safeParse({
      revision: 3,
      from: "0|0",
      path: ["1|0"],
      board: {},
    }).success).toBe(false);
    expect(MoveRequestSchema.safeParse({
      revision: 3,
      from: "0|0",
      path: ["1|0"],
      clientClockMs: 5,
    }).success).toBe(false);
  });

  it("validates per-viewer snapshots and keeps credentials outside their public shape", () => {
    const snapshot = validSnapshot();
    expect(RoomSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(RoomSnapshotSchema.safeParse({ ...snapshot, sessionToken: "private-token" }).success)
      .toBe(false);
    const publicPlayer = {
      playerId: "player_1",
      name: "Ada",
      side: "white",
      connected: true,
      recoveryDeadlineMs: null,
    };
    expect(PublicPlayerRecordSchema.parse(publicPlayer)).toEqual(publicPlayer);
    expect(PublicPlayerRecordSchema.safeParse({
      ...publicPlayer,
      sessionToken: "private-token",
    }).success).toBe(false);
  });

  it("keeps acknowledgments explicitly discriminated as success or error", () => {
    const snapshot = validSnapshot();
    const success = RoomAccessAcknowledgmentSchema.parse({
      ok: true,
      data: {
        code: "ab2cd9",
        snapshot,
      },
    });
    const failure = RoomAccessAcknowledgmentSchema.parse({
      ok: false,
      error: { code: "room-not-found", message: "No room has that code. Check the code or create a room." },
    });
    const leaveSuccess = LeaveRoomAcknowledgmentSchema.parse({ ok: true, data: { left: true } });

    expect(success).toMatchObject({ ok: true, data: { code: "AB2CD9" } });
    expect(failure).toEqual({
      ok: false,
      error: { code: "room-not-found", message: "No room has that code. Check the code or create a room." },
    });
    expect(leaveSuccess).toEqual({ ok: true, data: { left: true } });
  });
});
