/**
 * app.js - TournGames Frontend Application (v0.3)
 *
 * Core orchestrator: SPA routing, WebSocket signaling, WebRTC P2P,
 * host-authoritative game loop, game module loader, elimination overlay.
 *
 * v0.3 additions:
 * - CSRF token management for all state-changing requests
 * - Admin panel routing (conditional on user role)
 * - Banned user handling
 * - Redesigned UI with warm minimal aesthetic
 *
 * v0.2 features:
 * - WebSocket game-state relay fallback (when P2P fails)
 * - Auth integration (login/register/logout)
 * - Lobby browser: list/create/join specific lobbies
 * - Signups: reserve slots in signup-type lobbies
 */

import * as auth from "/ui/auth.js";
import * as fb from "/ui/firebase.js";
import * as lobbies from "/ui/lobbies.js";
import * as admin from "/ui/admin.js";
import {
 saveLocalReplay,
 loadLocalReplays,
 renameLocalReplay,
} from "/ui/local-archive.js";

// ─── Polyfills ───────────────────────────────────────────────────────────────

if (!CanvasRenderingContext2D.prototype.roundRect) {
 CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
 const rad = Array.isArray(r) ? r : [r, r, r, r];
 this.beginPath();
 this.moveTo(x + rad[0], y);
 this.lineTo(x + w - 1 - rad[1], y);
 this.quadraticCurveTo(x + w, y, x + w, y + rad[1]);
 this.lineTo(x + w, y + h - rad[2]);
 this.quadraticCurveTo(x + w, y + h, x + w - rad[3], y + h);
 this.lineTo(x + rad[3], y + h);
 this.quadraticCurveTo(x, y + h, x, y + h - rad[2]);
 this.lineTo(x, y + rad[0]);
 this.quadraticCurveTo(x, y, x + rad[0], y);
 this.closePath();
 };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TICK_RATE_MS = 16.67;
const P2P_TIMEOUT_MS = 4000; // Fallback: start game via WS relay after 4s if P2P not ready
const ICE_CONFIG_DEFAULT = {
 iceServers: [
 { urls: "stun:stun.l.google.com:19302" },
 { urls: "stun:stun1.l.google.com:19302" },
 ],
};

const WS_URL =
 (window.location.protocol === "https:" ? "wss" : "ws") +
 "://" +
 window.location.host +
 "/ws";

const PLAYER_COLORS = [
 "#fbbf24", "#f87171", "#60a5fa", "#34d399",
 "#a78bfa", "#fb7185", "#22d3ee", "#facc15",
 "#c084fc", "#86efac",
];

// ─── DOM Cache ───────────────────────────────────────────────────────────────

const dom = {
 // Nav (using data-section attributes now)
 navLinks: document.querySelectorAll(".nav-link"),
 navAdmin: document.querySelector(".nav-link-admin"),
 sectionGame: document.getElementById("section-game"),
 sectionLobbies: document.getElementById("section-lobbies"),
 sectionArchive: document.getElementById("section-archive"),
 sectionAdmin: document.getElementById("section-admin"),
 sectionPatreon: document.getElementById("section-patreon"),

 // Lobby screen
 findMatchBtn: document.getElementById("find-match-btn"),
 playSoloBtn: document.getElementById("play-solo-btn"),
 findMatchScreen: document.getElementById("find-match-screen"),
 usernameScreen: document.getElementById("username-screen"),
 usernameInput: document.getElementById("username-input"),
 setUsernameBtn: document.getElementById("set-username-btn"),
 usernameError: document.getElementById("username-error"),
 lobbyWait: document.getElementById("lobby-wait"),
 lobbyNameDisplay: document.getElementById("lobby-name-display"),
 playerList: document.getElementById("player-list"),
 lobbyStatus: document.getElementById("lobby-status"),
 lobbyCount: document.getElementById("lobby-count"),
 leaveLobbyBtn: document.getElementById("leave-lobby-btn"),
 startMatchBtn: document.getElementById("start-match-btn"),

 // Game screen
 gameScreen: document.getElementById("game-screen"),
 gameCanvas: document.getElementById("game-canvas"),
 gameWrapper: document.getElementById("game-canvas-wrapper"),
 eliminationOverlay: document.getElementById("elimination-overlay"),
 viewReplayBtn: document.getElementById("view-replay-btn"),
 backToLobbyBtn: document.getElementById("back-to-lobby-btn"),

 // Archive
 replayList: document.getElementById("replay-list"),
 replayViewer: document.getElementById("replay-viewer"),
 replayTitle: document.getElementById("replay-title"),

 // Loading / toast
 loadingOverlay: document.getElementById("loading-overlay"),
 loadingBar: document.getElementById("loading-bar"),
 loadingText: document.getElementById("loading-text"),
 playerInfo: document.getElementById("player-info"),
 toastContainer: document.getElementById("toast-container"),
};

// ─── App State ───────────────────────────────────────────────────────────────

const state = {
 playerId: null,
 playerName: null,
 userId: null, // set if logged in
 isAdmin: false, // set if user role === "admin"
 csrfToken: null, // CSRF token for state-changing requests
 gameModule: null,
 gameConfig: null,
 hostId: null,
 players: [],
 seed: null,
 gameId: null,
 isHost: false,
 matchStartTime: null,
 signalingSocket: null,
 p2pClient: null,
 gameState: null,
 tick: 0,
 gameInterval: null,
 renderFrameId: null,
 keys: new Set(),
 recordedInputs: {},
 pendingInputs: {},
 eliminated: false,
 matchEnded: false,
 p2pConnected: false,
 relayActive: false, // true when WS relay is being used as fallback
 currentSection: "game",
 currentLobbyId: null,
 iceConfig: ICE_CONFIG_DEFAULT,
 gameStarted: false,
 p2pFallbackTimer: null,
};

// expose for other modules
window.__tgn_state = state;
window.__tgn_playerName = null;
window.__tgn_user = null;
window.__tgn_showToast = showToast;

// ─── Utilities ───────────────────────────────────────────────────────────────

function generateId() {
 if (typeof crypto !== "undefined" && crypto.randomUUID) {
 return crypto.randomUUID();
 }
 return "player_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function generateName() {
 const adjs = ["Swift", "Deadly", "Clever", "Fierce", "Sneaky", "Brave", "Cold", "Sharp"];
 const nouns = ["Hawk", "Fox", "Wolf", "Eagle", "Panther", "Raven", "Tiger", "Cobra"];
 return adjs[Math.floor(Math.random() * adjs.length)] + " " +
 nouns[Math.floor(Math.random() * nouns.length)] + " " +
 (Math.floor(Math.random() * 900) + 100);
}

function initPlayer() {
 const stored = { id: localStorage.getItem("tgn_playerId"), name: localStorage.getItem("tgn_playerName") };
 if (!stored.id) stored.id = generateId();
 state.playerId = stored.id;

 if (!stored.name) {
 showUsernameScreen();
 return;
 }

 state.playerName = stored.name;
 localStorage.setItem("tgn_playerId", state.playerId);
 localStorage.setItem("tgn_playerName", state.playerName);
 window.__tgn_playerName = state.playerName;
 dom.playerInfo.textContent = state.playerName;
 hideUsernameScreen();
}

// ─── Profanity Filter (kept from v0.1) ───────────────────────────────────────

const LEET_MAP = {
 '4': 'a', '@': 'a', '8': 'b', '(': 'c', '<': 'c', '[': 'c', '{': 'c',
 '3': 'e', '!': 'i', '1': 'i', '|': 'i', '0': 'o', '$': 's', '5': 's',
 'z': 's', '7': 't', '+': 't', '9': 'g', '6': 'g',
 '`': 't', '\'': '', '"': '',
};

const BANNED_ROOTS = [
 'fuck', 'shit', 'piss', 'cunt', 'cock', 'dick', 'ass', 'bitch', 'whore', 'slut',
 'nigger', 'nigga', 'fag', 'faggot', 'retard', 'kike', 'chink', 'spic', 'gook',
 'cum', 'jizz', 'rape', 'pedo', 'pedophile', 'nazi', 'hitler', 'kkk',
 'bastard', 'bollocks', 'bugger', 'clit', 'crap', 'damn', 'dildo', 'dyke',
 'felch', 'gay', 'homo', 'horny', 'jerk', 'masturbate', 'muff', 'nob',
 'orgasm', 'penis', 'phallus', 'porn', 'prick', 'pube', 'pussy', 'queer',
 'rimjob', 'scrotum', 'sex', 'shemale', 'skank', 'snatch', 'sodomy', 'spunk',
 'suck', 'tard', 'testicle', 'tit', 'tits', 'twat', 'vagina', 'wank', 'wanker',
];

function normalizeForFilter(text) {
 let out = '';
 for (const ch of text.toLowerCase()) {
 const mapped = LEET_MAP[ch];
 if (mapped) out += mapped;
 else if (/[a-z0-9]/.test(ch)) out += ch;
 }
 return out;
}

function isInappropriate(text) {
 if (!text || text.length < 3) return false;
 const norm = normalizeForFilter(text);
 for (const root of BANNED_ROOTS) {
 if (norm.includes(root)) return true;
 }
 return false;
}

function validateUsername(name) {
 name = name.trim();
 if (name.length < 3) return { ok: false, msg: "Too short (min 3 chars)" };
 if (name.length > 16) return { ok: false, msg: "Too long (max 16 chars)" };
 if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return { ok: false, msg: "Only letters, numbers, _ and -" };
 if (isInappropriate(name)) return { ok: false, msg: "Inappropriate" };
 return { ok: true };
}

function showUsernameScreen() {
 dom.usernameScreen.classList.remove("hidden");
 dom.findMatchScreen.classList.add("hidden");
 dom.usernameInput.value = "";
 dom.usernameError.classList.add("hidden");
 dom.usernameInput.focus();
}

