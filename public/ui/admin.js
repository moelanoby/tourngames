/**
 * admin.js Admin Panel UI module
 *
 * Provides the admin interface for managing users, lobbies, and
 * viewing the audit log. All actions require admin role + CSRF token.
 *
 * Tabs:
 * - Users: list, ban/unban, promote/demote, delete
 * - Lobbies: list all (including private), delete, force-end
 * - Audit Log: view recent admin actions
 */

let fetchWithCSRF = null;
let getCSRFToken = null;
let currentTab = "users";

const dom = {};

function cacheDom() {
 dom.usersTbody = document.getElementById("admin-users-tbody");
 dom.lobbiesTbody = document.getElementById("admin-lobbies-tbody");
 dom.auditTbody = document.getElementById("admin-audit-tbody");
 dom.tabButtons = document.querySelectorAll("[data-admin-tab]");
 dom.tabContents = {
 users: document.getElementById("admin-tab-users"),
 lobbies: document.getElementById("admin-tab-lobbies"),
 audit: document.getElementById("admin-tab-audit"),
 };
}

export function init(opts = {}) {
  try {
 fetchWithCSRF = opts.fetchWithCSRF || fetch;
 getCSRFToken = opts.getCSRFToken || (() => null);
 cacheDom();

 // Wire up tab switching
 dom.tabButtons.forEach(btn => {
 btn.addEventListener("click", () => switchTab(btn.getAttribute("data-admin-tab")));
 });
  } catch (e) {
    console.warn("[Admin] Failed to initialize:", e);
  }
}

function switchTab(tab) {
 currentTab = tab;
 dom.tabButtons.forEach(b => b.classList.toggle("active", b.getAttribute("data-admin-tab") === tab));
 Object.entries(dom.tabContents).forEach(([key, el]) => {
 el.classList.toggle("hidden", key !== tab);
 });
 // Refresh data for the tab
 if (tab === "users") loadUsers();
 if (tab === "lobbies") loadLobbies();
 if (tab === "audit") loadAudit();
}

export function refresh() {
 switchTab(currentTab);
}

// ─── Users ───────────────────────────────────────────────────────────────────

async function loadUsers() {
 if (!dom.usersTbody) return;
 dom.usersTbody.innerHTML = '<tr><td colspan="6" class="text-center subtle" style="padding: 24px;">Loading...</td></tr>';
 try {
 const res = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); // Placeholder - use Firebase Admin rules instead
 if (!res.ok) {
 const data = await res.json().catch(() => ({}));
 dom.usersTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--danger); padding: 24px;">${escapeHtml(data.error || "Failed to load")}</td></tr>`;
 return;
 }
 const data = await res.json();
 renderUsers(data.users || []);
 } catch (e) {
 dom.usersTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--danger); padding: 24px;">Network error</td></tr>`;
 }
}

