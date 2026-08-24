/**
 * TournGames Server Lobbies & Signups Module
 *
 * CRUD for lobbies, signup management, and lobby listing.
 * Backed by Deno KV.
 */

import type { Lobby, PlayerSession, SignupEntry, LobbyType, LobbyID, PlayerID, UserID } from "./types.ts";

const kv = await Deno.openKv();
const LOBBY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function generateId(): string {
 return crypto.randomUUID();
}

function generateSeed(): number {
 return Math.floor(Math.random() * 2147483647) + 1;
}

function generateInviteCode(): string {
 // 6-char alphanumeric code (uppercase, no ambiguous chars)
 const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
 let out = "";
 const bytes = new Uint8Array(6);
 crypto.getRandomValues(bytes);
 for (let i = 0; i < 6; i++) out += chars[(bytes[i] ?? 0) % chars.length];
 return out;
}

// ─── Lobby CRUD ──────────────────────────────────────────────────────────────

export async function createLobby(opts: {
 name: string;
 gameId: string;
 hostName: string;
 hostUserId?: UserID | null;
 type?: LobbyType;
 maxPlayers?: number;
 minPlayers?: number;
 votingTimeMin?: number;
 matchTimeMin?: number;
}): Promise<Lobby> {
 const lobbyId = generateId();
 // Defensive: ensure all string fields are actually strings
 const safeName = typeof opts.name === "string" ? opts.name.trim().slice(0, 60) : "Untitled Lobby";
 const safeGameId = typeof opts.gameId === "string" ? opts.gameId : "team-chess";
 const safeHostName = typeof opts.hostName === "string" ? opts.hostName.slice(0, 16) : "Host";
 const safeType: LobbyType = ["open", "signup", "private"].includes(opts.type as string) ? opts.type as LobbyType : "open";
 const safeMax = typeof opts.maxPlayers === "number" && !isNaN(opts.maxPlayers)
 ? Math.min(20, Math.max(2, Math.floor(opts.maxPlayers))) : 10;
 const safeMin = typeof opts.minPlayers === "number" && !isNaN(opts.minPlayers)
 ? Math.min(10, Math.max(2, Math.floor(opts.minPlayers))) : 2;
 // Game timers (minutes): vote time capped at 2 min; match time -1 =
 // unlimited, otherwise any positive duration the host wants.
 const rawVoting = typeof opts.votingTimeMin === "number" && !isNaN(opts.votingTimeMin)
 ? opts.votingTimeMin : 0.25;
 const safeVotingMin = Math.min(2, Math.max(0.1, rawVoting));
 const rawMatch = typeof opts.matchTimeMin === "number" && !isNaN(opts.matchTimeMin)
 ? opts.matchTimeMin : 10;
 const safeMatchMin = rawMatch > 0 ? Math.round(rawMatch) : -1;

 const lobby: Lobby = {
 id: lobbyId,
 name: safeName || "Untitled Lobby",
 gameId: safeGameId,
 players: [],
 hostId: null,
 hostUserId: opts.hostUserId || null,
 hostName: safeHostName,
 seed: null,
 createdAt: Date.now(),
 status: "waiting",
 p2pReadyCount: 0,
 type: safeType,
 maxPlayers: safeMax,
 minPlayers: safeMin,
 votingTimeMin: safeVotingMin,
 matchTimeMin: safeMatchMin,
 inviteCode: safeType === "private" ? generateInviteCode() : null,
 signups: [],
 startedAt: null,
 updatedAt: Date.now(),
 };
 await kv.set(["lobby", lobbyId], lobby);
 return lobby;
}

export async function getLobby(lobbyId: string): Promise<Lobby | null> {
 const res = await kv.get<Lobby>(["lobby", lobbyId]);
 return res.value || null;
}

export async function updateLobby(lobby: Lobby): Promise<void> {
 // Defensive: ensure players and signups are clean arrays of plain objects
 if (Array.isArray(lobby.players)) {
 lobby.players = lobby.players.map((p) => ({
 id: typeof p.id === "string" ? p.id : String(p.id || ""),
 name: typeof p.name === "string" ? p.name : "Player",
 connected: !!p.connected,
 userId: typeof p.userId === "string" ? p.userId : null,
 }));
 }
 if (Array.isArray(lobby.signups)) {
 lobby.signups = lobby.signups.map((s) => ({
 userId: typeof s.userId === "string" ? s.userId : String(s.userId || ""),
 username: typeof s.username === "string" ? s.username : "Unknown",
 signedUpAt: typeof s.signedUpAt === "number" ? s.signedUpAt : Date.now(),
 }));
 }
 lobby.updatedAt = Date.now();
 try {
 await kv.set(["lobby", lobby.id], lobby);
 } catch (e) {
 console.warn("[Lobbies] Failed to update lobby:", e);
 }
}

