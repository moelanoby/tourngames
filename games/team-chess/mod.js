/**
 * Each player is a chess piece. Vote on moves with your team. Capture the king to win.
 */

// ─── Metadata ────────────────────────────────────────────────────────────────

export const metadata = {
 id: "team-chess",
 name: "Team Chess",
 description: "Multiplayer chess each player is a piece. Vote on moves.",
 maxPlayers: 20,
 minPlayers: 2,
 tickRate: 500, // 2 Hz turn-based, no need for 60fps
};

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
let imagesLoadedCount = 0;
const totalImages = 12;

function preloadImages() {
 if (typeof Image === "undefined") return;
 for (const [key, url] of Object.entries(PIECE_URLS)) {
 const img = new Image();
 img.crossOrigin = "anonymous";
 img.onload = () => { imagesLoadedCount++; };
 img.onerror = () => {
 imagesLoadedCount++;
 console.warn("[Chess] Failed to load piece:", key, " using Unicode fallback");
 };
 img.src = url;
 pieceImages[key] = img;
 }
}
preloadImages();

// Unicode fallback (if Wikimedia images fail to load)
const UNICODE_PIECES = {
 "white-king": "♔", "white-queen": "♕", "white-rook": "♖",
 "white-bishop": "♗", "white-knight": "♘", "white-pawn": "♙",
 "black-king": "♚", "black-queen": "♛", "black-rook": "♜",
 "black-bishop": "♝", "black-knight": "♞", "black-pawn": "♟",
};

// ─── Board Helpers ───────────────────────────────────────────────────────────

const BACK_RANK = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];

function createInitialBoard() {
 const board = [];
 for (let r = 0; r < 8; r++) board.push(new Array(8).fill(null));
 // Black on top (rows 0-1), White on bottom (rows 6-7)
 for (let c = 0; c < 8; c++) {
 board[0][c] = { type: BACK_RANK[c], color: "black", playerId: null };
 board[1][c] = { type: "pawn", color: "black", playerId: null };
 board[6][c] = { type: "pawn", color: "white", playerId: null };
 board[7][c] = { type: BACK_RANK[c], color: "white", playerId: null };
 }
 return board;
}

function toAlgebraic([r, c]) {
 return String.fromCharCode(97 + c) + (8 - r);
}

// ─── Move Validation (simplified chess) ──────────────────────────────────────

export function isLegalMove(board, from, to, color) {
 const [fr, fc] = from;
 const [tr, tc] = to;
 if (fr < 0 || fr > 7 || fc < 0 || fc > 7 || tr < 0 || tr > 7 || tc < 0 || tc > 7) return false;
 const piece = board[fr][fc];
 if (!piece || piece.color !== color) return false;
 const target = board[tr][tc];
 if (target && target.color === color) return false;

 const dr = tr - fr;
 const dc = tc - fc;
 const adr = Math.abs(dr);
 const adc = Math.abs(dc);

 switch (piece.type) {
 case "pawn": {
 const dir = color === "white" ? -1 : 1;
 const startRow = color === "white" ? 6 : 1;
 // Forward 1
 if (dc === 0 && dr === dir && !target) return true;
 // Forward 2 from start
 if (dc === 0 && dr === 2 * dir && fr === startRow && !target && !board[fr + dir][fc]) return true;
 // Diagonal capture
 if (adc === 1 && dr === dir && target) return true;
 return false;
 }
 case "knight":
 return (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
 case "bishop":
 if (adr !== adc || adr === 0) return false;
 return isPathClear(board, from, to);
 case "rook":
 if (dr !== 0 && dc !== 0) return false;
 if (dr === 0 && dc === 0) return false;
 return isPathClear(board, from, to);
 case "queen": {
 if (dr === 0 && dc === 0) return false;
 const isDiagonal = adr === adc;
 const isStraight = dr === 0 || dc === 0;
 if (!isDiagonal && !isStraight) return false;
 return isPathClear(board, from, to);
 }
 case "king":
 return adr <= 1 && adc <= 1 && (adr + adc > 0);
 default:
 return false;
 }
}

function isPathClear(board, from, to) {
 const [fr, fc] = from;
 const [tr, tc] = to;
 const dr = Math.sign(tr - fr);
 const dc = Math.sign(tc - fc);
 let r = fr + dr;
 let c = fc + dc;
 while (r !== tr || c !== tc) {
 if (board[r][c]) return false;
 r += dr;
 c += dc;
 }
 return true;
}

export function getLegalMoves(board, from, color) {
 const moves = [];
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 if (isLegalMove(board, from, [r, c], color)) {
 moves.push([r, c]);
 }
 }
 }
 return moves;
}

