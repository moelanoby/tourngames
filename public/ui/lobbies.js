/**
 * lobbies.js Lobby Browser UI module
 *
 * Renders the list of open lobbies, the create-lobby form, and the
 * lobby detail view (with signups). Sends WebSocket messages via the
 * callback registered by app.js.
 *
 * Public API:
 * lobbies.init({ send, getSignalingSocket, onJoinedLobby })
 * lobbies.refresh() request fresh lobby list from server
 * lobbies.renderLobbyList(list) render a list of lobby summaries
 * lobbies.showDetail(lobbyId) show detail view for a lobby
 * lobbies.hideDetail() back to list
 * lobbies.handleLobbyState(msg) handle lobby-state / game-start pushes
 * lobbies.getCurrentLobbyId() the lobby the local player is currently in
 */

const dom = {};
let sendFn = null;
let getSocketFn = null;
let onJoinedLobbyFn = null;
let onGameStartFn = null;
let currentLobbyId = null;
let currentDetailLobbyId = null;
let knownLobbies = [];
let createFormOpen = false;

export function init(opts = {}) {
 sendFn = opts.send || (() => {});
 getSocketFn = opts.getSignalingSocket || (() => null);
 onJoinedLobbyFn = opts.onJoinedLobby || (() => {});
 onGameStartFn = opts.onGameStart || (() => {});

 cacheDom();
 bindEvents();
}

function cacheDom() {
 dom.list = document.getElementById("lobby-browser-list");
 dom.createBtn = document.getElementById("create-lobby-btn");
 dom.createForm = document.getElementById("create-lobby-form");
 dom.confirmCreate = document.getElementById("confirm-create-lobby");
 dom.cancelCreate = document.getElementById("cancel-create-lobby");
 dom.createName = document.getElementById("create-name");
 dom.createGame = document.getElementById("create-game");
 dom.createType = document.getElementById("create-type");
 dom.createMin = document.getElementById("create-min");
 dom.createMax = document.getElementById("create-max");

 dom.detail = document.getElementById("lobby-detail");
 dom.detailName = document.getElementById("detail-name");
 dom.detailMeta = document.getElementById("detail-meta");
 dom.detailPlayers = document.getElementById("detail-players");
 dom.detailSignups = document.getElementById("detail-signups");
 dom.detailJoinBtn = document.getElementById("detail-join-btn");
 dom.detailInviteInput = document.getElementById("detail-invite-input");
 dom.detailInviteCode = document.getElementById("detail-invite-code");
 dom.detailJoinWithCode = document.getElementById("detail-join-with-code");
 dom.detailBackBtn = document.getElementById("detail-back-btn");
 dom.detailSignupBtn = document.getElementById("detail-signup-btn");
 dom.detailCancelSignupBtn = document.getElementById("detail-cancel-signup-btn");
 dom.detailSignupNote = document.getElementById("detail-signup-note");
 dom.detailStartMatchBtn = document.getElementById("detail-start-match-btn");
 dom.detailJoinSection = document.getElementById("detail-join-section");

 // Top-level "browse lobbies" link inside the game section
 dom.browseLink = document.getElementById("browse-lobbies-link");
}

