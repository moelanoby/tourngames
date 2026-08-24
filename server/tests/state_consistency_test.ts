/**
 * Regression tests for shallow single-step state bugs (all previously failed).
 *
 * 1. start-match broadcast used the stale pre-mutation lobby -> null seed
 * 2. recordSuccessfulLogin wrote a stale user back -> concurrent bans erased
 * 3. listLobbies idle sweep deleted live matches (>30min old) mid-game
 * 4. removePlayerFromLobby/removeSignup lost updates on concurrent removals
 *
 * Run: deno test -A --unstable-kv server/tests/state_consistency_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.0";
import { handleWebSocketMessage, connections } from "../signaling.ts";
import { createLobby, addPlayerToLobby, getLobby, listLobbies } from "../lobbies.ts";
import { createUser, getUserByUsername, banUser, recordSuccessfulLogin } from "../auth.ts";

class MockSocket {
  messages: unknown[] = [];
  readyState = 1;
  send(data: unknown) {
    if (typeof data !== "string") return;
    try { this.messages.push(JSON.parse(data)); } catch { this.messages.push(data); }
  }
  close(_code = 1000, _reason = "") { this.readyState = 3; }
}

const rid = () => Math.random().toString(36).slice(2, 10);

Deno.test("STATE: game-start broadcast carries the generated seed (not stale null)", async () => {
  const socket = new MockSocket();
  const pid = "proof-host-" + rid();
  const lobby = await createLobby({ name: "Seed Proof", gameId: "team-chess", hostName: "H" });
  await addPlayerToLobby(lobby, { id: pid, name: "H", connected: true, userId: null });
  await addPlayerToLobby(lobby, { id: "p2-" + rid(), name: "P2", connected: true, userId: null });
  connections.set(pid, { lobbyId: lobby.id, ws: socket as unknown as WebSocket, userId: null, username: "H" });
  try {
    await handleWebSocketMessage(
      socket as unknown as WebSocket,
      { playerId: pid, userId: null, username: "H" },
      JSON.stringify({ type: "start-match" }),
    );
    const gs = socket.messages.find((m) => (m as { type?: string }).type === "game-start") as
      | { seed: number | null; lobbyId: string }
      | undefined;
    const stored = await getLobby(lobby.id);
    assert(stored !== null);
    assert(stored.seed !== null, "KV lobby has no seed after start (different bug)");
    assert(gs !== undefined, "no game-start broadcast received");
    console.log("broadcast seed:", gs.seed, "| stored KV seed:", stored.seed);
    assertEquals(gs.seed, stored.seed, "game-start broadcast used the STALE pre-mutation lobby object");
  } finally {
    connections.delete(pid);
  }
});

Deno.test("STATE: recordSuccessfulLogin does not resurrect banned=true -> false", async () => {
  const uname = "proofban" + rid();
  const user = await createUser(uname, "Str0ngPass!x");
  // Login flow snapshot taken BEFORE verifyPassword (~100ms PBKDF2):
  const snapshot = await getUserByUsername(uname);
  assert(snapshot !== null);
  // Admin bans while the login is verifying:
  await banUser(snapshot, snapshot, "proof ban", "127.0.0.1");
  // ...then login succeeds and writes the STALE pre-ban user back:
  await recordSuccessfulLogin(snapshot, "127.0.0.1");
  const after = await getUserByUsername(uname);
  assert(after !== null);
  assertEquals(after.banned, true, "stale login write cleared the admin's ban flag");
});

Deno.test("STATE: live match idle < 2h is not swept mid-match by listLobbies", async () => {
  const kv = await Deno.openKv();
  const id = "proof-sweep-" + crypto.randomUUID();
  const t = Date.now();
  const lobby = {
    id, name: "Live Match", gameId: "team-chess",
    players: [{ id: "a", name: "A", connected: true }],
    hostId: "a", hostUserId: null, hostName: "A", seed: 1,
    createdAt: t - 3_600_000, status: "playing", p2pReadyCount: 0,
    type: "open" as const, maxPlayers: 10, minPlayers: 2,
    inviteCode: null, signups: [],
    startedAt: t - 40 * 60_000, updatedAt: t - 40 * 60_000,
  };
  await kv.set(["lobby", id], lobby);
  try {
    await listLobbies(); // sweep pass happens inside listLobbies
    const after = await getLobby(id);
    assert(after !== null, "40-minute-old LIVE match was deleted mid-match");
  } finally {
    await kv.delete(["lobby", id]);
  }
});

Deno.test("STATE: removePlayerFromLobby does not lose a concurrent removal", async () => {
  const { removePlayerFromLobby } = await import("../lobbies.ts");
  const lobby = await createLobby({ name: "Remove Proof", gameId: "team-chess", hostName: "H" });
  await addPlayerToLobby(lobby, { id: "ra", name: "A", connected: true, userId: null });
  await addPlayerToLobby(lobby, { id: "rb", name: "B", connected: true, userId: null });
  await addPlayerToLobby(lobby, { id: "rc", name: "C", connected: true, userId: null });
  // Both players read the same state and leave at once (interleaved RMW):
  const snapA = await getLobby(lobby.id);
  const snapB = await getLobby(lobby.id);
  assert(snapA && snapB);
  await removePlayerFromLobby(snapA, "ra"); // writes lobby without ra
  await removePlayerFromLobby(snapB, "rb"); // wrote from stale snap: resurrects ra?
  const after = await getLobby(lobby.id);
  assert(after !== null);
  const ids = after.players.map((p) => p.id).sort();
  console.log("remaining players:", ids);
  assertEquals(ids, ["rc"], "lost update: a removed player was resurrected by a stale write");
});
