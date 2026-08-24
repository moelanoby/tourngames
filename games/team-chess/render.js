/**
 * Team Chess - canvas rendering.
 *
 * Draws the board, pieces, and all game UX overlays: last-move highlight,
 * selection + legal-move hints, check / king-captured callouts, animated
 * vote progress bars, urgent-timer pulsing, and a spectator team legend.
 * The only DOM usage is preloading piece images (guarded for Node/Deno).
 */

import { isKingInCheck, quorumNeeded } from "./engine.js";
import { getSelection } from "./input.js";

// ─── Piece Images (Wikimedia Commons, cburnett set public domain) ──────────
// The standard chess piece set used by lichess.org and chess.com.
// Source: https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces
// Author: Cburnett released into the public domain.

const PIECE_URLS = {
 "white-king": "https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg",
 "white-queen": "https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg",
 "white-rook": "https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg",
 "white-bishop": "https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg",
 "white-knight": "https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg",
 "white-pawn": "https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg",
 "black-king": "https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg",
 "black-queen": "https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg",
 "black-rook": "https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg",
 "black-bishop": "https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg",
 "black-knight": "https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg",
 "black-pawn": "https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg",
};

const pieceImages = {};

function preloadImages() {
 if (typeof Image === "undefined") return;
 for (const [key, url] of Object.entries(PIECE_URLS)) {
 const img = new Image();
 img.crossOrigin = "anonymous";
 img.onerror = () => {
 console.warn("[Chess] Failed to load piece:", key, " using Unicode fallback");
 };
 img.src = url;
 pieceImages[key] = img;
 }
}
preloadImages();

// Unicode fallback (if Wikimedia images fail to load)
const UNICODE_PIECES = {
 "white-king": "\u2654", "white-queen": "\u2655", "white-rook": "\u2656",
 "white-bishop": "\u2657", "white-knight": "\u2658", "white-pawn": "\u2659",
 "black-king": "\u265A", "black-queen": "\u265B", "black-rook": "\u265C",
 "black-bishop": "\u265D", "black-knight": "\u265E", "black-pawn": "\u265F",
};

// ─── Animation helpers ───────────────────────────────────────────────────────

function prefersReducedMotion() {
 try {
 if (typeof matchMedia === "function") {
 return matchMedia("(prefers-reduced-motion: reduce)").matches;
 }
 } catch {
 // Ignore - treat as full motion.
 }
 return false;
}

/** Smoothly eased value in [0,1] used to fade/pulse overlays in. */
function easeIn(msElapsed) {
 const t = Math.min(1, msElapsed / 400);
 return 1 - Math.pow(1 - t, 3);
}

// Displayed fraction per proposal id, eased toward its target each frame so
// vote bars grow/shrink smoothly instead of jumping.
const voteBarAnim = new Map();
// Set the moment we first observe a finished match, for the end-banner fade.
let gameOverAt = null;

// ─── Main render ─────────────────────────────────────────────────────────────

