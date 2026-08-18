/**
 * Round-trip tests for chess-royale's replay system.
 *
 * These tests exercise the full pipeline:
 *   createGameState -> updateGameState (random moves) -> compileReplay
 *   -> loadReplay -> re-simulate -> compare final state with original
 *
 * They catch bugs where the recorded inputs don't perfectly reconstruct
 * the original simulation (off-by-one in tick bucketing, dropped inputs,
 * early termination, etc.).
 *
 * Run: deno test -A --unstable-kv server/tests/chess_replay_roundtrip_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import {
 createGameState,
 updateGameState,
 compileReplay,
 loadReplay,
 getLegalMoves,
 isMatchOver,
 getWinner,
 metadata,
} from "../../games/chess-royale/mod.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function randomSeed(): number {
 return Math.floor(Math.random() * 2147483647) + 1;
}

function randomPlayers(n: number) {
 return Array.from({ length: n }, (_, i) => ({
  id: `player-${i}`,
  name: `Player${i}`,
  connected: true,
 }));
}

/**
 * Simulate a game while recording every input the host would record.
 * Returns { finalState, recordedInputs, tickCount }.
 *
 * Each tick:
 *  - Pick a random legal move for the current team.
 *  - Pick a random player on that team to propose it.
 *  - Call updateGameState with that input.
 *  - If the input was a real action (propose-move), record it post-update
 *    with timestamp = state.timestamp (this mirrors what app.js _hostTick
 *    does for the replay recording).
 */
/**
 * Simulate a game while recording every input the host would record.
 * Returns { finalState, recordedInputs, tickCount }.
 *
 * Each tick:
 *  - Pick a legal move for the current team (preferring captures to
 *    make the game end faster).
 *  - Pick a random player on that team to propose it.
 *  - Call updateGameState with that input.
 *  - If the input was a real action (propose-move), record it post-update
 *    with timestamp = state.timestamp (this mirrors what app.js _hostTick
 *    does for the replay recording).
 */
function simulateGame(seed: number, players: any[], maxTicks = 100) {
 let state: any = createGameState(seed, players);
 const recordedInputs: Record<string, any[]> = {};
 for (const p of players) recordedInputs[p.id] = [];

 let tickCount = 0;
 while (state.running && tickCount < maxTicks) {
  tickCount++;
  const data = state.data;
  const team = data.turn;
  const teamPlayerIds = team === "white" ? data.whitePlayerIds : data.blackPlayerIds;

  // Find all legal moves for the current team, classifying them as
  // capturing or non-capturing.
  const capturingMoves: any[] = [];
  const nonCapturingMoves: any[] = [];
  for (let r = 0; r < 8; r++) {
   for (let c = 0; c < 8; c++) {
    const piece = data.board[r]?.[c];
    if (piece && piece.color === team) {
     const moves = getLegalMoves(data.board, [r, c], team);
     for (const m of moves) {
      const target = data.board[m[0]]?.[m[1]];
      const move = { from: [r, c], to: m, captures: !!target, targetIsKing: target?.type === "king" };
      if (target) capturingMoves.push(move);
      else nonCapturingMoves.push(move);
     }
    }
   }
  }

  // Prefer king captures > other captures > non-captures (to end the game faster).
  const kingCaptures = capturingMoves.filter((m) => m.targetIsKing);
  const otherCaptures = capturingMoves.filter((m) => !m.targetIsKing);
  let move: any;
  if (kingCaptures.length > 0) move = kingCaptures[0];
  else if (otherCaptures.length > 0 && Math.random() < 0.8) move = otherCaptures[Math.floor(Math.random() * otherCaptures.length)];
  else if (nonCapturingMoves.length > 0) move = nonCapturingMoves[Math.floor(Math.random() * nonCapturingMoves.length)];
  else move = null;

  const inputs: Record<string, any> = {};
  if (move && teamPlayerIds.length > 0) {
   const proposer = teamPlayerIds[Math.floor(Math.random() * teamPlayerIds.length)];
   if (proposer) {
    inputs[proposer] = {
     action: "propose-move",
     from: move.from,
     to: move.to,
     timestamp: Date.now(),
    };
   }
  }

  state = updateGameState(state, inputs, metadata?.tickRate || 500);

  // Record inputs with post-update timestamp (mirrors app.js _hostTick).
  for (const [pid, input] of Object.entries(inputs)) {
   if (input && input.action) {
    recordedInputs[pid].push({
     ...input,
     timestamp: state.timestamp,
    });
   }
  }

  // The voting deadline (20000ms = 40 ticks at 500ms/tick) fires
  // NATURALLY inside updateGameState when state.timestamp >= phaseDeadline.
  // No need for extra updateGameState calls  they would distort the
  // timestamps and break the replay round-trip.

  if (isMatchOver(state)) break;
 }

 return { finalState: state, recordedInputs, tickCount };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
 name: "REPLAY: loadReplay returns a non-empty array for any valid replay",
 fn() {
  for (let trial = 0; trial < 10; trial++) {
   const seed = randomSeed();
   const players = randomPlayers(2);
   const { finalState, recordedInputs } = simulateGame(seed, players, 50);
   const replay = compileReplay(
    recordedInputs, seed, finalState.timestamp,
    getWinner(finalState) || "p1", "Alice", players,
   );
   const states = loadReplay(replay);
   assert(states.length > 0, `Trial ${trial}: loadReplay returned empty array`);
  }
 },
});

