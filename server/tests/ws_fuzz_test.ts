/**
 * Fuzz test for the WebSocket message handler.
 *
 * Generates random/malformed messages and sends them to the handler,
 * checking that it never crashes. This catches the kind of bugs that
 * caused the `lobby.signups.length` TypeError in production.
 *
 * Run: deno test -A --unstable-kv server/tests/ws_fuzz_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1.0.0";

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

class MockSocket {
 messages: unknown[] = [];
 closed = false;
 closeCode = 0;
 readyState = 1; // OPEN

 send(data: unknown) {
 // Accept any type real WebSocket requires string, but we're mocking
 if (typeof data !== "string") return;
 try {
 this.messages.push(JSON.parse(data));
 } catch {
 this.messages.push(data);
 }
 }
 close(code = 1000, _reason = "") {
 this.closed = true;
 this.closeCode = code;
 this.readyState = 3; // CLOSED
 }
}

// ─── Random message generator ───────────────────────────────────────────────

function randomString(len: number): string {
 const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.@/ ";
 let out = "";
 for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
 return out;
}

function randomValue(): unknown {
 const type = Math.floor(Math.random() * 8);
 switch (type) {
 case 0: return null;
 case 1: return undefined;
 case 2: return Math.random() > 0.5;
 case 3: return Math.floor(Math.random() * 1000);
 case 4: return Math.random();
 case 5: return randomString(Math.floor(Math.random() * 50));
 case 6: return { foo: "bar", baz: Math.random() };
 case 7: return Array.from({ length: Math.floor(Math.random() * 5) }, () => randomString(5));
 }
}

function generateFuzzMessage(): unknown {
 // 30% chance: completely random JSON
 if (Math.random() < 0.3) return randomValue();

 // 70% chance: valid message type but with fuzzed fields
 const types = [
 "join", "join-specific", "create-lobby", "list-lobbies", "leave-lobby",
 "start-match", "offer", "answer", "ice-candidate", "p2p-ready",
 "match-over", "submit-replay", "poll-signals", "heartbeat",
 "game-state-relay", "input-relay", // old types that should be ignored
 ];
 const msgType = types[Math.floor(Math.random() * types.length)];
 return {
 type: msgType,
 // Fuzz each common field
 gameId: randomValue(),
 playerName: randomValue(),
 lobbyId: randomValue(),
 name: randomValue(),
 maxPlayers: randomValue(),
 minPlayers: randomValue(),
 lobbyType: randomValue(),
 hostName: randomValue(),
 to: randomValue(),
 from: randomValue(),
 data: randomValue(),
 winner: randomValue(),
 winnerName: randomValue(),
 replay: randomValue(),
 inviteCode: randomValue(),
 };
}

// ─── Fuzz test ──────────────────────────────────────────────────────────────

Deno.test("FUZZ: WebSocket handler never crashes on random input", { sanitizeResources: false, sanitizeOps: false }, async () => {
 const { handleWebSocketMessage } = await import("../signaling.ts");
 const { connections } = await import("../signaling.ts");

 const socket = new MockSocket();
 const playerId = "fuzz-player-" + Math.random().toString(36).slice(2);
 connections.set(playerId, {
 lobbyId: null,
 ws: socket as unknown as WebSocket,
 userId: null,
 username: "Fuzzer",
 });

 let crashes = 0;
 const crashMessages: string[] = [];

 // Send 500 random messages
 for (let i = 0; i < 500; i++) {
 const msg = generateFuzzMessage();
 try {
 const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
 await handleWebSocketMessage(
 socket as unknown as WebSocket,
 { playerId, userId: null, username: "Fuzzer" },
 raw,
 );
 } catch (e) {
 crashes++;
 const errMsg = e instanceof Error ? e.message : String(e);
 const stack = e instanceof Error ? e.stack?.split("\n")[1] : "";
 crashMessages.push(`Message ${i}: ${errMsg}\n ${stack}`);
 }
 }

 // The handler should NEVER crash, regardless of input
 assertEquals(
 crashes,
 0,
 `Fuzzer found ${crashes} crashes!\n${crashMessages.slice(0, 5).join("\n")}`,
 );

 connections.delete(playerId);
});

Deno.test("FUZZ: Malformed JSON doesn't crash handler", { sanitizeResources: false, sanitizeOps: false }, async () => {
 const { handleWebSocketMessage } = await import("../signaling.ts");
 const { connections } = await import("../signaling.ts");

 const socket = new MockSocket();
 const playerId = "fuzz-malformed-" + Math.random().toString(36).slice(2);
 connections.set(playerId, {
 lobbyId: null,
 ws: socket as unknown as WebSocket,
 userId: null,
 username: "Fuzzer",
 });

 const malformed = [
 "", // empty
 "{", // incomplete JSON
 "null",
 "undefined",
 "[]", // array instead of object
 "42", // number
 '"string"', // string
 "{ type: }", // syntax error
 '{"type": null}',
 '{"type": ""}',
 '{"type": 123}',
 '{"type": [], "data": {}}',
 JSON.stringify({ type: "join", gameId: null, playerName: null }),
 JSON.stringify({ type: "create-lobby", name: null, maxPlayers: -1 }),
 JSON.stringify({ type: "create-lobby", name: "a".repeat(10000), maxPlayers: 99999 }),
 ];

 let crashes = 0;
 for (const raw of malformed) {
 try {
 await handleWebSocketMessage(
 socket as unknown as WebSocket,
 { playerId, userId: null, username: "Fuzzer" },
 raw,
 );
 } catch (e) {
 crashes++;
 console.error(`Malformed input "${raw.slice(0, 50)}" crashed:`, e);
 }
 }

 assertEquals(crashes, 0, `${crashes} malformed inputs caused crashes`);

 connections.delete(playerId);
});