function bindEvents() {
 if (dom.createBtn) {
 dom.createBtn.addEventListener("click", () => {
 createFormOpen = !createFormOpen;
 dom.createForm.classList.toggle("hidden", !createFormOpen);
 if (createFormOpen) dom.createName.focus();
 });
 }
 if (dom.cancelCreate) {
 dom.cancelCreate.addEventListener("click", () => {
 createFormOpen = false;
 dom.createForm.classList.add("hidden");
 });
 }
 if (dom.confirmCreate) {
 dom.confirmCreate.addEventListener("click", handleCreate);
 }
 if (dom.detailBackBtn) {
 dom.detailBackBtn.addEventListener("click", hideDetail);
 }
 if (dom.detailJoinBtn) {
 dom.detailJoinBtn.addEventListener("click", () => handleJoinClick(false));
 }
 if (dom.detailJoinWithCode) {
 dom.detailJoinWithCode.addEventListener("click", () => handleJoinClick(true));
 }
 if (dom.detailSignupBtn) {
 dom.detailSignupBtn.addEventListener("click", handleSignup);
 }
 if (dom.detailCancelSignupBtn) {
 dom.detailCancelSignupBtn.addEventListener("click", handleCancelSignup);
 }
 if (dom.detailStartMatchBtn) {
 dom.detailStartMatchBtn.addEventListener("click", handleStartMatch);
 }
 if (dom.browseLink) {
 dom.browseLink.addEventListener("click", () => {
 window.location.hash = "#/lobbies";
 });
 }
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

export function refresh() {
 // Try HTTP first (works without an open WebSocket)
 fetch("/api/lobbies", { credentials: "include" })
 .then((r) => r.json())
 .then((data) => {
 if (data && data.lobbies) {
 knownLobbies = data.lobbies;
 renderLobbyList(knownLobbies);
 }
 })
 .catch((e) => console.warn("lobby refresh failed:", e));

 // Also ask via WebSocket if connected
 const ws = getSocketFn && getSocketFn();
 if (ws && ws.readyState === WebSocket.OPEN) {
 sendFn({ type: "list-lobbies" });
 }
}

// ─── Render: Lobby List ──────────────────────────────────────────────────────

export function renderLobbyList(list) {
 if (!dom.list) return;
 knownLobbies = list || knownLobbies;

 if (!knownLobbies || knownLobbies.length === 0) {
 dom.list.innerHTML = `
 <div class="text-center py-16 text-muted">
 <div class="text-4xl mb-4">🎮</div>
 <p class="font-mono">NO OPEN LOBBIES</p>
 <p class="text-sm mt-2">Create one above to get started.</p>
 </div>
 `;
 return;
 }

 dom.list.innerHTML = "";
 for (const lobby of knownLobbies) {
 const card = document.createElement("div");
 card.className =
 "card p-4 cursor-pointer group transition-all duration-200 " +
 "hover:border-gold hover:shadow-lg hover:shadow-yellow-500/5";

 const typeBadge = renderTypeBadge(lobby.type);
 const statusBadge = renderStatusBadge(lobby.status);
 const isFull = lobby.playerCount >= lobby.maxPlayers;
 const isPlaying = lobby.status === "playing" || lobby.status === "starting";

 card.innerHTML = `
 <div class="flex items-center justify-between gap-3 flex-wrap">
 <div class="flex-1 min-w-0">
 <div class="flex items-center gap-2 mb-1 flex-wrap">
 <span class="font-bold text-text truncate">${escapeHtml(lobby.name)}</span>
 ${typeBadge}
 ${statusBadge}
 </div>
 <div class="text-sm text-muted font-mono">
 ${escapeHtml(lobby.hostName || " ")} · ${escapeHtml(lobby.gameId)} · ${lobby.playerCount}/${lobby.maxPlayers} players
 ${lobby.signupCount > 0 ? ` · ${lobby.signupCount} signed up` : ""}
 </div>
 </div>
 <div class="text-right">
 ${isPlaying
 ? `<span class="text-xs text-danger font-mono">in progress</span>`
 : isFull
 ? `<span class="text-xs text-muted font-mono">FULL</span>`
 : `<span class="text-xs text-ok font-mono">OPEN</span>`}
 </div>
 </div>
 `;
 card.addEventListener("click", () => showDetail(lobby.id));
 dom.list.appendChild(card);
 }
}

function renderTypeBadge(type) {
 if (type === "signup") return `<span class="badge badge-signup">SIGNUP</span>`;
 if (type === "private") return `<span class="badge badge-private">PRIVATE</span>`;
 return `<span class="badge badge-open">OPEN</span>`;
}

function renderStatusBadge(status) {
 if (status === "playing") return `<span class="badge badge-playing">PLAYING</span>`;
 if (status === "starting") return `<span class="badge badge-playing">STARTING</span>`;
 return `<span class="badge badge-waiting">WAITING</span>`;
}

// ─── Create Lobby ────────────────────────────────────────────────────────────

function handleCreate() {
 const name = dom.createName.value.trim() || "Untitled Lobby";
 const gameId = dom.createGame.value;
 const type = dom.createType.value;
 const minPlayers = Math.max(2, parseInt(dom.createMin.value, 10) || 2);
 const maxPlayers = Math.max(minPlayers, parseInt(dom.createMax.value, 10) || 10);

 // Pull player name from the global app state
 const playerName = window.__tgn_playerName || "Host";

 // Send via WebSocket if available, else HTTP
 const ws = getSocketFn && getSocketFn();
 if (ws && ws.readyState === WebSocket.OPEN) {
 sendFn({
 type: "create-lobby",
 name,
 gameId,
 lobbyType: type,
 maxPlayers,
 minPlayers,
 hostName: playerName,
 });
 } else {
 // HTTP create (won't auto-join, but useful for setup)
 const fetchFn = window.__tgn_fetchWithCSRF || fetch;
 fetchFn("/api/lobbies", {
 method: "POST",
 body: JSON.stringify({ name, gameId, type, maxPlayers, minPlayers, hostName: playerName }),
 })
 .then((r) => r.json())
 .then((data) => {
 if (data.lobby) {
 showToast("Lobby created. Connect to matchmaking to join it.", "success");
 refresh();
 } else {
 showToast(data.error || "Failed to create lobby", "error");
 }
 })
 .catch((e) => showToast("Network error: " + e.message, "error"));
 }

 // Close form
 createFormOpen = false;
 dom.createForm.classList.add("hidden");
 showToast("Creating lobby...", "info");
}

// ─── Detail View ─────────────────────────────────────────────────────────────

export async function showDetail(lobbyId) {
 currentDetailLobbyId = lobbyId;
 dom.list.classList.add("hidden");
 dom.createForm.classList.add("hidden");
 createFormOpen = false;
 dom.detail.classList.remove("hidden");

 // Fetch full lobby
 try {
 const res = await fetch(`/api/lobbies/${lobbyId}`, { credentials: "include" });
 const data = await res.json();
 if (data.lobby) {
 renderDetail(data.lobby);
 } else {
 showToast(data.error || "Lobby not found", "error");
 hideDetail();
 }
 } catch (e) {
 showToast("Failed to load lobby: " + e.message, "error");
 hideDetail();
 }
}

export function hideDetail() {
 dom.detail.classList.add("hidden");
 dom.list.classList.remove("hidden");
 currentDetailLobbyId = null;
}

function renderDetail(lobby) {
 dom.detailName.textContent = lobby.name;
 dom.detailMeta.textContent =
 `${lobby.gameId} · ${lobby.type} · ${lobby.players.length}/${lobby.maxPlayers} players`;

 // Players
 dom.detailPlayers.innerHTML = "";
 if (lobby.players.length === 0) {
 dom.detailPlayers.innerHTML = `<p class="text-sm text-muted">No players in lobby yet.</p>`;
 } else {
 for (const p of lobby.players) {
 const isHost = p.id === lobby.hostId;
 const div = document.createElement("div");
 div.className = "flex items-center justify-between p-2 bg-surface rounded border border-border";
 div.innerHTML = `
 <div class="flex items-center gap-2">
 <div class="w-2 h-2 rounded-full ${isHost ? "bg-gold" : "bg-ok"}"></div>
 <span class="font-mono text-sm text-text">${escapeHtml(p.name)}</span>
 ${isHost ? '<span class="badge badge-signup">HOST</span>' : ""}
 </div>
 <span class="text-xs ${p.connected ? "text-ok" : "text-muted"} font-mono">
 ${p.connected ? "ONLINE" : "OFFLINE"}
 </span>
 `;
 dom.detailPlayers.appendChild(div);
 }
 }

 // Signups
 if (lobby.type === "signup") {
 dom.detailSignups.parentElement.classList.remove("hidden");
 dom.detailSignups.innerHTML = "";
 if (lobby.signups.length === 0) {
 dom.detailSignups.innerHTML = `<p class="text-sm text-muted">No signups yet.</p>`;
 } else {
 for (const s of lobby.signups) {
 const div = document.createElement("div");
 div.className = "flex items-center justify-between p-2 bg-surface rounded border border-border";
 div.innerHTML = `
 <span class="font-mono text-sm text-text">${escapeHtml(s.username)}</span>
 <span class="text-xs text-muted">${new Date(s.signedUpAt).toLocaleDateString()}</span>
 `;
 dom.detailSignups.appendChild(div);
 }
 }

 // Check if current user is signed up
 const user = window.__tgn_user;
 const isSignedUp = user && lobby.signups.some((s) => s.userId === user.id);
 dom.detailSignupBtn.classList.toggle("hidden", isSignedUp);
 dom.detailCancelSignupBtn.classList.toggle("hidden", !isSignedUp);

 if (!user) {
 dom.detailSignupNote.textContent = "Log in to sign up for this tournament.";
 } else if (lobby.signups.length >= lobby.maxPlayers) {
 dom.detailSignupNote.textContent = "Signups are full.";
 } else {
 dom.detailSignupNote.textContent = "";
 }
 } else {
 dom.detailSignups.parentElement.classList.add("hidden");
 }

 // Join button / invite code
 const isPrivate = lobby.type === "private";
 dom.detailInviteInput.classList.toggle("hidden", !isPrivate);
 if (isPrivate) {
 dom.detailJoinBtn.classList.add("hidden");
 } else {
 dom.detailJoinBtn.classList.remove("hidden");
 const isFull = lobby.players.length >= lobby.maxPlayers;
 const isPlaying = lobby.status === "playing" || lobby.status === "starting";
 dom.detailJoinBtn.disabled = isFull || isPlaying;
 dom.detailJoinBtn.textContent = isPlaying ? "match in progress" : isFull ? "lobby full" : "join lobby";
 }

 // Start match button (only visible to host we don't know yet, so we show it always and server validates)
 const user = window.__tgn_user;
 const isHost = lobby.hostUserId && user && lobby.hostUserId === user.id;
 dom.detailStartMatchBtn.disabled = !isHost || lobby.players.length < lobby.minPlayers;
 dom.detailStartMatchBtn.title = !isHost
 ? "Only the host can start the match"
 : lobby.players.length < lobby.minPlayers
 ? `Need at least ${lobby.minPlayers} players`
 : "";
}

// ─── Join Lobby ──────────────────────────────────────────────────────────────

function handleJoinClick(useInviteCode) {
 if (!currentDetailLobbyId) return;
 const playerName = window.__tgn_playerName || "Player";
 const inviteCode = useInviteCode ? dom.detailInviteCode.value.trim().toUpperCase() : undefined;

 // Make sure WebSocket is connected (app.js exposes it)
 const ws = getSocketFn && getSocketFn();
 if (!ws || ws.readyState !== WebSocket.OPEN) {
 showToast("Connecting to server...", "info");
 // The app.js will need to open the socket we request it via a custom event
 window.dispatchEvent(new CustomEvent("tgn:need-socket"));
 // Defer join
 setTimeout(() => handleJoinClick(useInviteCode), 1000);
 return;
 }

 sendFn({
 type: "join-specific",
 lobbyId: currentDetailLobbyId,
 playerName,
 inviteCode,
 });
 showToast("Joining lobby...", "info");
}

// ─── Signups ─────────────────────────────────────────────────────────────────

async function handleSignup() {
 if (!currentDetailLobbyId) return;
 const user = window.__tgn_user;
 if (!user) {
 showToast("Log in to sign up", "error");
 window.dispatchEvent(new CustomEvent("tgn:show-auth"));
 return;
 }
 try {
 const fetchFn = window.__tgn_fetchWithCSRF || fetch;
 const res = await fetchFn(`/api/lobbies/${currentDetailLobbyId}/signup`, {
 method: "POST",
 });
 const data = await res.json();
 if (!res.ok) {
 showToast(data.error || "Signup failed", "error");
 return;
 }
 showToast("Signed up", "success");
 renderDetail(data.lobby);
 } catch (e) {
 showToast("Network error: " + e.message, "error");
 }
}

async function handleCancelSignup() {
 if (!currentDetailLobbyId) return;
 try {
 const fetchFn = window.__tgn_fetchWithCSRF || fetch;
 const res = await fetchFn(`/api/lobbies/${currentDetailLobbyId}/signup`, {
 method: "DELETE",
 });
 const data = await res.json();
 if (!res.ok) {
 showToast(data.error || "Cancel failed", "error");
 return;
 }
 showToast("Signup cancelled", "info");
 renderDetail(data.lobby);
 } catch (e) {
 showToast("Network error: " + e.message, "error");
 }
}

// ─── Start Match ─────────────────────────────────────────────────────────────

function handleStartMatch() {
 if (!currentDetailLobbyId) return;
 const ws = getSocketFn && getSocketFn();
 if (!ws || ws.readyState !== WebSocket.OPEN) {
 showToast("Not connected to server", "error");
 return;
 }
 sendFn({ type: "start-match" });
 showToast("Starting match...", "info");
}

// ─── Lobby State Push (from WebSocket) ───────────────────────────────────────

export function handleLobbyState(msg) {
 // If we're in a lobby (game section), update the in-lobby view
 if (msg.type === "lobby-state" && msg.lobby) {
 currentLobbyId = msg.lobby.id;
 window.__tgn_currentLobby = msg.lobby;
 if (onJoinedLobbyFn) onJoinedLobbyFn(msg.lobby, msg.iceConfig);
 // If detail view is showing this lobby, refresh it
 if (currentDetailLobbyId === msg.lobby.id) {
 renderDetail(msg.lobby);
 }
 return;
 }

 if (msg.type === "game-start") {
 if (onGameStartFn) onGameStartFn(msg);
 return;
 }

 if (msg.type === "lobby-list") {
 renderLobbyList(msg.lobbies);
 return;
 }
}

export function getCurrentLobbyId() {
 return currentLobbyId;
}

export function setCurrentLobbyId(id) {
 currentLobbyId = id;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
 return String(str || "")
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
}

function showToast(message, type) {
 window.__tgn_showToast && window.__tgn_showToast(message, type);
}
