/**
 * TournGames Server WebSocket Signaling Module (DHT Phonebook Architecture)
 *
 * The server acts as a PHONEBOOK only:
 * - Real-time signaling relay (offer/answer/ICE) via WebSocket
 * - Signaling store-and-forward via Deno KV (backup if WS drops)
 * - Peer directory via Deno KV (who's in which lobby)
 *
 * The server NEVER relays game state. All game traffic flows over the P2P mesh.
 * If P2P connections fail, peers use multi-hop mesh routing (peer-to-peer relay),
 * NOT server relay.
 *
 * Security: per-connection message rate limiting (60 msg/sec, 300 msg/10sec).
 */

import type { Lobby, PlayerSession } from "./types.ts";
import {
 getLobby,
 updateLobby,
 createLobby,
 addPlayerToLobby,
 removePlayerFromLobby,
 startLobbyMatch,
 resetLobbyToWaiting,
 listLobbies,
 generateId,
} from "./lobbies.ts";
import { getUserById, recordUserWin, recordUserMatch } from "./auth.ts";
import { rateLimit, sanitizeString, sanitizeLobbyName, auditLog } from "./security.ts";
import {
 registerPeer,
 unregisterPeer,
 heartbeatPeer,
 storeSignal,
 pollSignals,
} from "./phonebook.ts";

// ─── Connection State (in-memory) ────────────────────────────────────────────
// WebSocket connections are ONLY for signaling. Once P2P is established,
// the WS can be closed. Game state never touches the server.

export interface ConnectionInfo {
 lobbyId: string | null;
 ws: WebSocket;
 userId: string | null;
 username: string | null;
}

const connections = new Map<string, ConnectionInfo>();

export function getConnection(playerId: string): ConnectionInfo | undefined {
 return connections.get(playerId);
}

export function listConnectionsInLobby(lobbyId: string): ConnectionInfo[] {
 const out: ConnectionInfo[] = [];
 for (const info of connections.values()) {
 if (info.lobbyId === lobbyId) out.push(info);
 }
 return out;
}

export function removeConnection(playerId: string): void {
 connections.delete(playerId);
}

// ─── ICE config (shared) ─────────────────────────────────────────────────────
// Multiple STUN servers for redundancy. TURN servers can be added via
// the TURN_SERVER_URL / TURN_USERNAME / TURN_CREDENTIAL env vars for
// production deployments behind symmetric NATs.

function buildIceConfig() {
 const iceServers: any[] = [
 { urls: "stun:stun.l.google.com:19302" },
 { urls: "stun:stun1.l.google.com:19302" },
 { urls: "stun:stun2.l.google.com:19302" },
 { urls: "stun:stun3.l.google.com:19302" },
 ];

 const turnUrl = Deno.env.get("TURN_SERVER_URL");
 if (turnUrl) {
 const turnUser = Deno.env.get("TURN_USERNAME") || "";
 const turnCred = Deno.env.get("TURN_CREDENTIAL") || "";
 iceServers.push({
 urls: turnUrl,
 username: turnUser,
 credential: turnCred,
 });
 }

 return { iceServers };
}

export const ICE_CONFIG = buildIceConfig();

// ─── Send Helper ─────────────────────────────────────────────────────────────

function safeSend(ws: WebSocket | undefined | null, data: unknown): void {
 if (!ws) return;
 try {
 if (ws.readyState === WebSocket.OPEN) {
 // JSON.stringify can return undefined for undefined/functions/symbols
 const str = JSON.stringify(data);
 if (typeof str === "string") {
 ws.send(str);
 }
 }
 } catch (e) {
 console.warn("[WS] safeSend failed:", e);
 }
}

// ─── Message Handling ────────────────────────────────────────────────────────

export interface HandleContext {
 playerId: string;
 userId: string | null;
 username: string | null;
}