export async function deleteLobby(lobbyId: string): Promise<void> {
 const lobby = await getLobby(lobbyId);
 if (!lobby) return;
 // Also delete signup records
 const signups = Array.isArray(lobby.signups) ? lobby.signups : [];
 for (const signup of signups) {
 await kv.delete(["signup", lobbyId, signup.userId]);
 }
 await kv.delete(["lobby", lobbyId]);
}

/**
 * Purge ALL lobbies and related data from the database.
 * Called on server startup to ensure a clean state.
 */
export async function purgeAllLobbies(): Promise<number> {
 let count = 0;
 // Delete all lobbies
 for await (const entry of kv.list({ prefix: ["lobby"] })) {
 await kv.delete(entry.key);
 count++;
 }
 // Delete all lobby-peer index entries
 for await (const entry of kv.list({ prefix: ["lobby-peer"] })) {
 await kv.delete(entry.key);
 }
 // Delete all signup records
 for await (const entry of kv.list({ prefix: ["signup"] })) {
 await kv.delete(entry.key);
 }
 // Delete all peer entries (phonebook)
 for await (const entry of kv.list({ prefix: ["peer"] })) {
 await kv.delete(entry.key);
 }
 // Delete all stored signals
 for await (const entry of kv.list({ prefix: ["signal"] })) {
 await kv.delete(entry.key);
 }
 return count;
}

export async function listLobbies(gameId?: string, includePrivate = false): Promise<Lobby[]> {
 const out: Lobby[] = [];
 const now = Date.now();
 for await (const entry of kv.list<Lobby>({ prefix: ["lobby"] })) {
 const lobby = entry.value;
 if (!lobby) continue;
 // Null-safe: old lobby entries may not have players array
 const players = Array.isArray(lobby.players) ? lobby.players : [];
 // Expire dead lobbies so they don't pile up:
 //  - empty waiting rooms after 30 min idle
 //  - any lobby idle for over 30 min (no writes at all)
 //  - matches that started more than 2h ago (long over)
 const lastActivity = Math.max(lobby.updatedAt || 0, lobby.createdAt || 0, lobby.startedAt || 0);
 if (lobby.status === "waiting" && players.length === 0 && now - (lobby.createdAt || 0) > LOBBY_TIMEOUT_MS) {
 await kv.delete(["lobby", lobby.id]);
 continue;
 }
 if (now - lastActivity > LOBBY_TIMEOUT_MS) {
 await kv.delete(["lobby", lobby.id]);
 continue;
 }
 if (lobby.status !== "waiting" && lobby.startedAt && now - lobby.startedAt > 2 * LOBBY_TIMEOUT_MS) {
 await kv.delete(["lobby", lobby.id]);
 continue;
 }
 if (gameId && lobby.gameId !== gameId) continue;
 if (!includePrivate && lobby.type === "private") continue;
 out.push(lobby);
 }
 // Sort: waiting first, then by recency
 out.sort((a, b) => {
 if (a.status === "waiting" && b.status !== "waiting") return -1;
 if (a.status !== "waiting" && b.status === "waiting") return 1;
 return (b.createdAt || 0) - (a.createdAt || 0);
 });
 return out;
}

// ─── Player Management ───────────────────────────────────────────────────────

export async function addPlayerToLobby(
 lobby: Lobby,
 player: PlayerSession,
): Promise<{ ok: boolean; reason?: string; lobby: Lobby }> {
 // Null-safe: ensure players array exists (old lobby entries may not have it)
 if (!Array.isArray(lobby.players)) lobby.players = [];
 if (!Array.isArray(lobby.signups)) lobby.signups = [];
 if (lobby.status !== "waiting") {
 return { ok: false, reason: "Lobby is not waiting for players", lobby };
 }
 if (lobby.players.find((p) => p.id === player.id)) {
 return { ok: true, lobby };
 }
 if (lobby.players.length >= (lobby.maxPlayers || 10)) {
 return { ok: false, reason: "Lobby is full", lobby };
 }
 lobby.players.push(player);
 if (lobby.hostId === null) {
 lobby.hostId = player.id;
 lobby.hostName = player.name;
 lobby.hostUserId = player.userId || null;
 }
 await updateLobby(lobby);
 return { ok: true, lobby };
}