// ─── Game State ──────────────────────────────────────────────────────────────

// ─── Timers (host-configurable lobby settings) ──────────────────────────────
//
// Two independent host-controlled timers, both measured in MINUTES:
//  1. Vote time  - votingTimeMin: how long a team has per turn to vote.
//                  Capped at 2 minutes. Fractions allowed (0.25 = 15s).
//  2. Match time - matchTimeMin: total wall-clock time for the whole game.
//                  -1 = unlimited. When time runs out, the team with the
//                  more valuable material wins (equal material = draw).
//
// Early execution: as soon as a proposal holds enough votes (a strict
// majority of the moving team), a 15-second lock-in starts; when it
// elapses the top-voted move is executed immediately instead of waiting
// for the full vote timer.
//
// Settings flow from lobby creation -> "game-start" message ->
// createGameState options: { votingTimeMin, matchTimeMin }
const DEFAULT_VOTING_MIN = 0.25; // 15 seconds
const MIN_VOTING_MS = 5000;
const MAX_VOTING_MS = 120000; // hard cap: 2 minutes
const QUORUM_EXEC_DELAY_MS = 15000; // 15s from "enough votes" to execution

export function normalizeTimers(options) {
 const o = options || {};

 // Vote time per turn (minutes, capped at 2)
 let votingMs = DEFAULT_VOTING_MIN * 60000;
 if (typeof o.votingTimeMin === "number" && Number.isFinite(o.votingTimeMin) && o.votingTimeMin > 0) {
 votingMs = o.votingTimeMin * 60000;
 } else if (typeof o.votingTimeSec === "number" && Number.isFinite(o.votingTimeSec) && o.votingTimeSec > 0) {
 votingMs = o.votingTimeSec * 1000; // legacy replays stored seconds
 } else if (typeof o.votingMs === "number" && Number.isFinite(o.votingMs) && o.votingMs > 0) {
 votingMs = o.votingMs;
 }
 votingMs = Math.min(MAX_VOTING_MS, Math.max(MIN_VOTING_MS, Math.round(votingMs)));

 // Total match time (minutes). -1 (or any negative / 0 for legacy
 // replays) means unlimited -> null internally.
 let matchMs = null; // null = unlimited
 if (typeof o.matchTimeMin === "number" && Number.isFinite(o.matchTimeMin)) {
 matchMs = o.matchTimeMin > 0 ? Math.round(o.matchTimeMin * 60000) : null;
 } else if (typeof o.matchMs === "number" && Number.isFinite(o.matchMs)) {
 matchMs = o.matchMs > 0 ? Math.round(o.matchMs) : null;
 }

 return { votingMs, matchMs };
}