export function render(ctx, state, localPlayerId, w, h) {
 // Background
 ctx.fillStyle = "#1a1a1a";
 ctx.fillRect(0, 0, w, h);

 if (!state || !state.data) {
 ctx.fillStyle = "#888";
 ctx.font = "16px sans-serif";
 ctx.textAlign = "center";
 ctx.fillText("Waiting for game state...", w / 2, h / 2);
 return;
 }

 const data = state.data;
 const nowMs = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
 const squareSize = Math.min(w, h) / 8;
 const boardSize = squareSize * 8;
 const ox = (w - boardSize) / 2;
 const oy = (h - boardSize) / 2;

 // Draw board squares
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const isLight = (r + c) % 2 === 0;
 ctx.fillStyle = isLight ? "#f0d9b5" : "#b58863";
 ctx.fillRect(ox + c * squareSize, oy + r * squareSize, squareSize, squareSize);
 }
 }

 // Highlight last move
 if (data.lastMove) {
 ctx.fillStyle = "rgba(255, 215, 0, 0.35)";
 const [fr, fc] = data.lastMove.from;
 const [tr, tc] = data.lastMove.to;
 ctx.fillRect(ox + fc * squareSize, oy + fr * squareSize, squareSize, squareSize);
 ctx.fillRect(ox + tc * squareSize, oy + tr * squareSize, squareSize, squareSize);
 }

 // Highlight selected square + legal moves
 const selection = getSelection();
 if (selection.square) {
 const [r, c] = selection.square;
 // Gentle breathing alpha on the selection box (static when reduced motion)
 const selAlpha = prefersReducedMotion() ? 0.4 : 0.32 + 0.12 * (0.5 + 0.5 * Math.sin(nowMs / 300));
 ctx.fillStyle = `rgba(91, 124, 95, ${selAlpha.toFixed(3)})`;
 ctx.fillRect(ox + c * squareSize, oy + r * squareSize, squareSize, squareSize);
 // Draw legal move dots
 ctx.fillStyle = "rgba(91, 124, 95, 0.35)";
 for (const [mr, mc] of selection.legalMoves) {
 const cx = ox + mc * squareSize + squareSize / 2;
 const cy = oy + mr * squareSize + squareSize / 2;
 // If there's an enemy piece, draw a ring instead of a dot
 if (data.board?.[mr]?.[mc]) {
 ctx.strokeStyle = "rgba(184, 84, 50, 0.6)";
 ctx.lineWidth = 4;
 ctx.beginPath();
 ctx.arc(cx, cy, squareSize / 2 - 2, 0, Math.PI * 2);
 ctx.stroke();
 } else {
 ctx.beginPath();
 ctx.arc(cx, cy, squareSize / 5, 0, Math.PI * 2);
 ctx.fill();
 }
 }
 }

 // Highlight local player's piece
 const assignment = data.pieceAssignments[localPlayerId];
 if (assignment && assignment.pos && !assignment.captured) {
 const [r, c] = assignment.pos;
 ctx.strokeStyle = "#5b7c5f";
 ctx.lineWidth = 4;
 ctx.strokeRect(ox + c * squareSize + 2, oy + r * squareSize + 2, squareSize - 4, squareSize - 4);
 }

 // Draw pieces (row/cell guards: never crash the render loop on a
 // partially-delivered state - just skip the missing cells)
 for (let r = 0; r < 8; r++) {
 const row = data.board && data.board[r];
 if (!Array.isArray(row)) continue;
 for (let c = 0; c < 8; c++) {
 const piece = row[c];
 if (!piece) continue;
 const x = ox + c * squareSize;
 const y = oy + r * squareSize;
 drawPiece(ctx, piece, x, y, squareSize);
 }
 }

 // Draw coordinates
 ctx.fillStyle = "#666";
 ctx.font = `${Math.floor(squareSize * 0.15)}px monospace`;
 ctx.textAlign = "center";
 ctx.textBaseline = "top";
 for (let c = 0; c < 8; c++) {
 ctx.fillText(String.fromCharCode(97 + c), ox + c * squareSize + squareSize / 2, oy + boardSize + 4);
 }
 ctx.textAlign = "right";
 ctx.textBaseline = "middle";
 for (let r = 0; r < 8; r++) {
 ctx.fillText(String(8 - r), ox - 6, oy + r * squareSize + squareSize / 2);
 }

 // Turn indicator
 const isMyTurn = assignment && data.turn === assignment.color;
 ctx.fillStyle = data.turn === "white" ? "#f0d9b5" : "#333";
 ctx.fillRect(ox, oy + boardSize + 20, boardSize, 30);
 ctx.fillStyle = data.turn === "white" ? "#333" : "#f0d9b5";
 ctx.font = "bold 16px sans-serif";
 ctx.textAlign = "center";
 ctx.textBaseline = "middle";
 const turnText = (data.turn === "white" ? "White" : "Black") + " to move" + (isMyTurn ? " (your team!)" : "");
 ctx.fillText(turnText, ox + boardSize / 2, oy + boardSize + 35);

 drawTimers(ctx, state, data, ox, oy, boardSize);
 drawCheckCallout(ctx, state, data, ox, oy, squareSize, boardSize, nowMs);
 drawVoteBars(ctx, state, data, ox, oy, w, boardSize, nowMs);
 drawTeamLegend(ctx, state, data, ox, oy, w, h, boardSize);
 drawGameOverBanner(ctx, state, data, ox, oy, boardSize, nowMs);

 ctx.textAlign = "center";
}

