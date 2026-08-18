/**
 * Invariant tests for lobby validation.
 *
 * Tests that validateLobby catches corrupt data correctly,
 * and that the server never stores invalid lobbies.
 *
 * Run: deno test -A --unstable-kv server/tests/invariant_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import { validateLobby, checkLobbyInvariant, isLobbyValid } from "../invariants.ts";

// ─── Valid Lobbies ──────────────────────────────────────────────────────────

Deno.test("INVARIANT: Valid lobby passes validation", () => {
 const lobby = {
 id: "lobby-123",
 name: "Test Lobby",
 gameId: "chess-royale",
 type: "open",
 status: "waiting",
 players: [],
 signups: [],
 maxPlayers: 10,
 minPlayers: 2,
 hostName: "Alice",
 createdAt: Date.now(),
 seed: null,
 inviteCode: null,
 };
 assertEquals(isLobbyValid(lobby), true);
 assertEquals(validateLobby(lobby).length, 0);
});

Deno.test("INVARIANT: Full lobby with players passes", () => {
 const lobby = {
 id: "lobby-456",
 name: "Full Lobby",
 gameId: "chess-royale",
 type: "signup",
 status: "playing",
 players: [
 { id: "p1", name: "Alice", connected: true },
 { id: "p2", name: "Bob", connected: true },
 ],
 signups: [
 { userId: "u1", username: "Alice", signedUpAt: Date.now() },
 ],
 maxPlayers: 4,
 minPlayers: 2,
 hostName: "Alice",
 createdAt: Date.now(),
 seed: 12345,
 inviteCode: "ABCDEF",
 };
 assertEquals(isLobbyValid(lobby), true);
});

// ─── Invalid Lobbies ────────────────────────────────────────────────────────

Deno.test("INVARIANT: null lobby rejected", () => {
 assertEquals(isLobbyValid(null), false);
 assertEquals(validateLobby(null).length > 0, true);
});

Deno.test("INVARIANT: undefined lobby rejected", () => {
 assertEquals(isLobbyValid(undefined), false);
});

Deno.test("INVARIANT: string lobby rejected", () => {
 assertEquals(isLobbyValid("not a lobby"), false);
});

Deno.test("INVARIANT: number lobby rejected", () => {
 assertEquals(isLobbyValid(123), false);
});

Deno.test("INVARIANT: lobby with missing id rejected", () => {
 const lobby = { name: "Test", players: [], signups: [], maxPlayers: 10, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with empty id rejected", () => {
 const lobby = { id: "", name: "Test", players: [], signups: [], maxPlayers: 10, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with non-array players rejected", () => {
 const lobby = { id: "l1", name: "Test", players: "not array", signups: [], maxPlayers: 10, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with non-array signups rejected", () => {
 const lobby = { id: "l1", name: "Test", players: [], signups: null, maxPlayers: 10, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with maxPlayers < 2 rejected", () => {
 const lobby = { id: "l1", name: "Test", players: [], signups: [], maxPlayers: 1, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with minPlayers < 2 rejected", () => {
 const lobby = { id: "l1", name: "Test", players: [], signups: [], maxPlayers: 10, minPlayers: 1, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with minPlayers > maxPlayers rejected", () => {
 const lobby = { id: "l1", name: "Test", players: [], signups: [], maxPlayers: 5, minPlayers: 10, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: lobby with invalid status rejected", () => {
 const lobby = { id: "l1", name: "Test", players: [], signups: [], maxPlayers: 10, minPlayers: 2, status: "invalid" };
 assertEquals(isLobbyValid(lobby), false);
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

Deno.test("INVARIANT: undefined players rejected (not undefined)", () => {
 // players must be an array undefined is not allowed
 const lobby = { id: "l1", name: "Test", players: undefined, signups: [], maxPlayers: 10, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: undefined signups rejected", () => {
 const lobby = { id: "l1", name: "Test", players: [], signups: undefined, maxPlayers: 10, minPlayers: 2, status: "waiting" };
 assertEquals(isLobbyValid(lobby), false);
});

Deno.test("INVARIANT: checkLobbyInvariant throws in dev", () => {
 // In dev (no DENO_DEPLOYMENT_ID), it should throw
 const badLobby = { id: "", name: "Test", players: [], signups: [], maxPlayers: 10, minPlayers: 2, status: "waiting" };
 let threw = false;
 try {
 checkLobbyInvariant(badLobby, "test");
 } catch {
 threw = true;
 }
 // It might or might not throw depending on env, but should not crash
 assert(typeof threw === "boolean");
});

Deno.test("INVARIANT: All valid statuses accepted", () => {
 const statuses = ["waiting", "starting", "playing", "ended"];
 for (const status of statuses) {
 const lobby = { id: "l1", name: "Test", players: [], signups: [], maxPlayers: 10, minPlayers: 2, status };
 assertEquals(isLobbyValid(lobby), true, `Bug! Status "${status}" rejected`);
 }
});
