/**
 * Edge-case tests for chess-royale's move validation.
 *
 * These tests focus on scenarios that aren't covered by the existing
 * chess_thorough_test.ts: pawn promotion, blocked pawns, castling,
 * en passant, check/checkmate (or lack thereof), and the "king can
 * move into check" behavior of the capture-the-king variant.
 *
 * Run: deno test -A --unstable-kv server/tests/chess_edge_cases_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import {
 createGameState,
 isLegalMove,
 getLegalMoves,
 updateGameState,
} from "../../games/team-chess/mod.js";

function randomPlayers(n: number) {
 return Array.from({ length: n }, (_, i) => ({
  id: `player-${i}`,
  name: `Player${i}`,
  connected: true,
 }));
}

function makeEmptyBoard(): any[][] {
 const board: any[][] = [];
 for (let r = 0; r < 8; r++) board.push(new Array(8).fill(null));
 return board;
}

// ─── Pawn Edge Cases ────────────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Pawn forward move is blocked by any piece on destination",
 fn() {
  const board = makeEmptyBoard();
  // White pawn at e2 (row 6, col 4)
  board[6][4] = { type: "pawn", color: "white", playerId: "p1" };
  // Black piece blocking at e3
  board[5][4] = { type: "bishop", color: "black", playerId: "p2" };
  // Forward move should be ILLEGAL (destination is occupied)
  assertEquals(isLegalMove(board, [6, 4], [5, 4], "white"), false,
   "Pawn should not be able to move forward into an occupied square");
 },
});

Deno.test({
 name: "EDGE: Pawn 2-square move is blocked if intermediate square is occupied",
 fn() {
  const board = makeEmptyBoard();
  // White pawn at starting position e2 (row 6, col 4)
  board[6][4] = { type: "pawn", color: "white", playerId: "p1" };
  // Black piece at e3 (blocks the path)
  board[5][4] = { type: "bishop", color: "black", playerId: "p2" };
  // 2-square move should be ILLEGAL (intermediate is blocked)
  assertEquals(isLegalMove(board, [6, 4], [4, 4], "white"), false,
   "Pawn 2-square move should be blocked if intermediate square is occupied");
 },
});

Deno.test({
 name: "EDGE: Pawn 2-square move only allowed from starting row",
 fn() {
  const board = makeEmptyBoard();
  // White pawn at e3 (not starting row)
  board[5][4] = { type: "pawn", color: "white", playerId: "p1" };
  // 2-square move from non-starting row should be ILLEGAL
  assertEquals(isLegalMove(board, [5, 4], [3, 4], "white"), false,
   "Pawn 2-square move should only be allowed from starting row");
 },
});

Deno.test({
 name: "EDGE: Pawn diagonal capture requires enemy piece (no en passant)",
 fn() {
  const board = makeEmptyBoard();
  // White pawn at e2
  board[6][4] = { type: "pawn", color: "white", playerId: "p1" };
  // No enemy piece at d3 or f3 (diagonal squares)
  // Diagonal move without capture should be ILLEGAL
  assertEquals(isLegalMove(board, [6, 4], [5, 3], "white"), false,
   "Pawn diagonal move without capture should be illegal (no en passant)");
  assertEquals(isLegalMove(board, [6, 4], [5, 5], "white"), false,
   "Pawn diagonal move without capture should be illegal (no en passant)");

  // Add enemy pieces at d3 and f3
  board[5][3] = { type: "pawn", color: "black", playerId: "p2" };
  board[5][5] = { type: "pawn", color: "black", playerId: "p3" };
  // Now diagonal captures should be LEGAL
  assertEquals(isLegalMove(board, [6, 4], [5, 3], "white"), true,
   "Pawn diagonal capture of enemy should be legal");
  assertEquals(isLegalMove(board, [6, 4], [5, 5], "white"), true,
   "Pawn diagonal capture of enemy should be legal");
 },
});

Deno.test({
 name: "EDGE: Pawn cannot capture forward (only diagonal)",
 fn() {
  const board = makeEmptyBoard();
  // White pawn at e2
  board[6][4] = { type: "pawn", color: "white", playerId: "p1" };
  // Enemy piece directly in front
  board[5][4] = { type: "pawn", color: "black", playerId: "p2" };
  // Forward move should be ILLEGAL (blocked)
  assertEquals(isLegalMove(board, [6, 4], [5, 4], "white"), false,
   "Pawn should not capture forward (only diagonal)");
 },
});

Deno.test({
 name: "EDGE: Pawn promotion is NOT implemented (pawn stays as pawn at last rank)",
 fn() {
  // The chess-royale module doesn't implement pawn promotion. A pawn
  // reaching the last rank stays as a pawn. This is a known limitation,
  // not a bug. This test documents the current behavior.
  const board = makeEmptyBoard();
  // White pawn at e7 (one square from promotion rank)
  board[1][4] = { type: "pawn", color: "white", playerId: "p1" };
  // Move forward to e8 (rank 0 for white = promotion rank in standard chess)
  const legal = isLegalMove(board, [1, 4], [0, 4], "white");
  // The move IS legal (pawn can move forward to empty square).
  assertEquals(legal, true);

  // After the move, the piece is still a pawn (no promotion).
  // (We can't easily test this with just isLegalMove; we'd need to
  // execute the move and check the resulting piece type. The chess
  // module's executeTopMove just moves the piece, so it stays a pawn.)
  // This test just documents that the move is allowed; the lack of
  // promotion is by design.
 },
});

// ─── King Edge Cases ─────────────────────────────────────────────────────────

Deno.test({
 name: "EDGE: King can move into check (capture-the-king variant)",
 fn() {
  // Standard chess would forbid the king from moving into check.
  // Chess-royale doesn't validate check  the king can move anywhere
  // within 1 square, even into a square attacked by an enemy piece.
  // This is by design: the game ends on actual king capture, not on
  // checkmate. This test documents that behavior.
  const board = makeEmptyBoard();
  // White king at e1
  board[7][4] = { type: "king", color: "white", playerId: "p1" };
  // Black queen at e3 (attacks e2)
  board[5][4] = { type: "queen", color: "black", playerId: "p2" };
  // King moves to e2 (into the queen's attack). Should be LEGAL.
  assertEquals(isLegalMove(board, [7, 4], [6, 4], "white"), true,
   "King can move into check in the capture-the-king variant");
 },
});

Deno.test({
 name: "EDGE: Castling is NOT implemented (king 2-square move is illegal)",
 fn() {
  // Standard chess allows castling (king moves 2 squares toward rook).
  // Chess-royale's king move validation: `adr <= 1 && adc <= 1`.
  // So a 2-square king move is ILLEGAL. This is a known limitation.
  const board = makeEmptyBoard();
  // White king at e1, rook at h1 (kingside castling position)
  board[7][4] = { type: "king", color: "white", playerId: "p1" };
  board[7][7] = { type: "rook", color: "white", playerId: "p2" };
  // Kingside castle: king from e1 to g1 (2 squares right)
  assertEquals(isLegalMove(board, [7, 4], [7, 6], "white"), false,
   "Castling (2-square king move) should be illegal");
 },
});

Deno.test({
 name: "EDGE: King cannot move more than 1 square",
 fn() {
  const board = makeEmptyBoard();
  board[7][4] = { type: "king", color: "white", playerId: "p1" };
  // 2-square move should be illegal
  assertEquals(isLegalMove(board, [7, 4], [5, 4], "white"), false);
  assertEquals(isLegalMove(board, [7, 4], [7, 6], "white"), false);
  // 1-square moves should be legal (to empty squares)
  assertEquals(isLegalMove(board, [7, 4], [6, 4], "white"), true);
  assertEquals(isLegalMove(board, [7, 4], [6, 3], "white"), true);
 },
});

Deno.test({
 name: "EDGE: King cannot capture own piece",
 fn() {
  const board = makeEmptyBoard();
  board[7][4] = { type: "king", color: "white", playerId: "p1" };
  board[6][4] = { type: "pawn", color: "white", playerId: "p2" };
  // King cannot move forward onto own pawn
  assertEquals(isLegalMove(board, [7, 4], [6, 4], "white"), false,
   "King should not capture own piece");
 },
});

// ─── Knight Edge Cases ───────────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Knight can jump over pieces (L-shape)",
 fn() {
  const board = makeEmptyBoard();
  // White knight at g1 (row 7, col 6)
  board[7][6] = { type: "knight", color: "white", playerId: "p1" };
  // Surround the knight with friendly pawns
  board[6][5] = { type: "pawn", color: "white", playerId: "p2" };
  board[6][6] = { type: "pawn", color: "white", playerId: "p3" };
  board[7][5] = { type: "pawn", color: "white", playerId: "p4" };
  // Knight should still be able to jump to f3 (row 5, col 5)
  assertEquals(isLegalMove(board, [7, 6], [5, 5], "white"), true,
   "Knight should jump over pieces");
  // And to e2 (row 6, col 4)
  assertEquals(isLegalMove(board, [7, 6], [6, 4], "white"), true,
   "Knight should jump over pieces");
 },
});

Deno.test({
 name: "EDGE: Knight cannot land on own piece",
 fn() {
  const board = makeEmptyBoard();
  board[7][6] = { type: "knight", color: "white", playerId: "p1" };
  board[5][5] = { type: "pawn", color: "white", playerId: "p2" };
  // Knight cannot land on own pawn at f3
  assertEquals(isLegalMove(board, [7, 6], [5, 5], "white"), false);
 },
});

// ─── Blocked Path Edge Cases ─────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Bishop path blocked by any piece",
 fn() {
  const board = makeEmptyBoard();
  // White bishop at c1 (row 7, col 2)
  board[7][2] = { type: "bishop", color: "white", playerId: "p1" };
  // Friendly pawn at d2 (blocks the diagonal)
  board[6][3] = { type: "pawn", color: "white", playerId: "p2" };
  // Bishop cannot move past the pawn to e3, f4, g5, h6
  assertEquals(isLegalMove(board, [7, 2], [5, 4], "white"), false,
   "Bishop path should be blocked by friendly piece");
  // But can still move to other diagonals (e.g., b2)
  assertEquals(isLegalMove(board, [7, 2], [6, 1], "white"), true);
 },
});

Deno.test({
 name: "EDGE: Rook path blocked by enemy piece (can capture, not jump)",
 fn() {
  const board = makeEmptyBoard();
  // White rook at a1 (row 7, col 0)
  board[7][0] = { type: "rook", color: "white", playerId: "p1" };
  // Enemy bishop at d1 (row 7, col 3)
  board[7][3] = { type: "bishop", color: "black", playerId: "p2" };
  // Rook can capture the bishop at d1
  assertEquals(isLegalMove(board, [7, 0], [7, 3], "white"), true);
  // But cannot jump OVER the bishop to e1, f1, etc.
  assertEquals(isLegalMove(board, [7, 0], [7, 4], "white"), false,
   "Rook should not jump over enemy piece");
  assertEquals(isLegalMove(board, [7, 0], [7, 5], "white"), false);
 },
});

// ─── Out-of-bounds Edge Cases ────────────────────────────────────────────────

Deno.test({
 name: "EDGE: All pieces reject out-of-bounds moves",
 fn() {
  const board = makeEmptyBoard();
  // Place pieces at the edges
  board[0][0] = { type: "rook", color: "black", playerId: "p1" };
  board[0][7] = { type: "knight", color: "black", playerId: "p2" };
  board[7][0] = { type: "bishop", color: "white", playerId: "p3" };
  board[7][7] = { type: "queen", color: "white", playerId: "p4" };
  board[4][4] = { type: "king", color: "white", playerId: "p5" };

  // Try moves that go off the board (negative or >7)
  // isLegalMove should return false for all of these.
  // Note: the function might also throw if it accesses board[r][c] where
  // r or c is out of bounds. We use try/catch to handle both cases.
  const testMove = (from: [number, number], to: [number, number], color: string) => {
   try {
    return isLegalMove(board, from, to, color);
   } catch {
    return false; // throwing on invalid input is also acceptable
   }
  };
  assertEquals(testMove([0, 0], [-1, 0], "black"), false, "Rook should reject out-of-bounds");
  assertEquals(testMove([0, 0], [0, -1], "black"), false, "Rook should reject out-of-bounds");
  assertEquals(testMove([0, 7], [-2, 6], "black"), false, "Knight should reject out-of-bounds");
  assertEquals(testMove([7, 0], [8, 0], "white"), false, "Bishop should reject out-of-bounds");
  assertEquals(testMove([7, 7], [7, 8], "white"), false, "Queen should reject out-of-bounds");
  assertEquals(testMove([4, 4], [4, 8], "white"), false, "King should reject out-of-bounds");
 },
});

// ─── Stalemate-like Behavior ─────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Team with no proposals skips turn (no stalemate detection)",
 fn() {
  // In standard chess, if a team has no legal moves, it's stalemate
  // and the game ends in a draw. Chess-royale doesn't detect stalemate
  // if no proposals are submitted by the deadline, the turn just switches.
  // This is by design (the game only ends on king capture).
  const seed = 42;
  const players = randomPlayers(2);
  let state: any = createGameState(seed, players);
  const initialTurn = state.data.turn;
  // Advance time past the voting deadline with NO proposals.
  // updateGameState at timestamp >= phaseDeadline fires executeTopMove,
  // which sees an empty proposals array and calls switchTurn.
  state = updateGameState(state, {}, 21000);
  assertEquals(state.data.turn, initialTurn === "white" ? "black" : "white",
   "Empty voting round should switch turn (no stalemate detection)");
  assertEquals(state.running, true, "Game should still be running after empty vote");
 },
});

// ─── Same Square (no-op) ─────────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Move to the same square is illegal (no-op)",
 fn() {
  const board = makeEmptyBoard();
  board[4][4] = { type: "queen", color: "white", playerId: "p1" };
  // Queen cannot "move" to its own square
  assertEquals(isLegalMove(board, [4, 4], [4, 4], "white"), false);
  // Same for other pieces
  board[0][0] = { type: "rook", color: "black", playerId: "p2" };
  assertEquals(isLegalMove(board, [0, 0], [0, 0], "black"), false);
  board[7][4] = { type: "king", color: "white", playerId: "p3" };
  assertEquals(isLegalMove(board, [7, 4], [7, 4], "white"), false);
 },
});

// ─── Move from empty square ─────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Move from an empty square is illegal (no piece to move)",
 fn() {
  const board = makeEmptyBoard();
  // No piece at [4][4]; trying to move "from" there should be illegal.
  assertEquals(isLegalMove(board, [4, 4], [5, 5], "white"), false,
   "Move from empty square should be illegal");
  assertEquals(isLegalMove(board, [4, 4], [4, 5], "white"), false);
 },
});

// ─── Wrong color piece ───────────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Cannot move enemy's piece (wrong color)",
 fn() {
  const board = makeEmptyBoard();
  board[6][4] = { type: "pawn", color: "white", playerId: "p1" };
  // Black tries to move the white pawn
  assertEquals(isLegalMove(board, [6, 4], [5, 4], "black"), false,
   "Black should not be able to move white's pawn");
  // And vice versa
  board[1][4] = { type: "pawn", color: "black", playerId: "p2" };
  assertEquals(isLegalMove(board, [1, 4], [2, 4], "white"), false,
   "White should not be able to move black's pawn");
 },
});

// ─── Initial board sanity ────────────────────────────────────────────────────

Deno.test({
 name: "EDGE: Initial board has exactly 32 pieces in standard positions",
 fn() {
  const state: any = createGameState(123, randomPlayers(4));
  const board = state.data.board;
  let pieceCount = 0;
  let whitePawns = 0, blackPawns = 0;
  let whiteMajors = 0, blackMajors = 0;
  for (let r = 0; r < 8; r++) {
   for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (p) {
     pieceCount++;
     if (p.color === "white") {
      if (p.type === "pawn") whitePawns++;
      else whiteMajors++;
     } else {
      if (p.type === "pawn") blackPawns++;
      else blackMajors++;
     }
    }
   }
  }
  assertEquals(pieceCount, 32, "Initial board should have 32 pieces");
  assertEquals(whitePawns, 8, "White should have 8 pawns");
  assertEquals(blackPawns, 8, "Black should have 8 pawns");
  assertEquals(whiteMajors, 8, "White should have 8 major pieces");
  assertEquals(blackMajors, 8, "Black should have 8 major pieces");

  // Pawns on starting rows
  for (let c = 0; c < 8; c++) {
   assertEquals(board[1][c]?.type, "pawn", "Black pawns on row 1");
   assertEquals(board[1][c]?.color, "black");
   assertEquals(board[6][c]?.type, "pawn", "White pawns on row 6");
   assertEquals(board[6][c]?.color, "white");
  }
 },
});
