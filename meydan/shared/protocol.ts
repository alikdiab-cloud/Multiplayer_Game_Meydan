import { z } from "zod";

const SideSchema = z.enum(["white", "black"]);
const BoardCoordinateSchema = z.string().regex(/^[0-7]\|[0-7]$/, "Expected a board coordinate from 0|0 to 7|7.");
const RevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const MatchNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A complete move can capture at most the other 63 occupied board squares. */
export const MAX_MOVE_PATH_LENGTH = 63;

/** Names allow international letters and numbers plus safe, readable separators. */
export const DisplayNameSchema = z.string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} _.'-]*$/u, "Name contains unsupported display characters.");

export const RoomCodeSchema = z.string()
  .trim()
  .transform((code) => code.toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-9]{6}$/, "Room code must contain six letters or digits from 2 to 9."));

export const TimeControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("untimed") }).strict(),
  z.object({
    kind: z.literal("rapid"),
    initialMs: z.literal(600_000),
    incrementMs: z.literal(5_000),
  }).strict(),
  z.object({
    kind: z.literal("blitz"),
    initialMs: z.literal(300_000),
    incrementMs: z.literal(3_000),
  }).strict(),
]);

export type TimeControl = z.infer<typeof TimeControlSchema>;
export type TimeControlKind = TimeControl["kind"];

export const TIME_CONTROL_PRESETS = {
  untimed: { kind: "untimed" },
  rapid: { kind: "rapid", initialMs: 600_000, incrementMs: 5_000 },
  blitz: { kind: "blitz", initialMs: 300_000, incrementMs: 3_000 },
} as const satisfies Record<TimeControlKind, TimeControl>;

export const CreateRoomInputSchema = z.object({
  name: DisplayNameSchema,
  side: SideSchema,
  timeControl: TimeControlSchema,
}).strict();

export const JoinRoomInputSchema = z.object({
  name: DisplayNameSchema,
  code: RoomCodeSchema,
  role: z.enum(["player", "spectator"]).optional(),
}).strict();

/** A move request is deliberately only the current revision and a complete path. */
export const MoveRequestSchema = z.object({
  revision: RevisionSchema,
  from: BoardCoordinateSchema,
  path: z.array(BoardCoordinateSchema).min(1).max(MAX_MOVE_PATH_LENGTH),
}).strict();

export const RevisionRequestSchema = z.object({
  revision: RevisionSchema,
}).strict();

/** Draw actions are tied to the room revision they were prepared from. */
export const DrawOfferRequestSchema = RevisionRequestSchema;
export const DrawAcceptRequestSchema = RevisionRequestSchema;
export const DrawDeclineRequestSchema = RevisionRequestSchema;

export const RoomResumeInputSchema = z.object({
  code: RoomCodeSchema,
  sessionToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const ProtocolErrorCodeSchema = z.enum([
  "invalid-input",
  "room-not-found",
  "room-full",
  "room-capacity",
  "session-capacity",
  "session-conflict",
  "code-generation-failed",
  "session-generation-failed",
  "unauthorized",
  "not-your-turn",
  "stale-revision",
  "game-finished",
  "invalid-move",
  "conflict",
  "internal-error",
  "rate-limited",
]);

export const ProtocolErrorSchema = z.object({
  code: ProtocolErrorCodeSchema,
  message: z.string().trim().min(1).max(240),
}).strict();

export const AcknowledgmentSchema = <T extends z.ZodType>(dataSchema: T) => z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: dataSchema }).strict(),
  z.object({ ok: z.literal(false), error: ProtocolErrorSchema }).strict(),
]);

const LegalMoveSchema = z.object({
  from: BoardCoordinateSchema,
  path: z.array(BoardCoordinateSchema).min(1).max(MAX_MOVE_PATH_LENGTH),
  captured: z.array(BoardCoordinateSchema).max(MAX_MOVE_PATH_LENGTH),
}).strict();

const MoveRecordSchema = LegalMoveSchema.extend({
  ply: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  side: SideSchema,
  notation: z.string().min(1).max(512),
}).strict();

const GameResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("won"),
    winner: SideSchema,
    reason: z.enum(["no-moves", "resignation", "timeout", "disconnection"]),
  }).strict(),
  z.object({
    state: z.literal("draw"),
    reason: z.enum(["repetition", "one-piece-each", "king-moves", "lone-king", "agreement", "mutual-disconnection"]),
  }).strict(),
]);

const GameViewSchema = z.object({
  position: z.record(BoardCoordinateSchema, z.enum(["w", "b", "W", "B"])),
  turn: SideSchema,
  legalMoves: z.array(LegalMoveSchema),
  history: z.array(MoveRecordSchema),
  result: GameResultSchema.nullable(),
}).strict();

