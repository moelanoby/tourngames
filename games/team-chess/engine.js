/**
 * Team Chess - pure rules/state engine.
 *
 * This module contains NO DOM/canvas/browser references so it can run
 * under Deno tests and be unit-tested in isolation. Rendering lives in
 * render.js, replay serialization in replay.js, click/vote input in
 * input.js. mod.js wires everything together behind the stable contract.
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

export function toAlgebraic([r, c]) {
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

/**
 * True when `color`'s king sits on a square any enemy piece could legally
 * move to right now. Purely informational in Team Chess: kings CAN be
 * captured here (that's how the game ends), there is no forced response -
 * this powers the "Check!" visual callout only.
 */
export function isKingInCheck(board, color) {
 let kingPos = null;
 for (let r = 0; r < 8 && !kingPos; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board?.[r]?.[c];
 if (piece && piece.type === "king" && piece.color === color) {
 kingPos = [r, c];
 break;
 }
 }
 }
 if (!kingPos) return false;
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 const piece = board[r]?.[c];
 if (piece && piece.color !== color && isLegalMove(board, [r, c], kingPos, piece.color)) {
 return true;
 }
 }
 }
 return false;
}

/**
 * Quorum needed for a proposal to lock in: strict majority of the moving
 * team's players. Shared by the engine (updateQuorum) and the renderer
 * (vote progress bars).
 */
export function quorumNeeded(data, turn) {
 const teamSize = (turn === "white" ? data.whitePlayerIds : data.blackPlayerIds)?.length ?? 0;
 return Math.floor(teamSize / 2) + 1;
}

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

// ─── Dynamic voting timer ────────────────────────────────────────────────────
// The host's vote time is a BASE, not a rigid countdown:
//  - Every turn starts with the full base time.
//  - When a player submits a NEW proposal while the clock is running low
//    (< half the base left), the timer tops back up to half the base so
//    teammates always get time to react to fresh moves.
//  - The clock never exceeds the full base time from "now".
//  - Quorum lock-in (majority -> execute after 15s) overrides everything,
//    and an empty clock with no proposals skips the turn as before.
const VOTE_REFRESH_FRACTION = 0.5; // top up to 50% of base on new proposal

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
 const moveKey = JSON.stringify([input.from, input.to]);
 const isNewMove = !data.proposals.some(
 (p) => JSON.stringify([p.from, p.to]) === moveKey
 );
 data.proposals = data.proposals.filter((p) => p.playerId !== playerId);
 // Dynamic vote timer: a FRESH move guarantees the team at least half
 // of the base vote time to react (capped at the full base). Re-proposing
 // an identical move must NOT refresh - otherwise continuous spam would
 // push phaseDeadline forward forever and the turn could never end.
 if (isNewMove) {
 const refreshFloor = state.timestamp + data.votingDurationMs * VOTE_REFRESH_FRACTION;
 const refreshCap = state.timestamp + data.votingDurationMs;
 if (!data.quorumExecAt && refreshFloor > data.phaseDeadline) {
 data.phaseDeadline = Math.min(refreshFloor, refreshCap);
 }
 }
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
 const needed = quorumNeeded(data, data.turn);
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

 // Sort by votes, pick from the tied set with a SEEDED PRNG derived from
 // (seed, turnNumber). Must NOT use Math.random: loadReplay re-simulates
 // the recorded inputs and has to reproduce the exact same move.
 const sorted = [...data.proposals].sort((a, b) => b.votes - a.votes);
 const topVotes = sorted[0].votes;
 const tied = sorted.filter((p) => p.votes === topVotes);
 let prng = ((state.seed >>> 0) ^ Math.imul(data.turnNumber, 2654435761)) >>> 0;
 prng = (Math.imul(prng, 1103515245) + 12345) & 0x7fffffff;
 const winner = tied[prng % tied.length];

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
 data.lastProposedMove = null;
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

// ─── Status ──────────────────────────────────────────────────────────────────

export function getPlayerStatus(_state, _playerId) {
 // Players are always "alive" they can vote even if their piece is captured
 return "alive";
}

/**
 * Client-side state-shape validation used by app.js receiveState().
 * Rejects RTDB-mangled states (null-stripped board rows) before render.
 */
export function validateState(state) {
 const board = state && state.data && state.data.board;
 if (!Array.isArray(board) || board.length !== 8) return false;
 return board.every((row) => Array.isArray(row) && row.length === 8);
}

export function isMatchOver(state) {
 return !state.running;
}

export function getWinner(state) {
 return state.winner || null;
}