// ─── Timers (with urgency pulse) ─────────────────────────────────────────────

function drawTimers(ctx, state, data, ox, oy, boardSize) {
 ctx.font = "bold 14px monospace";

 // Lock-in countdown: a proposal has enough votes and executes in <=15s.
 if (data.quorumExecAt !== null && data.quorumExecAt !== undefined) {
 const execLeft = Math.max(0, Math.ceil((data.quorumExecAt - state.timestamp) / 1000));
 ctx.fillStyle = "#fbbf24"; // gold
 ctx.fillText("Enough votes! Executing in " + execLeft + "s", ox + boardSize / 2, oy + boardSize + 55);
 return;
 }

 // Vote timer (per turn)
 const remainingMs = Math.max(0, data.phaseDeadline - state.timestamp);
 const remainingSec = Math.ceil(remainingMs / 1000);

 // Total match clock (if configured; unlimited matches show no clock)
 let matchText = "";
 let matchLow = false;
 if (data.matchDurationMs !== null && data.matchDurationMs !== undefined) {
 const matchLeftMs = Math.max(0, data.matchDurationMs - state.timestamp);
 const mm = Math.floor(matchLeftMs / 60000);
 const ss = Math.floor((matchLeftMs % 60000) / 1000);
 matchText = "  Match: " + mm + ":" + String(ss).padStart(2, "0");
 // Under a minute left in the whole match.
 matchLow = (data.matchDurationMs - state.timestamp) <= 60000;
 }

 // Urgency: red once the active clock drops under 10 seconds (vote) or
 // under a minute (match). Pulses while urgent - statically red when the
 // user prefers reduced motion.
 const urgent = remainingSec <= 10 || matchLow;
 if (!urgent) {
 ctx.fillStyle = "#888";
 } else if (prefersReducedMotion()) {
 ctx.fillStyle = "#e83e3e";
 } else {
 const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((performance.now()) / 150));
 ctx.fillStyle = `rgba(232, 62, 62, ${pulse.toFixed(3)})`;
 }
 ctx.fillText("Vote: " + remainingSec + "s" + matchText, ox + boardSize / 2, oy + boardSize + 55);
}

// ─── Check callout ───────────────────────────────────────────────────────────

function findKing(data, color) {
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const p = data.board?.[r]?.[c];
 if (p && p.type === "king" && p.color === color) return [r, c];
 }
 }
 return null;
}

function drawCheckCallout(ctx, state, data, ox, oy, squareSize, boardSize, nowMs) {
 // No callouts once the match is over.
 if (!state || !state.running) return;

 // Informational only: kings can be captured in Team Chess, so "check"
 // just warns the moving team their king is attackable this instant.
 if (!isKingInCheck(data.board, data.turn)) return;

 const kingPos = findKing(data, data.turn);
 if (kingPos) {
 const [kr, kc] = kingPos;
 const reduced = prefersReducedMotion();
 const alpha = reduced ? 0.85 : 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(nowMs / 200));
 ctx.strokeStyle = `rgba(232, 62, 62, ${alpha.toFixed(3)})`;
 ctx.lineWidth = 5;
 ctx.strokeRect(ox + kc * squareSize + 3, oy + kr * squareSize + 3, squareSize - 6, squareSize - 6);
 }

 ctx.font = "bold 16px monospace";
 ctx.textAlign = "left";
 ctx.textBaseline = "middle";
 ctx.fillStyle = "#e83e3e";
 ctx.fillText("CHECK!", ox + 8, oy + boardSize + 35);
 ctx.textAlign = "center";
}

