/**
 * local-archive.js Local-only replay storage (v0.4)
 *
 * Replays are stored LOCALLY in the player's browser via localStorage.
 * They are NOT uploaded to the server, so each user only sees their own
 * match history in the Archive tab. Auto-numbering uses a localStorage
 * counter ("Match 1", "Match 2", ...) and the user can rename any of
 * their own matches freely.
 *
 * Extracted into its own module so it can be unit-tested via Deno.
 *
 * Storage layout:
 *   localStorage["tgn_replays"]         JSON-stringified array of ReplayData
 *   localStorage["tgn_replay_counter"] number for the next "Match N" title
 *
 * We cap the stored array at LOCAL_REPLAYS_MAX to stay safely under the
 * 5 MB localStorage per-origin limit (each team-chess replay is ~1-5 KB).
 */

// Allow tests to inject a mock storage. In the browser, `localStorage` is
// a global; in Node/Deno tests, the test file assigns `_storage` first.
let _storage;
function _getStore() {
 if (_storage) return _storage;
 if (typeof localStorage !== "undefined") return localStorage;
 // No localStorage available (private browsing, SSR, etc.) return a
 // shim where reads return null/empty and WRITES throw so callers
 // can detect that storage is unavailable and fall back gracefully.
 return _noopStorage;
}

// Shim used when no real localStorage is available. Exported so tests
// can inject it explicitly via `_setStorageBackend(_noStorageShim)`.
const _noopStorage = {
 getItem() { return null; },
 setItem() {
  // Throwing here lets saveLocalReplays() catch it and return false,
  // so saveLocalReplay() returns null and the UI shows a clear error
  // toast instead of silently dropping the data.
  const e = new Error("localStorage is unavailable in this context");
  e.name = "StorageUnavailableError";
  throw e;
 },
 removeItem() { /* no-op */ },
 clear() { /* no-op */ },
};

export const LOCAL_REPLAYS_KEY = "tgn_replays";
export const LOCAL_REPLAY_COUNTER_KEY = "tgn_replay_counter";
export const LOCAL_REPLAYS_MAX = 200;

/** Test hook: inject a mock storage backend. */
export function _setStorageBackend(s) { _storage = s; }
export function _resetStorageBackend() { _storage = null; }
/** Test hook: get the no-op shim (for simulating "no localStorage"). */
export function _getNoOpStorage() { return _noopStorage; }

// ─── Load / Save ────────────────────────────────────────────────────────────

/**
 * Read the local replay array (newest-first). Returns [] on parse error
 * or if localStorage is unavailable.
 */
export function loadLocalReplays() {
 try {
  const store = _getStore();
  const raw = store.getItem(LOCAL_REPLAYS_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  // Defensive: filter out entries that aren't valid replay objects (e.g.
  // a string or null sneaked in via manual localStorage editing).
  return parsed.filter(isValidReplay);
 } catch (e) {
  console.warn("[Archive] Failed to parse local replays:", e);
  return [];
 }
}

function isValidReplay(r) {
 return r && typeof r === "object" &&
  typeof r.replayId === "string" && r.replayId.length > 0 &&
  typeof r.gameModule === "string" && r.gameModule.length > 0 &&
  typeof r.seed === "number";
}

/**
 * Persist the local replay array (newest-first).
 * Returns true on success, false if localStorage is unavailable or
 * quota is exceeded (even after trimming the oldest 25%).
 */
export function saveLocalReplays(replays) {
 const store = _getStore();
 try {
  store.setItem(LOCAL_REPLAYS_KEY, JSON.stringify(replays));
  return true;
 } catch (e) {
  // Quota exceeded? Drop the oldest 25% and retry once.
  console.warn("[Archive] localStorage quota exceeded, dropping oldest:", e);
  const trimmed = replays.slice(0, Math.floor(replays.length * 0.75));
  try {
   store.setItem(LOCAL_REPLAYS_KEY, JSON.stringify(trimmed));
   return true;
  } catch (e2) {
   console.error("[Archive] Failed to save even after trimming:", e2);
   return false;
  }
 }
}

// ─── Counter ───────────────────────────────────────────────────────────────

/**
 * Allocate the next sequential "Match N" number from the local counter.
 * Each call increments the stored counter and returns the new number.
 */
export function nextLocalMatchNumber() {
 const store = _getStore();
 let n = 1;
 try {
  const raw = store.getItem(LOCAL_REPLAY_COUNTER_KEY);
  n = raw ? (parseInt(raw, 10) || 0) + 1 : 1;
 } catch { n = 1; }
 try {
  store.setItem(LOCAL_REPLAY_COUNTER_KEY, String(n));
 } catch { /* localStorage may be unavailable in private mode */ }
 return n;
}

// ─── Save Replay ────────────────────────────────────────────────────────────

/**
 * Save a replay to localStorage. Auto-assigns a "Match N" title if the
 * replay doesn't already have one. The replay is prepended so the newest
 * match appears first in the archive. The array is capped at
 * LOCAL_REPLAYS_MAX entries.
 *
 * @returns the saved replay (with title populated), or null if the save
 *          failed (localStorage unavailable or quota exceeded).
 */
export function saveLocalReplay(replay) {
 if (!replay || !replay.replayId) {
  console.warn("[Archive] saveLocalReplay: missing replayId");
  return null;
 }
 // Auto-assign a sequential title if none was provided.
 if (!replay.title || String(replay.title).trim().length === 0) {
  const n = nextLocalMatchNumber();
  replay.title = `Match ${n}`;
 } else {
  replay.title = String(replay.title).slice(0, 80).trim();
 }
 // Prepend (newest first) and cap the list.
 const all = loadLocalReplays();
 // If a replay with the same id already exists (shouldn't normally happen),
 // replace it instead of duplicating.
 const filtered = all.filter(r => r && r.replayId !== replay.replayId);
 filtered.unshift(replay);
 if (filtered.length > LOCAL_REPLAYS_MAX) {
  filtered.length = LOCAL_REPLAYS_MAX;
 }
 const ok = saveLocalReplays(filtered);
 return ok ? replay : null;
}

// ─── Rename ─────────────────────────────────────────────────────────────────

/**
 * Rename a local replay by id. Returns true on success, false if not found
 * or if the new title is empty/whitespace. No auth check needed 
 * replays are local to this browser, the user owns all of them.
 */
export function renameLocalReplay(replayId, newTitle) {
 const cleaned = String(newTitle || "").trim().slice(0, 80);
 if (cleaned.length === 0) return false;
 const all = loadLocalReplays();
 let found = false;
 for (const r of all) {
  if (r && r.replayId === replayId) {
   r.title = cleaned;
   found = true;
   break;
  }
 }
 if (!found) return false;
 return saveLocalReplays(all);
}

// ─── Delete (bonus helper, used by tests) ───────────────────────────────────

/**
 * Delete a local replay by id. Returns true on success, false if not found.
 */
export function deleteLocalReplay(replayId) {
 const all = loadLocalReplays();
 const filtered = all.filter(r => r && r.replayId !== replayId);
 if (filtered.length === all.length) return false; // nothing removed
 return saveLocalReplays(filtered);
}