export async function handleWebSocketMessage(
 ws: WebSocket,
 ctx: HandleContext,
 raw: unknown,
): Promise<void> {
 // ── Rate limit: 60 msg/sec, 300 msg/10sec per connection ──
 const rlSec = rateLimit(`ws-msg:${ctx.playerId}`, 60, 1000);
 if (!rlSec.ok) {
 safeSend(ws, { type: "error", message: "Rate limit: too many messages" });
 return;
 }
 const rl10 = rateLimit(`ws-msg-10:${ctx.playerId}`, 300, 10 * 1000);
 if (!rl10.ok) {
 safeSend(ws, { type: "error", message: "Rate limit: too many messages (sustained)" });
 return;
 }

 let msg: any;
 try {
 msg = JSON.parse(typeof raw === "string" ? raw : "");
 } catch {
 safeSend(ws, { type: "error", message: "Invalid JSON" });
 return;
 }
 // Guard: msg must be a non-null object with a type field
 if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
 safeSend(ws, { type: "error", message: "Invalid message format" });
 return;
 }
 if (typeof msg.type !== "string" || msg.type.length === 0) {
 safeSend(ws, { type: "error", message: "Missing or invalid message type" });
 return;
 }

 const playerId = ctx.playerId;
 const info = connections.get(playerId);

 switch (msg.type) {
 // ── Lobby Browsing ─────────────────────────────────────────────────────
 case "list-lobbies": {
 const lobbies = await listLobbies(msg.gameId, false);
 safeSend(ws, { type: "lobby-list", lobbies: lobbies.map(lobbySummary) });
 break;
 }

 // ── Create Lobby ───────────────────────────────────────────────────────
 case "create-lobby": {
 // First leave current lobby if any
 if (info?.lobbyId) await leaveLobby(playerId);

 const lobbyName = sanitizeLobbyName(msg.name) || "Untitled Lobby";
 const gameId = sanitizeString(msg.gameId, 50) || "chess-royale";
 const hostName = sanitizeString(msg.hostName, 16) || ctx.username || "Host";
 const lobbyType = ["open", "signup", "private"].includes(msg.lobbyType) ? msg.lobbyType : "open";
 const parsedMax = parseInt(msg.maxPlayers, 10);
 const parsedMin = parseInt(msg.minPlayers, 10);
 const maxPlayers = !isNaN(parsedMax) ? Math.min(20, Math.max(2, parsedMax)) : 10;
 const minPlayers = !isNaN(parsedMin) ? Math.min(10, Math.max(2, parsedMin)) : 2;

 // Profanity check on lobby name and host name
 const { isProfane } = await import("./security.ts");
 if (await isProfane(lobbyName)) {
 safeSend(ws, { type: "error", message: "Lobby name contains inappropriate language" });
 return;
 }
 if (await isProfane(hostName)) {
 safeSend(ws, { type: "error", message: "Player name contains inappropriate language" });
 return;
 }

 const lobby = await createLobby({
 name: lobbyName,
 gameId,
 hostName,
 hostUserId: ctx.userId,
 type: lobbyType,
 maxPlayers,
 minPlayers,
 });

 // Auto-join as host
 const player: PlayerSession = {
 id: playerId,
 name: hostName,
 connected: true,
 userId: ctx.userId,
 };
 await addPlayerToLobby(lobby, player);
 connections.set(playerId, { lobbyId: lobby.id, ws, userId: ctx.userId, username: player.name });
 await registerPeer(playerId, lobby.id, player.name, ctx.userId);

 await auditLog({
 action: "lobby-created",
 actorId: ctx.userId,
 actorName: hostName,
 targetId: lobby.id,
 targetName: lobby.name,
 details: `type=${lobbyType}, max=${maxPlayers}`,
 });

 safeSend(ws, {
 type: "lobby-created",
 lobby,
 iceConfig: ICE_CONFIG,
 });
 // Also broadcast updated lobby list
 await broadcastLobbyList();
 break;
 }

 // ── Join Specific Lobby ────────────────────────────────────────────────
 case "join-specific": {
 if (info?.lobbyId) await leaveLobby(playerId);

 const lobby = await getLobby(sanitizeString(msg.lobbyId, 100));
 if (!lobby) {
 safeSend(ws, { type: "error", message: "Lobby not found" });
 return;
 }
 if (lobby.type === "private" && lobby.inviteCode && msg.inviteCode !== lobby.inviteCode) {
 safeSend(ws, { type: "error", message: "Invalid invite code" });
 return;
 }
 const playerName = sanitizeString(msg.playerName, 16) || ctx.username || "Player";
 const player: PlayerSession = {
 id: playerId,
 name: playerName,
 connected: true,
 userId: ctx.userId,
 };
 const res = await addPlayerToLobby(lobby, player);
 if (!res.ok) {
 safeSend(ws, { type: "error", message: res.reason || "Could not join lobby" });
 return;
 }
 connections.set(playerId, { lobbyId: lobby.id, ws, userId: ctx.userId, username: playerName });
 await registerPeer(playerId, lobby.id, playerName, ctx.userId);

 // Notify everyone (including newcomer) of the new player list
 await broadcastLobbyState(lobby.id, {
 type: "lobby-state",
 lobby: res.lobby,
 iceConfig: ICE_CONFIG,
 });
 await broadcastLobbyList();
 // Auto-start if min players reached (for open/private lobbies)
 await checkAutoStart(lobby.id);
 break;
 }

 // ── Quick Match (auto-find or create) ──────────────────────────────────
 case "join": {
 if (info?.lobbyId) await leaveLobby(playerId);

 const gameId = sanitizeString(msg.gameId, 50) || "chess-royale";
 const playerName = sanitizeString(msg.playerName, 16) || ctx.username || "Player";
 const player: PlayerSession = {
 id: playerId,
 name: playerName,
 connected: true,
 userId: ctx.userId,
 };

 // Find an open waiting lobby with space
 let lobby: Lobby | null = null;
 const candidates = await listLobbies(gameId, false);
 for (const c of candidates) {
 const cPlayers = Array.isArray(c.players) ? c.players : [];
 if (c.type === "open" && c.status === "waiting" && cPlayers.length < (c.maxPlayers || 10)) {
 lobby = c;
 break;
 }
 }
 if (!lobby) {
 // Create one
 lobby = await createLobby({
 name: `${playerName}'s Lobby`,
 gameId,
 hostName: playerName,
 hostUserId: ctx.userId,
 type: "open",
 maxPlayers: 10,
 minPlayers: 2,
 });
 }

 const res = await addPlayerToLobby(lobby, player);
 if (!res.ok) {
 safeSend(ws, { type: "error", message: res.reason || "Could not join lobby" });
 return;
 }
 connections.set(playerId, { lobbyId: lobby.id, ws, userId: ctx.userId, username: playerName });
 await registerPeer(playerId, lobby.id, playerName, ctx.userId);
 await broadcastLobbyState(lobby.id, {
 type: "lobby-state",
 lobby: res.lobby,
 iceConfig: ICE_CONFIG,
 });
 await broadcastLobbyList();
 // Auto-start if min players reached (for open/private lobbies)
 await checkAutoStart(lobby.id);
 break;
 }

 // ── Leave Lobby ────────────────────────────────────────────────────────
 case "leave-lobby": {
 await leaveLobby(playerId);
 safeSend(ws, { type: "left-lobby" });
 await broadcastLobbyList();
 break;
 }

 // ── Start Match (host triggers early) ──────────────────────────────────
 case "start-match": {
 if (!info?.lobbyId) return;
 const lobby = await getLobby(info.lobbyId);
 if (!lobby) return;
 // Only host or signup-creator can start
 const isHost = lobby.hostId === playerId ||
 (lobby.hostUserId && lobby.hostUserId === ctx.userId);
 if (!isHost) {
 safeSend(ws, { type: "error", message: "Only the host can start the match" });
 return;
 }
 const res = await startLobbyMatch(lobby);
 if (!res.ok) {
 safeSend(ws, { type: "error", message: res.reason || "Could not start match" });
 return;
 }
 // Notify all players
 await broadcastLobbyState(lobby.id, {
 type: "game-start",
 lobbyId: lobby.id,
 seed: lobby.seed,
 players: lobby.players,
 hostId: lobby.hostId,
 gameModule: lobby.gameId,
 iceConfig: ICE_CONFIG,
 });
 await broadcastLobbyList();
 break;
 }

 // ── WebRTC Signaling Relay (real-time via WS + store-and-forward via KV) ──
 // The server relays offer/answer/ICE in real-time via WS, AND stores them
 // in KV so peers can retrieve them if their WS drops mid-negotiation.
 case "offer":
 case "answer":
 case "ice-candidate": {
 // Store in KV (phonebook backup)
 await storeSignal(msg.to, playerId, msg.type, msg.data);
 // Relay in real-time via WS
 const target = connections.get(msg.to);
 if (target) {
 safeSend(target.ws, {
 type: msg.type,
 from: playerId,
 to: msg.to,
 data: msg.data,
 });
 }
 break;
 }

 // ── Poll Signals (KV store-and-forward retrieval) ──────────────────────
 // A peer that reconnected or missed WS messages can poll for pending signals.
 case "poll-signals": {
 const signals = await pollSignals(playerId);
 safeSend(ws, { type: "signals", signals });
 break;
 }

 // ── Peer Heartbeat (keep phonebook entry alive) ────────────────────────
 case "heartbeat": {
 await heartbeatPeer(playerId);
 safeSend(ws, { type: "heartbeat-ack" });
 break;
 }

 // ── P2P Ready Notification ─────────────────────────────────────────────
 case "p2p-ready": {
 if (!info?.lobbyId) return;
 const lobby = await getLobby(info.lobbyId);
 if (!lobby) return;
 const fresh = await getLobby(lobby.id);
 if (!fresh) return;
 fresh.p2pReadyCount = (fresh.p2pReadyCount || 0) + 1;
 await updateLobby(fresh);
 const freshPlayers = Array.isArray(fresh.players) ? fresh.players : [];
 if (fresh.p2pReadyCount >= freshPlayers.length && freshPlayers.length >= 2) {
 await broadcastLobbyState(fresh.id, {
 type: "p2p-connected",
 hostId: fresh.hostId,
 });
 }
 break;
 }

 // ── Match-Over (stats recording only no game-state relay) ────────────
 // The host reports the match result so the server can update user stats.
 // Game-over is communicated to clients via the P2P mesh, not via the server.
 case "match-over": {
 if (!info?.lobbyId) return;
 const lobby = await getLobby(info.lobbyId);
 if (lobby) {
 const lobbyPlayers = Array.isArray(lobby.players) ? lobby.players : [];
 const winner = lobbyPlayers.find((p) => p.id === msg.winner);
 if (winner?.userId) {
 await recordUserWin(winner.userId);
 }
 for (const p of lobbyPlayers) {
 if (p.userId && p.userId !== winner?.userId) {
 await recordUserMatch(p.userId);
 }
 }
 }
 safeSend(ws, { type: "match-over-ack" });
 // Reset lobby to waiting after match
 setTimeout(async () => {
 if (info.lobbyId) {
 await resetLobbyToWaiting(info.lobbyId);
 await broadcastLobbyList();
 }
 }, 5000);
 break;
 }

 // ── Submit Replay (LEGACY) ─────────────────────────────────────────────
 // As of v0.4, replays are stored LOCALLY in the player's browser
 // (localStorage). The frontend no longer sends this message. We keep
 // the handler for backward compatibility with older clients that might
 // still send it, but it's a no-op acknowledgement  nothing is stored
 // server-side anymore.
 case "submit-replay": {
 safeSend(ws, { type: "replay-ack", replayId: msg.replay?.replayId || "" });
 break;
 }

 default:
 console.warn(`[WS] Unknown message type: ${msg.type}`);
 safeSend(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
 }
}