// ─── Vote progress bars ──────────────────────────────────────────────────────

function drawVoteBars(ctx, _state, data, ox, oy, _w, boardSize, _nowMs) {
 if (!(data.proposals && data.proposals.length > 0)) {
 voteBarAnim.clear();
 return;
 }

 const needed = quorumNeeded(data, data.turn);
 const reduced = prefersReducedMotion();

 // Layout: stacked bars under the timer line (never cover the board).
 const barTop = oy + boardSize + 72;

 const maxBars = 6;
 const shown = [...data.proposals]
 .sort((a, b) => b.votes - a.votes)
 .slice(0, maxBars);

 const barWidth = Math.min(boardSize * 0.7, 320);
 const bx = ox + (boardSize - barWidth) / 2;
 const rowH = 16;

 ctx.textAlign = "left";
 ctx.font = "bold 11px monospace";

 for (let i = 0; i < shown.length; i++) {
 const p = shown[i];
 const target = Math.min(1, p.votes / Math.max(1, needed));
 let display = voteBarAnim.get(p.id);
 if (display === undefined || reduced) {
 display = target;
 } else {
 // Ease ~12% of the gap per frame at 60fps; dt-independent enough.
 display += (target - display) * 0.18;
 if (Math.abs(target - display) < 0.01) display = target;
 }
 voteBarAnim.set(p.id, display);

 const y = barTop + i * rowH;
 if (y + rowH > oy * 2 + boardSize + 200) break; // hard safety cap

 // Track
 ctx.fillStyle = "rgba(255,255,255,0.08)";
 ctx.fillRect(bx, y, barWidth, 10);
 // Fill (gold, turns green at quorum)
 ctx.fillStyle = p.votes >= needed ? "#5b7c5f" : "#fbbf24";
 ctx.fillRect(bx, y, Math.max(2, barWidth * display), 10);
 // Count label
 ctx.fillStyle = "#aaa";
 ctx.textBaseline = "bottom";
 ctx.fillText(p.votes + "/" + needed, bx + barWidth + 6, y + 10);
 // Move label
 ctx.fillStyle = "#777";
 const label = sq(p.from) + "\u2192" + sq(p.to);
 ctx.fillText(label, bx - 6, y + 10);
 }

 ctx.textAlign = "center";
}

function sq(pair) {
 if (!Array.isArray(pair) || pair.length !== 2) return "?";
 return String.fromCharCode(97 + pair[1]) + String(8 - pair[0]);
}

// ─── Spectator team legend ───────────────────────────────────────────────────

function teamStats(data, color) {
 let total = 0;
 let captured = 0;
 for (const a of Object.values(data.pieceAssignments || {})) {
 if (a.color !== color) continue;
 total++;
 if (a.captured) captured++;
 }
 return { total, captured };
}

function drawTeamLegend(ctx, _state, data, ox, oy, w, h, boardSize) {
 const gutter = Math.min(ox, w - ox - boardSize);
 if (!Number.isFinite(gutter)) return;
 const whiteStats = teamStats(data, "white");
 const blackStats = teamStats(data, "black");

 ctx.font = "bold 12px sans-serif";
 ctx.textBaseline = "top";

 if (gutter >= 90) {
 // Vertical chips in both side gutters.
 drawTeamChip(ctx, "WHITE", whiteStats, ox - gutter + 6, oy + 8, gutter - 12, "#f0d9b5");
 drawTeamChip(ctx, "BLACK", blackStats, ox + boardSize + 6, oy + 8, gutter - 12, "#222222");
 } else {
 // Tight layout: one compact strip along the top edge.
 ctx.fillStyle = "rgba(0,0,0,0.55)";
 ctx.fillRect(ox, Math.max(0, oy - 22), boardSize, 20);
 ctx.textAlign = "left";
 ctx.textBaseline = "middle";
 const midY = Math.max(0, oy - 22) + 10;
 ctx.fillStyle = "#f0d9b5";
 ctx.fillText(
 `\u25CF White ${whiteStats.total - whiteStats.captured}/${whiteStats.total}`,
 ox + 8, midY,
 );
 ctx.fillStyle = "#888";
 ctx.fillText(
 `\u25CF Black ${blackStats.total - blackStats.captured}/${blackStats.total}`,
 ox + boardSize / 2 + 8, midY,
 );
 }
 void h;
}

