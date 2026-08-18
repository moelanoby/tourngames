/**
 * TournGames SDK Game Module Interface & Shared Types
 *
 * This file defines the contract that every game module must implement.
 * The core application loads game modules dynamically and interacts with
 * them exclusively through this interface. To swap the active game, you
 * only need to replace the game module file and update `public/game-config.json`.
 *
 * The server knows nothing about specific games it only routes signaling
 * messages and stores replays. The game module runs entirely in the browser.
 */

// ─── Core Identifiers ────────────────────────────────────────────────────────

export type PlayerID = string;

// ─── Player Input ────────────────────────────────────────────────────────────

/**
 * A single player input for one game tick.
 * The `jump` field is the only action in the simplest games, but game modules
 * may extend this interface with additional fields (e.g., `boost`, `left`, `right`).
 */
export interface PlayerInput {
 jump: boolean;
 timestamp: number; // Epoch milliseconds when the input was generated
}

/**
 * All player inputs for a single simulation tick (host-authoritative).
 */
export interface TickInputs {
 [playerId: string]: PlayerInput | undefined;
}

// ─── Player Session ──────────────────────────────────────────────────────────

export type PlayerStatus = "alive" | "dead";

export interface PlayerSession {
 id: PlayerID;
 name: string;
 connected: boolean;
 userId?: string | null;
}

// ─── Game State ──────────────────────────────────────────────────────────────

/**
 * The complete game state for one tick.
 *
 * `data` is an opaque field that the game module fully controls.
 * The core application never inspects `data` directly it only passes
 * the `GameState` object to the game module's render/update functions.
 */
export interface GameState {
 seed: number;
 tick: number;
 timestamp: number; // Game time elapsed in milliseconds
 running: boolean;
 winner: PlayerID | null;

 // Game-module-specific state opaque to the core app
 data: unknown;
}

// ─── Replay System ────────────────────────────────────────────────────────────

/**
 * Replay data structure saved to Deno KV.
 *
 * Since the game map is deterministic (seeded), a replay only needs the
 * seed and the timestamped inputs to reconstruct the entire match.
 */
export interface ReplayData {
 gameModule: string; // e.g. "chess-royale"
 seed: number;
 duration: number; // Match duration in milliseconds
 winner: PlayerID;
 winnerName: string;
 players: PlayerSession[];
 inputs: Record<PlayerID, { t: number; jump: boolean }[]>;
 createdAt: number; // Unix epoch milliseconds
 replayId: string; // Unique identifier
 // ── Local-only archive (v0.4) ───────────────────────────────────────────────
 // Display title shown in the archive. The CLIENT auto-assigns "Match N"
 // using a localStorage counter when saving, and the user can rename it
 // freely in the UI. The server doesn't read or validate this field.
 title?: string;
}

// ─── Game Module Interface ───────────────────────────────────────────────────

/**
 * Every game module must implement this interface and export it as the
 * default export, OR export individual functions matching these signatures.
 *
 * The core application interacts with the game exclusively through these
 * functions. No other game-specific code should be imported or called directly.
 */
export interface GameModule {
 // ── Metadata ───────────────────────────────────────────────────────────────
 readonly metadata: {
 id: string;
 name: string;
 description: string;
 maxPlayers: number;
 minPlayers: number;
 };

 // ── Core Game Loop ─────────────────────────────────────────────────────────

 /**
 * Initialize a new game state with a deterministic seed.
 * Called by the host once the lobby is full and the match begins.
 *
 * @param seed - Random seed for deterministic map generation
 * @param players - List of players in the match
 * @returns Initial GameState
 */
 createGameState(seed: number, players: PlayerSession[]): GameState;

 /**
 * Advance the game state by one tick (deterministic).
 * Only the host calls this. The resulting state is broadcast to all clients.
 *
 * @param state - Current game state
 * @param inputs - All player inputs for this tick
 * @param deltaTime - Fixed timestep in milliseconds (e.g. 16.67 for 60 FPS)
 * @returns Updated GameState
 */
 updateGameState(
 state: GameState,
 inputs: TickInputs,
 deltaTime: number,
 ): GameState;

 /**
 * Extract the local player's input from the current keyboard state.
 * Called every frame by each client.
 *
 * @param keys - Set of currently pressed key strings
 * @returns PlayerInput for this frame
 */
 getLocalInput(keys: Set<string>): PlayerInput;