// ─── Lobby Leave Helper ──────────────────────────────────────────────────────

async function leaveLobby(playerId: string): Promise<void> {
 const info = connections.get(playerId);
 if (!info?.lobbyId) return;
 const lobby = await getLobby(info.lobbyId);
 if (lobby) {
 await removePlayerFromLobby(lobby, playerId);
 await broadcastLobbyState(lobby.id, {
 type: "lobby-state",
 lobby: await getLobby(lobby.id),
 iceConfig: ICE_CONFIG,
 });
 }
 // Remove from phonebook
 await unregisterPeer(playerId);
 connections.set(playerId, { ...info, lobbyId: null });
}

// ─── Broadcast Helpers ───────────────────────────────────────────────────────

async function broadcastLobbyState(lobbyId: string, payload: unknown): Promise<void> {
 const conns = listConnectionsInLobby(lobbyId);
 for (const c of conns) safeSend(c.ws, payload);
}

async function broadcastLobbyList(): Promise<void> {
 const lobbies = await listLobbies(undefined, false);
 const summary = lobbies.map(lobbySummary);
 // Send to ALL connected clients (even those not in a lobby) so the browser updates
 for (const info of connections.values()) {
 safeSend(info.ws, { type: "lobby-list", lobbies: summary });
 }
}

