/**
 * Team Chess - replay recording/playback.
 *
 * compileReplay packages a finished match for local archival.
 * loadReplay deterministically re-simulates the recorded inputs to
 * reconstruct every game state frame. Pure logic - no DOM references.
 */

import { metadata, createGameState, updateGameState } from "./engine.js";

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
 const tickRate = metadata.tickRate || 500;
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
 const maxTicks = metadata.maxTicks ? metadata.maxTicks : 3600;
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
