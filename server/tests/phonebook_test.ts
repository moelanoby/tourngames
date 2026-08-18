/**
 * Tests for the Phonebook module (server/phonebook.ts).
 *
 * The phonebook handles:
 *  - Peer registration (player joins a lobby)
 *  - Heartbeats (keep peer entry alive)
 *  - Unregister (player leaves)
 *  - Signaling store-and-forward (offer/answer/ICE candidates)
 *
 * These tests use a real Deno KV instance (the --unstable-kv flag is
 * required). Each test cleans up its own KV entries to avoid cross-test
 * contamination.
 *
 * Run: deno test -A --unstable-kv server/tests/phonebook_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import {
 registerPeer,
 unregisterPeer,
 heartbeatPeer,
 getLobbyPeers,
 storeSignal,
 pollSignals,
} from "../phonebook.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const kv = await Deno.openKv();

function randomId(prefix: string): string {
 return `${prefix}_${crypto.randomUUID()}`;
}

async function cleanupPrefix(prefix: any[]) {
 for await (const entry of kv.list({ prefix })) {
  await kv.delete(entry.key);
 }
}

async function cleanupAll() {
 await cleanupPrefix(["peer"]);
 await cleanupPrefix(["lobby-peer"]);
 await cleanupPrefix(["signal"]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
 name: "PHONEBOOK: registerPeer stores entry and indexes by lobby",
 fn: async () => {
  await cleanupAll();
  const playerId = randomId("p");
  const lobbyId = randomId("l");
  await registerPeer(playerId, lobbyId, "Alice", null);
  const peers = await getLobbyPeers(lobbyId);
  assertEquals(peers.length, 1);
  assertEquals(peers[0]?.playerId, playerId);
  assertEquals(peers[0]?.username, "Alice");
  assertEquals(peers[0]?.userId, null);
 },
});

Deno.test({
 name: "PHONEBOOK: registerPeer with non-string fields coerces safely",
 fn: async () => {
  await cleanupAll();
  // Pass non-string values; registerPeer should coerce them.
  // @ts-ignore: intentionally passing wrong types
  await registerPeer(123, 456, 789, undefined);
  // Use the coerced IDs to look up the entry.
  const peers = await getLobbyPeers("456");
  assertEquals(peers.length, 1);
  assertEquals(peers[0]?.playerId, "123");
  assertEquals(peers[0]?.username, null); // 789 is not a string, so null
 },
});

Deno.test({
 name: "PHONEBOOK: registerPeer is idempotent (re-register updates lastSeen)",
 fn: async () => {
  await cleanupAll();
  const playerId = randomId("p");
  const lobbyId = randomId("l");
  await registerPeer(playerId, lobbyId, "Alice", null);
  const peers1 = await getLobbyPeers(lobbyId);
  const firstSeen = peers1[0]?.registeredAt;
  // Wait a tiny bit to ensure lastSeen would differ.
  await new Promise((r) => setTimeout(r, 10));
  await registerPeer(playerId, lobbyId, "Alice", null);
  const peers2 = await getLobbyPeers(lobbyId);
  assertEquals(peers2.length, 1, "Re-register should not duplicate");
  // registeredAt should be the same (only lastSeen updates on heartbeat).
  assertEquals(peers2[0]?.registeredAt, firstSeen);
 },
});

Deno.test({
 name: "PHONEBOOK: getLobbyPeers returns empty for unknown lobby",
 fn: async () => {
  await cleanupAll();
  const peers = await getLobbyPeers("nonexistent-lobby");
  assertEquals(peers, []);
 },
});

Deno.test({
 name: "PHONEBOOK: heartbeatPeer updates lastSeen but not registeredAt",
 fn: async () => {
  await cleanupAll();
  const playerId = randomId("p");
  const lobbyId = randomId("l");
  await registerPeer(playerId, lobbyId, "Alice", null);
  const before = (await getLobbyPeers(lobbyId))[0];
  await new Promise((r) => setTimeout(r, 10));
  await heartbeatPeer(playerId);
  const after = (await getLobbyPeers(lobbyId))[0];
  assertEquals(after.registeredAt, before.registeredAt,
   "registeredAt should not change on heartbeat");
  assert(after.lastSeen > before.lastSeen,
   "lastSeen should update on heartbeat");
 },
});

Deno.test({
 name: "PHONEBOOK: heartbeatPeer on unknown peer is a no-op (no crash)",
 fn: async () => {
  await cleanupAll();
  // No exception should be thrown.
  await heartbeatPeer("nonexistent-peer");
  // No new entries should appear.
  const peers = await getLobbyPeers("any-lobby");
  assertEquals(peers, []);
 },
});

Deno.test({
 name: "PHONEBOOK: unregisterPeer removes both peer and lobby-peer entries",
 fn: async () => {
  await cleanupAll();
  const playerId = randomId("p");
  const lobbyId = randomId("l");
  await registerPeer(playerId, lobbyId, "Alice", null);
  assertEquals((await getLobbyPeers(lobbyId)).length, 1);
  await unregisterPeer(playerId);
  assertEquals((await getLobbyPeers(lobbyId)).length, 0,
   "Lobby-peer entry should be removed after unregister");
  // The peer entry should also be gone.
  const peerRes = await kv.get(["peer", playerId]);
  assertEquals(peerRes.value, null,
   "Peer entry should be removed after unregister");
 },
});

Deno.test({
 name: "PHONEBOOK: unregisterPeer on unknown peer is a no-op (no crash)",
 fn: async () => {
  await cleanupAll();
  // No exception should be thrown.
  await unregisterPeer("nonexistent-peer");
 },
});

Deno.test({
 name: "PHONEBOOK: storeSignal + pollSignals round-trip",
 fn: async () => {
  await cleanupAll();
  const targetId = randomId("p");
  const fromId = randomId("p2");
  await storeSignal(targetId, fromId, "offer", { sdp: "fake-sdp" });
  // No delay needed  the production code uses a monotonic seq counter
  // to break ties when two signals share the same createdAt millisecond.
  await storeSignal(targetId, fromId, "ice-candidate", { candidate: "fake-candidate" });
  const signals = await pollSignals(targetId);
  assertEquals(signals.length, 2);
  assertEquals(signals[0]?.type, "offer");
  assertEquals(signals[1]?.type, "ice-candidate");
  assertEquals(signals[0]?.data, { sdp: "fake-sdp" });
  assertEquals(signals[1]?.data, { candidate: "fake-candidate" });
  // pollSignals should consume on read; a second poll returns [].
  const signals2 = await pollSignals(targetId);
  assertEquals(signals2, [], "pollSignals should consume signals on read");
 },
});

Deno.test({
 name: "PHONEBOOK: signals stored in same millisecond still sort correctly (seq tiebreaker)",
 fn: async () => {
  // Store 5 signals in rapid succession. They'll all have the same
  // Date.now() value (same millisecond), but the seq counter ensures
  // deterministic ordering.
  await cleanupAll();
  const targetId = randomId("p");
  const types = ["offer", "answer", "ice-candidate", "ice-candidate", "ice-candidate"];
  for (const t of types) {
   await storeSignal(targetId, "from", t as any, { x: 1 });
  }
  const signals = await pollSignals(targetId);
  assertEquals(signals.length, 5);
  // They should come back in insertion order (offer first, then answer,
  // then the 3 ICE candidates).
  assertEquals(signals.map((s) => s.type), types);
  // seq values should be strictly increasing.
  for (let i = 1; i < signals.length; i++) {
   assert(signals[i].seq > signals[i - 1].seq, `seq should increase: ${signals[i - 1].seq} -> ${signals[i].seq}`);
  }
 },
});

Deno.test({
 name: "PHONEBOOK: pollSignals returns signals in chronological order",
 fn: async () => {
  await cleanupAll();
  const targetId = randomId("p");
  // Store signals with staggered timestamps.
  // We can't set timestamps directly, but we can wait between stores.
  await storeSignal(targetId, "from1", "offer", { n: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await storeSignal(targetId, "from2", "answer", { n: 2 });
  await new Promise((r) => setTimeout(r, 10));
  await storeSignal(targetId, "from3", "ice-candidate", { n: 3 });
  const signals = await pollSignals(targetId);
  assertEquals(signals.length, 3);
  assertEquals(signals[0]?.data, { n: 1 });
  assertEquals(signals[1]?.data, { n: 2 });
  assertEquals(signals[2]?.data, { n: 3 });
 },
});

Deno.test({
 name: "PHONEBOOK: pollSignals on unknown target returns empty (no crash)",
 fn: async () => {
  await cleanupAll();
  const signals = await pollSignals("nonexistent-target");
  assertEquals(signals, []);
 },
});

Deno.test({
 name: "PHONEBOOK: storeSignal with non-serializable data stores null instead of crashing",
 fn: async () => {
  await cleanupAll();
  const targetId = randomId("p");
  // An object with a circular reference can't be JSON.stringify'd.
  const circular: any = {};
  circular.self = circular;
  await storeSignal(targetId, "from", "offer", circular);
  const signals = await pollSignals(targetId);
  assertEquals(signals.length, 1);
  // The data should be null (since JSON.stringify threw and the catch
  // set safeData = null).
  assertEquals(signals[0]?.data, null,
   "Non-serializable signal data should be stored as null, not crash");
 },
});

Deno.test({
 name: "PHONEBOOK: unregisterPeer cleans up pending signals",
 fn: async () => {
  await cleanupAll();
  const targetId = randomId("p");
  const lobbyId = randomId("l");
  await registerPeer(targetId, lobbyId, "Alice", null);
  await storeSignal(targetId, "from", "offer", { sdp: "fake" });
  assertEquals((await pollSignals(targetId)).length, 1);
  // Re-store after the consume-on-read above.
  await storeSignal(targetId, "from", "offer", { sdp: "fake2" });
  await unregisterPeer(targetId);
  // After unregister, polling should return [] (signals were cleaned up).
  assertEquals((await pollSignals(targetId)), [],
   "Pending signals should be cleaned up on unregister");
 },
});

Deno.test({
 name: "PHONEBOOK: getLobbyPeers returns multiple peers for the same lobby",
 fn: async () => {
  await cleanupAll();
  const lobbyId = randomId("l");
  await registerPeer(randomId("p1"), lobbyId, "Alice", null);
  await registerPeer(randomId("p2"), lobbyId, "Bob", null);
  await registerPeer(randomId("p3"), lobbyId, "Carol", null);
  const peers = await getLobbyPeers(lobbyId);
  assertEquals(peers.length, 3);
  const names = peers.map((p) => p.username).sort();
  assertEquals(names, ["Alice", "Bob", "Carol"]);
 },
});

Deno.test({
 name: "PHONEBOOK: signal entries have UUIDs",
 fn: async () => {
  await cleanupAll();
  const targetId = randomId("p");
  await storeSignal(targetId, "from", "offer", { x: 1 });
  const signals = await pollSignals(targetId);
  assertEquals(signals.length, 1);
  assert(typeof signals[0]?.id === "string", "Signal id should be a string");
  assert(signals[0].id.length > 10, "Signal id should be a UUID-like string");
 },
});

Deno.test({
 name: "PHONEBOOK: signals expire after TTL (5 minutes)",
 fn: async () => {
  // NOTE: Deno KV's expireIn doesn't make entries immediately invisible
  // in tests (the expiry is a background process). We can't easily test
  // TTL expiry without waiting 5 minutes. This test is a no-op placeholder
  // documenting the TTL behavior.
  // To test this properly, we'd need to mock Date.now() or use a fake
  // KV that supports time travel.
  // For now, we just verify the signal entry exists after storage.
  await cleanupAll();
  const targetId = randomId("p");
  await storeSignal(targetId, "from", "offer", { x: 1 });
  const signals = await pollSignals(targetId);
  assert(signals.length === 1, "Signal should be retrievable within TTL");
 },
});
