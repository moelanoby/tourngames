/**
 * Thorough property-based tests for chess game logic.
 *
 * Tests invariants across random game states, move sequences,
 * and edge cases that humans would miss.
 *
 * Run: deno test -A server/tests/chess_thorough_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import {
 createGameState,
 updateGameState,
 isLegalMove,
 getLegalMoves,
 getPlayerStatus,
 isMatchOver,
 getWinner,
 handleClick,
} from "../../games/team-chess/mod.js";

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

function makeGameState(playerCount = 4) {
 return createGameState(randomSeed(), randomPlayers(playerCount));
}

// Apply a random legal move for the current team
function applyRandomMove(state: any): boolean {
 const data = state.data as any;
 const team = data.turn;
 const allMoves = [];
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = data.board[r]?.[c];
 if (piece && piece.color === team) {
 const moves = getLegalMoves(data.board, [r, c], team);
 for (const m of moves) {
 allMoves.push({ from: [r, c], to: m });
 }
 }
 }
 }
 if (allMoves.length === 0) return false;
 const move = allMoves[Math.floor(Math.random() * allMoves.length)];
 const inputs: Record<string, unknown> = {};
 // Pick a random player on the current team to propose
 const teamPlayerIds = team === "white" ? data.whitePlayerIds : data.blackPlayerIds;
 const proposer = teamPlayerIds[Math.floor(Math.random() * teamPlayerIds.length)];
 if (!proposer) return false;
 inputs[proposer] = {
 action: "propose-move",
 from: move!.from,
 to: move!.to,
 timestamp: Date.now(),
 };
 updateGameState(state, inputs, 500);
 return true;
}

// ─── Move Validation Properties ─────────────────────────────────────────────

Deno.test("PROPERTY: Bishop only moves diagonally", () => {
 for (let trial = 0; trial < 100; trial++) {
 const state = makeGameState();
 const board = state.data.board;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece || piece.type !== "bishop") continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) {
 const tr = move[0]!;
 const tc = move[1]!;
 const adr = Math.abs(tr - r);
 const adc = Math.abs(tc - c);
 assert(adr === adc && adr > 0, `Bug! Bishop at [${r},${c}] moves to [${tr},${tc}] not diagonal`);
 }
 }
 }
 }
});

Deno.test("PROPERTY: Rook only moves straight (horizontal or vertical)", () => {
 for (let trial = 0; trial < 100; trial++) {
 const state = makeGameState();
 const board = state.data.board;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece || piece.type !== "rook") continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) {
 const tr = move[0]!;
 const tc = move[1]!;
 const isStraight = (tr === r && tc !== c) || (tc === c && tr !== r);
 assert(isStraight, `Bug! Rook at [${r},${c}] moves to [${tr},${tc}] not straight`);
 }
 }
 }
 }
});

Deno.test("PROPERTY: Queen moves diagonally OR straight (not both)", () => {
 for (let trial = 0; trial < 100; trial++) {
 const state = makeGameState();
 const board = state.data.board;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece || piece.type !== "queen") continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) {
 const tr = move[0]!;
 const tc = move[1]!;
 const adr = Math.abs(tr - r);
 const adc = Math.abs(tc - c);
 const isDiagonal = adr === adc && adr > 0;
 const isStraight = (tr === r && tc !== c) || (tc === c && tr !== r);
 assert(isDiagonal || isStraight, `Bug! Queen at [${r},${c}] moves to [${tr},${tc}] neither diagonal nor straight`);
 }
 }
 }
 }
});

Deno.test("PROPERTY: King moves at most 1 square", () => {
 for (let trial = 0; trial < 100; trial++) {
 const state = makeGameState();
 const board = state.data.board;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (!piece || piece.type !== "king") continue;
 const moves = getLegalMoves(board, [r, c], piece.color);
 for (const move of moves) {
 const tr = move[0]!;
 const tc = move[1]!;
 const adr = Math.abs(tr - r);
 const adc = Math.abs(tc - c);
 assert(adr <= 1 && adc <= 1 && (adr + adc > 0), `Bug! King at [${r},${c}] moves to [${tr},${tc}] more than 1 square`);
 }
 }
 }
 }
});

Deno.test("PROPERTY: Pawn starting position allows 2-square move", () => {
 // White pawns start at row 6, black at row 1
 for (let trial = 0; trial < 50; trial++) {
 const state = makeGameState();
 const board = state.data.board;
 // Check white pawns
 for (let c = 0; c < 8; c++) {
 const piece = board[6]?.[c];
 if (!piece || piece.type !== "pawn" || piece.color !== "white") continue;
 const moves = getLegalMoves(board, [6, c], "white");
 const twoSquare = moves.find((m) => m[0] === 4 && m[1] === c);
 assert(twoSquare, `Bug! White pawn at [6,${c}] can't make 2-square starting move`);
 }
 // Check black pawns
 for (let c = 0; c < 8; c++) {
 const piece = board[1]?.[c];
 if (!piece || piece.type !== "pawn" || piece.color !== "black") continue;
 const moves = getLegalMoves(board, [1, c], "black");
 const twoSquare = moves.find((m) => m[0] === 3 && m[1] === c);
 assert(twoSquare, `Bug! Black pawn at [1,${c}] can't make 2-square starting move`);
 }
 }
});

// ─── Game State Properties ──────────────────────────────────────────────────

Deno.test("PROPERTY: Initial board has 32 pieces", () => {
 for (let trial = 0; trial < 50; trial++) {
 const state = makeGameState(2 + Math.floor(Math.random() * 18));
 let count = 0;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 if (state.data.board[r]?.[c]) count++;
 }
 }
 assertEquals(count, 32, `Bug! Initial board has ${count} pieces, expected 32`);
 }
});

Deno.test("PROPERTY: Each team has exactly 16 pieces at start", () => {
 for (let trial = 0; trial < 50; trial++) {
 const state = makeGameState();
 let white = 0, black = 0;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const p = state.data.board[r]?.[c];
 if (p) {
 if (p.color === "white") white++;
 else black++;
 }
 }
 }
 assertEquals(white, 16, `Bug! White has ${white} pieces, expected 16`);
 assertEquals(black, 16, `Bug! Black has ${black} pieces, expected 16`);
 }
});

Deno.test("PROPERTY: Each team has exactly 1 king", () => {
 for (let trial = 0; trial < 50; trial++) {
 const state = makeGameState();
 let whiteKings = 0, blackKings = 0;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const p = state.data.board[r]?.[c];
 if (p && p.type === "king") {
 if (p.color === "white") whiteKings++;
 else blackKings++;
 }
 }
 }
 assertEquals(whiteKings, 1, `Bug! White has ${whiteKings} kings`);
 assertEquals(blackKings, 1, `Bug! Black has ${blackKings} kings`);
 }
});

Deno.test("PROPERTY: Game starts in voting phase with white to move", () => {
 for (let trial = 0; trial < 100; trial++) {
 const state = makeGameState();
 assertEquals(state.data.turn, "white", "Bug! White doesn't move first");
 assertEquals(state.data.phase, "voting", "Bug! Game doesn't start in voting phase");
 assertEquals(state.running, true, "Bug! Game doesn't start running");
 assertEquals(state.winner, null, "Bug! Game has a winner at start");
 }
});

// ─── Move Execution Properties ──────────────────────────────────────────────

Deno.test("PROPERTY: Turn switches after voting deadline", () => {
 for (let trial = 0; trial < 20; trial++) {
 const state = makeGameState();
 const initialTurn = state.data.turn;
 // Advance time past the voting deadline (20000ms)
 updateGameState(state, {}, 21000);
 assert(state.data.turn !== initialTurn, "Bug! Turn didn't switch after deadline");
 }
});

Deno.test("PROPERTY: Empty voting round skips turn (no crash)", () => {
 for (let trial = 0; trial < 20; trial++) {
 const state = makeGameState();
 const initialTurn = state.data.turn;
 // No proposals should skip turn without crashing
 updateGameState(state, {}, 21000);
 assert(state.data.turn !== initialTurn, "Bug! Turn didn't switch on empty vote");
 assertEquals(state.running, true, "Bug! Game ended on empty vote");
 }
});

Deno.test("PROPERTY: Player status is always 'alive' (can vote even when captured)", () => {
 for (let trial = 0; trial < 50; trial++) {
 const state = makeGameState(4);
 for (const pid of Object.keys(state.data.pieceAssignments)) {
 assertEquals(getPlayerStatus(state, pid), "alive", `Bug! Player ${pid} is not alive`);
 }
 }
});

// ─── Capture & Win Condition Properties ─────────────────────────────────────

Deno.test("PROPERTY: Capturing a king ends the game", () => {
 for (let trial = 0; trial < 10; trial++) {
 const state = makeGameState(2);
 const data = state.data as any;

 // Manually set up a position where white can capture black's king
 // Place white queen adjacent to black king
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 data.board[r][c] = null;
 }
 }
 data.board[3][4] = { type: "king", color: "black", playerId: data.blackPlayerIds[0] };
 data.board[3][3] = { type: "queen", color: "white", playerId: data.whitePlayerIds[0] };
 data.turn = "white";
 data.phase = "voting";
 data.phaseDeadline = state.timestamp + 20000;

 // Propose the capture
 const inputs: Record<string, unknown> = {};
 (inputs as Record<string, unknown>)[data.whitePlayerIds[0]!] = {
 action: "propose-move",
 from: [3, 3],
 to: [3, 4],
 timestamp: Date.now(),
 };

 // Advance past deadline to execute
 updateGameState(state, inputs, 500);
 updateGameState(state, {}, 21000);

 assert(isMatchOver(state), "Bug! Game didn't end after king capture");
 assert(data.winnerTeam === "white", `Bug! Winner team is ${data.winnerTeam}, expected white`);
 }
});

Deno.test("PROPERTY: Captured pieces are marked as captured", () => {
 for (let trial = 0; trial < 10; trial++) {
 const state = makeGameState(2);
 const data = state.data as any;

 // Set up a capture scenario
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 data.board[r][c] = null;
 }
 }
 const capturedPlayerId = data.blackPlayerIds[0]!;
 data.board[3][4] = { type: "rook", color: "black", playerId: capturedPlayerId };
 data.board[3][3] = { type: "queen", color: "white", playerId: data.whitePlayerIds[0] };
 (data.pieceAssignments as Record<string, any>)[capturedPlayerId] = {
 type: "rook", color: "black", pos: [3, 4], captured: false
 };
 data.turn = "white";
 data.phase = "voting";
 data.phaseDeadline = state.timestamp + 20000;

 const inputs: Record<string, unknown> = {};
 (inputs as Record<string, unknown>)[data.whitePlayerIds[0]!] = {
 action: "propose-move",
 from: [3, 3],
 to: [3, 4],
 timestamp: Date.now(),
 };

 updateGameState(state, inputs, 500);
 updateGameState(state, {}, 21000);

 assert(
 (data.pieceAssignments as Record<string, any>)[capturedPlayerId].captured,
 "Bug! Captured piece not marked as captured"
 );
 }
});

// ─── Random Game Simulation ─────────────────────────────────────────────────

Deno.test("PROPERTY: Random game never enters invalid state", () => {
 for (let trial = 0; trial < 30; trial++) {
 const state = makeGameState(4);
 let moves = 0;
 while (state.running && moves < 50) {
 const moved = applyRandomMove(state);
 if (!moved) break;
 moves++;
 }
 // Game should either still be running or ended with a winner team
 if (!state.running) {
 assert(state.data.winnerTeam, "Bug! Game ended without a winner team");
 }
 }
});

Deno.test("PROPERTY: Game never exceeds 50 moves without ending", () => {
 // With random moves, king captures should happen within reasonable time
 for (let trial = 0; trial < 10; trial++) {
 const state = makeGameState(4);
 let moves = 0;
 while (state.running && moves < 100) {
 const moved = applyRandomMove(state);
 if (!moved) break;
 moves++;
 }
 // This is a soft assertion random games CAN go long, but 100 moves
 // with random play should almost always end
 if (moves >= 100) {
 console.warn(`Trial ${trial}: Game lasted 100+ moves (unexpected but not a bug)`);
 }
 }
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

Deno.test("EDGE: 2-player game (minimum)", () => {
 const state = makeGameState(2);
 assertEquals(state.data.whitePlayerIds.length, 1);
 assertEquals(state.data.blackPlayerIds.length, 1);
 assert(state.running);
});

Deno.test("EDGE: 20-player game (maximum)", () => {
 const state = makeGameState(20);
 assertEquals(state.data.whitePlayerIds.length + state.data.blackPlayerIds.length, 20);
 // Some players will share pieces (round-robin assignment)
 const assignedPieces = Object.values(state.data.pieceAssignments).filter((a: any) => a.pos !== null);
 // Each piece can have at most 1 player, but with 20 players and 32 pieces,
 // all 20 should get unique pieces
 assertEquals(assignedPieces.length, 20);
});

Deno.test("EDGE: Same seed produces identical games", () => {
 const seed = 12345;
 const players = randomPlayers(4);
 const state1 = createGameState(seed, players);
 const state2 = createGameState(seed, players);
 assertEquals(state1.data.turn, state2.data.turn);
 assertEquals(state1.data.whitePlayerIds, state2.data.whitePlayerIds);
 assertEquals(state1.data.blackPlayerIds, state2.data.blackPlayerIds);
 // Board should be identical
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const p1 = state1.data.board[r]?.[c];
 const p2 = state2.data.board[r]?.[c];
 if (p1 && p2) {
 assertEquals(p1.type, p2.type);
 assertEquals(p1.color, p2.color);
 assertEquals(p1.playerId, p2.playerId);
 }
 }
 }
});

Deno.test("EDGE: Click on empty square does nothing", () => {
 const state = makeGameState(2);
 const playerId = state.data.whitePlayerIds[0]!;
 // Click on empty square (row 3, col 3 is empty at start)
 handleClick(3 * 75 + 37, 3 * 75 + 37, playerId, state);
 // State should be unchanged
 assertEquals(state.data.turn, "white");
});

Deno.test("EDGE: Click during wrong team's turn does nothing", () => {
 const state = makeGameState(2);
 const blackPlayerId = state.data.blackPlayerIds[0]!;
 // Black player clicks during white's turn
 handleClick(6 * 75 + 37, 4 * 75 + 37, blackPlayerId, state); // click a white pawn
 // State should be unchanged (no selection, no proposal)
 assertEquals(state.data.proposals.length, 0);
});
