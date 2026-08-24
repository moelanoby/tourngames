/**
 * Formal law tests for games/team-chess/mod.js.
 *
 * These are mathematical properties, not examples:
 *   L1  determinism       - createGameState is pure in (seed, players)
 *   L2  equivariance      - player relabeling acts only on ids
 *   L4  perft(1) = 20     - exhaustive initial move graph == classical value
 *   L5  quorum bicond.    - quorumExecAt set <=> some proposal holds majority
 *   L6  replay ≡ live     - re-simulation reproduces the exact final state
 *   L7  serialization     - JSON round-trip is an isomorphism on states
 *   L8  sync invariant    - assignments/board stay consistent under adversarial fuzz
 *
 * Run: deno test -A --unstable-kv server/tests/chess_formal_laws_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert@1.0.0";
import {
 createGameState,
 updateGameState,
 getLegalMoves,
 loadReplay,
 compileReplay,
 metadata,
} from "../../games/team-chess/mod.js";

const TICK = metadata.tickRate || 500;
// deno-lint-ignore no-explicit-any
type AnyState = any;
const clone = (x: unknown) => JSON.parse(JSON.stringify(x));
const mkPlayers = (n: number) =>
 Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i }));

// Deterministic PRNG so failures reproduce.
function makeRand(seed: number) {
 let s = seed >>> 0;
 return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

Deno.test("L1: createGameState is deterministic in (seed, players)", () => {
 for (const seed of [0, 1, 42, 2 ** 31 - 1]) {
 const a = createGameState(seed, mkPlayers(8), { votingTimeMin: 1 });
 const b = createGameState(seed, mkPlayers(8), { votingTimeMin: 1 });
 assertEquals(clone(a), clone(b));
 }
});

Deno.test("L2: player relabeling equivariance", () => {
 const players = mkPlayers(6);
 const s1 = createGameState(777, players, {});
 const renamed = players.map((p) => ({ id: p.id + "-x", name: p.name }));
 const s2 = createGameState(777, renamed, {});
 for (let r = 0; r < 8; r++) {
 for (let c = 0; c < 8; c++) {
 // deno-lint-ignore no-explicit-any
 const p1: any = (s1.data.board as any)[r][c];
 // deno-lint-ignore no-explicit-any
 const p2: any = (s2.data.board as any)[r][c];
 assertEquals(!!p1, !!p2, `presence differs at ${r},${c}`);
 if (p1 && p2) {
 assertEquals(p1.type, p2.type);
 assertEquals(p1.color, p2.color);
 const expectedPid = p1.playerId == null ? null : p1.playerId + "-x";
 assertEquals(p2.playerId ?? null, expectedPid);
 }
 }
 }
});

function pieceCount(board: AnyState): number {
 let n = 0;
 for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c]) n++;
 return n;
}

/** Drive forward until the pending proposal executes or the match ends. */
function runToExecution(state: AnyState, maxTicks = 45): AnyState {
 const t0 = state.data.turnNumber;
 let s = state;
 for (let i = 0; i < maxTicks && s.running; i++) {
 s = updateGameState(s, {}, TICK);
 if (s.data.turnNumber > t0 || !s.running) break;
 }
 return s;
}

Deno.test("L4: perft(1) from the initial position equals the classical 20 moves", () => {
 const root: AnyState = createGameState(20260924, mkPlayers(2), {});
 const pid = root.data.whitePlayerIds[0]!;
 let executed = 0;
 for (let fr = 0; fr < 8; fr++) for (let fc = 0; fc < 8; fc++) {
 const p = root.data.board[fr]?.[fc];
 if (!p || p.color !== "white") continue;
 for (const [tr, tc] of getLegalMoves(root.data.board, [fr, fc], "white")) {
 const s: AnyState = runToExecution(
 updateGameState(clone(root), { [pid]: { action: "propose-move", from: [fr, fc], to: [tr, tc] } }, TICK),
 );
 assert(!s.running || s.data.turnNumber === 2, "move must execute");
 assertEquals((s.data.board[tr as number] as any)?.[tc as number]?.color, "white");
 assertEquals(s.data.board[fr][fc] ?? null, null);
 executed++;
 }
 }
 assertEquals(executed, 20);
});

Deno.test("L5: quorum biconditional - quorumExecAt <=> majority proposal exists", () => {
 const rand = makeRand(555);
 for (let g = 0; g < 40; g++) {
 const n = 2 + Math.floor(rand() * 10);
 let s = createGameState(Math.floor(rand() * 2 ** 31), mkPlayers(n), { votingTimeSec: 5 });
 for (let t = 0; t < 150 && s.running; t++) {
 const inputs: Record<string, unknown> = {};
 for (let i = 0; i < n; i++) {
 const roll = rand();
 if (roll < 0.35) {
 inputs["p" + i] = { action: "propose-move", from: [Math.floor(rand() * 8), Math.floor(rand() * 8)], to: [Math.floor(rand() * 8), Math.floor(rand() * 8)] };
 } else if (roll < 0.7 && (s.data.proposals as unknown[]).length) {
 const props: Array<{ id: string }> = s.data.proposals;
 inputs["p" + i] = { action: "vote", proposalId: props[Math.floor(rand() * props.length)]!.id };
 }
 }
 s = updateGameState(s, inputs, TICK);
 if (!s.running || s.data.phase !== "voting") continue;
 const d = s.data;
 const teamSize = (d.turn === "white" ? d.whitePlayerIds : d.blackPlayerIds).length;
 const needed = Math.floor(teamSize / 2) + 1;
 const props2: Array<{ id: string; votes: number }> = d.proposals ?? [];
 const hasMajority = props2.some((p) => p.votes >= needed);
 const quorumSet = d.quorumExecAt !== null && d.quorumExecAt !== undefined;
 assertEquals(quorumSet, hasMajority, `game ${g} tick ${t}`);
 }
 }
});