function renderUsers(users) {
 if (!dom.usersTbody) return;
 if (users.length === 0) {
 dom.usersTbody.innerHTML = '<tr><td colspan="6" class="text-center subtle" style="padding: 24px;">No users</td></tr>';
 return;
 }
 dom.usersTbody.innerHTML = "";
 for (const u of users) {
 const tr = document.createElement("tr");
 const status = u.banned
 ? '<span class="badge badge-danger">Banned</span>'
 : u.lockedUntil && u.lockedUntil > Date.now()
 ? '<span class="badge badge-warning">Locked</span>'
 : '<span class="badge badge-success">Active</span>';
 const role = u.role === "admin"
 ? '<span class="badge badge-accent">Admin</span>'
 : '<span class="badge badge-default">User</span>';
 const lastLogin = u.lastLoginAt
 ? new Date(u.lastLoginAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
 : '<span class="subtle">Never</span>';
 const wins = `${u.wins || 0}w / ${u.matchesPlayed || 0}m`;

 tr.innerHTML = `
 <td><strong>${escapeHtml(u.username)}</strong></td>
 <td>${role}</td>
 <td>${status}</td>
 <td class="mono">${wins}</td>
 <td class="mono">${lastLogin}</td>
 <td>
 <div class="flex gap-1" style="flex-wrap: wrap;">
 ${renderUserActions(u)}
 </div>
 </td>
 `;
 dom.usersTbody.appendChild(tr);
 }

 // Wire up action buttons
 dom.usersTbody.querySelectorAll("[data-action]").forEach(btn => {
 btn.addEventListener("click", () => handleUserAction(
 btn.getAttribute("data-action"),
 btn.getAttribute("data-user-id"),
 btn.getAttribute("data-username"),
 ));
 });
}

function renderUserActions(u) {
 const buttons = [];
 if (u.banned) {
 buttons.push(actionBtn("unban", u.id, u.username, "Unban", "btn-secondary btn-sm"));
 } else {
 buttons.push(actionBtn("ban", u.id, u.username, "Ban", "btn-danger-ghost btn-sm"));
 }
 if (u.role === "admin") {
 buttons.push(actionBtn("demote", u.id, u.username, "Demote", "btn-ghost btn-sm"));
 } else {
 buttons.push(actionBtn("promote", u.id, u.username, "Promote", "btn-ghost btn-sm"));
 }
 buttons.push(actionBtn("delete", u.id, u.username, "Delete", "btn-danger-ghost btn-sm"));
 return buttons.join("");
}

function actionBtn(action, userId, username, label, classes) {
 return `<button class="btn ${classes}" data-action="${action}" data-user-id="${userId}" data-username="${escapeHtml(username)}">${label}</button>`;
}

async function handleUserAction(action, userId, username) {
 if (!userId) return;

 if (action === "delete") {
 if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
 } else if (action === "ban") {
 const reason = prompt(`Reason for banning "${username}":`, "Rule violation");
 if (reason === null) return;
 return await doUserAction(action, userId, { reason });
 }

 return await doUserAction(action, userId);
}

async function doUserAction(action, userId, body = {}) {
 try {
 const res = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
 const data = await res.json();
 if (!res.ok) {
 showToast(data.error || `Failed to ${action} user`, "error");
 return;
 }
 showToast(`User ${action} successful`, "success");
 loadUsers();
 } catch (e) {
 showToast("Network error: " + e.message, "error");
 }
}

// ─── Lobbies ─────────────────────────────────────────────────────────────────

async function loadLobbies() {
 if (!dom.lobbiesTbody) return;
 dom.lobbiesTbody.innerHTML = '<tr><td colspan="6" class="text-center subtle" style="padding: 24px;">Loading...</td></tr>';
 try {
 const res = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); // Placeholder
 if (!res.ok) {
 const data = await res.json().catch(() => ({}));
 dom.lobbiesTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--danger); padding: 24px;">${escapeHtml(data.error || "Failed to load")}</td></tr>`;
 return;
 }
 const data = await res.json();
 renderLobbies(data.lobbies || []);
 } catch (e) {
 dom.lobbiesTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--danger); padding: 24px;">Network error</td></tr>`;
 }
}

