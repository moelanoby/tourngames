import { assert } from "jsr:@std/assert@1";
import * as eng from "../../games/team-chess/engine.js";

Deno.test("LAW: every capture (owned or unowned) is recorded in captureHistory", () => {
  const players = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `p${i}` }));
  let state = eng.createGameState(1234, players, { votingTimeMin: 0.25, matchTimeMin: 30 });

  // Drive a deterministic sequence of legal proposals+votes until a capture happens,
  // using the same two-pass input application the host loop performs.
  const alg = ([r, c]: number[]) => "abcdefgh"[c] + (8 - r);
  const rc = (s: string): [number, number] => [8 - parseInt(s[1], 10), "abcdefgh".indexOf(s[0])];
  let capturesSeen = 0;
  for (let turn = 0; turn < 200 && capturesSeen === 0; turn++) {
    const side = state.data.turn;
    // find a capture move if one exists, else any legal move
    let chosen: [number[], number[]] | null = null;
    outer: for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = state.data.board[r][c];
      if (!p || p.color !== side) continue;
      for (const to of eng.getLegalMoves(state.data.board, [r, c], side)) {
        if (state.data.board[to[0]][to[1]]) { chosen = [[r, c], to]; break outer; }
      }
    }
    if (!chosen) {
      outer2: for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = state.data.board[r][c];
        if (!p || p.color !== side) continue;
        const to = eng.getLegalMoves(state.data.board, [r, c], side)[0];
        if (to) { chosen = [[r, c], to]; break outer2; }
      }
    }
    if (!chosen) break;
    const mover = Object.entries(state.data.playerTeams).find(([, t]) => t === side)![0];
    const inputs: Record<string, any> = {
      [mover]: { action: "propose-move", from: chosen[0], to: chosen[1] },
    };
    state = eng.updateGameState(state, inputs, 0);
    const pid = state.data.proposals.find((pp: any) => pp.from[0] === chosen![0][0] && pp.from[1] === chosen![0][1] && pp.to[0] === chosen![1][0] && pp.to[1] === chosen![1][1])?.id;
    if (pid && state.data.playerTeams[mover + "b"]) {} // no-op
    // all team players vote for it -> quorum
    const votes: Record<string, any> = {};
    for (const [pl, t] of Object.entries(state.data.playerTeams)) {
      if (t === side && pl !== mover) votes[pl] = { action: "vote", proposalId: pid };
    }
    state = eng.updateGameState(state, votes, 0);
    state.timestamp += 20_000;
    const before = countPieces(state);
    state = eng.updateGameState(state, {}, 0);
    const after = countPieces(state);
    const hist = state.data.captureHistory ?? [];
    assertEquals(hist.length >= 0, true);
    if (after < before) {
      capturesSeen++;
      assertEquals(
        hist.length > 0,
        true,
        `a piece was removed from the board but captureHistory is empty`,
      );
      const last = hist[hist.length - 1];
      assert(last.square && last.type && last.color && last.tick !== undefined);
    }
  }
  assert(capturesSeen >= 1, "expected at least one capture in 200 turns");
});

function countPieces(s: any): number {
  let n = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (s.data.board[r][c]) n++;
  return n;
}

import { assertEquals } from "jsr:@std/assert@1";
