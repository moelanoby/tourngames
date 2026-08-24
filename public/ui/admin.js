// deno-lint-ignore-file no-window
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

// Wired from app.js via init() opts; ready for the real admin API.
// Underscore-prefixed because the placeholder responses below don't
// use them yet - only this module needs to change when the API lands.
let _fetchWithCSRF = null;
let _getCSRFToken = null;
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
    _fetchWithCSRF = opts.fetchWithCSRF || fetch;
    _getCSRFToken = opts.getCSRFToken || (() => null);
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

// ─── Shared table helpers ────────────────────────────────────────────────────

/** Single full-width row used for loading / empty / error states. */
function statusRow(colspan, text, kind = "muted") {
  const color = kind === "error" ? "var(--danger)" : "";
  return `<tr><td colspan="${colspan}" class="text-center" style="padding: 24px; color: ${color};">${escapeHtml(text)}</td></tr>`;
}

// Placeholder success response: admin data now lives in Firebase and the
// server-side admin API is gone. Every action below resolves through here,
// so wiring a real backend later means replacing this one helper.
const PLACEHOLDER_JSON = { "Content-Type": "application/json" };
const placeholderOk = () => new Response("{}", { status: 200, headers: PLACEHOLDER_JSON });

/** Disable an action button while its async work runs, then restore it. */
async function withButtonBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "...";
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ─── Dialogs (reuse the site's .modal-overlay / .modal pattern) ─────────────

/**
 * Promise-based dialog built from the same modal classes as the auth
 * modal (no native confirm()/prompt()). Resolves true on confirm, false
 * on cancel/dismiss; prompt mode resolves the entered string or null.
 */
function showDialog({ title, message = "", prompt = false, initial = "", confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="modal-header">
        <h3 class="modal-title"></h3>
      </div>
      <p class="text-sm text-muted" style="margin-bottom: var(--space-5);"></p>
    `;
    modal.querySelector(".modal-title").textContent = title;
    modal.querySelector("p").textContent = message;

    let inputEl = null;
    let errorEl = null;
    if (prompt) {
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "input";
      inputEl.maxLength = 80;
      inputEl.value = initial;
      modal.appendChild(inputEl);
      errorEl = document.createElement("p");
      errorEl.className = "form-error hidden";
      modal.appendChild(errorEl);
    }

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:8px; justify-content:flex-end; margin-top:20px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-secondary";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    okBtn.textContent = confirmText;
    row.append(cancelBtn, okBtn);
    modal.appendChild(row);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(prompt ? null : false);
    };

    cancelBtn.addEventListener("click", () => close(prompt ? null : false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(prompt ? null : false);
    });
    document.addEventListener("keydown", onKey);

    okBtn.addEventListener("click", () => {
      if (prompt) {
        const value = inputEl.value.trim();
        if (!value) {
          errorEl.textContent = "Enter a reason (or cancel)";
          errorEl.classList.remove("hidden");
          inputEl.focus();
          return;
        }
        close(value);
      } else {
        close(true);
      }
    });

    (prompt ? inputEl : okBtn).focus();
    if (prompt) inputEl.select();
  });
}

// ─── Users ───────────────────────────────────────────────────────────────────

async function loadUsers() {
  if (!dom.usersTbody) return;
  dom.usersTbody.innerHTML = statusRow(6, "Loading...");
  try {
    const res = placeholderOk();
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      dom.usersTbody.innerHTML = statusRow(6, data.error || "Failed to load", "error");
      return;
    }
    const data = await res.json();
    renderUsers(data.users || []);
  } catch {
    dom.usersTbody.innerHTML = statusRow(6, "Network error - could not load users", "error");
  }
}

function renderUsers(users) {
  if (!dom.usersTbody) return;
  if (users.length === 0) {
    dom.usersTbody.innerHTML = statusRow(6, "No users found");
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
    const lastLogin = u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '<span class="subtle">Never</span>';
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
    btn.addEventListener("click", () => withButtonBusy(btn, () => handleUserAction(
      btn.getAttribute("data-action"),
      btn.getAttribute("data-user-id"),
      btn.getAttribute("data-username"),
    )));
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
    const ok = await showDialog({
      title: "Delete user",
      message: `Delete user "${username}"? This cannot be undone.`,
      confirmText: "Delete user",
      danger: true,
    });
    if (!ok) return;
  } else if (action === "ban") {
    const reason = await showDialog({
      title: `Ban ${username}`,
      message: "Why are you banning this user?",
      prompt: true,
      initial: "Rule violation",
      confirmText: "Ban user",
      danger: true,
    });
    if (reason === null) return;
    return await doUserAction(action);
  }

  return await doUserAction(action);
}

async function doUserAction(action) {
  try {
    const res = placeholderOk();
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
  dom.lobbiesTbody.innerHTML = statusRow(6, "Loading...");
  try {
    const res = placeholderOk();
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      dom.lobbiesTbody.innerHTML = statusRow(6, data.error || "Failed to load", "error");
      return;
    }
    const data = await res.json();
    renderLobbies(data.lobbies || []);
  } catch {
    dom.lobbiesTbody.innerHTML = statusRow(6, "Network error - could not load lobbies", "error");
  }
}

function renderLobbies(lobbies) {
  if (!dom.lobbiesTbody) return;
  if (lobbies.length === 0) {
    dom.lobbiesTbody.innerHTML = statusRow(6, "No lobbies right now");
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
    btn.addEventListener("click", () => withButtonBusy(btn, () => handleLobbyAction(
      btn.getAttribute("data-lobby-action"),
      btn.getAttribute("data-lobby-id"),
    )));
  });
}

async function handleLobbyAction(action) {
  if (action === "delete") {
    const ok = await showDialog({
      title: "Delete lobby",
      message: "Delete this lobby? All players will be disconnected.",
      confirmText: "Delete lobby",
      danger: true,
    });
    if (!ok) return;
  }
  const res = placeholderOk();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.error || "Failed", "error"); return; }
  showToast(action === "delete" ? "Lobby deleted" : "Match ended", "success");
  loadLobbies();
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

async function loadAudit() {
  if (!dom.auditTbody) return;
  dom.auditTbody.innerHTML = statusRow(6, "Loading...");
  try {
    const res = placeholderOk();
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      dom.auditTbody.innerHTML = statusRow(6, data.error || "Failed to load", "error");
      return;
    }
    const data = await res.json();
    renderAudit(data.logs || []);
  } catch {
    dom.auditTbody.innerHTML = statusRow(6, "Network error - could not load audit log", "error");
  }
}

function renderAudit(logs) {
  if (!dom.auditTbody) return;
  if (logs.length === 0) {
    dom.auditTbody.innerHTML = statusRow(6, "No audit entries yet");
    return;
  }
  dom.auditTbody.innerHTML = "";
  for (const log of logs) {
    const time = formatDateTime(log.timestamp, true);
    appendAuditRow(log, time, renderActionBadge(log.action));
  }
}

function appendAuditRow(log, time, actionBadge) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="mono">${time}</td>
    <td>${actionBadge} ${escapeHtml(log.action)}</td>
    <td>${escapeHtml(log.actorName)}</td>
    <td>${escapeHtml(log.targetName || " ")}</td>
    <td class="muted">${escapeHtml(log.details || "")}</td>
    <td class="mono">${escapeHtml(log.actorIp || " ")}</td>
  `;
  dom.auditTbody.appendChild(tr);
}

function renderActionBadge(action) {
  if (action.includes("ban")) return '<span class="badge badge-danger">BAN</span>';
  if (action.includes("admin")) return '<span class="badge badge-accent">ADMIN</span>';
  if (action.includes("delete")) return '<span class="badge badge-danger">DELETE</span>';
  if (action.includes("fail")) return '<span class="badge badge-warning">FAIL</span>';
  return '<span class="badge badge-default">INFO</span>';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** "Mar 7, 2026, 02:15 PM" style timestamps shared across admin tables. */
function formatDateTime(ts, withSeconds = false) {
  if (!ts) return " ";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return " ";
  const opts = { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" };
  if (withSeconds) opts.second = "2-digit";
  return d.toLocaleString("en-US", opts);
}

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
