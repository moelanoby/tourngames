/**
 * TournGames Server Shared Types
 */

export type PlayerID = string;
export type UserID = string;
export type LobbyID = string;

export interface PlayerSession {
 id: PlayerID;
 name: string;
 connected: boolean;
 userId?: UserID | null;
}

export type LobbyStatus = "waiting" | "starting" | "playing" | "ended";
export type LobbyType = "open" | "signup" | "private";

export interface SignupEntry {
 userId: UserID;
 username: string;
 signedUpAt: number;
}

export interface Lobby {
 id: LobbyID;
 name: string;
 gameId: string;
 players: PlayerSession[];
 hostId: PlayerID | null;
 hostUserId: UserID | null;
 hostName: string;
 seed: number | null;
 createdAt: number;
 status: LobbyStatus;
 p2pReadyCount: number;
 /** Per-player idempotent p2p-ready flags (playerId -> true). */
 p2pReady?: Record<string, boolean>;
 /** Set once match-over stats have been recorded for the current match. */
 resultRecorded?: boolean;
 type: LobbyType;
 maxPlayers: number;
 minPlayers: number;
 /** Vote time per turn in minutes (0.1-2; fractions allowed). */
 votingTimeMin?: number;
 /** Total match time in minutes (-1 = unlimited). */
 matchTimeMin?: number;
 inviteCode: string | null;
 signups: SignupEntry[];
 startedAt: number | null;
 /** Last write time, used for stale-lobby sweeps. */
 updatedAt?: number;
}

export type UserRole = "user" | "admin";

export interface User {
 id: UserID;
 username: string;
 usernameLower: string;
 passwordHash: string;
 passwordSalt: string;
 createdAt: number;
 wins: number;
 matchesPlayed: number;
 // Security fields
 role: UserRole;
 banned: boolean;
 bannedAt: number | null;
 bannedReason: string | null;
 bannedBy: UserID | null;
 failedLoginAttempts: number;
 lockedUntil: number | null;
 lastLoginAt: number | null;
 lastLoginIp: string | null;
}

export interface Session {
 token: string;
 userId: UserID;
 expiresAt: number;
 createdAt: number;
 csrfToken: string;
}

export interface ReplayData {
 gameModule: string;
 seed: number;
 duration: number;
 winner: string;
 winnerName: string;
 players: PlayerSession[];
 inputs: Record<string, { t: number; jump: boolean }[]>;
 createdAt: number;
 replayId: string;
 // ── Local-only archive (v0.4) ─────────────────────────────────────────────
 // Display title shown in the archive. The CLIENT auto-assigns "Match N"
 // using a localStorage counter when saving, and the user can rename it
 // freely in the UI. The server doesn't read or validate this field
 // (replays aren't stored server-side anymore).
 title?: string;
}

export interface AuthState {
 user: User | null;
}

export interface AuditEntry {
 id: string;
 action: string;
 actorId: string | null;
 actorName: string;
 actorIp: string;
 targetId: string | null;
 targetName: string | null;
 details: string | null;
 timestamp: number;
}

export type SignalMessage =
 | { type: "join"; gameId: string; playerName: string }
 | { type: "join-specific"; lobbyId: string; playerName: string; inviteCode?: string }
 | { type: "create-lobby"; name: string; gameId: string; maxPlayers: number; minPlayers: number; lobbyType: LobbyType; hostName: string }
 | { type: "list-lobbies"; gameId?: string }
 | { type: "leave-lobby" }
 | { type: "start-match" }
 | { type: "offer"; to: string; from: string; data: unknown }
 | { type: "answer"; to: string; from: string; data: unknown }
 | { type: "ice-candidate"; to: string; from: string; data: unknown }
 | { type: "p2p-ready" }
 | { type: "game-state-relay"; state: unknown; tick: number }
 | { type: "input-relay"; playerId: string; input: unknown }
 | { type: "match-over-relay"; winner: string; winnerName: string }
 | { type: "submit-replay"; replay: ReplayData };
