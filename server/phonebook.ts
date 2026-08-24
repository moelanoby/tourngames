/**
 * TournGames Server Phonebook Module (DHT-style)
 *
 * Deno KV acts as a distributed phonebook for P2P peer discovery and
 * signaling message store-and-forward. The server NEVER relays game state 
 * all game traffic flows directly over the P2P mesh.
 *
 * Responsibilities:
 * 1. Peer registration: when a peer joins a lobby, store their info in KV
 * so other peers can discover them.
 * 2. Signaling store-and-forward: offer/answer/ICE candidates are stored
 * in KV so peers can retrieve them even if the WebSocket drops.
 * 3. Lobby roster: authoritative list of peers in each lobby.
 *
 * The server is NOT involved in game-state relay. Once P2P connections are
 * established, the server steps back entirely.
 */

const kv = await Deno.openKv();

const PEER_TTL_MS = 2 * 60 * 1000; // 2 minutes
const SIGNAL_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SIGNAL_MAX_PER_PEER = 50;

// Monotonic counter for signal sequence numbers. Used as a tiebreaker
// when two signals are stored within the same millisecond (which would
// otherwise make their createdAt values identical and the sort order
// non-deterministic). In production this matters because offer/answer
// messages MUST be delivered before ICE candidates for WebRTC to work.
let _signalSeq = 0;

// ─── Peer Registration ───────────────────────────────────────────────────────

export interface PeerEntry {
 playerId: string;
 lobbyId: string;
 username: string | null;
 userId: string | null;
 registeredAt: number;
 lastSeen: number;
}

export async function registerPeer(
 playerId: string,
 lobbyId: string,
 username: string | null,
 userId: string | null,
): Promise<void> {
 // Defensive: ensure all fields are serializable (strings or null)
 const safePlayerId = typeof playerId === "string" ? playerId : String(playerId || "");
 const safeLobbyId = typeof lobbyId === "string" ? lobbyId : String(lobbyId || "");
 const safeUsername = typeof username === "string" ? username : null;
 const safeUserId = typeof userId === "string" ? userId : null;

 // If the peer was already registered (e.g., browser refresh, reconnect),
 // preserve the original `registeredAt` so the entry reflects when the
 // player FIRST joined, not the latest reconnect. Without this, every
 // refresh would reset the registration time, which is misleading.
 const existing = await kv.get<PeerEntry>(["peer", safePlayerId]);
 const registeredAt = existing.value?.registeredAt ?? Date.now();

 const entry: PeerEntry = {
 playerId: safePlayerId,
 lobbyId: safeLobbyId,
 username: safeUsername,
 userId: safeUserId,
 registeredAt,
 lastSeen: Date.now(),
 };
 try {
 // Store by player ID
 await kv.set(["peer", safePlayerId], entry, { expireIn: PEER_TTL_MS });
 // Index by lobby (for roster queries)
 await kv.set(["lobby-peer", safeLobbyId, safePlayerId], entry, { expireIn: PEER_TTL_MS });
 } catch (e) {
 console.warn("[Phonebook] Failed to register peer:", e);
 }
}

export async function heartbeatPeer(playerId: string): Promise<void> {
 const res = await kv.get<PeerEntry>(["peer", playerId]);
 if (!res.value) return;
 res.value.lastSeen = Date.now();
 await kv.set(["peer", playerId], res.value, { expireIn: PEER_TTL_MS });
 await kv.set(["lobby-peer", res.value.lobbyId, playerId], res.value, { expireIn: PEER_TTL_MS });
}

export async function unregisterPeer(playerId: string): Promise<void> {
 const res = await kv.get<PeerEntry>(["peer", playerId]);
 if (res.value) {
 await kv.delete(["lobby-peer", res.value.lobbyId, playerId]);
 }
 await kv.delete(["peer", playerId]);
 // Clean up pending signals
 for await (const entry of kv.list({ prefix: ["signal", playerId] })) {
 await kv.delete(entry.key);
 }
}

export async function getLobbyPeers(lobbyId: string): Promise<PeerEntry[]> {
 const out: PeerEntry[] = [];
 for await (const entry of kv.list<PeerEntry>({ prefix: ["lobby-peer", lobbyId] })) {
 if (entry.value) out.push(entry.value);
 }
 return out;
}

// ─── Signaling Store-and-Forward ─────────────────────────────────────────────

export interface SignalEntry {
 id: string;
 targetId: string; // target player ID
 fromId: string; // sending player ID
 type: "offer" | "answer" | "ice-candidate";
 data: unknown;
 createdAt: number;
 // Monotonic sequence number for deterministic ordering when two
 // signals share the same createdAt millisecond. Offer/answer messages
 // MUST be delivered before ICE candidates for WebRTC to work.
 seq: number;
}

/**
 * Store a signaling message for a target peer.
 * The target peer can retrieve it via pollSignals().
 * Also used as a backup when WS relay fails.
 */
export async function storeSignal(
 targetId: string,
 fromId: string,
 type: "offer" | "answer" | "ice-candidate",
 data: unknown,
): Promise<string> {
 const id = crypto.randomUUID();

 // Defensive: sanitize data to ensure it's KV-serializable.
 // Deno KV rejects undefined, functions, symbols, and circular references.
 // We try JSON round-trip; if it fails, store null.
 let safeData: unknown = data;
 try {
 const json = JSON.stringify(data);
 safeData = json === undefined ? null : JSON.parse(json);
 } catch {
 safeData = null;
 }

 const entry: SignalEntry = {
 id,
 targetId: typeof targetId === "string" ? targetId : String(targetId || ""),
 fromId: typeof fromId === "string" ? fromId : String(fromId || ""),
 type,
 data: safeData,
 createdAt: Date.now(),
 seq: ++_signalSeq,
 };
 try {
 await kv.set(["signal", entry.targetId, id], entry, { expireIn: SIGNAL_TTL_MS });
 } catch (e) {
 console.warn("[Phonebook] Failed to store signal:", e);
 return id;
 }

 // Trim old signals if too many (prevent unbounded growth)
 const signals: Array<{ key: Deno.KvKey; createdAt: number }> = [];
 for await (const sig of kv.list<SignalEntry>({ prefix: ["signal", entry.targetId] })) {
 if (sig.value) signals.push({ key: sig.key, createdAt: sig.value.createdAt });
 }
 if (signals.length > SIGNAL_MAX_PER_PEER) {
 signals.sort((a, b) => a.createdAt - b.createdAt);
 const toDelete = signals.slice(0, signals.length - SIGNAL_MAX_PER_PEER);
 for (const s of toDelete) {
 await kv.delete(s.key);
 }
 }

 return id;
}

/**
 * Retrieve (and delete) all pending signals for a peer.
 * Called when a peer reconnects or polls for missed signals.
 */
export async function pollSignals(targetId: string): Promise<SignalEntry[]> {
 const out: SignalEntry[] = [];
 for await (const entry of kv.list<SignalEntry>({ prefix: ["signal", targetId] })) {
 if (entry.value) out.push(entry.value);
 await kv.delete(entry.key); // consume on read
 }
 // Sort by createdAt first, then by seq as a tiebreaker for signals
 // stored within the same millisecond. This ensures deterministic
 // ordering (offer before ICE candidates, etc.) even under tight timing.
 return out.sort((a, b) => {
 if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
 return (a.seq ?? 0) - (b.seq ?? 0);
 });
}