Deno.test({
 name: "REPLAY: loadReplay reproduces states tick-for-tick (round-trip)",
 fn() {
  // The key round-trip property: re-simulating the recorded inputs
  // should produce the SAME state at each tick as the original game.
  //
  // We run the original for a fixed number of ticks (well past the
  // first voting deadline at tick 40 so a move actually executes),
  // then load the replay and compare the state at the SAME tick
  // index. This catches off-by-one bugs in the input bucketing, state
  // aliasing, deadline fires at the wrong tick, etc.
  for (let trial = 0; trial < 10; trial++) {
   const seed = randomSeed();
   const players = randomPlayers(2);

   // Run the simulation, capturing SNAPSHOTS at each tick (since
   // updateGameState mutates in place, we need to deep-clone each
   // state to compare later).
   const states: any[] = [];
   let s: any = createGameState(seed, players);
   states.push(JSON.parse(JSON.stringify(s)));
   const recorded: Record<string, any[]> = {};
   for (const p of players) recorded[p.id] = [];
   for (let tick = 0; tick < 100 && s.running; tick++) {
    const data = s.data;
    const team = data.turn;
    const teamPlayerIds = team === "white" ? data.whitePlayerIds : data.blackPlayerIds;
    // Capture-preferring move selection (same as simulateGame)
    const captures: any[] = [], noncaptures: any[] = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
     const piece = data.board[r]?.[c];
     if (piece && piece.color === team) {
      const moves = getLegalMoves(data.board, [r, c], team);
      for (const m of moves) {
       const t = data.board[m[0]]?.[m[1]];
       const move = { from: [r, c], to: m, isKing: t?.type === "king" };
       (t ? captures : noncaptures).push(move);
      }
     }
    }
    const kc = captures.filter((m) => m.isKing);
    const oc = captures.filter((m) => !m.isKing);
    let move: any = null;
    if (kc.length) move = kc[0];
    else if (oc.length && Math.random() < 0.85) move = oc[Math.floor(Math.random() * oc.length)];
    else if (noncaptures.length) move = noncaptures[Math.floor(Math.random() * noncaptures.length)];
    const inputs: Record<string, any> = {};
    if (move && teamPlayerIds.length) {
     inputs[teamPlayerIds[0]] = { action: "propose-move", from: move.from, to: move.to, timestamp: Date.now() };
    }
    s = updateGameState(s, inputs, metadata?.tickRate || 500);
    states.push(JSON.parse(JSON.stringify(s)));
    for (const [pid, input] of Object.entries(inputs)) {
     if (input && input.action) {
      if (!recorded[pid]) recorded[pid] = [];
      recorded[pid].push({ ...input, timestamp: s.timestamp });
     }
    }
   }

   // Compile a replay from the recorded inputs and load it.
   const replay = compileReplay(recorded, seed, s.timestamp, "p1", "Alice", players);
   const replayedStates = loadReplay(replay);

   // Compare state at tick 80 (well past the first deadline at tick 40).
   const tickToCheck = 80;
   assert(replayedStates.length > tickToCheck,
    `Trial ${trial}: replay only has ${replayedStates.length} states, need ${tickToCheck + 1}`);
   assert(states.length > tickToCheck,
    `Trial ${trial}: simulation only has ${states.length} states`);

   const origAtTick = states[tickToCheck];
   const replayAtTick = replayedStates[tickToCheck] as any;
   assertEquals(replayAtTick.tick, origAtTick.tick,
    `Trial ${trial}: tick mismatch at index ${tickToCheck} orig=${origAtTick.tick} replay=${replayAtTick.tick}`);
   assertEquals(replayAtTick.timestamp, origAtTick.timestamp,
    `Trial ${trial}: timestamp mismatch at index ${tickToCheck} orig=${origAtTick.timestamp} replay=${replayAtTick.timestamp}`);
   assertEquals(replayAtTick.data.turn, origAtTick.data.turn,
    `Trial ${trial}: turn mismatch at tick ${tickToCheck} orig=${origAtTick.data.turn} replay=${replayAtTick.data.turn}`);
   assertEquals(replayAtTick.data.turnNumber, origAtTick.data.turnNumber,
    `Trial ${trial}: turnNumber mismatch at tick ${tickToCheck} orig=${origAtTick.data.turnNumber} replay=${replayAtTick.data.turnNumber}`);
  }
 },
});