function hideUsernameScreen() {
 dom.usernameScreen.classList.add("hidden");
 dom.findMatchScreen.classList.remove("hidden");
}

function setUsername() {
 const name = dom.usernameInput.value.trim();
 const result = validateUsername(name);
 if (!result.ok) {
 dom.usernameError.textContent = result.msg;
 dom.usernameError.classList.remove("hidden");
 dom.usernameInput.focus();
 return;
 }
 state.playerName = name;
 localStorage.setItem("tgn_playerName", state.playerName);
 window.__tgn_playerName = state.playerName;
 dom.playerInfo.textContent = state.playerName;
 hideUsernameScreen();
}

function changeUsername() {
 showUsernameScreen();
 dom.usernameInput.value = state.playerName;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function showToast(message, type) {
 type = type || "info";
 const toast = document.createElement("div");
 const typeMap = {
 info: "border-gold text-gold",
 error: "border-danger text-danger",
 success: "border-ok text-ok",
 warning: "border-yellow-400 text-yellow-400",
 };
 toast.className =
 "mb-3 px-4 py-3 rounded border text-sm font-mono pointer-events-auto slide-up " + (typeMap[type] || typeMap.info);
 toast.textContent = message;
 dom.toastContainer.appendChild(toast);
 setTimeout(() => {
 if (toast.parentNode) {
 toast.style.transition = "opacity 0.3s";
 toast.style.opacity = "0";
 setTimeout(() => toast.parentNode && toast.parentNode.removeChild(toast), 300);
 }
 }, 4500);
}

// ─── Loading Overlay ─────────────────────────────────────────────────────────

function showLoading(text) {
 dom.loadingText.textContent = text || "loading...";
 dom.loadingBar.style.width = "0%";
 dom.loadingOverlay.classList.remove("hidden");
 dom.loadingOverlay.style.display = "flex";
 dom.loadingOverlay._startTime = Date.now();
 dom.loadingOverlay._barInterval = setInterval(() => {
 const elapsed = (Date.now() - dom.loadingOverlay._startTime) / 1000;
 const progress = Math.min(90, Math.log10(elapsed * 3 + 1) * 45);
 dom.loadingBar.style.width = progress + "%";
 }, 100);
}

function setLoadingText(text) {
 dom.loadingText.textContent = text;
}

function hideLoading() {
 if (dom.loadingOverlay._barInterval) {
 clearInterval(dom.loadingOverlay._barInterval);
 dom.loadingOverlay._barInterval = null;
 }
 let p = 90;
 const finishInterval = setInterval(() => {
 p = Math.min(100, p + 4);
 dom.loadingBar.style.width = p + "%";
 if (p >= 100) clearInterval(finishInterval);
 }, 30);
 setTimeout(() => {
 dom.loadingOverlay.classList.add("hidden");
 dom.loadingOverlay.style.display = "none";
 dom.loadingBar.style.width = "0%";
 }, 500);
}

// ─── Router ──────────────────────────────────────────────────────────────────

function showSection(section) {
 const sections = {
 game: dom.sectionGame,
 lobbies: dom.sectionLobbies,
 archive: dom.sectionArchive,
 admin: dom.sectionAdmin,
 patreon: dom.sectionPatreon,
 };

 // Guard: don't show admin section to non-admins
 if (section === "admin" && !state.isAdmin) {
 section = "game";
 window.location.hash = "#/game";
 }

 Object.values(sections).forEach(s => s && s.classList.remove("active"));
 // Deactivate all nav links
 document.querySelectorAll(".nav-link").forEach(n => n.classList.remove("active"));

 if (sections[section]) sections[section].classList.add("active");
 // Activate the matching nav link
 const navLink = document.querySelector(`.nav-link[data-section="${section}"]`);
 if (navLink) navLink.classList.add("active");
 state.currentSection = section;

 if (section === "lobbies") {
 lobbies.refresh();
 }
 if (section === "archive" && archiveNeedsRefresh) {
 initArchive();
 archiveNeedsRefresh = false;
 }
 if (section === "admin" && state.isAdmin) {
 admin.refresh();
 }
}

let archiveNeedsRefresh = true;

function initRouter() {
 function navigate() {
 const hash = window.location.hash || "#/game";
 const section = hash.replace("#/", "") || "game";
 showSection(section);

 if (section === "game" && (state.matchEnded || state.eliminated)) {
 gameMgr.reset();
 }
 }

 window.addEventListener("hashchange", navigate);

 // Wire up all nav links via data-section attribute
 document.querySelectorAll(".nav-link[data-section]").forEach(link => {
 link.addEventListener("click", () => {
 const section = link.getAttribute("data-section");
 if (section === "game" && (state.matchEnded || state.eliminated)) {
 gameMgr.reset();
 }
 if (section === "archive") {
 archiveNeedsRefresh = true;
 }
 window.location.hash = "#/" + section;
 });
 });

 if (!window.location.hash) window.location.hash = "#/game";
 navigate();
}

// ─=== Signaling Client (WebSocket) ══════════════════════════════════════════

function createSignalingSocket(onMessage) {
 const ws = new WebSocket(WS_URL);

 ws.onopen = () => {
 state.websocketConnected = true;
 console.log("[WS] Connected");
 };

 ws.onmessage = (event) => {
 let msg;
 try { msg = JSON.parse(event.data); } catch (e) {
 console.warn("WS parse error:", e);
 return;
 }
 onMessage(msg);
 };

 ws.onclose = (event) => {
 state.websocketConnected = false;
 console.log("[WS] Closed", event.code, event.reason);
 // If we're in a match and P2P is connected, the game can continue
 // (the WS was only used for signaling). If not in a match, reload.
 if (!state.p2pConnected && !state.matchEnded && !state.gameStarted) {
 showToast("Connection lost. Reloading...", "error");
 setTimeout(() => window.location.reload(), 2000);
 } else if (state.gameStarted) {
 showToast("Signaling connection lost game continues via P2P mesh", "warning");
 }
 };

 ws.onerror = (err) => {
 console.error("[WS] Error:", err);
 // Don't auto-close let onclose handle it
 };

 return ws;
}

function sendToServer(msg) {
 if (state.signalingSocket && state.signalingSocket.readyState === WebSocket.OPEN) {
 state.signalingSocket.send(JSON.stringify(msg));
 return true;
 }
 return false;
}

// ─── CSRF-aware fetch helper ─────────────────────────────────────────────────
// All state-changing requests (POST/PUT/DELETE) must include the CSRF token.
// This helper wraps fetch() to automatically add the header.

async function fetchWithCSRF(url, options = {}) {
 if (!options.method || options.method === "GET") {
 return fetch(url, { ...options, credentials: "include" });
 }
 // State-changing request add CSRF header
 const headers = {
 "Content-Type": "application/json",
 ...(options.headers || {}),
 };
 if (state.csrfToken) {
 headers["X-CSRF-Token"] = state.csrfToken;
 }
 return fetch(url, { ...options, headers, credentials: "include" });
}

// ─=== P2P Client (WebRTC) ════════════════════════════════════════════════════

class P2PClient {
 constructor(localPlayerId, hostId, players, iceConfig) {
 this.localPlayerId = localPlayerId;
 this.hostId = hostId;
 this.players = players;
 this.isHost = localPlayerId === hostId;
 this.iceConfig = iceConfig || ICE_CONFIG_DEFAULT;

 this.pcs = new Map(); // peerId -> RTCPeerConnection
 this.channels = new Map(); // peerId -> RTCDataChannel
 this.onMessage = null;
 this.onPeerConnected = null;
 this.onAllConnected = null;
 this.peerConnected = new Set();

 // ─── Mesh routing state ───
 // When a direct connection to a peer fails, we route through connected peers.
 // routingTable[destId] = nextHopId (the peer to send via)
 this.routingTable = new Map();
 this.maxRelayHops = 2; // Don't relay through more than 2 intermediate peers
 }

 _createPC(peerId) {
 const pc = new RTCPeerConnection(this.iceConfig);

 pc.onicecandidate = (e) => {
 if (e.candidate) {
 sendToServer({
 type: "ice-candidate", to: peerId, from: this.localPlayerId, data: e.candidate,
 });
 }
 };

 pc.oniceconnectionstatechange = () => {
 const st = pc.iceConnectionState;
 console.log(`[P2P] ${peerId.slice(0, 8)} ICE: ${st}`);
 if (st === "failed") {
 console.warn(`[P2P] ICE failed for ${peerId.slice(0, 8)} will try mesh routing`);
 // Mark this peer as needing relay
 this._updateRoutingTable();
 }
 };

 pc.onconnectionstatechange = () => {
 const st = pc.connectionState;
 console.log(`[P2P] ${peerId.slice(0, 8)} state: ${st}`);
 if (st === "failed" || st === "disconnected") {
 console.warn("[P2P] Connection issue for", peerId.slice(0, 8));
 this._updateRoutingTable();
 }
 };

 return pc;
 }

 _setupChannel(dc, peerId) {
 dc.onmessage = (e) => {
 let msg;
 try { msg = JSON.parse(e.data); } catch { return; }
 // ─── Mesh routing: check if this is a relayed message ───
 if (msg._relay) {
 // This message is destined for someone else relay it
 if (msg._relay.to !== this.localPlayerId) {
 this._relayMessage(msg._relay.to, msg._relay.original, msg._relay.hops + 1, peerId);
 return;
 }
 // It's for us strip the relay envelope
 msg = msg._relay.original;
 }
 if (this.onMessage) this.onMessage(peerId, msg);
 };

 dc.onopen = () => {
 console.log("[P2P] Data channel open:", peerId.slice(0, 8));
 this.peerConnected.add(peerId);
 if (this.onPeerConnected) this.onPeerConnected(peerId);
 this._checkAllConnected();
 this._updateRoutingTable();
 // Announce our routing table to this peer so they know we can relay
 this._sendRoutingInfo(peerId);
 };

 dc.onclose = () => {
 console.log("[P2P] Data channel closed:", peerId.slice(0, 8));
 this.peerConnected.delete(peerId);
 this._updateRoutingTable();
 };

 dc.onerror = (e) => console.error("[P2P] Data channel error:", peerId, e);
 }

 _checkAllConnected() {
 if (!this.isHost) return;
 const allOpen = this.players.every(p => {
 if (p.id === this.localPlayerId) return true;
 const dc = this.channels.get(p.id);
 return dc && dc.readyState === "open";
 });
 if (allOpen && this.onAllConnected) {
 this.onAllConnected();
 }
 }

 // ─── Mesh Routing ────────────────────────────────────────────────────────

 /**
 * Update the routing table based on which peers are directly connected.
 * For peers we can't reach directly, find a relay path through connected peers.
 */
 _updateRoutingTable() {
 const allPeerIds = this.players.map(p => p.id).filter(id => id !== this.localPlayerId);
 for (const peerId of allPeerIds) {
 const dc = this.channels.get(peerId);
 if (dc && dc.readyState === "open") {
 // Direct connection no relay needed
 this.routingTable.delete(peerId);
 } else {
 // Need a relay find a connected peer that can reach them
 // For now, we just mark it as needing relay; the actual relay
 // peer is chosen at send time based on who's connected.
 this.routingTable.set(peerId, null);
 }
 }
 }

 /**
 * Send routing info to a peer so they know we can relay for them.
 */
 _sendRoutingInfo(peerId) {
 const dc = this.channels.get(peerId);
 if (!dc || dc.readyState !== "open") return;
 const reachable = Array.from(this.peerConnected);
 dc.send(JSON.stringify({
 type: "routing-info",
 reachable, // peers we can reach directly
 from: this.localPlayerId,
 }));
 }

 /**
 * Relay a message to a destination peer through an intermediate peer.
 */
 _relayMessage(destId, originalMessage, hops, viaPeerId) {
 if (hops > this.maxRelayHops) {
 console.warn(`[P2P] Max relay hops exceeded for ${destId.slice(0, 8)}`);
 return;
 }
 // Try direct first
 const dc = this.channels.get(destId);
 if (dc && dc.readyState === "open") {
 dc.send(JSON.stringify(originalMessage));
 return;
 }
 // Find a relay peer (any connected peer that isn't the sender)
 for (const [pid, relayDc] of this.channels) {
 if (pid === viaPeerId || pid === destId) continue; // don't loop back
 if (relayDc.readyState === "open") {
 relayDc.send(JSON.stringify({
 _relay: {
 to: destId,
 original: originalMessage,
 hops: hops,
 },
 }));
 console.log(`[P2P] Relaying to ${destId.slice(0, 8)} via ${pid.slice(0, 8)} (hops: ${hops})`);
 return;
 }
 }
 console.warn(`[P2P] No relay path to ${destId.slice(0, 8)}`);
 }

 async connectToPeer(peerId) {
 const pc = this._createPC(peerId);
 const dc = pc.createDataChannel("game");
 this._setupChannel(dc, peerId);
 this.pcs.set(peerId, pc);
 this.channels.set(peerId, dc);

 const offer = await pc.createOffer();
 await pc.setLocalDescription(offer);
 sendToServer({
 type: "offer", to: peerId, from: this.localPlayerId, data: offer,
 });
 }

 async handleOffer(from, offer) {
 let pc = this.pcs.get(from);
 if (!pc) {
 pc = this._createPC(from);
 this.pcs.set(from, pc);
 }
 pc.ondatachannel = (e) => {
 const dc = e.channel;
 this._setupChannel(dc, from);
 this.channels.set(from, dc);
 };
 try {
 await pc.setRemoteDescription(offer);
 const answer = await pc.createAnswer();
 await pc.setLocalDescription(answer);
 sendToServer({
 type: "answer", to: from, from: this.localPlayerId, data: answer,
 });
 } catch (e) {
 console.error("[P2P] handleOffer failed:", e);
 }
 }

 async handleAnswer(from, answer) {
 const pc = this.pcs.get(from);
 if (pc) {
 try { await pc.setRemoteDescription(answer); }
 catch (e) { console.warn("[P2P] handleAnswer:", e); }
 }
 }

 async handleIceCandidate(from, candidate) {
 const pc = this.pcs.get(from);
 if (pc) {
 try {
 await pc.addIceCandidate(new RTCIceCandidate(candidate));
 } catch (e) {
 if (!(e.message && e.message.includes("already"))) {
 console.warn("[P2P] ICE add failed:", e);
 }
 }
 }
 }

 /**
 * Send a message to a specific peer. If direct connection is unavailable,
 * route through a connected peer (mesh relay).
 */
 sendToPeer(peerId, message) {
 // Try direct first
 const dc = this.channels.get(peerId);
 if (dc && dc.readyState === "open") {
 dc.send(JSON.stringify(message));
 return true;
 }
 // Direct failed try mesh routing
 console.log(`[P2P] Direct send to ${peerId.slice(0, 8)} failed, trying mesh relay...`);
 this._relayMessage(peerId, message, 0, this.localPlayerId);
 return false; // return false so callers know direct send failed
 }

 /**
 * Broadcast a message to all peers. Uses direct connection when available,
 * mesh routing for unreachable peers.
 */
 broadcast(message) {
 let anySent = false;
 const allPeerIds = this.players.map(p => p.id).filter(id => id !== this.localPlayerId);
 for (const peerId of allPeerIds) {
 const dc = this.channels.get(peerId);
 if (dc && dc.readyState === "open") {
 dc.send(JSON.stringify(message));
 anySent = true;
 } else {
 // Try mesh relay for this peer
 this._relayMessage(peerId, message, 0, this.localPlayerId);
 anySent = true; // assume relay will eventually deliver
 }
 }
 return anySent;
 }

 closeAll() {
 for (const pc of this.pcs.values()) {
 try { pc.close(); } catch {}
 }
 this.pcs.clear();
 this.channels.clear();
 this.peerConnected.clear();
 this.routingTable.clear();
 }
}

// ─=== Game Manager ════════════════════════════════════════════════════════════

class GameManager {
 constructor() {
 this.module = null;
 this.state = null;
 this.tick = 0;
 this.gameInterval = null;
 this.renderFrameId = null;
 this.keys = new Set();
 this.recordedInputs = {};
 this.pendingInputs = {};
 this.matchStartTime = null;
 this.canvas = dom.gameCanvas;
 this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
 }

 async loadGameModule(gameModulePath) {
 showLoading("Loading game module...");
 const mod = await import(gameModulePath);
 this.module = mod.default || mod;
 return this.module;
 }

 // Host: start the authoritative simulation
 startHostGame() {
 if (!this.module || !state.seed || !state.players || state.players.length === 0) {
 console.error("[GameManager] Cannot start host game: missing prerequisites", {
 module: !!this.module, seed: state.seed, players: state.players,
 });
 showToast("Failed to start game (missing data)", "error");
 return;
 }

 this.state = this.module.createGameState(state.seed, state.players.map(p => ({
 id: p.id, name: p.name, color: p.color || PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
 })));
 this.matchStartTime = Date.now();
 this.tick = 0;
 this.recordedInputs = {};

 for (const p of state.players) {
 this.recordedInputs[p.id] = [];
 }

 // Send initial state to peers (P2P + WS relay)
 this._broadcastState();

 // Start the game loop use module's tick rate if specified (chess = 500ms, fast games = 16ms)
 const tickRate = this.module.metadata?.tickRate || TICK_RATE_MS;
 if (this.gameInterval) clearInterval(this.gameInterval);
 this.gameInterval = setInterval(() => this._hostTick(), tickRate);

 // Start render loop for host too
 if (!this.renderFrameId) this._renderLoop();

 state.gameStarted = true;
 console.log("[GameManager] Host game started. tick rate:", tickRate);
 }

 _hostTick() {
 this.tick++;

 const hostInput = this.module.getLocalInput(this.keys);
 if (hostInput) this.pendingInputs[state.playerId] = hostInput;

 const dt = this.module.metadata?.tickRate || TICK_RATE_MS;
 const inputs = {};
 for (const p of state.players) {
 if (this.pendingInputs[p.id]) {
 inputs[p.id] = this.pendingInputs[p.id];
 delete this.pendingInputs[p.id];
 } else {
 inputs[p.id] = { jump: false, timestamp: Date.now() };
 }
 }

 this.state = this.module.updateGameState(this.state, inputs, dt);
 this._broadcastState();

 // Record inputs for replay
 for (const [pid, input] of Object.entries(inputs)) {
 if (input && (input.jump || input.action)) {
 if (!this.recordedInputs[pid]) this.recordedInputs[pid] = [];
 this.recordedInputs[pid].push({
 ...input,
 timestamp: this.state.timestamp,
 });
 }
 }

 if (this.module.isMatchOver(this.state)) {
 this._endMatch();
 return;
 }

 // Safety cap (chess games can be long 200 ticks at 500ms = 100 seconds)
 const maxTicks = this.module.metadata?.maxTicks || 3600;
 if (this.tick > maxTicks) {
 this._endMatch();
 }
 }

 _broadcastState() {
 if (!this.state) return;
 const payload = { type: "game-state", state: this.state, tick: this.tick };
 // ─── P2P mesh only no server relay ───
 // The host broadcasts state to all peers via WebRTC data channels.
 // If a direct connection fails, the mesh routing layer relays through
 // other connected peers. The server never sees game state.
 if (state.p2pClient) {
 state.p2pClient.broadcast(payload);
 }
 }

 _endMatch() {
 if (this.gameInterval) {
 clearInterval(this.gameInterval);
 this.gameInterval = null;
 }

 state.matchEnded = true;
 const winnerId = this.module.getWinner(this.state);
 const winnerName = state.players.find(p => p.id === winnerId)?.name || "Unknown";
 const duration = this.state.timestamp;

 // Broadcast match-over via P2P mesh (game-over is peer-to-peer)
 const payload = { type: "match-over", winner: winnerId, winnerName: winnerName };
 if (state.p2pClient) state.p2pClient.broadcast(payload);
 // Report match result to server (stats only no game-state relay)
 sendToServer({ type: "match-over", winner: winnerId, winnerName: winnerName });

 // Compile and save replay LOCALLY (not uploaded to the server).
 const replay = this.module.compileReplay(
 this.recordedInputs,
 state.seed,
 duration,
 winnerId,
 winnerName,
 state.players,
 );

 // v0.4: replays are stored in the player's browser via localStorage.
 // Nothing is POSTed to the server, so each user only sees their own
 // matches in the Archive tab. The client auto-assigns "Match N" using
 // a localStorage counter if no title was set.
 try {
 saveLocalReplay(replay);
 showToast("Replay saved to your local archive", "success");
 } catch (e) {
 console.error("[Archive] Failed to save local replay:", e);
 showToast("Failed to save replay (localStorage full or disabled)", "error");
 }

 this.showResults(winnerId, winnerName, duration);

 setTimeout(() => {
 if (state.p2pClient) state.p2pClient.closeAll();
 }, 5000);
 }

 // Client: start receiving and rendering state
 startClientGame() {
 this._renderLoop();
 }

 _renderLoop() {
 if (this.ctx && this.state) {
 try {
 this.module.render(this.ctx, this.state, state.playerId, this.canvas.width, this.canvas.height);
 } catch (e) {
 console.error("[render] error:", e);
 }
 this._checkElimination();
 updateGameSidebar(this.state);
 } else if (this.ctx) {
 this.ctx.fillStyle = "#0a0a15";
 this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
 this.ctx.fillStyle = "#e8b400";
 this.ctx.font = "bold 24px monospace";
 this.ctx.textAlign = "center";
 this.ctx.fillText("waiting for game state...", this.canvas.width / 2, this.canvas.height / 2);
 }
 this.collectAndSendInput();
 this.renderFrameId = requestAnimationFrame(() => this._renderLoop());
 }

 _checkElimination() {
 if (!this.state || !this.state.running) return;
 if (state.eliminated || state.matchEnded) return;

 const status = this.module.getPlayerStatus(this.state, state.playerId);
 if (status === "dead") {
 state.eliminated = true;
 this.showEliminated();
 }
 }

 receiveState(newState, tick) {
 this.state = newState;
 this.tick = tick;
 }

 receiveMatchOver(winnerId, winnerName) {
 if (state.matchEnded) return;
 state.matchEnded = true;
 this.showResults(winnerId, winnerName, this.state?.timestamp || 0);
 }

 showEliminated() {
 dom.gameWrapper.style.opacity = "0";
 setTimeout(() => {
 dom.gameWrapper.style.display = "none";
 dom.eliminationOverlay.classList.add("active");
 }, 50);
 }

 hideEliminated() {
 dom.eliminationOverlay.classList.remove("active");
 dom.gameWrapper.style.display = "flex";
 dom.gameWrapper.style.opacity = "1";
 state.eliminated = false;
 }

 showResults(winnerId, winnerName, duration) {
 if (state.eliminated) {
 const existing = document.getElementById("winner-info");
 if (existing) existing.remove();
 const info = document.createElement("div");
 info.id = "winner-info";
 info.className = "mt-6 p-4 card border border-border rounded text-center";
 info.innerHTML =
 "<div class='text-muted text-sm font-mono'>MATCH RESULT</div>" +
 "<div class='text-2xl font-display font-bold text-gold mt-2'>" +
 escapeHTML(winnerName) + " wins!</div>";
 const center = dom.eliminationOverlay.querySelector(".text-center");
 if (center) center.appendChild(info);
 dom.viewReplayBtn.classList.remove("hidden");
 } else {
 showToast(winnerName + " wins the match!", "success");
 }
 state.matchEnded = true;
 }

 collectAndSendInput() {
 if (!this.state || !this.state.running || state.isHost) return;
 if (state.eliminated || state.matchEnded) return;

 const status = this.module.getPlayerStatus(this.state, state.playerId);
 if (status !== "alive") return;

 const input = this.module.getLocalInput(this.keys);
 if (input && (input.jump || input.action)) {
 const payload = { type: "input", playerId: state.playerId, input: input };
 if (state.p2pClient) {
 state.p2pClient.sendToPeer(state.hostId, payload);
 }
 }
 }

 setupKeyboard() {
 const gameKeys = new Set(["Space", "ArrowUp", "KeyW", "KeyA", "KeyS", "KeyD"]);
 const isGameKey = (e) => gameKeys.has(e.code) || gameKeys.has(e.key);
 const isTyping = (e) => e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;

 window.addEventListener("keydown", (e) => {
 if (isTyping(e)) return;
 this.keys.add(e.code);
 this.keys.add(e.key);
 if (isGameKey(e)) e.preventDefault();
 });
 window.addEventListener("keyup", (e) => {
 if (isTyping(e)) return;
 this.keys.delete(e.code);
 this.keys.delete(e.key);
 if (isGameKey(e)) e.preventDefault();
 });
 }

 setupMouse() {
 if (!this.canvas) return;
 this.canvas.addEventListener("click", (e) => {
 if (!this.module.handleClick) return;
 const rect = this.canvas.getBoundingClientRect();
 const scaleX = this.canvas.width / rect.width;
 const scaleY = this.canvas.height / rect.height;
 const x = (e.clientX - rect.left) * scaleX;
 const y = (e.clientY - rect.top) * scaleY;
 this.module.handleClick(x, y, state.playerId, this.state);
 });
 }

 reset() {
 this.state = null;
 this.tick = 0;
 this.recordedInputs = {};
 this.pendingInputs = {};
 this.matchStartTime = null;
 this.keys.clear();

 if (this.gameInterval) {
 clearInterval(this.gameInterval);
 this.gameInterval = null;
 }
 if (this.renderFrameId) {
 cancelAnimationFrame(this.renderFrameId);
 this.renderFrameId = null;
 }

 this.hideEliminated();
 dom.viewReplayBtn.classList.add("hidden");

 dom.gameScreen.classList.add("hidden");
 dom.findMatchScreen.classList.remove("hidden");
 dom.findMatchBtn.classList.remove("hidden");
 dom.lobbyWait.classList.add("hidden");

 state.eliminated = false;
 state.matchEnded = false;
 state.p2pConnected = false;
 state.gameStarted = false;
 // Stop heartbeat and close P2P connections
 stopHeartbeat();
 if (state.p2pClient) {
 state.p2pClient.closeAll();
 state.p2pClient = null;
 }
 }
}

const gameMgr = new GameManager();

// ─=== Event Handlers ═══════════════════════════════════════════════════════

function handlePlaySoloClick() {
 dom.findMatchScreen.classList.add("hidden");
 dom.gameScreen.classList.remove("hidden");
 dom.playerInfo.textContent = state.playerName + " · solo mode";

 state.playerId = state.playerName;
 state.seed = Math.floor(Math.random() * 0x7fffffff);
 state.hostId = state.playerName;
 state.isHost = true;
 state.players = [
 { id: state.playerName, name: state.playerName, connected: true },
 { id: "bot-1", name: "Bot 1", connected: true },
 { id: "bot-2", name: "Bot 2", connected: true },
 ];
 state.players.forEach((p, i) => { p.color = PLAYER_COLORS[i % PLAYER_COLORS.length]; });

 state.p2pClient = {
 isHost: true,
 broadcast: () => false,
 sendToPeer: () => false,
 closeAll: () => {},
 };

 gameMgr.startHostGame();
}

function handleFindMatchClick() {
 // "Make a lobby" button connect WS and show available lobbies
 dom.findMatchBtn.classList.add("hidden");

 // Show the quick-lobbies panel
 const quickLobbies = document.getElementById("quick-lobbies");
 if (quickLobbies) quickLobbies.classList.remove("hidden");

 dom.playerInfo.textContent = "connecting as " + state.playerName;

 // Connect WebSocket if not already connected
 if (!state.signalingSocket || state.signalingSocket.readyState !== WebSocket.OPEN) {
 state.signalingSocket = createSignalingSocket(handleSignalingMessage);
 state.signalingSocket.onopen = () => {
 state.websocketConnected = true;
 console.log("[WS] Connected, waiting for assign-id");
 // Request lobby list once connected
 sendToServer({ type: "list-lobbies" });
 };
 } else {
 // Already connected just refresh the list
 sendToServer({ type: "list-lobbies" });
 }

 // Also fetch via HTTP for immediate display
 fetchQuickLobbies();
}

async function fetchQuickLobbies() {
 const list = document.getElementById("quick-lobby-list");
 if (!list) return;
 try {
  // Use Firebase lobby list instead of server API
  const lobbies = knownLobbies || [];
  renderQuickLobbies(lobbies);
 console.warn("Failed to fetch lobbies:", e);
 }
}

function renderQuickLobbies(lobbyList) {
 const list = document.getElementById("quick-lobby-list");
 if (!list) return;

 if (lobbyList.length === 0) {
 list.innerHTML = '<p class="subtle text-sm" style="padding: 24px; text-align: center;">No open lobbies. Click "+ Create new" to make one.</p>';
 return;
 }

 list.innerHTML = "";
 for (const lobby of lobbyList) {
 if (lobby.status !== "waiting") continue;
 if (lobby.playerCount >= lobby.maxPlayers) continue;
 const div = document.createElement("div");
 div.className = "list-item list-item-hover";
 div.innerHTML =
 '<div class="flex-1">' +
 '<div class="font-semibold">' + escapeHTML(lobby.name) + '</div>' +
 '<div class="text-sm muted mono">' + escapeHTML(lobby.hostName) + ' · ' + lobby.playerCount + '/' + lobby.maxPlayers + ' players</div>' +
 '</div>' +
 '<button class="btn btn-primary btn-sm">Join</button>';
 const btn = div.querySelector("button");
 btn.addEventListener("click", () => {
 if (!state.signalingSocket || state.signalingSocket.readyState !== WebSocket.OPEN) {
 showToast("Connecting...", "info");
 return;
 }
 sendToServer({
 type: "join-specific",
 lobbyId: lobby.id,
 playerName: state.playerName,
 });
 showToast("Joining lobby...", "info");
 });
 list.appendChild(div);
 }
}

function leaveCurrentLobby() {
 sendToServer({ type: "leave-lobby" });
 state.currentLobbyId = null;
 lobbies.setCurrentLobbyId(null);
 dom.lobbyWait.classList.add("hidden");
 dom.findMatchScreen.classList.remove("hidden");
 dom.findMatchBtn.classList.remove("hidden");
 const quickLobbies = document.getElementById("quick-lobbies");
 if (quickLobbies) quickLobbies.classList.add("hidden");
 dom.playerInfo.textContent = state.playerName;
}

// ─── Handle incoming signaling messages ─────────────────────────────────────
// FIXED: removed duplicate case blocks; properly handle {player} vs {players}.

function handleSignalingMessage(msg) {
 switch (msg.type) {
 case "assign-id":
 state.playerId = msg.playerId;
 state.iceConfig = msg.iceConfig || ICE_CONFIG_DEFAULT;
 if (msg.username) {
 state.userId = msg.userId;
 window.__tgn_user = { id: msg.userId, username: msg.username };
 if (!state.playerName) {
 state.playerName = msg.username;
 localStorage.setItem("tgn_playerName", state.playerName);
 window.__tgn_playerName = state.playerName;
 }
 }
 dom.playerInfo.textContent = "Connected: " + state.playerName;
 // Don't auto-join just refresh the lobby list so the player
 // can choose which lobby to join or create a new one.
 sendToServer({ type: "list-lobbies" });
 fetchQuickLobbies();
 lobbies.refresh();
 break;

 case "lobby-list":
 lobbies.renderLobbyList(msg.lobbies);
 // Also update the quick-lobby panel on the game screen
 renderQuickLobbies(msg.lobbies);
 break;

 case "lobby-state":
 handleLobbyStateUpdate(msg.lobby, msg.iceConfig);
 break;

 case "lobby-created":
 // We created a lobby via WS server sends full lobby state
 handleLobbyStateUpdate(msg.lobby, msg.iceConfig);
 showToast("Lobby created: " + msg.lobby.name, "success");
 // Switch to the game tab so the user sees the lobby they're now in
 window.location.hash = "#/game";
 break;

 case "left-lobby":
 state.currentLobbyId = null;
 lobbies.setCurrentLobbyId(null);
 dom.lobbyWait.classList.add("hidden");
 dom.findMatchScreen.classList.remove("hidden");
 dom.findMatchBtn.classList.remove("hidden");
 dom.playerInfo.textContent = state.playerName;
 break;

 case "game-start":
 handleGameStart(msg);
 break;

 case "offer":
 if (state.p2pClient) state.p2pClient.handleOffer(msg.from, msg.data);
 break;

 case "answer":
 if (state.p2pClient) state.p2pClient.handleAnswer(msg.from, msg.data);
 break;

 case "ice-candidate":
 if (state.p2pClient) state.p2pClient.handleIceCandidate(msg.from, msg.data);
 break;

 case "p2p-connected":
 if (!state.p2pConnected) {
 state.p2pConnected = true;
 if (state.p2pFallbackTimer) {
 clearTimeout(state.p2pFallbackTimer);
 state.p2pFallbackTimer = null;
 }
 // Don't restart the game it already started on game-start.
 // Just mark P2P as connected so we prefer it for future state relays.
 console.log("[P2P] All peers connected (server-confirmed).");
 }
 break;

 case "player-joined": {
 // Server sends { player } (singular). Update local state.
 if (!state.players.find(p => p.id === msg.player.id)) {
 state.players.push(msg.player);
 }
 renderLobby();
 break;
 }

 case "player-left": {
 state.players = state.players.filter(p => p.id !== msg.playerId);
 renderLobby();
 break;
 }

 // ── KV signaling store-and-forward (phonebook backup) ──
 // When we poll for signals, we get any offer/answer/ICE that were
 // stored in KV while our WS was disconnected.
 case "signals": {
 if (msg.signals && state.p2pClient) {
 for (const sig of msg.signals) {
 console.log(`[P2P] Processing stored ${sig.type} from ${sig.fromId.slice(0, 8)}`);
 if (sig.type === "offer") {
 state.p2pClient.handleOffer(sig.fromId, sig.data);
 } else if (sig.type === "answer") {
 state.p2pClient.handleAnswer(sig.fromId, sig.data);
 } else if (sig.type === "ice-candidate") {
 state.p2pClient.handleIceCandidate(sig.fromId, sig.data);
 }
 }
 }
 break;
 }

 case "heartbeat-ack":
 // Phonebook entry refreshed nothing to do
 break;

 case "match-over-ack":
 console.log("[Server] match-over recorded");
 break;

 case "error":
 console.warn("[Server error]", msg.message);
 showToast(msg.message || "Server error", "error");
 // If banned, redirect to login
 if (msg.message && msg.message.includes("banned")) {
 setTimeout(() => {
 state.signalingSocket && state.signalingSocket.close();
 auth.showModal("login");
 }, 2000);
 }
 break;

 case "replay-ack":
 console.log("[Replay] saved:", msg.replayId);
 break;

 default:
 console.warn("Unknown signaling message:", msg.type);
 }
}

function handleLobbyStateUpdate(lobby, iceConfig) {
 if (!lobby) return;
 state.currentLobbyId = lobby.id;
 state.players = lobby.players;
 state.hostId = lobby.hostId;
 state.gameId = lobby.gameId;
 if (iceConfig) state.iceConfig = iceConfig;
 lobbies.setCurrentLobbyId(lobby.id);

 state.isHost = (state.playerId === state.hostId);

 // Show the lobby wait UI
 dom.findMatchBtn.classList.add("hidden");
 dom.findMatchScreen.classList.remove("hidden");
 dom.lobbyWait.classList.remove("hidden");
 // Hide the quick-lobbies panel (we're now in a lobby)
 const quickLobbies = document.getElementById("quick-lobbies");
 if (quickLobbies) quickLobbies.classList.add("hidden");
 dom.lobbyNameDisplay.textContent = lobby.name + " · " + lobby.type;
 dom.leaveLobbyBtn.classList.remove("hidden");

 // Update invite link
 const inviteLink = document.getElementById("lobby-invite-link");
 if (inviteLink) {
 const baseUrl = window.location.origin + window.location.pathname;
 inviteLink.value = baseUrl + "#/lobbies";
 }

 // Update waiting hint
 const waitHint = document.getElementById("lobby-wait-hint");
 if (waitHint) {
 const playerCount = lobby.players.length;
 const minPlayers = lobby.minPlayers || 2;
 if (playerCount < minPlayers) {
 waitHint.textContent = `Waiting for ${minPlayers - playerCount} more player${minPlayers - playerCount > 1 ? "s" : ""} to join. Share the link above or tell them to click "Find match".`;
 } else if (state.isHost) {
 waitHint.textContent = "Ready! Click 'Start match' when you want to begin.";
 } else {
 waitHint.textContent = "Ready! Waiting for the host to start the match.";
 }
 }

 // Show start-match button to the host for ALL lobby types.
 // The host chooses when to start no auto-start.
 if (state.isHost) {
 dom.startMatchBtn.classList.remove("hidden");
 const minPlayers = lobby.minPlayers || 2;
 if (lobby.players.length < minPlayers) {
 dom.startMatchBtn.disabled = true;
 dom.startMatchBtn.textContent = `Need ${minPlayers - lobby.players.length} more player${minPlayers - lobby.players.length > 1 ? "s" : ""}`;
 } else {
 dom.startMatchBtn.disabled = false;
 dom.startMatchBtn.textContent = "Start match";
 }
 } else {
 dom.startMatchBtn.classList.add("hidden");
 }

 dom.lobbyStatus.textContent = lobby.status === "waiting" ? "waiting for players..." : "match starting...";
 dom.playerInfo.innerHTML =
 "<span class='text-gold'>" + (state.isHost ? "● HOST" : "● PLAYER") + "</span>" +
 " · " + escapeHTML(lobby.name);

 renderLobby();
}

function renderLobby() {
 const container = dom.playerList;
 container.innerHTML = "";
 state.players.forEach((p, i) => {
 const isHost = p.id === state.hostId;
 const isYou = p.id === state.playerId;
 const dotColor = isHost ? "bg-gold" : "bg-ok";
 const div = document.createElement("div");
 div.className = "flex items-center justify-between p-3 bg-surface rounded border border-border";
 div.innerHTML =
 "<div class='flex items-center space-x-3'>" +
 "<div class='w-3 h-3 rounded-full " + dotColor + "'></div>" +
 "<span class='font-mono text-sm text-text'>" + escapeHTML(p.name) + "</span>" +
 (isHost ? "<span class='badge badge-signup'>HOST</span>" : "") +
 (isYou ? "<span class='badge badge-open'>YOU</span>" : "") +
 "</div>" +
 "<span class='text-xs " + (p.connected ? "text-ok" : "text-muted") + " font-mono'>" +
 (p.connected ? "ONLINE" : "OFFLINE") + "</span>";
 container.appendChild(div);
 });

 const max = state.gameConfig?.maxPlayers || 10;
 dom.lobbyCount.textContent = state.players.length + "/" + max;
 dom.lobbyCount.className = "ml-2 font-mono font-bold " +
 (state.players.length >= max ? "text-ok" : "text-gold");
}

function escapeHTML(str) {
 return String(str || "")
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
}

// Handle game-start message from server
function handleGameStart(msg) {
 state.seed = msg.seed;
 state.players = msg.players;
 state.hostId = msg.hostId;
 state.gameId = msg.gameId || msg.gameModule;
 state.iceConfig = msg.iceConfig || ICE_CONFIG_DEFAULT;
 state.players.forEach((p, i) => { p.color = PLAYER_COLORS[i % PLAYER_COLORS.length]; });
 state.isHost = (state.playerId === state.hostId);

 dom.playerInfo.innerHTML =
 "<span class='text-gold'>" + (state.isHost ? "● HOST" : "● PLAYER") + "</span>" +
 " · Seed: " + msg.seed;

 // Show game-screen immediately on game-start.
 dom.lobbyWait.classList.add("hidden");
 dom.gameScreen.classList.remove("hidden");
 dom.findMatchScreen.classList.add("hidden");

 // Set up P2P mesh all game traffic flows over WebRTC, not the server.
 setupP2P();

 // Start the host's local simulation immediately
 if (state.isHost) {
 gameMgr.startHostGame();
 } else {
 gameMgr.startClientGame();
 }

 // Start heartbeat to keep phonebook entry alive
 startHeartbeat();

 // Poll for any KV-stored signals we might have missed
 setTimeout(() => sendToServer({ type: "poll-signals" }), 1000);
 // Poll again after 3 seconds in case signaling is slow
 setTimeout(() => sendToServer({ type: "poll-signals" }), 3000);
}

// ─── Heartbeat (keep phonebook entry alive) ──────────────────────────────────
// Send a heartbeat every 60 seconds so our peer entry in Deno KV doesn't expire.

let heartbeatInterval = null;

function startHeartbeat() {
 if (heartbeatInterval) clearInterval(heartbeatInterval);
 heartbeatInterval = setInterval(() => {
 sendToServer({ type: "heartbeat" });
 }, 60 * 1000);
}

function stopHeartbeat() {
 if (heartbeatInterval) {
 clearInterval(heartbeatInterval);
 heartbeatInterval = null;
 }
}

// ─── Chat (separate public + team) ───────────────────────────────────────────

let currentChatChannel = "public"; // "public" or "team"

function displayChatMessage(playerName, message, channel, senderTeam) {
 const chatMessages = document.getElementById("chat-messages");
 if (!chatMessages) return;
 // Only display if the message is for the currently active channel
 if (channel !== currentChatChannel) return;

 const div = document.createElement("div");
 div.className = "chat-message";
 const teamBadge = senderTeam
 ? ' <span class="badge ' + (senderTeam === "white" ? "badge-default" : "badge-accent") + '" style="font-size: 9px; padding: 1px 4px;">' + senderTeam + "</span>"
 : "";
 div.innerHTML = '<span class="chat-author">' + escapeHTML(playerName) + "</span>" + teamBadge + ": " + escapeHTML(message);
 chatMessages.appendChild(div);
 chatMessages.scrollTop = chatMessages.scrollHeight;
 while (chatMessages.children.length > 100) {
 chatMessages.removeChild(chatMessages.firstChild);
 }
}

function switchChatChannel(channel) {
 currentChatChannel = channel;
 // Clear displayed messages and switch placeholder
 const chatMessages = document.getElementById("chat-messages");
 if (chatMessages) chatMessages.innerHTML = "";
 const input = document.getElementById("chat-input");
 if (input) {
 input.placeholder = channel === "public" ? "Message all players..." : "Message your team only...";
 }
 // Update tab styling
 const publicTab = document.getElementById("chat-tab-public");
 const teamTab = document.getElementById("chat-tab-team");
 if (publicTab) publicTab.classList.toggle("active", channel === "public");
 if (teamTab) teamTab.classList.toggle("active", channel === "team");
}

function sendChat() {
 const input = document.getElementById("chat-input");
 if (!input) return;
 const message = input.value.trim();
 if (!message) return;
 input.value = "";

 const team = state.gameState?.data?.playerTeams?.[state.playerId] || null;

 if (state.p2pClient) {
 state.p2pClient.broadcast({
 type: "chat",
 channel: currentChatChannel,
 playerId: state.playerId,
 playerName: state.playerName,
 message,
 senderTeam: team,
 timestamp: Date.now(),
 });
 }
 displayChatMessage(state.playerName, message, currentChatChannel, team);
}

// ─── Capture Sound ───────────────────────────────────────────────────────────

let audioCtx = null;
let lastCaptureTick = -1;

function playCaptureSound() {
 try {
 if (!audioCtx) {
 audioCtx = new (window.AudioContext || window.webkitAudioContext)();
 }
 // Resume context if suspended (browsers require user gesture)
 if (audioCtx.state === "suspended") audioCtx.resume();

 const now = audioCtx.currentTime;

 // "Thunk" a short percussive sound like a chess piece landing
 // Low-frequency thump (the piece hitting the board)
 const osc1 = audioCtx.createOscillator();
 const gain1 = audioCtx.createGain();
 osc1.type = "sine";
 osc1.frequency.setValueAtTime(180, now);
 osc1.frequency.exponentialRampToValueAtTime(60, now + 0.08);
 gain1.gain.setValueAtTime(0.4, now);
 gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
 osc1.connect(gain1);
 gain1.connect(audioCtx.destination);
 osc1.start(now);
 osc1.stop(now + 0.12);

 // Click/capture accent (higher freq, very short)
 const osc2 = audioCtx.createOscillator();
 const gain2 = audioCtx.createGain();
 osc2.type = "triangle";
 osc2.frequency.setValueAtTime(800, now);
 osc2.frequency.exponentialRampToValueAtTime(200, now + 0.05);
 gain2.gain.setValueAtTime(0.15, now);
 gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
 osc2.connect(gain2);
 gain2.connect(audioCtx.destination);
 osc2.start(now);
 osc2.stop(now + 0.06);
 } catch (e) {
 console.warn("[Audio] Failed to play capture sound:", e);
 }
}

let lastProposalCount = -1;
let lastVoteCount = -1;
let lastTurn = null;

function toAlgebraic([r, c]) {
 return String.fromCharCode(97 + c) + (8 - r);
}

function updateGameSidebar(gameState) {
 if (!gameState || !gameState.data) return;
 const data = gameState.data;
 state.gameState = gameState; // store for chat team lookup

 // ─── Check for capture sound ───
 if (data.lastCaptureTick && data.lastCaptureTick !== lastCaptureTick) {
 lastCaptureTick = data.lastCaptureTick;
 if (data.lastCaptureTick === gameState.tick) {
 playCaptureSound();
 }
 }

 // Update turn/timer info
 const turnEl = document.getElementById("chess-turn");
 const phaseEl = document.getElementById("chess-phase");
 const timerEl = document.getElementById("chess-timer");
 const team = data.playerTeams && data.playerTeams[state.playerId];
 const isMyTurn = team && data.turn === team;

 if (turnEl) {
 let text = data.turn === "white" ? "White to move" : "Black to move";
 if (isMyTurn) text += " (your team!)";
 if (!gameState.running && data.winnerTeam) {
 text = (data.winnerTeam === "white" ? "White" : "Black") + " wins!";
 }
 turnEl.textContent = text;
 }
 if (phaseEl) {
 phaseEl.textContent = data.phase === "voting" ? "Voting phase" : "Executing...";
 }
 if (timerEl) {
 const remaining = Math.max(0, Math.ceil((data.phaseDeadline - gameState.timestamp) / 1000));
 timerEl.textContent = remaining + "s";
 timerEl.className = remaining <= 5 ? "badge badge-danger" : "badge badge-accent";
 timerEl.style.fontSize = "14px";
 timerEl.style.padding = "4px 10px";
 }

 // Update vote panel only when proposals/votes change
 const totalVotes = Object.keys(data.playerVotes || {}).length;
 if (data.proposals.length === lastProposalCount && totalVotes === lastVoteCount && data.turn === lastTurn) return;
 lastProposalCount = data.proposals.length;
 lastVoteCount = totalVotes;
 lastTurn = data.turn;

 const voteList = document.getElementById("vote-list");
 if (!voteList) return;

 if (!gameState.running) {
 voteList.innerHTML = '<p class="subtle text-sm">Game over.</p>';
 return;
 }

 if (!isMyTurn || data.phase !== "voting") {
 voteList.innerHTML = '<p class="subtle text-sm">Waiting for other team...</p>';
 return;
 }

 if (data.proposals.length === 0) {
 voteList.innerHTML = '<p class="subtle text-sm">No proposals yet. Click a piece to propose a move.</p>';
 return;
 }

 voteList.innerHTML = "";
 for (const proposal of data.proposals) {
 const myVote = data.playerVotes[state.playerId] === proposal.id;
 const div = document.createElement("div");
 div.className = "vote-item" + (myVote ? " voted" : "");
 div.innerHTML =
 '<div class="vote-move">' + toAlgebraic(proposal.from) + " → " + toAlgebraic(proposal.to) + "</div>" +
 '<div class="flex items-center gap-2">' +
 '<span class="vote-count">' + proposal.votes + " vote" + (proposal.votes !== 1 ? "s" : "") + "</span>" +
 '<button class="btn ' + (myVote ? "btn-primary" : "btn-secondary") + ' btn-sm" data-proposal-id="' + proposal.id + '">' +
 (myVote ? "✓" : "Vote") +
 "</button>" +
 "</div>";
 const btn = div.querySelector("button");
 btn.addEventListener("click", () => {
 if (gameMgr.module.voteForProposal) {
 gameMgr.module.voteForProposal(proposal.id, state.playerId, gameMgr.state);
 }
 });
 voteList.appendChild(div);
 }
}

// Set up P2P connections
function setupP2P() {
 const p2p = new P2PClient(state.playerId, state.hostId, state.players, state.iceConfig);

 p2p.onMessage = (peerId, msg) => {
 // Chat messages: public goes to everyone, team only goes to same-team players
 if (msg.type === "chat") {
 if (msg.channel === "team") {
 // Only display if we're on the same team as the sender
 const myTeam = state.gameState?.data?.playerTeams?.[state.playerId];
 if (myTeam && myTeam === msg.senderTeam) {
 displayChatMessage(msg.playerName, msg.message, "team", msg.senderTeam);
 }
 } else {
 // Public chat everyone sees it
 displayChatMessage(msg.playerName, msg.message, "public", msg.senderTeam);
 }
 return;
 }
 if (p2p.isHost) {
 if (msg.type === "input") {
 gameMgr.pendingInputs[msg.playerId] = msg.input;
 }
 } else {
 if (msg.type === "game-state") {
 gameMgr.receiveState(msg.state, msg.tick);
 }
 if (msg.type === "match-over") {
 gameMgr.receiveMatchOver(msg.winner, msg.winnerName);
 }
 }
 };

 p2p.onPeerConnected = (peerId) => {
 console.log("[P2P] Peer connected:", peerId.slice(0, 8));
 if (!p2p.isHost) {
 sendToServer({ type: "p2p-ready" });
 }
 };

 p2p.onAllConnected = () => {
 console.log("[P2P] All peers connected full mesh established.");
 sendToServer({ type: "p2p-ready" });
 state.p2pConnected = true;
 };

 state.p2pClient = p2p;

 if (p2p.isHost) {
 // Host waits for incoming offers from clients
 console.log("[P2P] Host waiting for offers...");
 } else {
 // Each client connects to ALL other peers (full mesh) for robust routing.
 // The host connection is the most important (for game state).
 p2p.connectToPeer(state.hostId).catch(e => {
 console.error("[P2P] connection error to host:", e);
 showToast("P2P connection failed check your network", "error");
 });
 // Also connect to other non-host peers for mesh routing redundancy
 for (const player of state.players) {
 if (player.id !== state.playerId && player.id !== state.hostId) {
 p2p.connectToPeer(player.id).catch(e => {
 console.warn("[P2P] mesh connection to", player.id.slice(0, 8), "failed:", e);
 });
 }
 }
 }
}

// ─=== Archive (LOCAL-ONLY STORAGE) ═══════════════════════════════════════════
//
// As of v0.4, replays are stored LOCALLY in the player's browser via
// localStorage. They are NOT uploaded to the server, so each user only
// sees their own match history in the Archive tab. Auto-numbering uses
// a localStorage counter ("Match 1", "Match 2", ...) and the user can
// rename any of their own matches freely.
//
// The actual storage helpers live in /ui/local-archive.js (imported above)
// so they can be unit-tested via Deno. This file just contains the
// archive UI rendering + the rename prompt flow.

async function initArchive() {
 // Read replays from localStorage. Each user only sees their own
 // matches  nothing is fetched from the server.
 const replays = loadLocalReplays();

 if (!replays || replays.length === 0) {
 dom.replayList.innerHTML =
 '<div class="text-center py-16 text-muted font-mono">' +
 "<div class='text-3xl mb-2'>📦</div>" +
 "<p>NO REPLAYS FOUND</p>" +
 "<p class='text-sm mt-2'>Finish a match to see replays here.</p>" +
 "</div>";
 return;
 }

 dom.replayList.innerHTML = "";
 replays.forEach(replay => {
 const date = new Date(replay.createdAt);
 const dateStr = date.toLocaleDateString("en-US", {
 month: "short", day: "numeric", year: "numeric",
 hour: "2-digit", minute: "2-digit",
 });
 const duration = formatDuration(replay.duration);
 const winnerName = replay.winnerName || replay.winner?.slice(0, 8) || "???";
 // Display the title (auto-assigned as "Match N" by the client on save,
 // or whatever the user renamed it to).
 const title = (replay.title && String(replay.title).trim().length > 0)
 ? String(replay.title)
 : "Match";

 const div = document.createElement("div");
 div.className =
 "card border border-border rounded-lg p-4 " +
 "cursor-pointer group transition-all duration-200 " +
 "hover:border-gold hover:shadow-lg";
 div.innerHTML =
 "<div class='flex items-center justify-between'>" +
 "<div class='flex-1'>" +
 "<div class='flex items-center space-x-3'>" +
 "<span class='text-gold font-bold font-display text-lg'>▶</span>" +
 "<div class='flex-1 min-w-0'>" +
 // Title is the primary heading; winner is the secondary line
 "<div class='font-bold text-text truncate'>" + escapeHTML(title) + "</div>" +
 "<div class='text-sm text-muted font-mono'>" +
 escapeHTML(winnerName) + " won · " + dateStr + " · " + duration + " · " +
 (replay.players?.length || 0) + " players" +
 "</div>" +
 "</div></div></div>" +
 "<div class='flex items-center gap-2 shrink-0'>" +
 // All local replays belong to the current user, so they can all be renamed.
 "<button class='btn btn-ghost btn-sm replay-rename-btn' data-replay-id='" +
 escapeHTML(replay.replayId) + "' data-current-title='" + escapeHTML(title) +
 "'>Rename</button>" +
 "<span class='text-xs text-gold font-mono bg-surface px-2 py-1 rounded'>" +
 escapeHTML(replay.gameModule || "chess-royale") + "</span>" +
 "</div></div>";
 // Click anywhere on the card launches the replay, EXCEPT on the
 // Rename button (so users can click rename without launching playback).
 div.addEventListener("click", (e) => {
 if (e.target && e.target.closest && e.target.closest(".replay-rename-btn")) return;
 playReplay(replay);
 });
 dom.replayList.appendChild(div);
 });

 // Wire up the rename buttons.
 dom.replayList.querySelectorAll(".replay-rename-btn").forEach(btn => {
 btn.addEventListener("click", (e) => {
 e.stopPropagation();
 const replayId = btn.getAttribute("data-replay-id");
 const currentTitle = btn.getAttribute("data-current-title") || "";
 handleRenameReplay(replayId, currentTitle);
 });
 });
}

/**
 * Prompt for a new title and update the local replay in-place.
 * No server round-trip  the rename is purely client-side.
 */
async function handleRenameReplay(replayId, currentTitle) {
 const input = window.prompt("Rename this match:", currentTitle);
 if (input === null) return; // user cancelled
 const newTitle = String(input).trim().slice(0, 80);
 if (newTitle.length === 0) {
 showToast("Title can't be empty", "error");
 return;
 }
 if (newTitle === currentTitle) return; // no change
 if (renameLocalReplay(replayId, newTitle)) {
 showToast("Match renamed", "success");
 archiveNeedsRefresh = true;
 initArchive();
 } else {
 showToast("Match not found in your local archive", "error");
 }
}

async function playReplay(replay) {
 showLoading("Loading replay...");
 dom.replayList.classList.add("hidden");
 dom.replayViewer.classList.remove("hidden");
 // Header shows the match title (e.g. "Match 3" or a renamed title) plus
 // the winner as a secondary hint, so users can find the match they want.
 const matchTitle = (replay.title && String(replay.title).trim().length > 0)
 ? String(replay.title)
 : "Match";
 dom.replayTitle.textContent = matchTitle + " · " + (replay.winnerName || "Unknown") + " won";

 const gameModulePath = "/games/" + (replay.gameModule || "chess-royale") + "/mod.js";
 let mod;
 try {
 if (gameMgr.module && gameMgr.module.metadata?.id === replay.gameModule) {
 mod = gameMgr.module;
 } else {
 const imported = await import(gameModulePath);
 mod = imported.default || imported;
 }
 } catch (e) {
 console.error("Failed to load game module for replay:", e);
 showToast("Failed to load game module", "error");
 hideLoading();
 return;
 }

 let states;
 try {
 states = mod.loadReplay(replay);
 } catch (e) {
 console.error("Failed to load replay:", e);
 showToast("Failed to load replay data", "error");
 hideLoading();
 return;
 }

 const replayCanvas = document.getElementById("replay-canvas");
 if (!replayCanvas) { hideLoading(); return; }
 const wrapper = replayCanvas.parentElement;
 wrapper.innerHTML = '<canvas id="replay-canvas" width="800" height="600" class="bg-black w-full max-w-full"></canvas>';
 const canvas = document.getElementById("replay-canvas");
 const ctx = canvas.getContext("2d");

 hideLoading();

 let playing = true;
 let frame = 0;
 let speed = 1;
 let lastTime = 0;
 const fps = 30;

 let controlsDiv = document.getElementById("replay-controls");
 if (controlsDiv) controlsDiv.remove();
 controlsDiv = document.createElement("div");
 controlsDiv.id = "replay-controls";
 controlsDiv.className = "mt-4 flex items-center justify-center space-x-6 flex-wrap gap-3";
 controlsDiv.innerHTML =
 '<button id="replay-playpause" class="btn btn-primary btn-sm">⏸ PAUSE</button>' +
 '<div class="text-muted font-mono text-sm">' +
 '<span id="replay-frame">1</span> / <span id="replay-total">' + states.length + "</span></div>" +
 '<div class="flex items-center space-x-2">' +
 '<span class="text-muted text-sm">Speed:</span>' +
 '<select id="replay-speed" class="bg-surface border border-border rounded px-2 py-1 text-text font-mono text-sm">' +
 '<option value="0.5">0.5x</option>' +
 '<option value="1" selected>1x</option>' +
 '<option value="2">2x</option>' +
 '<option value="4">4x</option>' +
 '</select></div>' +
 '<input id="replay-scrub" type="range" min="0" max="' + (states.length - 1) + '" value="0" class="w-48">';
 wrapper.appendChild(controlsDiv);

 const playPauseBtn = document.getElementById("replay-playpause");
 const speedSelect = document.getElementById("replay-speed");
 const scrub = document.getElementById("replay-scrub");
 const frameEl = document.getElementById("replay-frame");
 const totalEl = document.getElementById("replay-total");
 totalEl.textContent = states.length;

 playPauseBtn.addEventListener("click", () => {
 playing = !playing;
 playPauseBtn.textContent = playing ? "⏸ PAUSE" : "▶ PLAY";
 });

 speedSelect.addEventListener("change", (e) => {
 speed = parseFloat(e.target.value);
 });

 scrub.max = states.length - 1;
 scrub.addEventListener("input", (e) => {
 frame = parseInt(e.target.value, 10);
 playing = false;
 playPauseBtn.textContent = "▶ PLAY";
 });

 function render(timestamp) {
 if (!lastTime) lastTime = timestamp;
 const deltaTime = timestamp - lastTime;

 if (playing && deltaTime > 1000 / (fps * speed)) {
 frame = Math.min(frame + 1, states.length - 1);
 lastTime = timestamp;
 }

 const s = states[frame];
 if (s) {
 mod.render(ctx, s, null, canvas.width, canvas.height);
 }

 frameEl.textContent = frame + 1;
 scrub.value = frame;

 requestAnimationFrame(render);
 }
 requestAnimationFrame(render);
}

function formatDuration(ms) {
 const total = Math.floor(ms / 1000);
 const m = Math.floor(total / 60);
 const s = total % 60;
 return m + ":" + s.toString().padStart(2, "0");
}

// ─=== Main Initialization ═══════════════════════════════════════════════════

// Expose helpers for the lobbies/auth/admin UI modules
window.__tgn_send = sendToServer;
window.__tgn_getSocket = () => state.signalingSocket;
window.__tgn_fetchWithCSRF = fetchWithCSRF;
window.__tgn_getCSRFToken = () => state.csrfToken;

// Handle requests from lobby UI to open the socket
window.addEventListener("tgn:need-socket", () => {
 if (!state.signalingSocket || state.signalingSocket.readyState !== WebSocket.OPEN) {
 state.signalingSocket = createSignalingSocket(handleSignalingMessage);
 }
});

// Handle requests to show the auth modal
window.addEventListener("tgn:show-auth", () => {
 auth.showModal("login");
});

async function main() {
 showLoading("Loading...");

 // Load auth module
 auth.init();
 auth.onUserChange((user) => {
 window.__tgn_user = user;
 if (user) {
 state.userId = user.id;
 state.isAdmin = (user.role === "admin");
 // Show/hide admin nav link
 if (dom.navAdmin) {
 dom.navAdmin.classList.toggle("hidden", !state.isAdmin);
 }
 // Use account username as display name if not already set
 if (!state.playerName) {
 state.playerName = user.username;
 localStorage.setItem("tgn_playerName", state.playerName);
 window.__tgn_playerName = state.playerName;
 if (dom.playerInfo) dom.playerInfo.textContent = state.playerName;
 hideUsernameScreen();
 }
 } else {
 state.userId = null;
 state.isAdmin = false;
 state.csrfToken = null;
 if (dom.navAdmin) dom.navAdmin.classList.add("hidden");
 }
 });

 // Fetch CSRF token (will be set if logged in)
 try {
  // Firebase auth handles authentication - no CSRF needed

 // Initialize player name from localStorage
 initPlayer();

 // Initialize lobby browser module
 lobbies.init({
 send: sendToServer,
 getSignalingSocket: () => state.signalingSocket,
 onJoinedLobby: (lobby, iceConfig) => {
 handleLobbyStateUpdate(lobby, iceConfig);
 },
 onGameStart: (msg) => {
 handleGameStart(msg);
 },
 });

 // Initialize admin module
 admin.init({
 fetchWithCSRF: fetchWithCSRF,
 getCSRFToken: () => state.csrfToken,
 });

 // Load game config
 let gameConfig;
 try {
 const configRes = await fetch("/game-config.json");
 gameConfig = await configRes.json();
 } catch (e) {
 console.error("Failed to load game config:", e);
 gameConfig = { gameId: "chess-royale", gameModulePath: "/games/chess-royale/mod.js", gameName: "Chess Royale", maxPlayers: 20 };
 }

 setLoadingText("loading game module...");
 try {
 await gameMgr.loadGameModule(gameConfig.gameModulePath);
 } catch (e) {
 console.error("Failed to load game module:", e);
 showToast("Failed to load game module: " + e.message, "error");
 }

 state.gameConfig = gameConfig;
 dom.playerInfo.textContent = state.playerName + " · " + gameConfig.gameName;

 // Set game name and description dynamically from config
 const gameNameEl = document.getElementById("game-name");
 const gameDescEl = document.getElementById("game-description");
 if (gameNameEl) gameNameEl.textContent = gameConfig.gameName || "Unknown Game";
 if (gameDescEl) gameDescEl.textContent = gameConfig.description || "";

 // Set canvas dimensions from config
 if (gameConfig.canvasWidth && gameConfig.canvasHeight && dom.gameCanvas) {
 dom.gameCanvas.width = gameConfig.canvasWidth;
 dom.gameCanvas.height = gameConfig.canvasHeight;
 }

 gameMgr.setupKeyboard();
 gameMgr.setupMouse();
 initRouter();

 // Wire up chat
 const chatSendBtn = document.getElementById("chat-send-btn");
 const chatInput = document.getElementById("chat-input");
 if (chatSendBtn) chatSendBtn.addEventListener("click", sendChat);
 if (chatInput) {
 chatInput.addEventListener("keydown", (e) => {
 if (e.key === "Enter") {
 e.preventDefault();
 sendChat();
 }
 });
 }
 // Chat tab switching
 const chatTabPublic = document.getElementById("chat-tab-public");
 const chatTabTeam = document.getElementById("chat-tab-team");
 if (chatTabPublic) chatTabPublic.addEventListener("click", () => switchChatChannel("public"));
 if (chatTabTeam) chatTabTeam.addEventListener("click", () => switchChatChannel("team"));

 // ─── Wire up buttons ───
 dom.findMatchBtn.addEventListener("click", handleFindMatchClick);
 dom.playSoloBtn.addEventListener("click", handlePlaySoloClick);

 // "Create new" lobby button (in the quick-lobbies panel)
 const quickCreateBtn = document.getElementById("quick-create-btn");
 if (quickCreateBtn) {
 quickCreateBtn.addEventListener("click", () => {
 if (!state.signalingSocket || state.signalingSocket.readyState !== WebSocket.OPEN) {
 showToast("Connecting to server...", "info");
 return;
 }
 const lobbyName = state.playerName + "'s Lobby";
 sendToServer({
 type: "create-lobby",
 name: lobbyName,
 gameId: state.gameConfig?.gameId || "chess-royale",
 lobbyType: "open",
 maxPlayers: 10,
 minPlayers: 2,
 hostName: state.playerName,
 });
 showToast("Creating lobby...", "info");
 });
 }
 dom.setUsernameBtn.addEventListener("click", setUsername);
 dom.usernameInput.addEventListener("keydown", (e) => {
 if (e.key === "Enter") setUsername();
 });
 dom.viewReplayBtn.addEventListener("click", () => {
 archiveNeedsRefresh = true;
 window.location.hash = "#/archive";
 });
 dom.backToLobbyBtn.addEventListener("click", () => {
 state.eliminated = false;
 dom.eliminationOverlay.classList.remove("active");
 dom.gameScreen.classList.add("hidden");
 dom.findMatchScreen.classList.remove("hidden");
 });
 dom.leaveLobbyBtn.addEventListener("click", leaveCurrentLobby);
 dom.startMatchBtn.addEventListener("click", () => {
 sendToServer({ type: "start-match" });
 showToast("Starting match...", "info");
 });

 // Copy invite link button
 const copyInviteBtn = document.getElementById("copy-invite-btn");
 if (copyInviteBtn) {
 copyInviteBtn.addEventListener("click", () => {
 const inviteLink = document.getElementById("lobby-invite-link");
 if (inviteLink) {
 inviteLink.select();
 try {
 navigator.clipboard.writeText(inviteLink.value);
 showToast("Link copied! Share it with friends.", "success");
 } catch {
 document.execCommand("copy");
 showToast("Link copied!", "success");
 }
 }
 });
 }

 dom.playerInfo.addEventListener("click", changeUsername);
 dom.playerInfo.style.cursor = "pointer";
 dom.playerInfo.title = "click to change name";

 if (state.playerName) {
 dom.playerInfo.textContent = state.playerName;
 }

 hideLoading();
 showToast("ready. click 'find match' to play.", "info");
}

// Start the app
main().catch((e) => {
 console.error("main() failed:", e);
 hideLoading();
 showToast("Failed to start: " + e.message, "error");
});