// ─── Lobby Summary (for browser view) ────────────────────────────────────────

function lobbySummary(lobby: Lobby) {
 // Null-safe access older lobby entries in KV may not have all fields
 // (e.g. `signups` was added in a later version, `players` could be undefined
 // if the lobby was created before the schema was finalized).
 const players = Array.isArray(lobby.players) ? lobby.players : [];
 const signups = Array.isArray(lobby.signups) ? lobby.signups : [];
 return {
 id: lobby.id,
 name: lobby.name || "Untitled Lobby",
 gameId: lobby.gameId || "chess-royale",
 type: lobby.type || "open",
 status: lobby.status || "waiting",
 playerCount: players.length,
 signupCount: signups.length,
 maxPlayers: lobby.maxPlayers || 10,
 minPlayers: lobby.minPlayers || 2,
 hostName: lobby.hostName || "Unknown",
 createdAt: lobby.createdAt || Date.now(),
 seed: lobby.status === "starting" || lobby.status === "playing" ? lobby.seed : null,
 hasInviteCode: !!lobby.inviteCode,
 };
}

// ─── Auto-Start Watcher ──────────────────────────────────────────────────────
// DISABLED: The host must manually click "Start match" to begin the game.
// This function is kept for compatibility but does nothing the host
// controls when the match starts via the "start-match" WebSocket message.

export async function checkAutoStart(lobbyId: string): Promise<void> {
 // No-op host must manually start the match
 return;
}

// ─── Connection Cleanup ──────────────────────────────────────────────────────

export async function handleWebSocketClose(playerId: string): Promise<void> {
 await leaveLobby(playerId);
 removeConnection(playerId);
 await broadcastLobbyList();
}

// Re-export for use by mod.ts
export { connections };
