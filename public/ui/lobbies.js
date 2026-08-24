/**
 * lobbies.js - Lobby Browser UI Module (Firebase Version)
 *
 * Uses Firebase Realtime Database for lobby management.
 * No server API needed - everything through Firebase SDK.
 */

import {
  createLobby as fbCreateLobby,
  joinLobby as fbJoinLobby,
  startMatch as fbStartMatch,
  updateLobby as fbUpdateLobby,
  cleanupStaleLobbies,
  leaveLobby as fbLeaveLobby,
  onLobbyListChange,
  onLobbyChange,
  sendSignal,
  onSignal,
  sendChatMessage,
  onChatMessages,
  saveGameState,
  getCurrentUser,
  updatePresence,
  sendLobbyMessage,
  onLobbyMessages,
} from "./firebase.js?v=20260924g";

const dom = {};
let currentLobbyId = null;
let currentDetailLobbyId = null;
let knownLobbies = [];
let createFormOpen = false;
let unsubLobbyList = null;
let unsubLobby = null;

// ─── Init ────────────────────────────────────────────────────────────────────

export function init(opts = {}) {
  cacheDom();
  bindEvents();
  updateNamePlaceholder();
  // Start listening to lobby list from Firebase
  startLobbyListListener();
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
  dom.createVotingTime = document.getElementById("create-voting-time");
  dom.createMatchTime = document.getElementById("create-match-time");
  dom.detailTimerSection = document.getElementById("detail-timer-section");
  dom.detailVotingTime = document.getElementById("detail-voting-time");
  dom.detailMatchTime = document.getElementById("detail-match-time");
  dom.detailSaveTimersBtn = document.getElementById("detail-save-timers-btn");
  dom.createVotingTime = document.getElementById("create-voting-time");
  dom.createMatchTime = document.getElementById("create-match-time");

  dom.detail = document.getElementById("lobby-detail");
  dom.detailName = document.getElementById("detail-name");
  dom.detailMeta = document.getElementById("detail-meta");
  dom.detailPlayers = document.getElementById("detail-players");
  dom.detailSignups = document.getElementById("detail-signups");
  dom.detailJoinBtn = document.getElementById("detail-join-btn");
  dom.detailLeaveBtn = document.getElementById("detail-leave-btn");
  dom.detailInviteInput = document.getElementById("detail-invite-input");
  dom.detailJoinSection = document.getElementById("detail-join-section");
  dom.detailBackBtn = document.getElementById("detail-back-btn");
  dom.detailStartMatchBtn = document.getElementById("detail-start-match-btn");
  dom.browseLink = document.getElementById("browse-lobbies-link");
}

/**
 * Show the real username in the create-form placeholder,
 * e.g. "wawa's lobby :D!". Falls back to {Username} until we know a name.
 */
export function updateNamePlaceholder(username) {
  if (!dom.createName) return;
  const name = username || getCurrentUser()?.displayName || "";
  dom.createName.placeholder = (name ? name : "{Username}") + "'s lobby :D!";
}