 /**
 * Render the current game state to the canvas.
 * Called by all clients (including the host) every frame.
 *
 * @param ctx - Canvas 2D rendering context
 * @param state - Current GameState (received from host)
 * @param localPlayerId - The local player's ID (for camera/UI)
 * @param canvasWidth - Canvas width in pixels
 * @param canvasHeight - Canvas height in pixels
 */
 render(
 ctx: CanvasRenderingContext2D,
 state: GameState,
 localPlayerId: PlayerID,
 canvasWidth: number,
 canvasHeight: number,
 ): void;

 // ── Game Status ────────────────────────────────────────────────────────────

 /** Check if a specific player is alive or dead. */
 getPlayerStatus(state: GameState, playerId: PlayerID): PlayerStatus;

 /** Check if the match is over (one or zero players remaining). */
 isMatchOver(state: GameState): boolean;

 /** Get the winning player ID (only valid when isMatchOver returns true). */
 getWinner(state: GameState): PlayerID | null;

 // ── Replay System ──────────────────────────────────────────────────────────

 /**
 * Compile a ReplayData object from recorded inputs.
 * Called by the host after the match ends.
 *
 * @param inputs - Timestamped inputs per player
 * @param seed - The seed used for the match
 * @param duration - Total match duration in ms
 * @param winner - Winning player ID
 * @param winnerName - Winning player name
 * @param players - Player sessions
 * @returns ReplayData ready for KV storage
 */
 compileReplay(
 inputs: Record<PlayerID, PlayerInput[]>,
 seed: number,
 duration: number,
 winner: PlayerID,
 winnerName: string,
 players: PlayerSession[],
 ): ReplayData;

 /**
 * Reconstruct the full sequence of game states from a replay.
 * Used by the archive viewer for replay playback.
 *
 * @param replay - ReplayData from KV
 * @returns Array of GameState snapshots (one per tick)
 */
 loadReplay(replay: ReplayData): GameState[];

 /**
 * Generate a unique replay ID.
 * Default implementation uses timestamp + random.
 */
 generateReplayId(): string;
}

// ─── Signaling Messages (WebSocket ↔ Server) ─────────────────────────────────

export type SignalMessage =
 | { type: "join"; gameId: string; playerName: string }
 | {
 type: "joined";
 lobbyId: string;
 players: PlayerSession[];
 hostId: PlayerID;
 seed: number;
 }
 | {
 type: "offer";
 to: PlayerID;
 from: PlayerID;
 data: RTCSessionDescriptionInit;
 }
 | {
 type: "answer";
 to: PlayerID;
 from: PlayerID;
 data: RTCSessionDescriptionInit;
 }
 | {
 type: "ice-candidate";
 to: PlayerID;
 from: PlayerID;
 data: RTCIceCandidateInit;
 }
 | { type: "host-selected"; hostId: PlayerID }
 | {
 type: "game-start";
 seed: number;
 players: PlayerSession[];
 hostId: PlayerID;
 gameModule: string;
 }
 | { type: "leave"; playerId: PlayerID }
 | { type: "p2p-ready"; playerId: PlayerID };

// ─── P2P Data Channel Messages ───────────────────────────────────────────────

export type P2PMessage =
 | { type: "game-state"; state: GameState; tick: number }
 | { type: "match-over"; winner: PlayerID; winnerName: string }
 | { type: "input"; playerId: PlayerID; input: PlayerInput; tick: number }
 | { type: "player-joined"; player: PlayerSession }
 | { type: "player-left"; playerId: PlayerID }
 | { type: "replay-ack"; replayId: string }
 | { type: "chat"; playerId: PlayerID; message: string };

// ─── Lobby ───────────────────────────────────────────────────────────────────

export type LobbyStatus = "waiting" | "starting" | "playing" | "ended";

export interface Lobby {
 id: string;
 gameId: string;
 players: PlayerSession[];
 hostId: PlayerID | null;
 seed: number | null;
 createdAt: number;
 status: LobbyStatus;
 p2pReadyCount: number;
}

// ─── Game Constants ──────────────────────────────────────────────────────────

/** Default tick rate for the fixed-timestep simulation (ms). */
export const TICK_RATE_MS = 16.67; // ~60 FPS