export const PublicPlayerRecordSchema = z.object({
  playerId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: DisplayNameSchema,
  side: SideSchema,
  connected: z.boolean(),
  recoveryDeadlineMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();

export const RoomPhaseSchema = z.enum(["waiting", "playing", "finished"]);

export const RoomClockSchema = z.object({
  whiteMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  blackMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  activeSide: SideSchema.nullable(),
  running: z.boolean(),
}).strict();

const DrawOfferSchema = z.object({ offeredBy: SideSchema }).strict();

export const RoomSnapshotSchema = z.object({
  /** Monotonic within a room, including across rematches, so old commands stay stale. */
  revision: RevisionSchema,
  matchNumber: MatchNumberSchema,
  phase: RoomPhaseSchema,
  gameView: GameViewSchema,
  players: z.object({
    white: PublicPlayerRecordSchema.nullable(),
    black: PublicPlayerRecordSchema.nullable(),
  }).strict(),
  viewerSide: SideSchema.nullable(),
  spectatorCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timeControl: TimeControlSchema,
  clock: RoomClockSchema,
  serverNow: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  drawOffer: DrawOfferSchema.nullable(),
  rematchVotes: z.object({ white: z.boolean(), black: z.boolean() }).strict(),
}).strict();

export const SessionCredentialsSchema = z.object({
  sessionToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const RoomAccessDataSchema = z.object({
  code: RoomCodeSchema,
  snapshot: RoomSnapshotSchema,
}).strict();

const SnapshotDataSchema = z.object({ snapshot: RoomSnapshotSchema }).strict();
const LeaveRoomDataSchema = z.object({ left: z.literal(true) }).strict();

export const RoomClosedNoticeSchema = z.object({
  reason: z.enum(["host-left", "idle-timeout", "server-shutdown"]),
}).strict();

export type Side = z.infer<typeof SideSchema>;
export type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>;
export type JoinRoomInput = z.infer<typeof JoinRoomInputSchema>;
export type JoinRoomRole = NonNullable<JoinRoomInput["role"]>;
export type MoveRequest = z.infer<typeof MoveRequestSchema>;
export type RevisionRequest = z.infer<typeof RevisionRequestSchema>;
export type DrawOfferRequest = z.infer<typeof DrawOfferRequestSchema>;
export type DrawAcceptRequest = z.infer<typeof DrawAcceptRequestSchema>;
export type DrawDeclineRequest = z.infer<typeof DrawDeclineRequestSchema>;
export type RoomResumeInput = z.infer<typeof RoomResumeInputSchema>;
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type Acknowledgment<T> = { ok: true; data: T } | { ok: false; error: ProtocolError };
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;
export type PublicPlayerRecord = z.infer<typeof PublicPlayerRecordSchema>;
export type RoomClock = z.infer<typeof RoomClockSchema>;
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;
export type SessionCredentials = z.infer<typeof SessionCredentialsSchema>;
export type RoomClosedNotice = z.infer<typeof RoomClosedNoticeSchema>;

export type CreateRoomAcknowledgment = Acknowledgment<z.infer<typeof RoomAccessDataSchema>>;
export type JoinRoomAcknowledgment = Acknowledgment<z.infer<typeof RoomAccessDataSchema>>;
export type ResumeRoomAcknowledgment = Acknowledgment<z.infer<typeof RoomAccessDataSchema>>;
export type RoomMutationAcknowledgment = Acknowledgment<z.infer<typeof SnapshotDataSchema>>;
export type LeaveRoomAcknowledgment = Acknowledgment<z.infer<typeof LeaveRoomDataSchema>>;

export type ClientToServerEvents = {
  "room:create": (input: CreateRoomInput, acknowledge: (response: CreateRoomAcknowledgment) => void) => void;
  "room:join": (input: JoinRoomInput, acknowledge: (response: JoinRoomAcknowledgment) => void) => void;
  "room:resume": (input: RoomResumeInput, acknowledge: (response: ResumeRoomAcknowledgment) => void) => void;
  "room:leave": (acknowledge: (response: LeaveRoomAcknowledgment) => void) => void;
  "game:move": (input: MoveRequest, acknowledge: (response: RoomMutationAcknowledgment) => void) => void;
  "match:resign": (input: RevisionRequest, acknowledge: (response: RoomMutationAcknowledgment) => void) => void;
  "draw:offer": (input: DrawOfferRequest, acknowledge: (response: RoomMutationAcknowledgment) => void) => void;
  "draw:accept": (input: DrawAcceptRequest, acknowledge: (response: RoomMutationAcknowledgment) => void) => void;
  "draw:decline": (input: DrawDeclineRequest, acknowledge: (response: RoomMutationAcknowledgment) => void) => void;
  "rematch:vote": (input: RevisionRequest, acknowledge: (response: RoomMutationAcknowledgment) => void) => void;
};

export type ServerToClientEvents = {
  "session:credential": (credentials: SessionCredentials) => void;
  "room:snapshot": (snapshot: RoomSnapshot) => void;
  "room:closed": (notice: RoomClosedNotice) => void;
  "server:error": (error: ProtocolError) => void;
};

export const RoomAccessAcknowledgmentSchema = AcknowledgmentSchema(RoomAccessDataSchema);
export const CreateRoomAcknowledgmentSchema = RoomAccessAcknowledgmentSchema;
export const JoinRoomAcknowledgmentSchema = RoomAccessAcknowledgmentSchema;
export const ResumeRoomAcknowledgmentSchema = RoomAccessAcknowledgmentSchema;
export const RoomMutationAcknowledgmentSchema = AcknowledgmentSchema(SnapshotDataSchema);
export const LeaveRoomAcknowledgmentSchema = AcknowledgmentSchema(LeaveRoomDataSchema);
