/**
 * auth.js - Authentication UI Module (Firebase Version)
 * 
 * Handles login/register modal, session state using Firebase Auth.
 * Exposes API for app.js:
 * - auth.init()
 * - auth.getUser()
 * - auth.onUserChange(cb)
 * - auth.requireLogin()
 * - auth.showModal(tab)
 */

import { 
  initFirebase, 
  getAuthInstance, 
  signInAnon, 
  signInWithPassword, 
  registerWithPassword, 
  signOutUser, 
  getCurrentUser,
  startAuthListener,
  onAuthChange as firebaseOnAuthChange
} from "./firebase.js";

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
const userChangeCallbacks = [];

export async function init() {
  cacheDom();
  await initFirebase();

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

  // Start Firebase auth listener
  startAuthListener();

  // Also listen for auth changes from Firebase
  firebaseOnAuthChange((user) => {
    if (user) {
      // Convert Firebase user to our format
      const userData = {
        uid: user.uid,
        username: user.displayName || user.email?.split("@")[0] || "Anonymous",
        email: user.email,
        isAnonymous: user.isAnonymous,
        wins: 0, // TODO: load from database
        matchesPlayed: 0
      };
      setUser(userData);
    } else {
      setUser(null);
    }
  });
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
    let user;
    if (currentTab === "login") {
      // For login, use email = username@tourngames.local (or just use Firebase Auth email)
      // We'll use a simple approach: email = username + "@tourngames.local"
      user = await signInWithPassword(username + "@tourngames.local", password);
    } else {
      user = await registerWithPassword(username + "@tourngames.local", password, username);
    }

    // Update display name if needed
    if (user && !user.displayName) {
      await updateProfile(user, { displayName: username });
    }

    hideModal();
  } catch (err) {
    // Handle Firebase error codes
    let msg = "Something went wrong";
    if (err.code === "auth/user-not-found" || err.code === "auth/wrong-password") {
      msg = "Invalid username or password";
    } else if (err.code === "auth/email-already-in-use") {
      msg = "Username already taken";
    } else if (err.code === "auth/weak-password") {
      msg = "Password too weak (min 6 characters)";
    } else if (err.code === "auth/invalid-email") {
      msg = "Invalid username format";
    } else {
      msg = err.message;
    }
    showError(msg);
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
    await signOutUser();
  } catch { /* ignore */ }
  setUser(null);
}

function setUser(user) {
  currentUser = user;
  if (user) {
    dom.authButtons.classList.add("hidden");
    dom.userMenu.classList.remove("hidden");
    dom.userMenu.classList.add("flex");
    let display = user.username;
    if (user.wins !== undefined) display += ` · ${user.wins}w`;
    if (user.isAnonymous) display += ' <span class="user-badge user-badge-guest">GUEST</span>';
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