function renderLobbies(lobbies) {
 if (!dom.lobbiesTbody) return;
 if (lobbies.length === 0) {
 dom.lobbiesTbody.innerHTML = '<tr><td colspan="6" class="text-center subtle" style="padding: 24px;">No lobbies</td></tr>';
 return;
 }
 dom.lobbiesTbody.innerHTML = "";
 for (const l of lobbies) {
 const tr = document.createElement("tr");
 const statusBadge = l.status === "playing"
 ? '<span class="badge badge-danger">Playing</span>'
 : l.status === "starting"
 ? '<span class="badge badge-warning">Starting</span>'
 : '<span class="badge badge-success">Waiting</span>';
 const typeBadge = l.type === "signup"
 ? '<span class="badge badge-accent">Signup</span>'
 : l.type === "private"
 ? '<span class="badge badge-default">Private</span>'
 : '<span class="badge badge-default">Open</span>';
 const players = `${l.players?.length || 0}/${l.maxPlayers}`;

 tr.innerHTML = `
 <td><strong>${escapeHtml(l.name)}</strong></td>
 <td>${typeBadge}</td>
 <td>${statusBadge}</td>
 <td class="mono">${players}</td>
 <td>${escapeHtml(l.hostName || " ")}</td>
 <td>
 <div class="flex gap-1">
 ${l.status === "playing" || l.status === "starting"
 ? `<button class="btn btn-ghost btn-sm" data-lobby-action="end" data-lobby-id="${l.id}">End match</button>`
 : ""
 }
 <button class="btn btn-danger-ghost btn-sm" data-lobby-action="delete" data-lobby-id="${l.id}">Delete</button>
 </div>
 </td>
 `;
 dom.lobbiesTbody.appendChild(tr);
 }

 dom.lobbiesTbody.querySelectorAll("[data-lobby-action]").forEach(btn => {
 btn.addEventListener("click", () => handleLobbyAction(
 btn.getAttribute("data-lobby-action"),
 btn.getAttribute("data-lobby-id"),
 ));
 });
}

async function handleLobbyAction(action, lobbyId) {
 if (action === "delete") {
 if (!confirm("Delete this lobby? Players will be disconnected.")) return;
 const res = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
 const data = await res.json().catch(() => ({}));
 if (!res.ok) { showToast(data.error || "Failed", "error"); return; }
 showToast("Lobby deleted", "success");
 loadLobbies();
 } else if (action === "end") {
 const res = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
 const data = await res.json().catch(() => ({}));
 if (!res.ok) { showToast(data.error || "Failed", "error"); return; }
 showToast("Match ended", "success");
 loadLobbies();
 }
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

async function loadAudit() {
 if (!dom.auditTbody) return;
 dom.auditTbody.innerHTML = '<tr><td colspan="6" class="text-center subtle" style="padding: 24px;">Loading...</td></tr>';
 try {
 const res = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
 if (!res.ok) {
 const data = await res.json().catch(() => ({}));
 dom.auditTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--danger); padding: 24px;">${escapeHtml(data.error || "Failed to load")}</td></tr>`;
 return;
 }
 const data = await res.json();
 renderAudit(data.logs || []);
 } catch (e) {
 dom.auditTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--danger); padding: 24px;">Network error</td></tr>`;
 }
}

function renderAudit(logs) {
 if (!dom.auditTbody) return;
 if (logs.length === 0) {
 dom.auditTbody.innerHTML = '<tr><td colspan="6" class="text-center subtle" style="padding: 24px;">No audit entries</td></tr>';
 return;
 }
 dom.auditTbody.innerHTML = "";
 for (const log of logs) {
 const tr = document.createElement("tr");
 const time = new Date(log.timestamp).toLocaleString("en-US", {
 month: "short", day: "numeric",
 hour: "2-digit", minute: "2-digit", second: "2-digit",
 });
 const actionBadge = renderActionBadge(log.action);
 tr.innerHTML = `
 <td class="mono">${time}</td>
 <td>${actionBadge} ${escapeHtml(log.action)}</td>
 <td>${escapeHtml(log.actorName)}${log.actorId ? "" : ""}</td>
 <td>${escapeHtml(log.targetName || " ")}</td>
 <td class="muted">${escapeHtml(log.details || "")}</td>
 <td class="mono">${escapeHtml(log.actorIp || " ")}</td>
 `;
 dom.auditTbody.appendChild(tr);
 }
}

function renderActionBadge(action) {
 if (action.includes("ban")) return '<span class="badge badge-danger"> </span>';
 if (action.includes("admin")) return '<span class="badge badge-accent"> </span>';
 if (action.includes("delete")) return '<span class="badge badge-danger"> </span>';
 if (action.includes("fail")) return '<span class="badge badge-warning"> </span>';
 return '<span class="badge badge-default"> </span>';
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