function drawTeamChip(ctx, label, stats, x, y, cw, swatch) {
 const ch = 58;
 ctx.fillStyle = "rgba(0,0,0,0.45)";
 ctx.fillRect(x, y, cw, ch);
 ctx.strokeStyle = "rgba(255,255,255,0.15)";
 ctx.lineWidth = 1;
 ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
 // Swatch dot
 ctx.fillStyle = swatch;
 ctx.beginPath();
 ctx.arc(x + 12, y + 14, 6, 0, Math.PI * 2);
 ctx.fill();
 // Title
 ctx.fillStyle = "#ddd";
 ctx.textAlign = "left";
 ctx.font = "bold 12px sans-serif";
 ctx.fillText(label, x + 24, y + 8);
 // Counts: players alive / captured
 ctx.font = "11px monospace";
 ctx.fillStyle = "#9a9a9a";
 ctx.fillText(`players: ${stats.total}`, x + 8, y + 28);
 ctx.fillText(`pieces lost: ${stats.captured}`, x + 8, y + 42);
}

// ─── Game-over banner (checkmate / king captured / timeout) ─────────────────

function drawGameOverBanner(ctx, state, data, ox, oy, boardSize, nowMs) {
 if (state.running) {
 gameOverAt = null;
 return;
 }
 if (gameOverAt === null) gameOverAt = nowMs;

 const reduced = prefersReducedMotion();
 const alpha = reduced ? 1 : easeIn(nowMs - gameOverAt);

 // Dim the board
 ctx.fillStyle = `rgba(0, 0, 0, ${(0.65 * alpha).toFixed(3)})`;
 ctx.fillRect(ox, oy, boardSize, boardSize);

 const cx = ox + boardSize / 2;
 const cy = oy + boardSize / 2;

 let headline;
 if (data.winnerTeam === "white") headline = "WHITE WINS!";
 else if (data.winnerTeam === "black") headline = "BLACK WINS!";
 else headline = "DRAW";

 let reason = "";
 if (data.lastCaptureType === "king") reason = "King captured - checkmate!";
 else if (data.timeUp) reason = "Time up - material decides";

 ctx.textAlign = "center";
 ctx.textBaseline = "middle";

 ctx.globalAlpha = alpha;
 ctx.fillStyle = data.winnerTeam === "black" ? "#e8e8e8" : "#fbbf24";
 ctx.font = "bold 34px sans-serif";
 ctx.fillText(headline, cx, cy - 14);

 if (reason) {
 ctx.fillStyle = "#bbb";
 ctx.font = "16px sans-serif";
 ctx.fillText(reason, cx, cy + 22);
 }
 ctx.globalAlpha = 1;
}

// ─── Piece drawing ───────────────────────────────────────────────────────────

function drawPiece(ctx, piece, x, y, size) {
 const key = piece.color + "-" + piece.type;
 const img = pieceImages[key];
 const padding = size * 0.08;

 if (img && img.complete && img.naturalWidth > 0) {
 ctx.drawImage(img, x + padding, y + padding, size - 2 * padding, size - 2 * padding);
 } else {
 // Fallback: Unicode chess symbol
 const symbol = UNICODE_PIECES[key];
 if (symbol) {
 ctx.fillStyle = piece.color === "white" ? "#fff" : "#222";
 ctx.strokeStyle = piece.color === "white" ? "#333" : "#000";
 ctx.lineWidth = 2;
 ctx.font = `${Math.floor(size * 0.72)}px serif`;
 ctx.textAlign = "center";
 ctx.textBaseline = "middle";
 ctx.fillText(symbol, x + size / 2, y + size / 2 + 2);
 ctx.strokeText(symbol, x + size / 2, y + size / 2 + 2);
 }
 }
}
