// deno-lint-ignore-file no-explicit-any
/**
 * player_client.ts - headless WS player for TournGames load/soak tests.
 *
 * Usage:
 *   deno run -A scripts/player_client.ts session --name p01 --mode create|join \
 *     [--lobby <id>] [--max 20] [--duration 600] [--log <file.jsonl>] [--url ws://localhost:8000/ws]
 */

const args = Deno.args;
function arg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if ((args[0] ?? "session") !== "session") {
  console.error("unknown mode", args[0]);
  Deno.exit(2);
}

const url = arg("--url") ?? "ws://localhost:8000/ws";
const name = arg("--name") ?? `p${crypto.randomUUID().slice(0, 4)}`;
const joinMode = arg("--mode") ?? "join"; // create | join
const lobbyArg = arg("--lobby");
const maxPlayers = parseInt(arg("--max") ?? "20", 10);
const durationSec = parseInt(arg("--duration") ?? "600", 10);
const autoStart = args.includes("--auto-start");
const logPath = arg("--log");

let logFile: Deno.FsFile | null = null;
if (logPath) {
  const dir = logPath.replace(/\/[^/]+$/, "");
  if (dir) await Deno.mkdir(dir, { recursive: true });
  logFile = await Deno.open(logPath, { write: true, create: true, truncate: true });
}
function log(obj: any) {
  const line = JSON.stringify({ t: Date.now(), ...obj }) + "\n";
  if (logFile) logFile.writeSync(new TextEncoder().encode(line));
  else console.log(line.trim());
}

let startedMatch = false;
const ws = new WebSocket(url);
let lobbyId: string | null = null;
let startedAt = 0;

ws.onopen = () => {
  startedAt = Date.now();
  log({ ev: "open" });
  if (joinMode === "create") {
    ws.send(JSON.stringify({
      type: "create-lobby",
      name: `${name}s-lobby`,
      gameId: "team-chess",
      hostName: name,
      lobbyType: "open",
      maxPlayers,
      minPlayers: 2,
    }));
  } else if (lobbyArg) {
    ws.send(JSON.stringify({ type: "join-specific", lobbyId: lobbyArg, playerName: name }));
  } else {
    ws.send(JSON.stringify({ type: "join", gameId: "team-chess", playerName: name }));
  }
};

ws.onmessage = (e) => {
  let msg: any;
  try { msg = JSON.parse(e.data); } catch { log({ ev: "badjson", raw: String(e.data).slice(0, 200) }); return; }
  log({ ev: "in", msg });

  if (msg.type === "lobby-created") {
    lobbyId = msg.lobby?.id;
    console.log(`LOBBY_ID=${lobbyId}`);
    if (logPath) Deno.writeTextFile(logPath.replace(/\.jsonl$/, ".lobbyid"), String(lobbyId));
  }

  if (msg.type === "game-start") console.log(`GAME_START seed=${msg.seed}`);

  // Host convenience: auto-start when roster is full.
  if (autoStart && msg.type === "lobby-state" && !startedMatch) {
    const count = msg.lobby?.players?.length ?? 0;
    if (count >= (msg.lobby?.maxPlayers ?? maxPlayers)) {
      startedMatch = true;
      ws.send(JSON.stringify({ type: "start-match" }));
      log({ ev: "sent-start-match", count });
    }
  }
};

// Heartbeat + signal polling keep-alives.
const hb = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "heartbeat" }));
}, 15000);
const poll = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "poll-signals" }));
}, 10000);

ws.onerror = (e) => log({ ev: "error", err: String(e) });
ws.onclose = (e) => {
  log({ ev: "close", code: e.code, reason: e.reason });
  clearInterval(hb); clearInterval(poll);
};

setTimeout(() => {
  log({ ev: "done" });
  try { ws.close(1000, "soak complete"); } catch { /* */ }
  clearInterval(hb); clearInterval(poll);
  setTimeout(() => Deno.exit(0), 300);
}, durationSec * 1000);
