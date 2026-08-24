/**
 * archive.js Archive UI component
 *
 * Handles fetching and displaying replays, plus the replay viewer.
 */

let replayStates = [];
let replayModule = null;
let replayAnimationFrame = null;
let replayPlaying = false;
let replayCurrentFrame = 0;
let replayFPS = 30;
let replaySpeed = 1;

/**
 * Fetch replays from the server's KV-backed API.
 * @param {string} gameModule - The game module ID to filter by
 */
export async function fetchReplays(gameModule) {
 try {
 const params = new URLSearchParams();
 if (gameModule) params.set("gameModule", gameModule);
 const res = await fetch(`/api/replays?${params.toString()}`);
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 return await res.json();
 } catch (err) {
 console.error("Failed to fetch replays:", err);
 return [];
 }
}

/**
 * Render the list of replays in the archive.
 * @param {Array} replays
 */
export function renderReplayList(replays) {
 const container = document.getElementById("replay-list");
 if (!container) return;

 if (!replays || replays.length === 0) {
 container.innerHTML = `
 <div class="text-center py-16 text-esports-muted">
 <div class="text-4xl mb-4">📦</div>
 <p class="font-mono">NO REPLAYS FOUND</p>
 <p class="text-sm mt-2">Finish a match to see replays here.</p>
 </div>
 `;
 return;
 }

 container.innerHTML = "";
 replays.forEach((replay) => {
 const date = new Date(replay.createdAt);
 const dateStr = date.toLocaleDateString("en-US", {
 month: "short",
 day: "numeric",
 year: "numeric",
 hour: "2-digit",
 minute: "2-digit",
 });
 const duration = formatDuration(replay.duration);
 const winnerName = replay.winnerName || replay.winner?.slice(0, 8) || "???";
 const playerCount = replay.players?.length || 0;

 const div = document.createElement("div");
 div.className =
 "bg-esports-card border border-esports-border rounded-lg p-4 " +
 "cursor-pointer group transition-all duration-200 " +
 "hover:border-esports-accent hover:shadow-lg hover:shadow-esports-accent/10";

 div.innerHTML = `
 <div class="flex items-center justify-between">
 <div class="flex-1">
 <div class="flex items-center space-x-3">
 <span class="text-esports-accent font-bold font-display text-lg">▶</span>
 <div>
 <div class="font-bold text-esports-text">${escapeHtml(winnerName)} <span class="text-esports-muted font-normal">won</span></div>
 <div class="text-sm text-esports-muted font-mono">
 ${dateStr} · ${duration} · ${playerCount} players
 </div>
 </div>
 </div>
 </div>
 <div class="text-right">
 <span class="text-xs text-esports-accent font-mono bg-esports-surface px-2 py-1 rounded">
 ${replay.gameModule || "team-chess"}
 </span>
 </div>
 </div>
 `;
 div.addEventListener("click", () => {
 const moduleId = replay.gameModule === "chess-royale" ? "team-chess" : (replay.gameModule || "team-chess");
 playReplay(replay, `/games/${moduleId}/mod.js`);
 });
 container.appendChild(div);
 });
}

