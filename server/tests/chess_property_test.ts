/**
 * Property-based tests for chess move validation.
 *
 * Instead of hand-writing test cases, we define INVARIANTS that must
 * always hold true, then let the test framework generate thousands of
 * random board positions and moves to try to break them.
 *
 * Run: deno test -A server/tests/chess_property_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import { createGameState, isLegalMove, getLegalMoves } from "../../games/chess-royale/mod.js";

// ─── Helper: generate a random board position ───────────────────────────────

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

// ─── Property 1: A piece can never move to a square occupied by a same-color piece ─

Deno.test("PROPERTY: No move targets a same-color piece", async (t) => {
 // Run 100 random games, check the invariant holds for every legal move
 for (let trial = 0; trial < 100; trial++) {
 const seed = randomSeed();
 const players = randomPlayers(2 + Math.floor(Math.random() * 6));
 const state = createGameState(seed, players);
 const board = state.data.board;

 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece) continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) { const tr = move[0]!; const tc = move[1]!;
 const target = board[tr]?.[tc];
 if (target) {
 assert(
 target.color !== piece.color,
 `Bug found! ${piece.color} ${piece.type} at [${r},${c}] can capture same-color piece at [${tr},${tc}] (seed=${seed})`
 );
 }
 }
 }
 }
 }
});

// ─── Property 2: A pawn can never move backward ─────────────────────────────

Deno.test("PROPERTY: Pawns never move backward", () => {
 for (let trial = 0; trial < 100; trial++) {
 const seed = randomSeed();
 const players = randomPlayers(2);
 const state = createGameState(seed, players);
 const board = state.data.board;

 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece || piece.type !== "pawn") continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) { const tr = move[0]!; const tc = move[1]!;
 const dr = tr - r;
 if (piece.color === "white") {
 assert(dr <= 0, `Bug! White pawn at [${r},${c}] moves backward to [${tr},${tc}]`);
 } else {
 assert(dr >= 0, `Bug! Black pawn at [${r},${c}] moves backward to [${tr},${tc}]`);
 }
 }
 }
 }
 }
});

// ─── Property 3: A knight always moves in L-shape ───────────────────────────

Deno.test("PROPERTY: Knights only move in L-shape", () => {
 for (let trial = 0; trial < 100; trial++) {
 const seed = randomSeed();
 const state = createGameState(seed, randomPlayers(2));
 const board = state.data.board;

 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece || piece.type !== "knight") continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) { const tr = move[0]!; const tc = move[1]!;
 const adr = Math.abs(tr - r);
 const adc = Math.abs(tc - c);
 const isLShape = (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
 assert(isLShape, `Bug! Knight at [${r},${c}] moves to [${tr},${tc}] not an L-shape`);
 }
 }
 }
 }
});

// ─── Property 4: No piece can move off the board ────────────────────────────

Deno.test("PROPERTY: All moves stay on board", () => {
 for (let trial = 0; trial < 100; trial++) {
 const seed = randomSeed();
 const state = createGameState(seed, randomPlayers(2));
 const board = state.data.board;

 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece) continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) { const tr = move[0]!; const tc = move[1]!;
 assert(tr >= 0 && tr < 8, `Bug! Move to row ${tr} (off board)`);
 assert(tc >= 0 && tc < 8, `Bug! Move to col ${tc} (off board)`);
 }
 }
 }
 }
});

// ─── Property 5: Every player is assigned to exactly one piece ──────────────

Deno.test("PROPERTY: Every player has exactly one piece assignment", () => {
 for (let trial = 0; trial < 50; trial++) {
 const playerCount = 2 + Math.floor(Math.random() * 18); // 2-20 players
 const players = randomPlayers(playerCount);
 const state = createGameState(randomSeed(), players);
 const assignments = state.data.pieceAssignments;

 assertEquals(
 Object.keys(assignments).length,
 playerCount,
 `Bug! ${playerCount} players but only ${Object.keys(assignments).length} assignments`
 );

 // Each assignment must have a valid position and not be captured at start
 for (const [pid, a] of Object.entries(assignments)) {
 assert(a.pos !== null, `Bug! Player ${pid} has no position at game start`);
 assert(!a.captured, `Bug! Player ${pid} is captured at game start`);
 const pos = a.pos!; const r = pos[0]!; const c = pos[1]!;
 assert(r >= 0 && r < 8 && c >= 0 && c < 8, `Bug! Invalid position [${r},${c}]`);
 }
 }
});

// ─── Property 6: Teams are balanced (difference ≤ 1) ────────────────────────

Deno.test("PROPERTY: Teams differ by at most 1 player", () => {
 for (let trial = 0; trial < 50; trial++) {
 const playerCount = 2 + Math.floor(Math.random() * 18);
 const players = randomPlayers(playerCount);
 const state = createGameState(randomSeed(), players);

 const whiteCount = state.data.whitePlayerIds.length;
 const blackCount = state.data.blackPlayerIds.length;
 const diff = Math.abs(whiteCount - blackCount);

 assert(diff <= 1, `Bug! Teams unbalanced: ${whiteCount} white vs ${blackCount} black (diff=${diff})`);
 assertEquals(whiteCount + blackCount, playerCount, `Bug! Not all players assigned to teams`);
 }
});
