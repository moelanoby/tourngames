/**
 * lobby.js Lobby UI component
 *
 * Exported functions for updating the lobby screen DOM.
 */

export function renderLobby(players, hostId, localPlayerId, gameName = "Team Chess") {
 const container = document.getElementById("player-list");
 if (!container) return;

 container.innerHTML = "";

 players.forEach((p) => {
 const isHost = p.id === hostId;
 const isYou = p.id === localPlayerId;
 const dotColor = isHost ? "bg-esports-accent" : "bg-esports-success";

 const div = document.createElement("div");
 div.className =
 "flex items-center justify-between p-3 bg-esports-surface rounded " +
 "border border-esports-border transition-colors hover:border-esports-accent";

 div.innerHTML = `
 <div class="flex items-center space-x-3">
 <div class="w-3 h-3 rounded-full ${dotColor} animate-pulse"></div>
 <span class="font-mono text-sm text-esports-text">${escapeHtml(p.name)}</span>
 ${isHost ? '<span class="text-xs bg-esports-accent/20 text-esports-accent font-bold px-2 py-0.5 rounded">HOST</span>' : ""}
 ${isYou ? '<span class="text-xs bg-esports-success/20 text-esports-success font-bold px-2 py-0.5 rounded">YOU</span>' : ""}
 </div>
 <span class="text-xs ${p.connected ? "text-esports-success" : "text-esports-muted"} font-mono">
 ${p.connected ? "ONLINE" : "OFFLINE"}
 </span>
 `;
 container.appendChild(div);
 });
}

export function setLobbyStatus(text, count = "") {
 const statusEl = document.getElementById("lobby-status");
 const countEl = document.getElementById("lobby-count");
 if (statusEl) statusEl.textContent = text;
 if (countEl) {
 countEl.textContent = count ? `(${count}/10)` : "";
 countEl.className = "ml-2 font-mono text-esports-accent";
 }
}

export function showLobby(show) {
 const lobby = document.getElementById("lobby-wait");
 if (lobby) {
 lobby.classList.toggle("hidden", !show);
 }
}

export function showLobbyStatus() {
 const findBtn = document.getElementById("find-match-btn");
 if (findBtn) findBtn.classList.add("hidden");
 showLobby(true);
}

function escapeHtml(str) {
 return str
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
}