export async function removePlayerFromLobby(
 lobby: Lobby,
 playerId: PlayerID,
): Promise<Lobby> {
 // Null-safe: ensure players array exists
 if (!Array.isArray(lobby.players)) lobby.players = [];
 lobby.players = lobby.players.filter((p) => p.id !== playerId);
 if (lobby.players.length === 0) {
 // Don't delete keep the lobby so others can still join via browser
 // But reset host if host left
 lobby.hostId = null;
 await updateLobby(lobby);
 return lobby;
 }
 // If host left, pick a new host
 if (lobby.hostId === playerId) {
 lobby.hostId = lobby.players[0]?.id || null;
 lobby.hostName = lobby.players[0]?.name || "Unknown";
 lobby.hostUserId = lobby.players[0]?.userId || null;
 }
 await updateLobby(lobby);
 return lobby;
}

// ─── Signups ─────────────────────────────────────────────────────────────────

export async function addSignup(lobby: Lobby, userId: UserID, username: string): Promise<{ ok: boolean; reason?: string; lobby: Lobby }> {
 // Null-safe: ensure signups array exists
 if (!Array.isArray(lobby.signups)) lobby.signups = [];
 if (lobby.type !== "signup") {
 return { ok: false, reason: "Lobby does not use signups", lobby };
 }
 if (lobby.signups.find((s) => s.userId === userId)) {
 return { ok: true, lobby }; // already signed up
 }
 if (lobby.signups.length >= (lobby.maxPlayers || 10)) {
 return { ok: false, reason: "Signups are full", lobby };
 }
 const entry: SignupEntry = {
 userId,
 username,
 signedUpAt: Date.now(),
 };
 lobby.signups.push(entry);
 await updateLobby(lobby);
 await kv.set(["signup", lobby.id, userId], entry);
 return { ok: true, lobby };
}

export async function removeSignup(lobby: Lobby, userId: UserID): Promise<Lobby> {
 if (!Array.isArray(lobby.signups)) lobby.signups = [];
 lobby.signups = lobby.signups.filter((s) => s.userId !== userId);
 await updateLobby(lobby);
 await kv.delete(["signup", lobby.id, userId]);
 return lobby;
}

// ─── Match Start ─────────────────────────────────────────────────────────────

export async function startLobbyMatch(lobby: Lobby): Promise<{ ok: boolean; reason?: string; lobby: Lobby }> {
 if (!Array.isArray(lobby.players)) lobby.players = [];
 if (lobby.status !== "waiting") {
 return { ok: false, reason: "Lobby is not in waiting state", lobby };
 }
 if (lobby.players.length < (lobby.minPlayers || 2)) {
 return { ok: false, reason: `Need at least ${lobby.minPlayers || 2} players`, lobby };
 }
 lobby.status = "starting";
 lobby.seed = generateSeed();
 lobby.p2pReadyCount = 0;
 lobby.startedAt = Date.now();
 await updateLobby(lobby);
 return { ok: true, lobby };
}

export async function endLobbyMatch(lobbyId: string): Promise<void> {
 const lobby = await getLobby(lobbyId);
 if (!lobby) return;
 lobby.status = "ended";
 lobby.players = [];
 lobby.hostId = null;
 lobby.p2pReadyCount = 0;
 await updateLobby(lobby);
 // Auto-delete ended lobbies after a short delay (caller can do this)
}

export async function resetLobbyToWaiting(lobbyId: string): Promise<Lobby | null> {
 const lobby = await getLobby(lobbyId);
 if (!lobby) return null;
 lobby.status = "waiting";
 lobby.seed = null;
 lobby.p2pReadyCount = 0;
 lobby.startedAt = null;
 await updateLobby(lobby);
 return lobby;
}

export { generateId, generateSeed, generateInviteCode, LOBBY_TIMEOUT_MS };
