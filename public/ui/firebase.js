/**


=== FILE: public/ui/firebase.js ===

 * firebase.js - Firebase Service Module
 * 
 * Replaces server-side API + WebSocket signaling with Firebase:
 * - Firebase Auth for user accounts
 * - Realtime Database for presence, lobbies, WebRTC signaling
 * - No backend server needed!
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { 
  getAuth, 
  signInAnonymously, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
  getDatabase, 
  ref, 
  set, 
  get, 
  push, 
  remove, 
  onValue, 
  off,
  onDisconnect,
  update,
  serverTimestamp,
  query,
  orderByChild,
  equalTo,
  limitToLast,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ─── Initialize Firebase ─────────────────────────────────────────────────────

let app, auth, db;
let initialized = false;

export function initFirebase() {
  if (initialized) return;
  if (!window.firebaseConfig) {
    console.error("Firebase config not loaded! Include firebase-config.js first.");
    return false;
  }
  app = initializeApp(window.firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  initialized = true;
  console.log("[Firebase] Initialized");
  return true;
}

export function getAuthInstance() { return auth; }
export function getDatabaseInstance() { return db; }
export function isInitialized() { return initialized; }

// ─── Auth ────────────────────────────────────────────────────────────────────

let currentUser = null;
const authCallbacks = [];

export function onAuthChange(callback) {
  authCallbacks.push(callback);
  if (currentUser !== null) callback(currentUser);
}

function notifyAuthChange(user) {
  currentUser = user;
  authCallbacks.forEach(cb => cb(user));
}

export async function signInAnon() {
  if (!initialized) initFirebase();
  const result = await signInAnonymously(auth);
  return result.user;
}

export async function signInWithPassword(email, password) {
  if (!initialized) initFirebase();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function registerWithPassword(email, password, displayName) {
  if (!initialized) initFirebase();
  const result = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) {
    await updateProfile(result.user, { displayName });
  }
  return result.user;
}

export async function signOutUser() {
  if (!initialized) initFirebase();
  // Remove presence + stop heartbeat before the auth listener flips to
  // signed-out, so other users do not see a ghost "online" entry.
  cleanup();
  await signOut(auth);
}

export function getCurrentUser() { return currentUser; }

export function startAuthListener() {
  if (!initialized) initFirebase();
  onAuthStateChanged(auth, (user) => {
    if (user) {
      // User is signed in - set up presence
      setupPresence(user.uid, user.displayName || user.email || "Anonymous");
    } else {
      // User signed out
      notifyAuthChange(null);
    }
    notifyAuthChange(user);
  });
}

// ─── Presence (Online Users) ────────────────────────────────────────────────

let myPresenceRef = null;
let presenceHeartbeat = null;

function setupPresence(uid, displayName) {
  // Guard against re-runs stacking intervals (every auth-state change used
  // to create a new 30s timer that was never cleared).
  if (presenceHeartbeat) { clearInterval(presenceHeartbeat); presenceHeartbeat = null; }
  myPresenceRef = ref(db, `presence/${uid}`);
  const presenceData = {
    uid,
    displayName,
    status: "online",
    lastSeen: serverTimestamp(),
    game: null,
    lobbyId: null
  };

  // Set presence data
  set(myPresenceRef, presenceData);

  // Remove on disconnect
  onDisconnect(myPresenceRef).remove();

  // Update lastSeen periodically
  presenceHeartbeat = setInterval(() => {
    if (myPresenceRef) {
      update(myPresenceRef, { lastSeen: serverTimestamp() });
    }
  }, 30000);
}

export function updatePresence(data) {
  if (myPresenceRef) {
    update(myPresenceRef, { ...data, lastSeen: serverTimestamp() });
  }
}

export function onPresenceChange(callback) {
  const presenceRef = ref(db, "presence");
  onValue(presenceRef, (snapshot) => {
    const users = [];
    snapshot.forEach((child) => {
      users.push(child.val());
    });
    callback(users.filter(u => u.status === "online"));
  });
  return () => off(presenceRef);
}

// ─── Lobbies ─────────────────────────────────────────────────────────────────

export async function createLobby(lobbyData) {
  if (!initialized) initFirebase();
  const lobbiesRef = ref(db, "lobbies");
  const newLobbyRef = push(lobbiesRef);
  const lobbyId = newLobbyRef.key;

  const lobby = {
    id: lobbyId,
    name: lobbyData.name || "Untitled Lobby",
    game: lobbyData.game || "team-chess",
    type: lobbyData.type || "open",
    minPlayers: lobbyData.minPlayers ?? 2,
    maxPlayers: lobbyData.maxPlayers ?? 10,
    // Timer settings (all measured in minutes; matchTimeMin -1 = unlimited)
    votingTimeMin: lobbyData.votingTimeMin ?? 0.25,
    matchTimeMin: lobbyData.matchTimeMin ?? 10,
    hostId: currentUser?.uid,
    hostName: currentUser?.displayName || "Anonymous",
    players: [currentUser?.uid],
    playerNames: { [currentUser?.uid]: currentUser?.displayName || "Anonymous" },
    status: "waiting", // waiting, starting, playing, finished
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await set(newLobbyRef, lobby);
  return lobby;
}

export async function joinLobby(lobbyId, opts = {}) {
  if (!initialized) initFirebase();
  const lobbyRef = ref(db, `lobbies/${lobbyId}`);

  // Atomic read-modify-write: a get()-then-update() race let two concurrent
  // joins clobber each other's players array, and capacity was never
  // enforced here. runTransaction serializes both.
  let codeRejected = false;
  const { committed, snapshot } = await runTransaction(lobbyRef, (lobby) => {
    // IMPORTANT: return undefined (NOT null) to abort - a returned null
    // is a valid write that would DELETE the whole lobby node.
    if (!lobby || typeof lobby !== "object") return undefined; // abort: gone
    if (lobby.status !== "waiting") return undefined;
    // Private lobbies are only joinable with the correct invite code
    // (checked inside the transaction so the check and the join are
    // atomic against concurrent updates).
    if (lobby.type === "private" && opts?.inviteCode !== lobby.inviteCode) {
      codeRejected = true;
      return undefined;
    }
    const players = Array.isArray(lobby.players) ? lobby.players : [];
    if (!players.includes(currentUser.uid)) {
      const max = Number.isFinite(lobby.maxPlayers) ? lobby.maxPlayers : 20;
      if (players.length >= max) return undefined; // full
    }
    return {
      ...lobby,
      players: players.includes(currentUser.uid)
        ? players
        : [...players, currentUser.uid],
      playerNames: {
        ...(lobby.playerNames || {}),
        [currentUser.uid]: currentUser.displayName || "Anonymous",
      },
      updatedAt: serverTimestamp(),
    };
  });

  const lobby = snapshot.val();

  if (!committed) {
    // Transaction aborted: distinguish why for the caller.
    if (codeRejected) throw new Error("Invalid invite code");
    if (!lobby) throw new Error("Lobby not found");
    if (lobby.status !== "waiting") throw new Error("Lobby not joinable");
    const players = Array.isArray(lobby.players) ? lobby.players : [];
    if (!players.includes(currentUser.uid)) throw new Error("Lobby is full");
  }

  // Update user's presence
  updatePresence({ lobbyId, game: lobby.game });

  return lobby;
}

export async function leaveLobby(lobbyId) {
  if (!initialized) initFirebase();
  const lobbyRef = ref(db, `lobbies/${lobbyId}`);
  const snapshot = await get(lobbyRef);
  if (!snapshot.exists()) return;

  const lobby = snapshot.val();
  const updatedPlayers = lobby.players.filter(p => p !== currentUser.uid);
  const updatedNames = { ...lobby.playerNames };
  delete updatedNames[currentUser.uid];

  if (updatedPlayers.length === 0) {
    // Last player leaves - delete lobby
    await remove(lobbyRef);
    // Also clean up signaling data
    await remove(ref(db, `signaling/${lobbyId}`));
  } else {
    // Check if host left
    let hostId = lobby.hostId;
    if (hostId === currentUser.uid) {
      hostId = updatedPlayers[0]; // New host is first remaining player
    }

    await update(lobbyRef, {
      players: updatedPlayers,
      playerNames: updatedNames,
      hostId,
      updatedAt: serverTimestamp()
    });
  }

  // Clear user's presence
  updatePresence({ lobbyId: null, game: null });
}

/**
 * Patch arbitrary fields on a lobby (host operations).
 */
