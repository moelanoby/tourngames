/**
 * Team Chess - local input handling.
 *
 * Owns the client-only interaction state (pending input, selected square,
 * legal-move hints for the selection) and exposes a read-only accessor so
 * render.js can draw the hints without duplicating logic. Depends only on
 * engine.js - no DOM references, no cycles.
 */

import { getLegalMoves } from "./engine.js";

let pendingInput = null;
let selectedSquare = null;
let legalMovesForSelected = [];

export function handleClick(x, y, playerId, state) {
 if (!state || !state.running || !state.data) return;
 const data = state.data;
 const team = data.playerTeams[playerId];
 if (!team || data.turn !== team || data.phase !== "voting") return;

 // Convert canvas coords to board square
 const squareSize = 75; // 600 / 8
 if (x < 0 || x >= 600 || y < 0 || y >= 600) return;
 const c = Math.floor(x / squareSize);
 const r = Math.floor(y / squareSize);
 if (r < 0 || r > 7 || c < 0 || c > 7) return;

 // If no selection, select a piece of our team
 if (!selectedSquare) {
 const piece = data.board?.[r]?.[c];
 if (piece && piece.color === team) {
 selectedSquare = [r, c];
 legalMovesForSelected = getLegalMoves(data.board, [r, c], team);
 }
 return;
 }

 const [sr, sc] = selectedSquare;

 // Same square deselect
 if (r === sr && c === sc) {
 selectedSquare = null;
 legalMovesForSelected = [];
 return;
 }

 // Another own piece switch selection
 const piece = data.board?.[r]?.[c];
 if (piece && piece.color === team) {
 selectedSquare = [r, c];
 legalMovesForSelected = getLegalMoves(data.board, [r, c], team);
 return;
 }

 // Legal destination propose the move
 if (legalMovesForSelected.some(([mr, mc]) => mr === r && mc === c)) {
 pendingInput = {
 action: "propose-move",
 from: [sr, sc],
 to: [r, c],
 timestamp: Date.now(),
 };
 selectedSquare = null;
 legalMovesForSelected = [];
 }
}

export function voteForProposal(proposalId, playerId, state) {
 if (!state || !state.running || !state.data) return;
 const data = state.data;
 const team = data.playerTeams[playerId];
 if (!team || data.turn !== team || data.phase !== "voting") return;
 pendingInput = {
 action: "vote",
 proposalId,
 timestamp: Date.now(),
 };
}

export function getLocalInput(_keys) {
 const input = pendingInput;
 pendingInput = null;
 return input || null;
}

/**
 * Read-only view of the current selection for the renderer:
 * { square: [r,c]|null, legalMoves: [[r,c],...] }
 */
export function getSelection() {
 return {
 square: selectedSquare ? [...selectedSquare] : null,
 legalMoves: legalMovesForSelected.map((m) => [...m]),
 };
}