function bindEvents() {
  if (dom.createBtn) {
    dom.createBtn.addEventListener("click", () => {
      createFormOpen = !createFormOpen;
      dom.createForm.classList.toggle("hidden", !createFormOpen);
      if (createFormOpen && dom.createName) dom.createName.focus();
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
    dom.detailJoinBtn.addEventListener("click", handleJoin);
  }
  if (dom.detailLeaveBtn) {
    dom.detailLeaveBtn.addEventListener("click", handleLeave);
  }
  if (dom.detailSaveTimersBtn) {
    dom.detailSaveTimersBtn.addEventListener("click", handleSaveTimers);
  }
  // Sweep dead lobbies now and every 5 minutes so they don't pile up.
  const sweep = () => { cleanupStaleLobbies().catch(() => {}); };
  sweep();
  setInterval(sweep, 5 * 60 * 1000);
  if (dom.detailStartMatchBtn) {
    dom.detailStartMatchBtn.addEventListener("click", handleStartMatch);
  }
  if (dom.browseLink) {
    dom.browseLink.addEventListener("click", () => {
      window.location.hash = "#/lobbies";
    });
  }
}

/**
 * Open the full create-lobby form (used by the game screen's
 * "+ Create new" button so there is ONE unified creation UI).
 */
export function openCreateForm() {
  hideDetail();
  if (dom.list) dom.list.classList.remove("hidden");
  createFormOpen = true;
  dom.createForm?.classList.remove("hidden");
  updateNamePlaceholder();
  if (dom.createName) dom.createName.focus();
}

// ─── Lobby List Listener (Firebase Realtime) ─────────────────────────────────

function startLobbyListListener() {
  if (unsubLobbyList) unsubLobbyList();
  unsubLobbyList = onLobbyListChange((lobbies) => {
    knownLobbies = lobbies;
    renderLobbyList(lobbies);
  });
}

export function refresh() {
  // Listener already keeps it fresh, but force re-render
  renderLobbyList(knownLobbies);
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

    const isFull = (lobby.players?.length || 0) >= (lobby.maxPlayers || 10);
    const isPlaying = lobby.status === "playing" || lobby.status === "starting";
    const playerCount = lobby.players?.length || 0;
    const typeBadge = lobby.type === "signup"
      ? `<span class="badge badge-signup">SIGNUP</span>`
      : lobby.type === "private"
      ? `<span class="badge badge-private">PRIVATE</span>`
      : `<span class="badge badge-open">OPEN</span>`;
    const statusBadge = isPlaying
      ? `<span class="badge badge-playing">PLAYING</span>`
      : `<span class="badge badge-waiting">WAITING</span>`;

    card.innerHTML = `
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-bold text-text truncate">${esc(lobby.name)}</span>
            ${typeBadge}
            ${statusBadge}
          </div>
          <div class="text-sm text-muted font-mono">
            ${esc(lobby.hostName || "Host")} · ${esc(lobby.game)} · ${playerCount}/${lobby.maxPlayers || 10} players
            · ${formatTimers(lobby)}
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

// ─── Create Lobby ────────────────────────────────────────────────────────────

async function handleCreate() {
  const user = getCurrentUser();
  if (!user) {
    showToast("Log in to create a lobby", "error");
    return;
  }

  // Default lobby name: "{Username}'s lobby :D!"
  const fallbackName = (user.displayName || user.email?.split("@")[0] || "Someone") + "'s lobby :D!";
  const name = dom.createName?.value?.trim() || fallbackName;
  const game = dom.createGame?.value || "team-chess";
  const type = dom.createType?.value || "open";
  const minPlayers = Math.max(2, parseInt(dom.createMin?.value, 10) || 2);
  const maxPlayers = Math.max(minPlayers, parseInt(dom.createMax?.value, 10) || 10);

  // Timer settings, all in MINUTES:
  //  - vote time: capped at 2 min (fractions allowed, e.g. 0.25 = 15s)
  //  - match time: -1 = unlimited, otherwise any positive duration
  const votingRaw = parseFloat(dom.createVotingTime?.value);
  const votingTimeMin = Number.isFinite(votingRaw) && votingRaw > 0 ? Math.min(2, Math.max(0.1, votingRaw)) : 0.25;
  const matchRaw = parseFloat(dom.createMatchTime?.value);
  const matchTimeMin = Number.isFinite(matchRaw) && matchRaw > 0 ? Math.round(matchRaw) : -1;

  try {
    const lobby = await fbCreateLobby({
      name,
      game,
      type,
      minPlayers,
      maxPlayers,
      votingTimeMin,
      matchTimeMin,
      hostName: user.displayName || user.email?.split("@")[0] || "Host",
    });
    showToast("Lobby created!", "success");
    // QoL: making a new game instantly purges your older dead/duplicate
    // lobbies so lists never fill up with stale "X's lobby" copies.
    cleanupStaleLobbies().catch(() => {});
    createFormOpen = false;
    dom.createForm.classList.add("hidden");
    // Auto-join the lobby you created: open the detail view AND attach
    // the app's lobby watcher, otherwise the host's Start press would
    // flip status to "starting" with nobody listening for it.
    showDetail(lobby.id);
    window.dispatchEvent(new CustomEvent("tgn:joined-lobby", { detail: lobby }));
  } catch (e) {
    showToast("Failed to create lobby: " + e.message, "error");
  }
}

// ─── Detail View ─────────────────────────────────────────────────────────────

export function showDetail(lobbyId) {
  currentDetailLobbyId = lobbyId;
  dom.list.classList.add("hidden");
  dom.createForm.classList.add("hidden");
  createFormOpen = false;
  dom.detail.classList.remove("hidden");

  // Subscribe to lobby changes in real-time
  if (unsubLobby) unsubLobby();
  unsubLobby = onLobbyChange(lobbyId, (lobby) => {
    if (!lobby) {
      showToast("Lobby was closed", "info");
      hideDetail();
      return;
    }
    renderDetail(lobby);
  });
}

export function hideDetail() {
  dom.detail.classList.add("hidden");
  dom.list.classList.remove("hidden");
  if (unsubLobby) { unsubLobby(); unsubLobby = null; }
  currentDetailLobbyId = null;
}

function renderDetail(lobby) {
  if (dom.detailName) dom.detailName.textContent = lobby.name;
  if (dom.detailMeta) {
    dom.detailMeta.textContent =
      `${esc(lobby.game)} · ${lobby.type} · ${lobby.players?.length || 0}/${lobby.maxPlayers || 10} players` +
      ` · ${formatTimers(lobby)}`;
  }

  // Players
  if (dom.detailPlayers) {
    dom.detailPlayers.innerHTML = "";
    const players = lobby.players || [];
    const names = lobby.playerNames || {};
    if (players.length === 0) {
      dom.detailPlayers.innerHTML = `<p class="text-sm text-muted">No players in lobby yet.</p>`;
    } else {
      for (const pid of players) {
        const isHost = pid === lobby.hostId;
        const div = document.createElement("div");
        div.className = "flex items-center justify-between p-2 bg-surface rounded border border-border";
        div.innerHTML = `
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full ${isHost ? "bg-gold" : "bg-ok"}"></div>
            <span class="font-mono text-sm text-text">${esc(names[pid] || pid.slice(0, 8))}</span>
            ${isHost ? '<span class="badge badge-signup">HOST</span>' : ""}
          </div>
        `;
        dom.detailPlayers.appendChild(div);
      }
    }
  }

  // Signups section - hide for now (not needed for MVP)
  if (dom.detailSignups) dom.detailSignups.parentElement.classList.add("hidden");

  // Join / Leave buttons
  const user = getCurrentUser();
  const playerCount = lobby.players?.length || 0;
  const isFull = playerCount >= (lobby.maxPlayers || 10);
  const isPlaying = lobby.status === "playing" || lobby.status === "starting";
  const alreadyIn = user && lobby.players?.includes(user.uid);

  if (dom.detailLeaveBtn) {
    // Members can leave while the lobby is still waiting.
    const canLeave = alreadyIn && !isPlaying;
    dom.detailLeaveBtn.classList.toggle("hidden", !canLeave);
  }

  if (dom.detailJoinBtn) {
    if (alreadyIn) {
      dom.detailJoinBtn.classList.add("hidden");
    } else {
      dom.detailJoinBtn.classList.remove("hidden");
      dom.detailJoinBtn.disabled = isFull || isPlaying;
      dom.detailJoinBtn.textContent = isPlaying ? "match in progress" : isFull ? "lobby full" : "Join Lobby";
    }
  }

  // Start match button (host only)
  const isHost = user && lobby.hostId === user.uid;
  if (dom.detailStartMatchBtn) {
    dom.detailStartMatchBtn.classList.toggle("hidden", !isHost);
    if (isHost) {
      const starting = lobby.status === "starting" || lobby.status === "playing";
      dom.detailStartMatchBtn.disabled = playerCount < (lobby.minPlayers || 2) || starting;
      dom.detailStartMatchBtn.textContent = starting
        ? "Starting..."
        : playerCount < (lobby.minPlayers || 2)
          ? `Need ${lobby.minPlayers || 2}+ players`
          : "Start Match";
    }
  }

  // Timer customization (host only, while the lobby is still waiting)
  if (dom.detailTimerSection) {
    dom.detailTimerSection.classList.toggle("hidden", !isHost || lobby.status !== "waiting");
    if (isHost && document.activeElement !== dom.detailVotingTime) {
      if (dom.detailVotingTime) {
        dom.detailVotingTime.value = lobby.votingTimeMin ?? 0.25;
      }
      if (dom.detailMatchTime && document.activeElement !== dom.detailMatchTime) {
        dom.detailMatchTime.value = lobby.matchTimeMin ?? 10;
      }
    }
  }
}

// ─── Host Timer Customization + Match Start (Firebase) ──────────────────────

async function handleSaveTimers() {
  if (!currentDetailLobbyId) return;
  const voteRaw = parseFloat(dom.detailVotingTime?.value);
  const votingTimeMin = Number.isFinite(voteRaw) && voteRaw > 0 ? Math.min(2, Math.max(0.1, voteRaw)) : 0.25;
  const matchRaw = parseFloat(dom.detailMatchTime?.value);
  const matchTimeMin = Number.isFinite(matchRaw) && matchRaw > 0 ? Math.round(matchRaw) : -1;

  try {
    await fbUpdateLobby(currentDetailLobbyId, { votingTimeMin, matchTimeMin });
    showToast(`Timers saved: vote ${votingTimeMin}min · match ${matchTimeMin < 0 ? "unlimited" : matchTimeMin + "min"}`, "success");
  } catch (e) {
    showToast("Failed to save timers: " + e.message, "error");
  }
}

/**
 * Host clicks Start: writes status=starting + seed to Firebase.
 * Every member's lobby watcher picks up the change and starts the game.
 */
async function handleStartMatch() {
  if (!currentDetailLobbyId) return;
  try {
    const lobby = await fbStartMatch(currentDetailLobbyId);
    showToast("Starting match...", "success");
    // The host starts locally and instantly - no listener round-trip.
    // Other members launch via their lobby watchers / poll fallback.
    window.dispatchEvent(new CustomEvent("tgn:match-start", { detail: lobby }));
  } catch (e) {
    showToast(e.message, "error");
  }
}

// ─── Join Lobby ──────────────────────────────────────────────────────────────

async function handleJoin() {
  if (!currentDetailLobbyId) return;
  const user = getCurrentUser();
  if (!user) {
    showToast("Log in to join a lobby", "error");
    return;
  }

  try {
    const lobby = await fbJoinLobby(currentDetailLobbyId);
    showToast("Joined lobby!", "success");
    // Let app.js attach to this lobby (waiting room UI + game-start watcher).
    window.dispatchEvent(new CustomEvent("tgn:joined-lobby", { detail: lobby }));
  } catch (e) {
    showToast(e.message, "error");
  }
}

/**
 * Leave the lobby currently open in the detail view (while waiting).
 * Notifies app.js so the game-screen waiting room detaches too.
 */
async function handleLeave() {
  if (!currentDetailLobbyId) return;
  const user = getCurrentUser();
  if (!user) {
    showToast("Log in first", "error");
    return;
  }
  try {
    await fbLeaveLobby(currentDetailLobbyId);
    showToast("Left lobby", "info");
    window.dispatchEvent(new CustomEvent("tgn:left-lobby", { detail: { lobbyId: currentDetailLobbyId } }));
  } catch (e) {
    showToast(e.message, "error");
  }
}

// ─── Leave Lobby ─────────────────────────────────────────────────────────────

export async function leaveCurrentLobby() {
  if (!currentLobbyId) return;
  try {
    await fbLeaveLobby(currentLobbyId);
  } catch { /* ignore */ }
  currentLobbyId = null;
}

// ─── State Push Handlers ─────────────────────────────────────────────────────

export function handleLobbyState(msg) {
  // Handle state updates from Firebase listener (already handled by onLobbyChange)
  if (msg.type === "game-start") {
    if (window.__tgn_onGameStart) window.__tgn_onGameStart(msg);
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

/** Human-readable timer summary, e.g. "vote 15s/turn · match 10min" or "match unlimited". */
export function formatTimers(lobby) {
  const voteMin = lobby?.votingTimeMin ?? 0.25;
  const voteLabel = voteMin * 60 < 90 ? Math.round(voteMin * 60) + "s" : voteMin + "min";
  const matchMin = lobby?.matchTimeMin ?? 10;
  const matchLabel = matchMin < 0 ? "unlimited" : matchMin + "min";
  return `vote ${voteLabel}/turn · match ${matchLabel}`;
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, type) {
  if (window.__tgn_showToast) window.__tgn_showToast(message, type);
  else console.log(`[${type}] ${message}`);
}