export async function updateLobby(lobbyId, patch) {
  if (!initialized) initFirebase();
  await update(ref(db, `lobbies/${lobbyId}`), { ...patch, updatedAt: serverTimestamp() });
}

/**
 * Host starts the match: locks the lobby, generates a seed and stamps the
 * start time. Every member's lobby watcher sees status flip to "starting"
 * and begins the game locally (host-authoritative P2P from there).
 * Returns the updated lobby data or throws with a readable reason.
 */
export async function startMatch(lobbyId) {
  if (!initialized) initFirebase();
  const snapshot = await get(ref(db, `lobbies/${lobbyId}`));
  if (!snapshot.exists()) throw new Error("Lobby not found");
  const lobby = snapshot.val();

  const uid = currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  if (lobby.hostId !== uid) throw new Error("Only the host can start the match");
  if (lobby.status === "starting" || lobby.status === "playing") {
    return lobby; // already starting - idempotent
  }
  const playerCount = Array.isArray(lobby.players) ? lobby.players.length : 0;
  if (playerCount < (lobby.minPlayers || 2)) {
    throw new Error(`Need at least ${lobby.minPlayers || 2} players`);
  }

  const seed = Math.floor(Math.random() * 2147483647) + 1;
  await updateLobby(lobbyId, { status: "starting", seed, startedAt: Date.now() });
  return { ...lobby, status: "starting", seed };
}