function formatDuration(ms) {
 const totalSec = Math.floor(ms / 1000);
 const m = Math.floor(totalSec / 60);
 const s = totalSec % 60;
 return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Show the replay viewer and start playback.
 * @param {object} replay - Replay data from KV
 * @param {string} gameModulePath - Path to the game module .js file
 */
export async function playReplay(replay, gameModulePath) {
 const listContainer = document.getElementById("replay-list");
 const viewer = document.getElementById("replay-viewer");
 const title = document.getElementById("replay-title");
 const canvas = document.getElementById("replay-canvas");

 if (!listContainer || !viewer || !title || !canvas) return;

 listContainer.classList.add("hidden");
 viewer.classList.remove("hidden");

 const winnerName = replay.winnerName || replay.winner?.slice(0, 8) || "???";
 title.textContent = `REPLAY: ${winnerName} ${formatDuration(replay.duration)}`;

 // Show loading
 canvas.parentElement.innerHTML = `
 <div class="text-center py-12">
 <p class="text-esports-muted font-mono">Loading replay…</p>
 </div>
 `;

 // Load the game module
 const mod = replayModule || (await import(gameModulePath));
 replayModule = mod;

 // Reconstruct states from replay
 canvas.parentElement.innerHTML = `<canvas id="replay-canvas" width="800" height="600" class="bg-black"></canvas>`;
 const replayCanvas = document.getElementById("replay-canvas");
 const ctx = replayCanvas?.getContext("2d");
 if (!ctx) return;

 replayStates = mod.loadReplay(replay);
 replayCurrentFrame = 0;
 replayPlaying = true;

 // Add playback controls
 const controlsHtml = `
 <div class="mt-4 flex items-center justify-center space-x-6">
 <button id="replay-play-pause" class="px-4 py-2 bg-esports-accent text-black font-bold rounded hover:bg-yellow-400 transition-colors">
 ⏸ PAUSE
 </button>
 <div class="text-esports-muted font-mono text-sm">
 <span id="replay-frame">${replayCurrentFrame + 1}</span> / <span id="replay-total">${replayStates.length}</span>
 </div>
 <div class="flex items-center space-x-2">
 <span class="text-esports-muted font-mono text-sm">Speed:</span>
 <select id="replay-speed" class="bg-esports-surface border border-esports-border rounded px-2 py-1 text-esports-text font-mono text-sm">
 <option value="0.5">0.5x</option>
 <option value="1" selected>1x</option>
 <option value="2">2x</option>
 <option value="4">4x</option>
 </select>
 </div>
 </div>
 <div class="mt-3">
 <input id="replay-scrub" type="range" min="0" max="${replayStates.length - 1}" value="0"
 class="w-full h-2 bg-esports-border rounded cursor-pointer">
 </div>
 `;

 const controlsContainer = document.createElement("div");
 controlsContainer.innerHTML = controlsHtml;
 viewer.insertBefore(controlsContainer, viewer.firstChild);

 // Scrubber
 const scrub = document.getElementById("replay-scrub");
 const playPauseBtn = document.getElementById("replay-play-pause");
 const speedSelect = document.getElementById("replay-speed");
 const frameDisplay = document.getElementById("replay-frame");
 const totalDisplay = document.getElementById("replay-total");

 scrub.addEventListener("input", (e) => {
 replayCurrentFrame = parseInt(e.target.value, 10);
 replayPlaying = false;
 playPauseBtn.textContent = "▶ PLAY";
 });

 playPauseBtn.addEventListener("click", () => {
 replayPlaying = !replayPlaying;
 playPauseBtn.textContent = replayPlaying ? "⏸ PAUSE" : "▶ PLAY";
 });

 speedSelect.addEventListener("change", (e) => {
 replaySpeed = parseFloat(e.target.value);
 });

 // Render loop
 const interval = 1000 / (replayFPS * replaySpeed);
 let lastTime = 0;

 function render(timestamp) {
 if (replayStates.length === 0) return;
 if (!lastTime) lastTime = timestamp;

 if (replayPlaying && timestamp - lastTime >= interval) {
 replayCurrentFrame = Math.min(replayCurrentFrame + 1, replayStates.length - 1);
 lastTime = timestamp;
 }

 const frame = Math.min(replayCurrentFrame, replayStates.length - 1);
 const state = replayStates[frame];
 if (state) {
 mod.render(ctx, state, null, replayCanvas.width, replayCanvas.height);
 }

 frameDisplay.textContent = replayCurrentFrame + 1;
 scrub.value = replayCurrentFrame;

 replayAnimationFrame = requestAnimationFrame(render);
 }

 replayAnimationFrame = requestAnimationFrame(render);
}

/**
 * Hide the replay viewer and show the replay list again.
 */
export function hideReplayViewer() {
 if (replayAnimationFrame) {
 cancelAnimationFrame(replayAnimationFrame);
 replayAnimationFrame = null;
 }
 replayStates = [];
 replayPlaying = false;
 replayModule = null;

 const listContainer = document.getElementById("replay-list");
 const viewer = document.getElementById("replay-viewer");
 const title = document.getElementById("replay-title");

 if (listContainer) listContainer.classList.remove("hidden");
 if (viewer) viewer.classList.add("hidden");
 if (title) title.textContent = "";

 // Remove dynamically added controls
 const extraControls = viewer?.querySelectorAll(":scope > div:not(#replay-title-wrapper)");
 extraControls?.forEach((el) => el.remove());
}

function escapeHtml(str) {
 return str
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
}
