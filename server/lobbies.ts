/**
 * TournGames Server Lobbies & Signups Module
 *
 * CRUD for lobbies, signup management, and lobby listing.
 * Backed by Deno KV.
 */

import type { Lobby, PlayerSession, SignupEntry, LobbyType, PlayerID, UserID } from "./types.ts";

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
 let safeMin = typeof opts.minPlayers === "number" && !isNaN(opts.minPlayers)
 ? Math.min(10, Math.max(2, Math.floor(opts.minPlayers))) : 2;
 // min > max would create a lobby that can never start (start demands more
 // players than may ever join) and lingers until the stale sweep.
 if (safeMin > safeMax) safeMin = safeMax;
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

// Defensive: ensure players and signups are clean arrays of plain objects
function normalizeLobbyForWrite(lobby: Lobby): void {
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
}

export async function updateLobby(lobby: Lobby): Promise<void> {
 normalizeLobbyForWrite(lobby);
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

// Retries for optimistic-concurrency conflicts on lobby writes.
const LOBBY_WRITE_RETRIES = 3;

type LobbyMutationOutcome = {
 /** Validation result of the mutation itself. */
 ok: boolean;
 reason?: string;
 /** Whether the mutation produced a change that must be persisted. */
 write: boolean;
};

/**
 * Run a lobby mutation atomically against fresh KV state.
 *
 * Each attempt fetches the current entry, applies `mutate` to a copy of it
 * (so capacity/duplicate checks are re-verified on live data, not a stale
 * snapshot), then commits with a versionstamp check via kv.atomic(). On
 * commit conflict the loop retries with a fresh get, up to
 * {@link LOBBY_WRITE_RETRIES} times.
 *
 * The caller-supplied `lobby` is only used as a fallback when the entry has
 * vanished from KV between the caller's read and now (legacy behavior:
 * mutate and plain-set). Return contract matches the old functions so
 * callers checking ok/reason are unaffected.
 */
async function mutateLobbyAtomically(
 lobby: Lobby,
 mutate: (fresh: Lobby) => LobbyMutationOutcome,
): Promise<{ ok: boolean; reason?: string; lobby: Lobby }> {
 const key = ["lobby", lobby.id];
 let lastSnapshot = lobby;
 for (let attempt = 0; attempt < LOBBY_WRITE_RETRIES; attempt++) {
 const entry = await kv.get<Lobby>(key);
 const current = entry.value;
 if (!current) {
 // Entry gone (e.g. swept between reads): fall back to legacy path.
 const outcome = mutate(lobby);
 if (!outcome.write) return { ok: outcome.ok, reason: outcome.reason, lobby };
 await updateLobby(lobby);
 return { ok: outcome.ok, reason: outcome.reason, lobby };
 }
 lastSnapshot = current;
 const candidate: Lobby = structuredClone(current);
 normalizeLobbyForWrite(candidate);
 const outcome = mutate(candidate);
 if (!outcome.ok || !outcome.write) {
 return { ok: outcome.ok, reason: outcome.reason, lobby: current };
 }
 candidate.updatedAt = Date.now();
 normalizeLobbyForWrite(candidate);
 const res = await kv.atomic()
 .check({ key, versionstamp: entry.versionstamp })
 .set(key, candidate)
 .commit();
 if (res.ok) return { ok: true, lobby: candidate };
 // Version conflict → someone else wrote; retry on a fresh snapshot.
 }
 return {
 ok: false,
 reason: "Lobby was modified concurrently, please retry",
 lobby: lastSnapshot,
 };
}

export async function addPlayerToLobby(
 lobby: Lobby,
 player: PlayerSession,
): Promise<{ ok: boolean; reason?: string; lobby: Lobby }> {
 return await mutateLobbyAtomically(lobby, (fresh) => {
 // Null-safe: ensure players array exists (old lobby entries may not have it)
 if (!Array.isArray(fresh.players)) fresh.players = [];
 if (!Array.isArray(fresh.signups)) fresh.signups = [];
 if (fresh.status !== "waiting") {
 return { ok: false, reason: "Lobby is not waiting for players", write: false };
 }
 if (fresh.players.find((p) => p.id === player.id)) {
 return { ok: true, write: false }; // already joined — idempotent
 }
 // Capacity is checked INSIDE the transaction data, closing the
 // two-concurrent-joins-overfill race.
 if (fresh.players.length >= (fresh.maxPlayers || 10)) {
 return { ok: false, reason: "Lobby is full", write: false };
 }
 fresh.players.push(player);
 if (fresh.hostId === null) {
 fresh.hostId = player.id;
 fresh.hostName = player.name;
 fresh.hostUserId = player.userId || null;
 }
 return { ok: true, write: true };
 });
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
 let addedEntry: SignupEntry | null = null;
 const result = await mutateLobbyAtomically(lobby, (fresh) => {
 // Null-safe: ensure signups array exists
 if (!Array.isArray(fresh.signups)) fresh.signups = [];
 if (fresh.type !== "signup") {
 return { ok: false, reason: "Lobby does not use signups", write: false };
 }
 if (fresh.signups.find((s) => s.userId === userId)) {
 return { ok: true, write: false }; // already signed up — idempotent
 }
 // Capacity is re-verified inside the transaction data.
 if (fresh.signups.length >= (fresh.maxPlayers || 10)) {
 return { ok: false, reason: "Signups are full", write: false };
 }
 addedEntry = { userId, username, signedUpAt: Date.now() };
 fresh.signups.push(addedEntry);
 return { ok: true, write: true };
 });
 // Only persist the signup index row once the lobby mutation actually
 // committed (avoids orphan index rows on conflict/full/duplicate).
 if (result.ok && addedEntry) {
 const entry: SignupEntry = addedEntry;
 await kv.set(["signup", lobby.id, userId], entry);
 }
 return result;
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
 return await mutateLobbyAtomically(lobby, (fresh) => {
 if (!Array.isArray(fresh.players)) fresh.players = [];
 if (fresh.status !== "waiting") {
 return { ok: false, reason: "Lobby is not in waiting state", write: false };
 }
 // Player count re-checked inside the transaction data so a concurrent
 // leave cannot strand a started match below minPlayers.
 if (fresh.players.length < (fresh.minPlayers || 2)) {
 return { ok: false, reason: `Need at least ${fresh.minPlayers || 2} players`, write: false };
 }
 fresh.status = "starting";
 fresh.seed = generateSeed();
 fresh.p2pReadyCount = 0;
 // New match: clear the previous match's bookkeeping so its recorded-result
 // guard and stale ready flags cannot suppress the next report.
 fresh.resultRecorded = false;
 fresh.p2pReady = {};
 fresh.startedAt = Date.now();
 return { ok: true, write: true };
 });
}

export async function resetLobbyToWaiting(lobbyId: string): Promise<Lobby | null> {
 const lobby = await getLobby(lobbyId);
 if (!lobby) return null;
 const result = await mutateLobbyAtomically(lobby, (fresh) => {
 fresh.status = "waiting";
 fresh.seed = null;
 fresh.p2pReadyCount = 0;
 fresh.startedAt = null;
 return { ok: true, write: true };
 });
 return result.lobby;
}