/**
 * Remove a lobby outright (used by host and by stale-lobby sweeps).
 */
export async function deleteLobby(lobbyId) {
  if (!initialized) initFirebase();
  await remove(ref(db, `lobbies/${lobbyId}`));
  // Best-effort cleanup of per-lobby side data.
  try { await remove(ref(db, `signaling/${lobbyId}`)); } catch { /* ignore */ }
  try { await remove(ref(db, `games/${lobbyId}`)); } catch { /* ignore */ }
  try { await remove(ref(db, `chat/${lobbyId}`)); } catch { /* ignore */ }
}

/**
 * Dynamic QoL sweep that deletes dead lobbies so they don't pile up.
 * A lobby is dead when ANY of these hold:
 *  1. Its host is gone: no presence entry or lastSeen older than
 *     HOST_OFFLINE_MS (covers closed tabs via onDisconnect).
 *  2. The host made a NEWER waiting lobby (duplicate cleanup): only the
 *     newest waiting lobby per host survives.
 *  3. Age: idle for over an hour, or the match ended more than 2h ago.
 *
 * Freshly created lobbies get a short grace period so a slow presence
 * write can't get your lobby nuked. Safe to call repeatedly from any
 * client; deletions are idempotent. Returns number of lobbies removed.
 */
const HOST_OFFLINE_MS = 5 * 60 * 1000;      // host absent from presence >5min
const NEW_LOBBY_GRACE_MS = 2 * 60 * 1000;   // newborn lobbies can't be swept
const LOBBY_IDLE_MAX_MS = 60 * 60 * 1000;   // no activity for 1h
const MATCH_OVER_MAX_MS = 2 * 60 * 60 * 1000; // match ended >2h ago

