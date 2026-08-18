/**
 * TournGames Server Replays Module
 *
 * Replay storage and retrieval backed by Deno KV.
 *
 * NOTE: As of v0.4, replays are stored LOCALLY in the player's browser
 * (localStorage), not on the server. This module is kept for backward
 * compatibility with older clients that still POST to /api/replays, but
 * the archive UI no longer reads from here. New matches are saved
 * client-side via app.js's saveLocalReplay() helper.
 */

import type { ReplayData } from "./types.ts";

const kv = await Deno.openKv();

export async function saveReplay(replay: ReplayData): Promise<void> {
 if (!replay || !replay.replayId) return;
 await kv.set(["replay", replay.replayId], replay);
 await kv.set(["replay-index", replay.gameModule, replay.createdAt], replay.replayId);
 // Also index by recent (no game filter)
 await kv.set(["replay-index-all", replay.createdAt], replay.replayId);
}

export async function listReplays(gameModule?: string, limit = 50): Promise<ReplayData[]> {
 const prefix = gameModule ? ["replay-index", gameModule] : ["replay-index-all"];
 const replays: ReplayData[] = [];
 // KV list iterates in lexicographic key order; reverse: true gives most-recent first
 // (createdAt is a number stored as the last key element, so higher = newer).
 const iter = kv.list<string>({ prefix }, { reverse: true, limit });
 for await (const entry of iter) {
  const replayId = entry.value;
  if (!replayId) continue;
  const result = await kv.get<ReplayData>(["replay", replayId]);
  if (result.value) replays.push(result.value);
  if (replays.length >= limit) break;
 }
 return replays;
}

export async function getReplay(replayId: string): Promise<ReplayData | null> {
 const result = await kv.get<ReplayData>(["replay", replayId]);
 return result.value || null;
}