export function createGameState(seed, players, options = {}) {
 let prng = (seed || 1) >>> 0;
 function rand() {
 prng = (prng * 1103515245 + 12345) & 0x7fffffff;
 return prng / 0x7fffffff;
 }

 const board = createInitialBoard();

 // Split players into teams (shuffled deterministically by seed)
 const shuffled = [...players].sort(() => rand() - 0.5);
 const half = Math.ceil(shuffled.length / 2);
 const whitePlayers = shuffled.slice(0, half);
 const blackPlayers = shuffled.slice(half);

 // Collect piece positions for each color
 const whitePositions = [];
 const blackPositions = [];
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 if (board[r][c]) {
 if (board[r][c].color === "white") whitePositions.push([r, c]);
 else blackPositions.push([r, c]);
 }
 }
 }

 // Shuffle positions (deterministic)
 for (let i = whitePositions.length - 1; i > 0; i--) {
 const j = Math.floor(rand() * (i + 1));
 [whitePositions[i], whitePositions[j]] = [whitePositions[j], whitePositions[i]];
 }
 for (let i = blackPositions.length - 1; i > 0; i--) {
 const j = Math.floor(rand() * (i + 1));
 [blackPositions[i], blackPositions[j]] = [blackPositions[j], blackPositions[i]];
 }

 // Assign players to pieces (round-robin if more players than pieces)
 const pieceAssignments = {};
 const playerTeams = {};
 for (let i = 0; i < whitePlayers.length; i++) {
 const [r, c] = whitePositions[i % whitePositions.length];
 board[r][c].playerId = whitePlayers[i].id;
 pieceAssignments[whitePlayers[i].id] = { type: board[r][c].type, color: "white", pos: [r, c], captured: false };
 playerTeams[whitePlayers[i].id] = "white";
 }
 for (let i = 0; i < blackPlayers.length; i++) {
 const [r, c] = blackPositions[i % blackPositions.length];
 board[r][c].playerId = blackPlayers[i].id;
 pieceAssignments[blackPlayers[i].id] = { type: board[r][c].type, color: "black", pos: [r, c], captured: false };
 playerTeams[blackPlayers[i].id] = "black";
 }

 const timers = normalizeTimers(options);

 return {
 seed: seed >>> 0,
 tick: 0,
 timestamp: 0,
 running: true,
 winner: null,
 data: {
 board,
 turn: "white",
 phase: "voting",
 votingDurationMs: timers.votingMs, // per-turn vote timer
 matchDurationMs: timers.matchMs, // total match timer (null = unlimited)
 settings: {
 votingTimeMin: timers.votingMs / 60000,
 matchTimeMin: timers.matchMs !== null ? timers.matchMs / 60000 : -1,
 },
 quorumExecAt: null, // timestamp when quorum reached + 15s delay elapses
 phaseDeadline: timers.votingMs, // in game-time ms
 proposals: [],
 playerVotes: {},
 pieceAssignments,
 playerTeams,
 lastMove: null,
 turnNumber: 1,
 whitePlayerIds: whitePlayers.map((p) => p.id),
 blackPlayerIds: blackPlayers.map((p) => p.id),
 winnerTeam: null,
 },
 };
}

// ─── Input Handling (clicks) ─────────────────────────────────────────────────

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
 const piece = data.board[r][c];
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
 const piece = data.board[r][c];
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

export function getLocalInput(keys) {
 const input = pendingInput;
 pendingInput = null;
 return input || null;
}

// ─── Update Game State ───────────────────────────────────────────────────────