export async function cleanupStaleLobbies() {
  if (!initialized) initFirebase();
  const [lobbiesSnap, presenceSnap] = await Promise.all([
    get(ref(db, "lobbies")),
    get(ref(db, "presence")),
  ]);
  if (!lobbiesSnap.exists()) return 0;

  // Presence lookup: uid -> { status, lastSeen }
  const presence = {};
  if (presenceSnap.exists()) {
    presenceSnap.forEach((child) => { presence[child.key] = child.val() || {}; });
  }

  const now = Date.now();
  let removed = 0;
  const deadKeys = new Set();

  // Collect waiting lobbies grouped by host (for duplicate detection).
  const byHost = {};
  const entries = [];
  lobbiesSnap.forEach((child) => {
    const lobby = child.val();
    if (!lobby || !child.key) return;
    entries.push({ key: child.key, lobby });

    if (lobby.status !== "waiting") return;

    // Rule 1: host left the game (offline presence), past grace period.
    const createdAt = typeof lobby.createdAt === "number" ? lobby.createdAt : 0;
    const fresh = createdAt && (now - createdAt < NEW_LOBBY_GRACE_MS);
    const pres = lobby.hostId ? presence[lobby.hostId] : null;
    const lastSeen = typeof pres?.lastSeen === "number" ? pres.lastSeen : 0;
    const hostOnline = pres && pres.status === "online"
      && (!lastSeen || now - lastSeen < HOST_OFFLINE_MS);

    if (!fresh && !hostOnline) {
      deadKeys.add(child.key);
      removed++;
      return;
    }
    if (lobby.hostId) {
      (byHost[lobby.hostId] = byHost[lobby.hostId] || []).push({ key: child.key, lobby });
    }
  });

  // Rule 2: multiple waiting lobbies from one host -> keep the newest,
  // sweep the rest ("host made a new game" duplicates).
  Object.values(byHost).forEach((list) => {
    if (list.length < 2) return;
    list.sort((a, b) => (b.lobby.updatedAt || b.lobby.createdAt || 0) - (a.lobby.updatedAt || a.lobby.createdAt || 0));
    for (let i = 1; i < list.length; i++) {
      if (!deadKeys.has(list[i].key)) {
        deadKeys.add(list[i].key);
        removed++;
      }
    }
  });

  // Rule 3: age-based fallbacks.
  entries.forEach(({ key, lobby }) => {
    if (deadKeys.has(key)) return;
    const updatedAt = typeof lobby.updatedAt === "number" ? lobby.updatedAt : null;
    const startedAt = typeof lobby.startedAt === "number" ? lobby.startedAt : null;
    const createdAt = typeof lobby.createdAt === "number" ? lobby.createdAt : updatedAt;
    const lastActivity = Math.max(updatedAt || 0, startedAt || 0, createdAt || 0);

    const matchLongOver = lobby.status && lobby.status !== "waiting"
      && startedAt && now - startedAt > MATCH_OVER_MAX_MS;
    const longIdle = !lastActivity || now - lastActivity > LOBBY_IDLE_MAX_MS;
    if (matchLongOver || longIdle) {
      deadKeys.add(key);
      removed++;
    }
  });

  deadKeys.forEach((key) => { deleteLobby(key).catch(() => {}); });

  // Same QoL for per-match relay data: drop games/{id} nodes whose host
  // stopped writing over an hour ago (abandoned matches).
  let gamesRemoved = 0;
  try {
    const gamesSnap = await get(ref(db, "games"));
    if (gamesSnap.exists()) {
      const nowMs = Date.now();
      gamesSnap.forEach((child) => {
        const g = child.val() || {};
        const updated = (g.state && g.state.updatedAt) || 0;
        if (!updated || nowMs - updated > LOBBY_IDLE_MAX_MS) {
          remove(ref(db, `games/${child.key}`)).catch(() => {});
          gamesRemoved++;
        }
      });
    }
  } catch { /* games node optional */ }

  return removed + gamesRemoved;
}

export function onLobbyListChange(callback) {
  const lobbiesRef = ref(db, "lobbies");
  const q = query(lobbiesRef, orderByChild("status"), equalTo("waiting"));
  onValue(q, (snapshot) => {
    const lobbies = [];
    snapshot.forEach((child) => {
      // Private lobbies are invite-only - never expose them in the
      // public listing (join still requires the invite code).
      const val = child.val();
      if (val && val.type === "private") return;
      lobbies.push(val);
    });
    callback(lobbies);
  });
  return () => off(q);
}

/** One-shot read of open (non-private) waiting lobbies for quick panels. */
export async function listPublicLobbies() {
  if (!initialized) initFirebase();
  const q = query(ref(db, "lobbies"), orderByChild("status"), equalTo("waiting"));
  const snapshot = await get(q);
  const lobbies = [];
  snapshot.forEach((child) => {
    const val = child.val();
    if (val && val.type === "private") return;
    lobbies.push(val);
  });
  return lobbies;
}

/** One-shot lobby read (used by the polling fallback for match start). */
export async function getLobbyOnce(lobbyId) {
  if (!initialized) initFirebase();
  const snapshot = await get(ref(db, `lobbies/${lobbyId}`));
  return snapshot.exists() ? snapshot.val() : null;
}

export function onLobbyChange(lobbyId, callback) {
  const lobbyRef = ref(db, `lobbies/${lobbyId}`);
  onValue(lobbyRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.val());
    } else {
      callback(null);
    }
  });
  return () => off(lobbyRef);
}