Deno.test({
 name: "REPLAY: loadReplay is deterministic (same replay -> same states)",
 fn() {
  const seed = 12345;
  const players = randomPlayers(4);
  const { finalState, recordedInputs } = simulateGame(seed, players, 30);
  const replay = compileReplay(
   recordedInputs, seed, finalState.timestamp,
   getWinner(finalState) || "p1", "Alice", players,
  );
  const states1 = loadReplay(replay);
  const states2 = loadReplay(replay);
  assertEquals(states1.length, states2.length);
  // Compare a few key fields on each state.
  for (let i = 0; i < states1.length; i++) {
   assertEquals(states1[i].tick, states2[i].tick, `Tick mismatch at state ${i}`);
   assertEquals(states1[i].timestamp, states2[i].timestamp, `Timestamp mismatch at state ${i}`);
   assertEquals(states1[i].running, states2[i].running, `Running mismatch at state ${i}`);
  }
 },
});

Deno.test({
 name: "REPLAY: loadReplay with empty inputs still produces states",
 fn() {
  // A replay with no recorded inputs (e.g., a match that ended immediately)
  // should still produce at least the initial state.
  const seed = 42;
  const players = randomPlayers(2);
  const replay = compileReplay(
   {}, seed, 0, "p1", "Alice", players,
  );
  const states = loadReplay(replay);
  // At minimum, the initial state should be present.
  assert(states.length >= 1, `Expected at least 1 state, got ${states.length}`);
  assertEquals(states[0].seed, seed);
  assertEquals(states[0].running, true);
  assertEquals(states[0].tick, 0);
 },
});

Deno.test({
 name: "REPLAY: loadReplay handles missing inputs field gracefully",
 fn() {
  const seed = 99;
  const players = randomPlayers(2);
  const replay: any = compileReplay(
   {}, seed, 0, "p1", "Alice", players,
  );
  // Delete the inputs field entirely (simulates a corrupted replay).
  delete replay.inputs;
  const states = loadReplay(replay);
  assert(states.length >= 1, `Should still produce initial state even with no inputs`);
 },
});
Deno.test({
 name: "REPLAY: loadReplay with invalid seed returns empty array (no crash)",
 fn() {
  const players = randomPlayers(2);
  // seed is NaN (invalid)
  const replay: any = {
   replayId: "rpl_bad_seed",
   gameModule: "chess-royale",
   seed: NaN,
   duration: 1000,
   winner: "p1",
   winnerName: "A",
   players,
   inputs: {},
   createdAt: Date.now(),
  };
  const states = loadReplay(replay);
  assertEquals(states, []);
 },
});

Deno.test({
 name: "REPLAY: loadReplay with missing players returns empty array (no crash)",
 fn() {
  const replay: any = {
   replayId: "rpl_no_players",
   gameModule: "chess-royale",
   seed: 1,
   duration: 1000,
   winner: "p1",
   winnerName: "A",
   // players field missing
   inputs: {},
   createdAt: Date.now(),
  };
  const states = loadReplay(replay);
  assertEquals(states, []);
 },
});

Deno.test({
 name: "REPLAY: loadReplay with null replay returns empty array (no crash)",
 fn() {
  // @ts-ignore: intentionally passing null
  const states = loadReplay(null);
  assertEquals(states, []);
 },
});
Deno.test({
 name: "REPLAY: loadReplay with undefined replay returns empty array (no crash)",
 fn() {
  // @ts-ignore: intentionally passing undefined
  const states = loadReplay(undefined);
  assertEquals(states, []);
 },
});

Deno.test({
 name: "REPLAY: loadReplay stops early when winner is set",
 fn() {
  // Simulate a real game where the king is captured. compileReplay
  // captures the actual winner. loadReplay should re-simulate and stop
  // at the winning tick, not run to maxTicks.
  //
  // We can't easily force a king capture in a randomly-seeded game, so
  // we directly construct a minimal replay with a single input that
  // we know ends the game. Then verify loadReplay stops early.
  //
  // Setup: place white queen adjacent to black king. White proposes
  // the capture. After the voting deadline, the move executes and the
  // game ends.
  //
  // We need createGameState to produce a board where white can capture
  // black's king in one move. Easiest way: manually craft the entire
  // replay (seed + inputs + winner) without relying on createGameState
  // to set up a capturable position.
  const seed = 777;
  const players = randomPlayers(2);
  // Run a real simulation that should end (with random moves, a king
  // capture usually happens within ~50 ticks).
  let found = false;
  for (let attempt = 0; attempt < 30 && !found; attempt++) {
   const s = attempt + seed;
   const { finalState, recordedInputs } = simulateGame(s, players, 200);
   if (isMatchOver(finalState) && getWinner(finalState)) {
    const replay = compileReplay(
     recordedInputs, s, finalState.timestamp,
     getWinner(finalState)!, "Winner", players,
    );
    const states = loadReplay(replay);
    // The replay should stop shortly after the king capture (well
    // before the 3600 maxTicks cap).
    assert(states.length < 300, `Replay should stop early, got ${states.length} states (attempt ${attempt})`);
    const final = states[states.length - 1] as any;
    assert(!final.running, `Replay should end with running=false`);
    assert(final.winner, `Replay should end with a winner set`);
    found = true;
   }
  }
  if (!found) {
   console.warn("Could not trigger a king capture in 30 random simulations; skipping this assertion.");
  }
 },
});