export function updateGameState(state, inputs, dt) {
 const data = state.data;
 state.tick++;
 state.timestamp += dt;

 if (!state.running) return state;

 // Total match timer: when time is up, decide the game by material count.
 if (data.matchDurationMs !== null && data.matchDurationMs !== undefined
 && state.timestamp >= data.matchDurationMs) {
 endByTimeout(state);
 return state;
 }

 if (data.phase === "voting") {
 // Process proposals and votes
 for (const [playerId, input] of Object.entries(inputs)) {
 if (!input || !input.action) continue;
 const team = data.playerTeams[playerId];
 if (!team || data.turn !== team) continue;

 if (input.action === "propose-move") {
 // Validate move
 if (isLegalMove(data.board, input.from, input.to, team)) {
 // Remove any existing proposal by this player
 data.proposals = data.proposals.filter((p) => p.playerId !== playerId);
 const proposal = {
 id: toAlgebraic(input.from) + "-" + toAlgebraic(input.to) + "-" + playerId.slice(0, 4),
 from: input.from,
 to: input.to,
 playerId,
 votes: 0,
 };
 data.proposals.push(proposal);
 // Auto-vote for own proposal
 data.playerVotes[playerId] = proposal.id;
 recountVotes(data);
 }
 } else if (input.action === "vote") {
 const proposal = data.proposals.find((p) => p.id === input.proposalId);
 if (proposal) {
 data.playerVotes[playerId] = input.proposalId;
 recountVotes(data);
 }
 }
 }

 // Enough votes? Start (or cancel) the 15-second lock-in, and execute
 // once it elapses - no need to wait for the full vote timer.
 updateQuorum(state);

 const quorumDue = data.quorumExecAt !== null && data.quorumExecAt !== undefined
 && state.timestamp >= data.quorumExecAt;
 if (quorumDue || state.timestamp >= data.phaseDeadline) {
 executeTopMove(state);
 }
 }

 return state;
}

/**
 * A proposal has "enough votes" when it holds a strict majority of the
 * moving team's players. First time that happens we stamp
 * quorumExecAt = now + 15s; the move then executes automatically when the
 * lock-in elapses even if the vote timer is still running. If votes shift
 * away and NO proposal holds a majority anymore, the lock-in is cancelled.
 */
function updateQuorum(state) {
 const data = state.data;

 let quorumProposal = null;
 if (data.proposals.length > 0) {
 const teamSize = (data.turn === "white" ? data.whitePlayerIds : data.blackPlayerIds).length;
 const needed = Math.floor(teamSize / 2) + 1;
 const sorted = [...data.proposals].sort((a, b) => b.votes - a.votes);
 if (sorted[0] && sorted[0].votes >= needed) {
 quorumProposal = sorted[0];
 }
 }

 if (quorumProposal && data.quorumExecAt === null) {
 data.quorumExecAt = state.timestamp + QUORUM_EXEC_DELAY_MS;
 } else if (!quorumProposal) {
 data.quorumExecAt = null;
 }
}

function recountVotes(data) {
 for (const p of data.proposals) p.votes = 0;
 for (const proposalId of Object.values(data.playerVotes)) {
 const p = data.proposals.find((pp) => pp.id === proposalId);
 if (p) p.votes++;
 }
}

function executeTopMove(state) {
 const data = state.data;

 if (data.proposals.length === 0) {
 // No proposals skip turn
 switchTurn(state);
 return;
 }

 // Sort by votes, pick from tied set randomly
 const sorted = [...data.proposals].sort((a, b) => b.votes - a.votes);
 const topVotes = sorted[0].votes;
 const tied = sorted.filter((p) => p.votes === topVotes);
 const winner = tied[Math.floor(Math.random() * tied.length)];

 // Execute the move
 const [fr, fc] = winner.from;
 const [tr, tc] = winner.to;
 const capturedPiece = data.board[tr][tc];

 // Move piece
 data.board[tr][tc] = data.board[fr][fc];
 data.board[fr][fc] = null;

 // Update piece assignment
 if (data.board[tr][tc].playerId) {
 data.pieceAssignments[data.board[tr][tc].playerId].pos = [tr, tc];
 }
 if (capturedPiece && capturedPiece.playerId) {
 data.pieceAssignments[capturedPiece.playerId].captured = true;
 data.pieceAssignments[capturedPiece.playerId].pos = null;
 }

 // Track capture for sound effect (client checks data.lastCaptureTick vs state.tick)
 if (capturedPiece) {
 data.lastCaptureTick = state.tick;
 data.lastCaptureType = capturedPiece.type;
 }

 // Check king capture
 if (capturedPiece && capturedPiece.type === "king") {
 data.winnerTeam = data.turn;
 state.winner = data.turn === "white"
 ? (data.whitePlayerIds[0] || null)
 : (data.blackPlayerIds[0] || null);
 state.running = false;
 return;
 }

 data.lastMove = { from: winner.from, to: winner.to };
 switchTurn(state);
}