// ─── WebRTC Signaling ────────────────────────────────────────────────────────

export async function sendSignal(lobbyId, toUid, signalData) {
  if (!initialized) initFirebase();
  // push() a unique child per signal: ICE bursts fire several candidates in
  // milliseconds, and a fixed per-sender key would overwrite the previous
  // unconsumed signal (a late candidate can even erase the offer itself).
  const signalRef = push(ref(db, `signaling/${lobbyId}/${toUid}/incoming`));
  await set(signalRef, {
    from: currentUser.uid,
    fromName: currentUser.displayName || "Anonymous",
    data: signalData,
    timestamp: serverTimestamp()
  });
}

export function onSignal(lobbyId, callback) {
  if (!initialized) initFirebase();
  const myUid = currentUser.uid;
  const signalRef = ref(db, `signaling/${lobbyId}/${myUid}/incoming`);
  onValue(signalRef, (snapshot) => {
    snapshot.forEach((child) => {
      const signal = child.val();
      callback(signal);
      // Remove after processing
      remove(child.ref);
    });
  });
  return () => off(signalRef);
}

export async function clearSignals(lobbyId) {
  if (!initialized) initFirebase();
  const myUid = currentUser.uid;
  await remove(ref(db, `signaling/${lobbyId}/${myUid}/incoming`));
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export async function sendChatMessage(lobbyId, message) {
  if (!initialized) initFirebase();
  const chatRef = ref(db, `chat/${lobbyId}/messages`);
  const newMsgRef = push(chatRef);
  await set(newMsgRef, {
    id: newMsgRef.key,
    from: currentUser.uid,
    fromName: currentUser.displayName || "Anonymous",
    message,
    timestamp: serverTimestamp()
  });
}

export function onChatMessages(lobbyId, callback) {
  if (!initialized) initFirebase();
  const chatRef = ref(db, `chat/${lobbyId}/messages`);
  const q = query(chatRef, orderByChild("timestamp"), limitToLast(50));
  onValue(q, (snapshot) => {
    const messages = [];
    snapshot.forEach((child) => {
      messages.push(child.val());
    });
    callback(messages);
  });
  return () => off(q);
}

// ─── Game State (Optional - for sync) ────────────────────────────────────────

export async function saveGameState(lobbyId, gameState) {
  if (!initialized) initFirebase();
  // Store the state as ONE opaque base64 JSON string. RTDB strips null
  // values from arrays on write (the chess board is 64 cells that are
  // mostly null), which deletes board rows and corrupts raw states.
  // A single string is something the database cannot mangle; onGameState
  // decodes it. Legacy plain-object nodes still decode as before.
  const json = btoa(unescape(encodeURIComponent(JSON.stringify(gameState))));
  // updatedAt stays top-level: the dead-relay sweeper reads
  // games/{id}/state/updatedAt to drop abandoned matches.
  await set(ref(db, `games/${lobbyId}/state`), { json, updatedAt: serverTimestamp() });
}

/** Client -> host input relay for players whose P2P channel failed. */
export async function writeLobbyInput(lobbyId, playerId, input) {
  if (!initialized) initFirebase();
  // Each input is push()-ed as a unique child under inputs/{pid} instead of
  // overwriting a single key. The host deletes exactly the child keys it
  // consumed, so an input written while it is consuming can no longer be
  // silently removed before being processed.
  await set(push(ref(db, `games/${lobbyId}/inputs/${playerId}`)), input);
}

/**
 * Host: live feed of relayed inputs keyed by player id.
 * Callback shape stays {pid: input}: when a player has several queued
 * inputs, the one with the newest push key wins ("last wins", matching
 * the previous overwrite semantics). The second argument maps pid to the
 * exact child keys backing the delivered inputs, so the host can delete
 * only what it actually consumed.
 */
export function onLobbyInputs(lobbyId, callback) {
  if (!initialized) initFirebase();
  const inputsRef = ref(db, `games/${lobbyId}/inputs`);
  return onValue(inputsRef, (snapshot) => {
    const inputs = {};
    const keysByPid = {};
    snapshot.forEach((pidChild) => {
      let lastKey = null;
      let lastVal = null;
      const seenKeys = [];
      pidChild.forEach((inputChild) => {
        // Push keys sort chronologically; deliver the newest non-null entry.
        if (inputChild.val() !== null) {
          seenKeys.push(inputChild.key);
          lastKey = inputChild.key;
          lastVal = inputChild.val();
        }
      });
      if (lastKey !== null) {
        inputs[pidChild.key] = lastVal;
        // Delete EVERY key we just observed: otherwise an older push left
        // behind would be re-delivered (out of order) on the next snapshot.
        keysByPid[pidChild.key] = seenKeys;
      }
    });
    callback(inputs, keysByPid);
  });
}

/**
 * Host: remove a consumed relayed input so it isn't reprocessed.
 * With childKeys, deletes exactly those pushed input children (multi-path
 * update - no newer unconsumed input is touched). Without them, removes
 * everything queued for that player (legacy single-key callers).
 */
export async function clearLobbyInput(lobbyId, playerId, childKeys) {
  if (!initialized) initFirebase();
  const pidRef = ref(db, `games/${lobbyId}/inputs/${playerId}`);
  if (Array.isArray(childKeys) && childKeys.length > 0) {
    await update(pidRef, Object.fromEntries(childKeys.map((k) => [k, null])));
  } else {
    await remove(pidRef);
  }
}

/** Host: publish the match result so non-P2P clients see it too. */
export async function writeMatchOver(lobbyId, winnerId, winnerName) {
  if (!initialized) initFirebase();
  await set(ref(db, `games/${lobbyId}/over`), { winner: winnerId, winnerName, at: serverTimestamp() });
}

/** Client: watch for the match result (fallback when P2P is down). */
export function onMatchOver(lobbyId, callback) {
  if (!initialized) initFirebase();
  const overRef = ref(db, `games/${lobbyId}/over`);
  // onValue returns an UNSUBSCRIBE function (modular SDK). Calling
  // off(ref,"value",handler) with it matches nothing and leaks the listener.
  let done = false;
  const unsub = onValue(overRef, (snapshot) => {
    if (done || !snapshot.exists()) return;
    done = true;
    unsub();
    const val = snapshot.val();
    callback(val.winner, val.winnerName);
  });
  return () => { done = true; unsub(); };
}

/** Clear per-lobby game relay data (called by the host at match start). */
export async function clearLobbyGame(lobbyId) {
  if (!initialized) initFirebase();
  try { await remove(ref(db, `games/${lobbyId}`)); } catch { /* ignore */ }
}

export function onGameState(lobbyId, callback) {
  if (!initialized) initFirebase();
  const gameRef = ref(db, `games/${lobbyId}/state`);
  onValue(gameRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const val = snapshot.val();
    try {
      // New format: { json: <base64> }. Legacy plain objects pass through
      // but are usually RTDB-corrupted; receiveState rejects those.
      if (val && typeof val.json === "string") {
        callback(JSON.parse(decodeURIComponent(escape(atob(val.json)))));
      } else {
        callback(val);
      }
    } catch (e) {
      console.warn("[Firebase] state decode failed:", e);
    }
  });
  return () => off(gameRef);
}


// ─── Lobby Chat/Messages ─────────────────────────────────────────────────────

export async function sendLobbyMessage(lobbyId, message, meta = {}) {
  if (!initialized) initFirebase();
  const user = getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  const msgRef = push(ref(db, `lobby_chat/${lobbyId}`));
  await set(msgRef, {
    id: msgRef.key,
    from: user.uid,
    fromName: user.displayName || user.email?.split("@")[0] || "Anonymous",
    message,
    channel: meta.channel || null,
    senderTeam: meta.senderTeam || null,
    timestamp: serverTimestamp()
  });
}

export function onLobbyMessages(lobbyId, callback) {
  if (!initialized) initFirebase();
  const chatRef = ref(db, `lobby_chat/${lobbyId}`);
  const q = query(chatRef, orderByChild("timestamp"), limitToLast(50));
  onValue(q, (snapshot) => {
    const messages = [];
    snapshot.forEach((child) => {
      messages.push(child.val());
    });
    callback(messages);
  });
  return () => off(q);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function cleanup() {
  if (myPresenceRef) {
    onDisconnect(myPresenceRef).cancel();
    remove(myPresenceRef);
  }
}
