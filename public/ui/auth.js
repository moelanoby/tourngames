/**
 * auth.js Authentication UI module
 *
 * Handles the login/register modal, session state, and exposes
 * a small API used by app.js:
 * - auth.init()
 * - auth.getUser()
 * - auth.onUserChange(cb)
 * - auth.requireLogin() returns true if logged in, else opens modal
 * - auth.showModal(tab)
 */

const dom = {};

function cacheDom() {
 dom.authModal = document.getElementById("auth-modal");
 dom.authModalTitle = document.getElementById("auth-modal-title");
 dom.authTabLogin = document.getElementById("auth-tab-login");
 dom.authTabRegister = document.getElementById("auth-tab-register");
 dom.authForm = document.getElementById("auth-form");
 dom.authUsername = document.getElementById("auth-username");
 dom.authPassword = document.getElementById("auth-password");
 dom.authError = document.getElementById("auth-error");
 dom.authSubmitBtn = document.getElementById("auth-submit-btn");
 dom.authModalClose = document.getElementById("auth-modal-close");

 dom.authButtons = document.getElementById("auth-buttons");
 dom.userMenu = document.getElementById("user-menu");
 dom.userDisplay = document.getElementById("user-display");
 dom.logoutBtn = document.getElementById("logout-btn");

 dom.showLoginBtn = document.getElementById("show-login-btn");
 dom.showRegisterBtn = document.getElementById("show-register-btn");
 dom.showRegisterFromUsername = document.getElementById("show-register-from-username");
}

let currentUser = null;
let csrfToken = null;
const userChangeCallbacks = [];

export function init() {
 cacheDom();

 // Tab switching
 dom.authTabLogin.addEventListener("click", () => setTab("login"));
 dom.authTabRegister.addEventListener("click", () => setTab("register"));

 // Modal open/close
 dom.showLoginBtn.addEventListener("click", () => showModal("login"));
 dom.showRegisterBtn.addEventListener("click", () => showModal("register"));
 if (dom.showRegisterFromUsername) {
 dom.showRegisterFromUsername.addEventListener("click", () => showModal("register"));
 }
 dom.authModalClose.addEventListener("click", hideModal);
 dom.authModal.addEventListener("click", (e) => {
 if (e.target === dom.authModal) hideModal();
 });

 // Form submit
 dom.authForm.addEventListener("submit", handleSubmit);

 // Logout
 dom.logoutBtn.addEventListener("click", handleLogout);

 // Fetch current user (if logged in via cookie)
 refresh();
}

let currentTab = "login";

function setTab(tab) {
 currentTab = tab;
 if (tab === "login") {
 dom.authTabLogin.classList.add("active");
 dom.authTabRegister.classList.remove("active");
 dom.authModalTitle.textContent = "Log in";
 dom.authSubmitBtn.textContent = "Log in";
 dom.authPassword.autocomplete = "current-password";
 } else {
 dom.authTabLogin.classList.remove("active");
 dom.authTabRegister.classList.add("active");
 dom.authModalTitle.textContent = "Sign up";
 dom.authSubmitBtn.textContent = "Sign up";
 dom.authPassword.autocomplete = "new-password";
 }
 dom.authError.classList.add("hidden");
}

export function showModal(tab = "login") {
 setTab(tab);
 dom.authModal.classList.remove("hidden");
 dom.authModal.style.display = "flex";
 dom.authUsername.value = "";
 dom.authPassword.value = "";
 dom.authError.classList.add("hidden");
 setTimeout(() => dom.authUsername.focus(), 50);
}

export function hideModal() {
 dom.authModal.classList.add("hidden");
 dom.authModal.style.display = "none";
}

async function handleSubmit(e) {
 e.preventDefault();
 const username = dom.authUsername.value.trim();
 const password = dom.authPassword.value;
 if (!username || !password) {
 showError("Enter username and password");
 return;
 }

 dom.authSubmitBtn.disabled = true;
 dom.authSubmitBtn.textContent = currentTab === "login" ? "Logging in..." : "Creating...";

 try {
 const endpoint = currentTab === "login" ? "/api/auth/login" : "/api/auth/register";
 const res = await fetch(endpoint, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 credentials: "include",
 body: JSON.stringify({ username, password }),
 });
 const data = await res.json();
 if (!res.ok) {
 showError(data.error || "Something went wrong");
 return;
 }
 // Store CSRF token returned by server
 if (data.csrfToken) {
 csrfToken = data.csrfToken;
 }
 setUser(data.user);
 hideModal();
 } catch (err) {
 showError("Network error: " + err.message);
 } finally {
 dom.authSubmitBtn.disabled = false;
 dom.authSubmitBtn.textContent = currentTab === "login" ? "Log in" : "Sign up";
 }
}

function showError(msg) {
 dom.authError.textContent = msg;
 dom.authError.classList.remove("hidden");
}

async function handleLogout() {
 try {
 await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
 } catch { /* ignore */ }
 csrfToken = null;
 setUser(null);
}

export async function refresh() {
 try {
 const res = await fetch("/api/auth/me", { credentials: "include" });
 const data = await res.json();
 if (data.csrfToken) csrfToken = data.csrfToken;
 setUser(data.user || null);
 } catch {
 setUser(null);
 }
}

function setUser(user) {
 currentUser = user;
 if (user) {
 dom.authButtons.classList.add("hidden");
 dom.userMenu.classList.remove("hidden");
 dom.userMenu.classList.add("flex");
 // Build display with optional admin badge
 let display = user.username;
 if (user.wins) display += ` · ${user.wins}w`;
 if (user.role === "admin") {
 display += ' <span class="user-badge user-badge-admin">ADMIN</span>';
 }
 dom.userDisplay.innerHTML = display;
 } else {
 dom.authButtons.classList.remove("hidden");
 dom.userMenu.classList.add("hidden");
 dom.userMenu.classList.remove("flex");
 dom.userDisplay.textContent = "";
 }
 for (const cb of userChangeCallbacks) {
 try { cb(user); } catch (e) { console.warn("userChange cb error:", e); }
 }
}

export function getUser() {
 return currentUser;
}

export function getCSRFToken() {
 return csrfToken;
}

export function onUserChange(cb) {
 userChangeCallbacks.push(cb);
}

/**
 * Returns true if the user is logged in. If not, opens the auth modal
 * and returns false. Use this to gate signup-only actions.
 */
export function requireLogin() {
 if (currentUser) return true;
 showModal("login");
 return false;
}