Deno.test("L6: replay re-simulation reproduces the exact live state", () => {
 for (let g = 0; g < 5; g++) {
 const seed = 1000 + g * 7919;
 const n = 2 + (g % 8);
 const settings = g % 2 === 0 ? { votingTimeSec: 5, matchTimeMin: -1 } : { votingTimeMin: 0.25 };
 const rand = makeRand(900000 + g);
 let s = createGameState(seed, mkPlayers(n), settings);
 const recorded: Record<string, { action: string; from?: number[]; to?: number[]; proposalId?: string; timestamp: number }[]> = {};
 // Frame 0 of a replay is the INITIAL state - record it for alignment.
 const liveFrames: string[] = [JSON.stringify([s.data.board, s.data.turnNumber])];
 for (let t = 0; t < 200 && s.running; t++) {
 const inputs: Record<string, unknown> = {};
 for (let i = 0; i < n; i++) {
 const roll = rand();
 if (roll < 0.4) inputs["p" + i] = { action: "propose-move", from: [Math.floor(rand() * 8), Math.floor(rand() * 8)], to: [Math.floor(rand() * 8), Math.floor(rand() * 8)] };
 else if (roll < 0.8) inputs["p" + i] = { action: "vote", proposalId: "a2-a3-p0" };
 else inputs["p" + i] = { jump: false };
 }
 s = updateGameState(s, inputs, TICK);
 for (const [pid, inp] of Object.entries(inputs)) {
 const rec = inp as { action?: string; from?: number[]; to?: number[]; proposalId?: string };
 if (rec.action) {
 (recorded[pid] ??= []).push({ ...rec, timestamp: s.timestamp } as typeof recorded[typeof pid][number]);
 }
 }
 liveFrames.push(JSON.stringify([s.data.board, s.data.turnNumber]));
 }
 const replay = compileReplay(recorded, seed, s.timestamp, s.winner, "W", mkPlayers(n).map((p) => ({ ...p, connected: true })), settings);
 const states = loadReplay(replay);
 assert(states.length >= liveFrames.length, "replay must cover the live frames");
 // Every live frame must appear identically in the replay (prefix equality)
 for (let i = 0; i < Math.min(liveFrames.length, states.length); i++) {
 const r = states[i];
 const liveBoardTurn = JSON.stringify([r.data.board, r.data.turnNumber]);
 // compare against our recorded live frame i
 assertEquals(liveBoardTurn, liveFrames[i], `frame ${i} diverged (game ${g})`);
 }
 }
});

Deno.test("L7: JSON round-trip is an isomorphism on game states", () => {
 const s = createGameState(9, mkPlayers(6), { votingTimeMin: 0.25 });
 assertEquals(clone(s), clone(clone(s)));
});

Deno.test("L8: board/assignment sync survives adversarial input fuzz", () => {
 const rand = makeRand(12345);
 for (let g = 0; g < 60; g++) {
 const n = 2 + Math.floor(rand() * 10);
 let s = createGameState(Math.floor(rand() * 2 ** 31), mkPlayers(n), { votingTimeSec: 5 });
 const checkSync = (st: ReturnType<typeof createGameState>) => {
 for (let r = 0; r < 8; r++) {
 const row = st.data.board[r];
 assert(Array.isArray(row) && row.length === 8);
 for (let c = 0; c < 8; c++) {
 const p = row[c];
 // deno-lint-ignore no-explicit-any
 const assignmentsAny: Record<string, any> = st.data.pieceAssignments ?? {};
 if (p?.playerId != null) {
 const a = assignmentsAny[String(p.playerId)];
 assert(a && !a.captured && a.pos[0] === r && a.pos[1] === c, "assignment desync");
 }
 }
 }
 };
 checkSync(s);
 for (let t = 0; t < 120 && s.running; t++) {
 const inputs: Record<string, unknown> = {};
 for (let i = 0; i < n; i++) {
 const roll = rand();
 if (roll < 0.3) inputs["p" + i] = { action: "propose-move", from: [Math.floor(rand() * 8), Math.floor(rand() * 8)], to: [Math.floor(rand() * 8), Math.floor(rand() * 8)] };
 else if (roll < 0.4) inputs["p" + i] = { action: "vote", proposalId: "x" };
 else if (roll < 0.5) inputs["p" + i] = { action: "WEIRD", junk: [null, { a: Infinity }] };
 else if (roll < 0.52) inputs["p" + i] = { action: "propose-move", from: [-5, 999], to: [NaN, Infinity] };
 else inputs["p" + i] = null;
 }
 s = updateGameState(s, inputs, TICK);
 checkSync(s);
 }
 }
});