function switchTurn(state) {
 const data = state.data;
 data.turn = data.turn === "white" ? "black" : "white";
 data.phase = "voting";
 data.phaseDeadline = state.timestamp + (data.votingDurationMs || 20000);
 data.proposals = [];
 data.playerVotes = {};
 data.quorumExecAt = null;
 data.turnNumber++;
}

const PIECE_VALUES = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

function materialScore(data, color) {
 let score = 0;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = data.board[r][c];
 if (piece && piece.color === color) score += PIECE_VALUES[piece.type] || 0;
 }
 }
 return score;
}

/**
 * Total match time expired. The team with more material value wins;
 * equal material is a draw (winner stays null).
 */
function endByTimeout(state) {
 const data = state.data;
 state.running = false;
 data.timeUp = true;

 const whiteScore = materialScore(data, "white");
 const blackScore = materialScore(data, "black");
 if (whiteScore === blackScore) {
 data.winnerTeam = null; // draw
 return;
 }

 data.winnerTeam = whiteScore > blackScore ? "white" : "black";
 const winnerIds = data.winnerTeam === "white" ? data.whitePlayerIds : data.blackPlayerIds;
 // Report a representative winning player so existing result UI keeps working.
 state.winner = winnerIds[0] || null;
}

// ─── Render ──────────────────────────────────────────────────────────────────

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
 if (selectedSquare) {
 const [r, c] = selectedSquare;
 ctx.fillStyle = "rgba(91, 124, 95, 0.4)";
 ctx.fillRect(ox + c * squareSize, oy + r * squareSize, squareSize, squareSize);
 // Draw legal move dots
 ctx.fillStyle = "rgba(91, 124, 95, 0.35)";
 for (const [mr, mc] of legalMovesForSelected) {
 const cx = ox + mc * squareSize + squareSize / 2;
 const cy = oy + mr * squareSize + squareSize / 2;
 // If there's an enemy piece, draw a ring instead of a dot
 if (data.board[mr][mc]) {
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

 // Draw pieces
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = data.board[r][c];
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

 ctx.textAlign = "center";
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
 if (data.matchDurationMs !== null && data.matchDurationMs !== undefined) {
 const matchLeftMs = Math.max(0, data.matchDurationMs - state.timestamp);
 const mm = Math.floor(matchLeftMs / 60000);
 const ss = Math.floor((matchLeftMs % 60000) / 1000);
 matchText = "  Match: " + mm + ":" + String(ss).padStart(2, "0");
 }

 // Red when the active timer is running low: <5s on the vote clock,
 // or under a minute left in the whole match.
 const matchLow = data.matchDurationMs != null && (data.matchDurationMs - state.timestamp) <= 60000;
 ctx.fillStyle = (remainingSec <= 5 || matchLow) ? "#e83e3e" : "#888";
 ctx.fillText("Vote: " + remainingSec + "s" + matchText, ox + boardSize / 2, oy + boardSize + 55);
}

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

// ─── Status & Replay ─────────────────────────────────────────────────────────

export function getPlayerStatus(state, playerId) {
 // Players are always "alive" they can vote even if their piece is captured
 return "alive";
}

export function isMatchOver(state) {
 return !state.running;
}

export function getWinner(state) {
 return state.winner || null;
}

export function compileReplay(inputs, seed, duration, winner, winnerName, players, settings) {
 // The CLIENT (app.js saveLocalReplay) auto-assigns a "Match N" title
 // using a localStorage counter and stores the replay locally. We just
 // pass through the inputs/players; the title field is filled in by
 // the client. The server is not involved in saving anymore.
 return {
 gameModule: "team-chess",
 seed,
 duration,
 winner,
 winnerName,
 players,
 settings: settings || null,
 inputs: inputs || {},
 createdAt: Date.now(),
 replayId: "rpl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
 };
}

export function loadReplay(replay) {
 // Reconstruct the full sequence of game states by re-simulating each tick
 // with the recorded inputs. Inputs are stored per player as an array of
 // {action, from?, to?, proposalId?, timestamp} objects recorded by the host.
 //
 // Chess runs at 500ms/tick, so we feed inputs whose recorded timestamp falls
 // within the current tick window, then advance the simulation by one tick
 // until the match ends or we hit the safety cap (matches the host loop in
 // app.js: maxTicks = metadata.maxTicks || 3600).
 //
 // IMPORTANT: updateGameState mutates the state object in place. If we just
 // push the same reference each iteration, every entry in the returned array
 // would alias the final state  making replay playback show the same frame
 // for every tick. We deep-snapshot each state before pushing so each
 // entry is a distinct, immutable view of that tick's state.
 if (!replay || typeof replay.seed !== "number" || !Number.isFinite(replay.seed) || !Array.isArray(replay.players)) {
 return [];
 }

 const players = (replay.players || []).map((p) => ({
 id: p.id,
 name: p.name,
 connected: p.connected !== false,
 }));

 // Bucket each player's inputs by tick index (timestamp / tickRate).
 //
 // The host records each input with timestamp = state.timestamp AFTER
 // updateGameState ran. So an input recorded at timestamp=5500 was
 // processed during the 11th updateGameState call (which transitioned
 // state.tick from 10 to 11). To re-play that input at the SAME tick in
 // the replay, we feed it at tk=10 (so updateGameState transitions
 // state.tick from 10 to 11 and processes it). Hence we subtract 1
 // from the bucket index. Inputs recorded at the very first tick
 // (timestamp = tickRate) go to bucket 0.
 const tickRate = (metadata && metadata.tickRate) || 500;
 const bucketed = {}; // tickIndex -> { playerId: input }
 const rawInputs = replay.inputs || {};
 for (const [playerId, list] of Object.entries(rawInputs)) {
 if (!Array.isArray(list)) continue;
 for (const inp of list) {
 if (!inp || typeof inp.timestamp !== "number") continue;
 // Subtract 1 because the input was recorded POST-update (it was
 // active during the transition into the recorded tick, not during
 // the transition out of it).
 const tk = Math.max(0, Math.floor(inp.timestamp / tickRate) - 1);
 if (!bucketed[tk]) bucketed[tk] = {};
 // Keep only the latest input per player per tick (matches host behavior
 // where pendingInputs is overwritten each tick).
 bucketed[tk][playerId] = inp;
 }
 }

 let s = createGameState(replay.seed, players, replay.settings || {});
 const states = [snapshotState(s)];
 const maxTicks = (metadata && metadata.maxTicks) ? metadata.maxTicks : 3600;
 let tk = 0;
 while (tk < maxTicks && s.running) {
 const inputs = bucketed[tk] || {};
 s = updateGameState(s, inputs, tickRate);
 states.push(snapshotState(s));
 tk++;
 if (s.winner) break;
 }
 return states;
}

/**
 * Deep-clone a game state so the caller can hold a stable snapshot of it
 * even if the original is mutated later. We use JSON round-trip for
 * simplicity  chess state is plain JSON-serializable data (no functions,
 * Dates, or circular refs). The board is an 8x8 array of plain objects,
 * and the rest of `state.data` is flat primitive fields.
 */
function snapshotState(s) {
 try {
 return JSON.parse(JSON.stringify(s));
 } catch {
 // Shouldn't happen for chess state, but if it does, return the
 // original reference rather than crashing replay playback.
 return s;
 }
}

export default {
 metadata,
 createGameState,
 updateGameState,
 getLocalInput,
 handleClick,
 voteForProposal,
 render,
 getPlayerStatus,
 isMatchOver,
 getWinner,
 compileReplay,
 loadReplay,
};
