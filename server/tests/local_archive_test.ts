/**
 * Tests for the local-archive helpers (public/ui/local-archive.js).
 *
 * Uses a simple in-memory localStorage shim so we can exercise the
 * save/load/rename/counter logic without a real browser. Catches bugs
 * around auto-numbering, corrupted storage, quota limits, and rename
 * edge cases.
 *
 * Run: deno test -A --unstable-kv server/tests/local_archive_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import {
 saveLocalReplay,
 loadLocalReplays,
 renameLocalReplay,
 deleteLocalReplay,
 nextLocalMatchNumber,
 saveLocalReplays,
 LOCAL_REPLAYS_KEY,
 LOCAL_REPLAY_COUNTER_KEY,
 LOCAL_REPLAYS_MAX,
 _setStorageBackend,
 _resetStorageBackend,
 _getNoOpStorage,
} from "../../public/ui/local-archive.js";

// ─── Mock localStorage ─────────────────────────────────────────────────────

class MockStorage {
 _map: Map<string, string>;
 _setItemThrows: boolean;
 _quotaLimit: number;
 constructor() {
  this._map = new Map();
  this._setItemThrows = false;
  this._quotaLimit = Infinity;
 }
 getItem(key: string): string | null {
  if (this._map.has(key)) return this._map.get(key) ?? null;
  return null;
 }
 setItem(key: string, value: string): void {
  if (this._setItemThrows) {
   const e = new Error("QuotaExceededError");
   e.name = "QuotaExceededError";
   throw e;
  }
  if (this._map.size + 1 > this._quotaLimit && !this._map.has(key)) {
   const e = new Error("QuotaExceededError");
   e.name = "QuotaExceededError";
   throw e;
  }
  this._map.set(key, String(value));
 }
 removeItem(key: string): void { this._map.delete(key); }
 clear(): void { this._map.clear(); }
 // Test hooks
 setQuotaLimit(n: number): void { this._quotaLimit = n; }
 makeSetItemThrow(): void { this._setItemThrows = true; }
}

function freshStorage() {
 const s = new MockStorage();
 _setStorageBackend(s);
 return s;
}

function makeReplay(id: string, overrides: Record<string, unknown> = {}): any {
 return {
  replayId: id,
  gameModule: "chess-royale",
  seed: 12345,
  duration: 60000,
  winner: "p1",
  winnerName: "Alice",
  players: [{ id: "p1", name: "Alice", connected: true }],
  inputs: {},
  createdAt: Date.now(),
  ...overrides,
 };
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

function reset() {
 _resetStorageBackend();
}

Deno.test({
 name: "ARCHIVE: empty storage returns []",
 fn() {
  reset();
  const s = freshStorage();
  assertEquals(loadLocalReplays(), []);
  assertEquals(s.getItem(LOCAL_REPLAY_COUNTER_KEY), null);
 },
});

Deno.test({
 name: "ARCHIVE: first save auto-titles as 'Match 1'",
 fn() {
  reset();
  const s = freshStorage();
  const r = makeReplay("r1");
  const saved = saveLocalReplay(r);
  assertEquals(saved.title, "Match 1");
  assertEquals(s.getItem(LOCAL_REPLAY_COUNTER_KEY), "1");
  const all = loadLocalReplays();
  assertEquals(all.length, 1);
  assertEquals(all[0].title, "Match 1");
 },
});

Deno.test({
 name: "ARCHIVE: sequential saves auto-number Match 1, 2, 3...",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  saveLocalReplay(makeReplay("r2"));
  saveLocalReplay(makeReplay("r3"));
  const all = loadLocalReplays();
  assertEquals(all.length, 3);
  // Newest first: r3, r2, r1
  assertEquals(all[0].replayId, "r3");
  assertEquals(all[0].title, "Match 3");
  assertEquals(all[1].replayId, "r2");
  assertEquals(all[1].title, "Match 2");
  assertEquals(all[2].replayId, "r1");
  assertEquals(all[2].title, "Match 1");
 },
});

Deno.test({
 name: "ARCHIVE: pre-supplied title is respected (no auto-numbering)",
 fn() {
  reset();
  const s = freshStorage();
  saveLocalReplay(makeReplay("r1", { title: "My Custom Title" }));
  // Counter should NOT advance since we didn't use it.
  assertEquals(s.getItem(LOCAL_REPLAY_COUNTER_KEY), null);
  const all = loadLocalReplays();
  assertEquals(all[0].title, "My Custom Title");
 },
});

Deno.test({
 name: "ARCHIVE: pre-supplied title with only whitespace falls back to auto-numbering",
 fn() {
  reset();
  const s = freshStorage();
  saveLocalReplay(makeReplay("r1", { title: "   " }));
  // Whitespace-only title should be treated as empty and auto-numbered.
  assertEquals(s.getItem(LOCAL_REPLAY_COUNTER_KEY), "1");
  const all = loadLocalReplays();
  assertEquals(all[0].title, "Match 1");
 },
});

Deno.test({
 name: "ARCHIVE: pre-supplied title is truncated to 80 chars",
 fn() {
  reset();
  freshStorage();
  const long = "x".repeat(200);
  saveLocalReplay(makeReplay("r1", { title: long }));
  const all = loadLocalReplays();
  assertEquals(all[0].title.length, 80);
 },
});

Deno.test({
 name: "ARCHIVE: save with same replayId replaces (no duplicate)",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1", { seed: 1 }));
  saveLocalReplay(makeReplay("r2"));
  saveLocalReplay(makeReplay("r1", { seed: 999 })); // re-save with different data
  const all = loadLocalReplays();
  assertEquals(all.length, 2); // still 2, not 3
  assertEquals(all[0].replayId, "r1"); // newest first
  assertEquals(all[0].seed, 999);
  assertEquals(all[1].replayId, "r2");
 },
});

Deno.test({
 name: "ARCHIVE: save with no replayId returns null (no crash)",
 fn() {
  reset();
  freshStorage();
  const result = saveLocalReplay({ gameModule: "chess-royale", seed: 1 });
  assertEquals(result, null);
  assertEquals(loadLocalReplays(), []);
 },
});

Deno.test({
 name: "ARCHIVE: rename updates the title in-place",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  const ok = renameLocalReplay("r1", "Epic Showdown");
  assertEquals(ok, true);
  const all = loadLocalReplays();
  assertEquals(all[0].title, "Epic Showdown");
 },
});

Deno.test({
 name: "ARCHIVE: rename returns false for unknown replayId",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  const ok = renameLocalReplay("does-not-exist", "new title");
  assertEquals(ok, false);
  // Existing replay is unchanged.
  assertEquals(loadLocalReplays()[0].title, "Match 1");
 },
});

Deno.test({
 name: "ARCHIVE: rename rejects empty/whitespace title (returns false)",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  assertEquals(renameLocalReplay("r1", ""), false);
  assertEquals(renameLocalReplay("r1", "   "), false);
  assertEquals(renameLocalReplay("r1", null), false);
  assertEquals(renameLocalReplay("r1", undefined), false);
  assertEquals(loadLocalReplays()[0].title, "Match 1");
 },
});

Deno.test({
 name: "ARCHIVE: rename truncates long titles to 80 chars",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  const long = "y".repeat(200);
  renameLocalReplay("r1", long);
  const all = loadLocalReplays();
  assertEquals(all[0].title.length, 80);
  assertEquals(all[0].title, "y".repeat(80));
 },
});

Deno.test({
 name: "ARCHIVE: rename title is escaped by the renderer (XSS check)",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  // The local-archive module itself doesn't escape (it just stores), but
  // the app.js renderer calls escapeHTML() on the title. We verify the
  // stored title is exactly what the user typed (the escape happens at
  // render time, not at storage time).
  renameLocalReplay("r1", "<script>alert('xss')</script>");
  const all = loadLocalReplays();
  assertEquals(all[0].title, "<script>alert('xss')</script>");
  // The renderer MUST escape this. (Tested separately in app.js behavior.)
 },
});

Deno.test({
 name: "ARCHIVE: corrupted localStorage (invalid JSON) returns []",
 fn() {
  reset();
  const s = freshStorage();
  s.setItem(LOCAL_REPLAYS_KEY, "{not valid json");
  assertEquals(loadLocalReplays(), []);
 },
});

Deno.test({
 name: "ARCHIVE: non-array stored value returns [] (defensive)",
 fn() {
  reset();
  const s = freshStorage();
  s.setItem(LOCAL_REPLAYS_KEY, JSON.stringify({ not: "an array" }));
  assertEquals(loadLocalReplays(), []);
 },
});

Deno.test({
 name: "ARCHIVE: array with invalid entries (strings/nulls) filters them out",
 fn() {
  reset();
  const s = freshStorage();
  // Manually craft a bad array with a mix of valid and invalid entries.
  const mixed = [
   makeReplay("good-1"),
   "not a replay",
   null,
   { notReplayId: true }, // missing replayId
   makeReplay("good-2", { gameModule: "" }), // missing gameModule
   { replayId: "bad-3" }, // missing seed
   makeReplay("good-3"),
  ];
  s.setItem(LOCAL_REPLAYS_KEY, JSON.stringify(mixed));
  const all = loadLocalReplays();
  assertEquals(all.length, 2);
  assertEquals(all[0].replayId, "good-1");
  assertEquals(all[1].replayId, "good-3");
 },
});

Deno.test({
 name: "ARCHIVE: cap at LOCAL_REPLAYS_MAX drops oldest (newest-first)",
 fn() {
  reset();
  freshStorage();
  // Save LOCAL_REPLAYS_MAX + 10 replays. The first 10 should be dropped
  // (they're the oldest since newest is at the front of the array).
  for (let i = 0; i < LOCAL_REPLAYS_MAX + 10; i++) {
   saveLocalReplay(makeReplay(`r${i}`));
  }
  const all = loadLocalReplays();
  assertEquals(all.length, LOCAL_REPLAYS_MAX);
  // Newest should be r(LOCAL_REPLAYS_MAX + 9), oldest kept should be r10.
  assertEquals(all[0].replayId, `r${LOCAL_REPLAYS_MAX + 9}`);
  assertEquals(all[all.length - 1].replayId, "r10");
 },
});

Deno.test({
 name: "ARCHIVE: quota exceeded on save triggers trim + retry",
 fn() {
  reset();
  const s = freshStorage();
  // Pre-populate with 100 replays.
  for (let i = 0; i < 100; i++) {
   saveLocalReplay(makeReplay(`r${i}`));
  }
  assertEquals(loadLocalReplays().length, 100);

  // Override setItem so the FIRST write to LOCAL_REPLAYS_KEY throws
  // (simulating quota exceeded), but subsequent writes succeed. Writes
  // to other keys (like the counter) should pass through unchanged.
  const realSetItem = s.setItem.bind(s);
  let replayWriteCalls = 0;
  s.setItem = function (key: string, value: string) {
   if (key === LOCAL_REPLAYS_KEY) {
    replayWriteCalls++;
    if (replayWriteCalls === 1) {
     const e = new Error("QuotaExceededError");
     e.name = "QuotaExceededError";
     throw e;
    }
   }
   return realSetItem(key, value);
  };

  // Save one more replay. The first setItem on LOCAL_REPLAYS_KEY will
  // throw, then saveLocalReplays should trim 25% and retry.
  saveLocalReplay(makeReplay("new-one"));

  // Verify the override was called: 1 throw + 1 retry = 2 calls to
  // setItem(LOCAL_REPLAYS_KEY, ...).
  assertEquals(replayWriteCalls, 2, `expected 2 replay writes, got ${replayWriteCalls}`);

  const all = loadLocalReplays();
  // After trim: filtered has 101 items (100 old + 1 new). 101 * 0.75 = 75.75
  // floored to 75. The trim keeps the FIRST 75 items, which includes
  // new-one (prepended at index 0) plus the 74 newest of the old replays.
  assertEquals(all.length, 75);
  assertEquals(all[0].replayId, "new-one");
 },
});

Deno.test({
 name: "ARCHIVE: quota exceeded on BOTH attempts returns null (saveLocalReplay)",
 fn() {
  reset();
  const s = freshStorage();
  // Pre-populate so there's data to trim.
  saveLocalReplay(makeReplay("r1"));
  // Make ALL setItem calls throw.
  s.makeSetItemThrow();
  // saveLocalReplay should return null, not throw.
  const result = saveLocalReplay(makeReplay("r2"));
  assertEquals(result, null);
 },
});

Deno.test({
 name: "ARCHIVE: saveLocalReplays returns boolean success indicator",
 fn() {
  reset();
  const s = freshStorage();
  assertEquals(saveLocalReplays([makeReplay("r1")]), true);
  s.makeSetItemThrow();
  assertEquals(saveLocalReplays([makeReplay("r2")]), false);
 },
});

Deno.test({
 name: "ARCHIVE: deleteLocalReplay removes entry, returns true on success",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  saveLocalReplay(makeReplay("r2"));
  assertEquals(deleteLocalReplay("r1"), true);
  const all = loadLocalReplays();
  assertEquals(all.length, 1);
  assertEquals(all[0].replayId, "r2");
 },
});

Deno.test({
 name: "ARCHIVE: deleteLocalReplay returns false for unknown id",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  assertEquals(deleteLocalReplay("does-not-exist"), false);
  assertEquals(loadLocalReplays().length, 1); // unchanged
 },
});

Deno.test({
 name: "ARCHIVE: nextLocalMatchNumber increments independently of saveLocalReplay",
 fn() {
  reset();
  const s = freshStorage();
  // Calling nextLocalMatchNumber directly increments the counter.
  assertEquals(nextLocalMatchNumber(), 1);
  assertEquals(nextLocalMatchNumber(), 2);
  assertEquals(nextLocalMatchNumber(), 3);
  assertEquals(s.getItem(LOCAL_REPLAY_COUNTER_KEY), "3");
  // A subsequent saveLocalReplay should use the next number (4).
  const saved = saveLocalReplay(makeReplay("r1"));
  assertEquals(saved.title, "Match 4");
 },
});

Deno.test({
 name: "ARCHIVE: clear() resets all state",
 fn() {
  reset();
  const s = freshStorage();
  saveLocalReplay(makeReplay("r1"));
  saveLocalReplay(makeReplay("r2"));
  assert(s.getItem(LOCAL_REPLAYS_KEY) !== null);
  assert(s.getItem(LOCAL_REPLAY_COUNTER_KEY) !== null);
  s.clear();
  assertEquals(loadLocalReplays(), []);
  assertEquals(s.getItem(LOCAL_REPLAY_COUNTER_KEY), null);
 },
});

Deno.test({
 name: "ARCHIVE: no localStorage available -> saveLocalReplay returns null, no crash",
 fn() {
  reset();
  // Inject the no-op shim explicitly (Deno has localStorage as a global,
  // so the fallback path wouldn't trigger naturally).
  _setStorageBackend(_getNoOpStorage());
  const result = saveLocalReplay(makeReplay("r1"));
  assertEquals(result, null);
  assertEquals(loadLocalReplays(), []);
  assertEquals(renameLocalReplay("r1", "new"), false);
 },
});

Deno.test({
 name: "ARCHIVE: replay without 'title' field gets auto-numbered",
 fn() {
  reset();
  freshStorage();
  const r = makeReplay("r1");
  // (r.title is already undefined since makeReplay doesn't set it)
  const saved = saveLocalReplay(r);
  assertEquals(saved.title, "Match 1");
 },
});

Deno.test({
 name: "ARCHIVE: loadLocalReplays returns a fresh array (mutations don't affect storage)",
 fn() {
  reset();
  freshStorage();
  saveLocalReplay(makeReplay("r1"));
  const all = loadLocalReplays();
  all.push(makeReplay("r2")); // mutate the returned array
  // Storage should be unaffected.
  assertEquals(loadLocalReplays().length, 1);
 },
});
