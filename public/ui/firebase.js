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
  limitToLast
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

function setupPresence(uid, displayName) {
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
  setInterval(() => {
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
    ...lobbyData,
    hostId: currentUser?.uid,
    hostName: currentUser?.displayName || "Anonymous",
    players: [currentUser?.uid],
    playerNames: { [currentUser?.uid]: currentUser?.displayName || "Anonymous" },
    status: "waiting", // waiting, playing, finished
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await set(newLobbyRef, lobby);
  return lobby;
}

export async function joinLobby(lobbyId) {
  if (!initialized) initFirebase();
  const lobbyRef = ref(db, `lobbies/${lobbyId}`);
  const snapshot = await get(lobbyRef);
  if (!snapshot.exists()) throw new Error("Lobby not found");

  const lobby = snapshot.val();
  if (lobby.status !== "waiting") throw new Error("Lobby not joinable");
  if (lobby.players.includes(currentUser.uid)) return lobby; // Already in

  const updatedPlayers = [...lobby.players, currentUser.uid];
  const updatedNames = { ...lobby.playerNames, [currentUser.uid]: currentUser.displayName || "Anonymous" };

  await update(lobbyRef, {
    players: updatedPlayers,
    playerNames: updatedNames,
    updatedAt: serverTimestamp()
  });

  // Update user's presence
  updatePresence({ lobbyId, game: lobby.game });

  return { ...lobby, players: updatedPlayers, playerNames: updatedNames };
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

export function onLobbyListChange(callback) {
  const lobbiesRef = ref(db, "lobbies");
  const q = query(lobbiesRef, orderByChild("status"), equalTo("waiting"));
  onValue(q, (snapshot) => {
    const lobbies = [];
    snapshot.forEach((child) => {
      lobbies.push(child.val());
    });
    callback(lobbies);
  });
  return () => off(q);
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
  const signalRef = ref(db, `signaling/${lobbyId}/${toUid}/incoming/${currentUser.uid}`);
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
  await set(ref(db, `games/${lobbyId}/state`), {
    ...gameState,
    updatedAt: serverTimestamp()
  });
}

export function onGameState(lobbyId, callback) {
  if (!initialized) initFirebase();
  const gameRef = ref(db, `games/${lobbyId}/state`);
  onValue(gameRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.val());
    }
  });
  return () => off(gameRef);
}


// ─── Lobby Chat/Messages ─────────────────────────────────────────────────────

export async function sendLobbyMessage(lobbyId, message) {
  if (!initialized) initFirebase();
  const user = getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  const msgRef = push(ref(db, `lobby_chat/${lobbyId}`));
  await set(msgRef, {
    id: msgRef.key,
    from: user.uid,
    fromName: user.displayName || user.email?.split("@")[0] || "Anonymous",
    message,
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
