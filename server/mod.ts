/**
 * TournGames Server Main Entry
 *
 * Deno Deploy / Deno 2.x
 *
 * Responsibilities:
 * 1. Serve static frontend assets
 * 2. HTTP API: auth, lobbies, signups, replays, admin, CSRF
 * 3. WebSocket signalling + game-state relay fallback
 *
 * Security features:
 * - Rate limiting on auth and API endpoints
 * - Account lockout after 5 failed logins
 * - CSRF protection on state-changing requests
 * - Security headers (CSP, HSTS, X-Frame-Options, etc.)
 * - Audit logging for admin actions
 * - Admin role with first-user-is-admin bootstrap
 */

import {
 createUser,
 getUserByUsername,
 verifyPassword,
 createSession,
 deleteSession,
 getSession,
 getAuthState,
 setSessionCookie,
 clearSessionCookie,
 validateUsername,
 validatePassword,
 publicUser,
 recordFailedLogin,
 recordSuccessfulLogin,
 isAccountLocked,
 getLockoutRemaining,
 getSessionToken,
 requireCSRF,
} from "./auth.ts";
import {
 createLobby,
 getLobby,
 listLobbies,
 addSignup,
 removeSignup,
 purgeAllLobbies,
} from "./lobbies.ts";
// (Replays are stored locally in the browser as of v0.4. The old replays.ts
// module was dead code with zero importers and has been deleted; the HTTP
// endpoints below remain as 410/legacy no-ops for old clients.)
import {
 handleWebSocketMessage,
 handleWebSocketClose,
 touchConnection,
 sweepIdleConnections,
 connections,
 ICE_CONFIG,
} from "./signaling.ts";
import type { HandleContext, ConnectionInfo } from "./signaling.ts";
import type { Lobby, LobbyType } from "./types.ts";
import { handleAdminApi } from "./admin.ts";
import {
 applySecurityHeaders,
 getClientIp,
 jsonResponse as json,
 jsonError,
 readJsonBody,
 rateLimitLogin,
 rateLimitRegister,
 rateLimitApi,
 rateLimitLobbyCreate,
 rateLimitSignup,
 revokeCSRFToken,
 validatePasswordStrength,
 sanitizeString,
 sanitizeLobbyName,
 auditLog,
 isProfane,
} from "./security.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
 ".html": "text/html; charset=utf-8",
 ".js": "application/javascript; charset=utf-8",
 ".mjs": "application/javascript; charset=utf-8",
 ".ts": "application/typescript; charset=utf-8",
 ".json": "application/json; charset=utf-8",
 ".css": "text/css; charset=utf-8",
 ".png": "image/png",
 ".jpg": "image/jpeg",
 ".jpeg": "image/jpeg",
 ".gif": "image/gif",
 ".svg": "image/svg+xml",
 ".ico": "image/x-icon",
 ".woff": "font/woff",
 ".woff2": "font/woff2",
 ".ttf": "font/ttf",
 ".otf": "font/otf",
 ".map": "application/json; charset=utf-8",
 ".txt": "text/plain; charset=utf-8",
 ".wasm": "application/wasm",
};

// ─── Static File Serving ─────────────────────────────────────────────────────

// Get the directory of the current module (server/mod.ts)
const __dirname = new URL(".", import.meta.url).pathname;
// Repo root = parent of server/. Static assets live at repo root (public/, games/, sdk/),
// so resolve everything against the root - NOT import.meta.url, which points into server/
// and made every asset 404.
const ROOT_DIR = new URL("../", import.meta.url).pathname;
const joinRoot = (rel: string) => ROOT_DIR + rel.replace(/^\/+/, "");
function resolveStaticPath(urlPath: string): string | null {
  let p = urlPath.replace(/^\/+/, "");
  if (p.includes("..") || p.includes("\\")) return null;
  if (p === "" || p === "index.html") return joinRoot("public/index.html");
  if (p.startsWith("public/")) p = p.slice("public/".length);
  if (p.startsWith("ui/")) return joinRoot("public/ui/" + p.slice("ui/".length));
  if (p.startsWith("games/") || p.startsWith("sdk/")) return joinRoot(p);
  if (p.startsWith("assets/")) return joinRoot("public/assets/" + p.slice("assets/".length));
  return joinRoot("public/" + p);
}

async function serveStaticFile(urlPath: string): Promise<Response> {
 const filePath = resolveStaticPath(urlPath);
 if (!filePath) {
 return applySecurityHeaders(new Response("Forbidden", { status: 403 }));
 }
 try {
 const content = await Deno.readTextFile(filePath);
  // Extract extension from the actual filename (handle file:// URLs and query strings)
  const urlPathForExt = urlPath.split("?")[0] ?? "";
  const extMatch = urlPathForExt.match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch?.[1] ? "." + extMatch[1].toLowerCase() : "";
  const mime = MIME_TYPES[ext] || "application/octet-stream";
 // Only cache binary assets (images, fonts) that don't change.
 const cacheControl = (ext === ".html" || ext === ".js" || ext === ".css" || ext === ".mjs")
 ? "no-cache, no-store, must-revalidate"
 : "public, max-age=3600";
 return applySecurityHeaders(new Response(content, {
 status: 200,
 headers: {
 "Content-Type": mime,
 "Cache-Control": cacheControl,
 },
 }));
 } catch {
 const hasExtension = /\.[a-zA-Z0-9]{1,8}$/.test(urlPath);
 if (hasExtension) {
 return applySecurityHeaders(new Response("Not Found", { status: 404 }));
 }
 try {
 const content = await Deno.readTextFile("public/index.html");
 return applySecurityHeaders(new Response(content, {
 status: 200,
 headers: {
 "Content-Type": "text/html; charset=utf-8",
 "Cache-Control": "no-cache",
 },
 }));
 } catch {
 return applySecurityHeaders(new Response("Not Found", { status: 404 }));
 }
 }
}

// ─── JSON Helpers ────────────────────────────────────────────────────────────
// jsonResponse / jsonError / readJsonBody / session-token + CSRF checks are
// shared and live in security.ts and auth.ts so every handler answers with
// one consistent envelope.

function rateLimitedResponse(retryAfter: number): Response {
 return jsonError("Too many requests. Please try again later.", 429, {
 "Retry-After": String(retryAfter),
 });
}

/** Map a readJsonBody result to an error Response (400 invalid / 413 large). */
function jsonBodyError(res: { ok: boolean; reason?: string }): Response {
 if (!res.ok && res.reason === "too-large") {
 return jsonError("Request body too large", 413);
 }
 return jsonError("Invalid JSON", 400);
}

// ─── HTTP API: Auth ──────────────────────────────────────────────────────────

async function handleAuthApi(req: Request, action: string): Promise<Response> {
 const ip = getClientIp(req);

 // ── Register ──
 if (action === "register" && req.method === "POST") {
 const rl = rateLimitRegister(ip);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

 const bodyRes = await readJsonBody(req);
 if (!bodyRes.ok) return jsonBodyError(bodyRes);
 const body = bodyRes.body;
 const username = sanitizeString(body.username, 16);
 const password = (body.password || "").toString();
 const uCheck = validateUsername(username);
 if (!uCheck.ok) return jsonError(uCheck.msg ?? "Invalid username", 400);
 // Server-side profanity check (uses bad-words npm + custom leetspeak filter)
 if (await isProfane(username)) {
 return jsonError("Username contains inappropriate language", 400);
 }
 const pCheck = validatePassword(password);
 if (!pCheck.ok) return jsonError(pCheck.msg ?? "Invalid password", 400);
 const strength = validatePasswordStrength(password);
 if (!strength.ok) return jsonError(strength.msg ?? "Password too weak", 400);

 try {
 const user = await createUser(username, password, ip);
 const session = await createSession(user.id);
 return json({
 user: publicUser(user),
 csrfToken: session.csrfToken,
 }, 200, {
 "Set-Cookie": setSessionCookie(session.token),
 });
 } catch (e) {
 // Only forward the controlled validation message, never raw error internals.
 return jsonError(e instanceof Error ? e.message : "Registration failed", 400);
 }
 }

 // ── Login ──
 if (action === "login" && req.method === "POST") {
 const bodyRes = await readJsonBody(req);
 if (!bodyRes.ok) return jsonBodyError(bodyRes);
 const body = bodyRes.body;
 const username = sanitizeString(body.username, 16);
 const password = (body.password || "").toString();

 const rl = rateLimitLogin(ip, username);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

 const user = await getUserByUsername(username);
 // Don't reveal whether user exists same error message
 if (!user) return jsonError("Invalid username or password", 401);

 // Check ban
 if (user.banned) {
 await auditLog({
 action: "login-attempt-banned",
 actorId: user.id,
 actorName: user.username,
 actorIp: ip,
 details: user.bannedReason || undefined,
 });
 return jsonError("Account banned: " + (user.bannedReason || "No reason provided"), 403);
 }

 // Check lockout
 if (isAccountLocked(user)) {
 const remaining = Math.ceil(getLockoutRemaining(user) / 1000);
 return jsonError(`Account locked. Try again in ${remaining} seconds.`, 423);
 }

 const ok = await verifyPassword(password, user.passwordHash, user.passwordSalt);
 if (!ok) {
 await recordFailedLogin(user);
 await auditLog({
 action: "login-failed",
 actorId: user.id,
 actorName: user.username,
 actorIp: ip,
 });
 // Check if this failure triggered a lockout
 const updated = await getUserByUsername(username);
 if (updated && isAccountLocked(updated)) {
 return jsonError("Too many failed attempts. Account locked for 15 minutes.", 423);
 }
 return jsonError("Invalid username or password", 401);
 }

 await recordSuccessfulLogin(user, ip);
 const session = await createSession(user.id);
 await auditLog({
 action: "login-success",
 actorId: user.id,
 actorName: user.username,
 actorIp: ip,
 });
 return json({
 user: publicUser(user),
 csrfToken: session.csrfToken,
 }, 200, {
 "Set-Cookie": setSessionCookie(session.token),
 });
 }

 // ── Logout ──
 if (action === "logout" && req.method === "POST") {
 // CSRF-protect logout too (login-CSRF annoyance vector). The current
 // client signs out via Firebase and never calls this endpoint, so the
 // extra check is safe.
 const csrfErr = await requireCSRF(req);
 if (csrfErr) return csrfErr;
 const token = getSessionToken(req);
 if (token) {
 const session = await getSession(token);
 if (session) {
 const user = await getAuthState(req);
 if (user.user) {
 await auditLog({
 action: "logout",
 actorId: user.user.id,
 actorName: user.user.username,
 actorIp: ip,
 });
 }
 }
 revokeCSRFToken(token);
 await deleteSession(token);
 }
 return json({ ok: true }, 200, {
 "Set-Cookie": clearSessionCookie(),
 });
 }

 // ── Me ──
 if (action === "me" && req.method === "GET") {
 const auth = await getAuthState(req);
 if (!auth.user) return json({ user: null, csrfToken: null }, 200);
 // Return CSRF token so frontend can include it in requests
 const token = getSessionToken(req);
 let csrfToken: string | null = null;
 if (token) {
 const session = await getSession(token);
 if (session) csrfToken = session.csrfToken;
 }
 return json({ user: publicUser(auth.user), csrfToken }, 200);
 }

 return jsonError("Not found", 404);
}

// ─── HTTP API: CSRF ──────────────────────────────────────────────────────────

async function handleCsrfApi(req: Request): Promise<Response> {
 if (req.method !== "GET") return jsonError("Method not allowed", 405);
 const auth = await getAuthState(req);
 if (!auth.user) return jsonError("Not authenticated", 401);
 const token = getSessionToken(req);
 if (!token) return jsonError("No session", 401);
 const session = await getSession(token);
 if (!session) return jsonError("Session expired", 401);
 return json({ csrfToken: session.csrfToken }, 200);
}

// ─── HTTP API: Lobbies ───────────────────────────────────────────────────────

function lobbySummary(lobby: Lobby) {
 const players = Array.isArray(lobby.players) ? lobby.players : [];
 const signups = Array.isArray(lobby.signups) ? lobby.signups : [];
 return {
 id: lobby.id,
 name: lobby.name,
 gameId: lobby.gameId,
 type: lobby.type,
 status: lobby.status,
 playerCount: players.length,
 signupCount: signups.length,
 maxPlayers: lobby.maxPlayers,
 minPlayers: lobby.minPlayers,
 votingTimeMin: lobby.votingTimeMin ?? 0.25,
 matchTimeMin: lobby.matchTimeMin ?? 10,
 hostName: lobby.hostName,
 hostUserId: lobby.hostUserId || null,
 createdAt: lobby.createdAt,
 seed: lobby.status === "starting" || lobby.status === "playing" ? lobby.seed : null,
 hasInviteCode: !!lobby.inviteCode,
 };
}

async function handleLobbiesApi(req: Request, action: string): Promise<Response> {
 const ip = getClientIp(req);

 // ── List Lobbies ──
 if (action === "" && req.method === "GET") {
 const rl = rateLimitApi(ip);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
 const url = new URL(req.url);
 const gameId = url.searchParams.get("gameId") || undefined;
 const lobbies = await listLobbies(gameId, false);
 return json({ lobbies: lobbies.map(lobbySummary) });
 }

 // ── Create Lobby (HTTP alternative to WS) ──
 if (action === "" && req.method === "POST") {
 const csrfErr = await requireCSRF(req);
 if (csrfErr) return csrfErr;

 const auth = await getAuthState(req);
 if (auth.user?.banned) return jsonError("Account banned", 403);
 if (auth.user) {
 const rl = rateLimitLobbyCreate(auth.user.id);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
 }

 const bodyRes = await readJsonBody(req);
 if (!bodyRes.ok) return jsonBodyError(bodyRes);
 const body = bodyRes.body;
 const lobbyName = sanitizeLobbyName(body.name) || "Untitled Lobby";
 // Profanity check on lobby name
 if (await isProfane(lobbyName)) {
 return jsonError("Lobby name contains inappropriate language", 400);
 }
 const lobby = await createLobby({
 name: lobbyName,
 gameId: sanitizeString(body.gameId, 50) || "team-chess",
 hostName: sanitizeString(body.hostName, 16) || auth.user?.username || "Host",
 hostUserId: auth.user?.id || null,
 type: (body.type as LobbyType) || "open",
 maxPlayers: Math.min(20, Math.max(2, parseInt(String(body.maxPlayers), 10) || 10)),
 minPlayers: Math.min(10, Math.max(2, parseInt(String(body.minPlayers), 10) || 2)),
 votingTimeMin: (() => {
 const v = Number(body.votingTimeMin);
 if (!Number.isFinite(v) || v <= 0) return 0.25;
 return Math.min(2, Math.max(0.1, v)); // vote time capped at 2 minutes
 })(),
 matchTimeMin: (() => {
 const v = Number(body.matchTimeMin);
 if (!Number.isFinite(v) || v <= 0) return -1; // -1 / 0 = unlimited
 return Math.round(v);
 })(),
 });
 return json({ lobby: lobbySummary(lobby) });
 }

 // ── Get Lobby ──
 if (action && !action.includes("/") && req.method === "GET") {
 const lobby = await getLobby(action);
 if (!lobby) return jsonError("Lobby not found", 404);
 // Sanitized summary only: the raw lobby object leaked inviteCode (making
 // the private-lobby gate worthless), players[].userId and signup lists.
 return json({ lobby: lobbySummary(lobby) });
 }

 // ── Signup actions ──
 if (action && action.includes("/")) {
 const [lobbyId, sub] = action.split("/");
 const lobby = await getLobby(lobbyId!);
 if (!lobby) return jsonError("Lobby not found", 404);

 if (sub === "signup" && req.method === "POST") {
 const csrfErr = await requireCSRF(req);
 if (csrfErr) return csrfErr;

 const auth = await getAuthState(req);
 if (!auth.user) return jsonError("Must be logged in to sign up", 401);
 if (auth.user.banned) return jsonError("Account banned", 403);

 const rl = rateLimitSignup(auth.user.id);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

 const res = await addSignup(lobby, auth.user.id, auth.user.username);
 if (!res.ok) return jsonError(res.reason ?? "Signup failed", 400);
 return json({ lobby: res.lobby });
 }

 if (sub === "signup" && req.method === "DELETE") {
 const csrfErr = await requireCSRF(req);
 if (csrfErr) return csrfErr;

 const auth = await getAuthState(req);
 if (!auth.user) return jsonError("Must be logged in", 401);
 const updated = await removeSignup(lobby, auth.user.id);
 return json({ lobby: updated });
 }

 if (sub === "signups" && req.method === "GET") {
 return json({ signups: lobby.signups });
 }
 }

 return jsonError("Not found", 404);
}

// ─── HTTP API: Replays ───────────────────────────────────────────────────────
//
// NOTE: As of v0.4, replays are stored LOCALLY in the player's browser
// (localStorage). The frontend never reads from or writes to these
// endpoints. The GET endpoints return 410 Gone so that old replays
// (from previous server-side storage runs) aren't publicly enumerable.
// The POST endpoint is kept as a silent no-op for backward compat with
// any v0.3-or-older client that might still try to upload.

async function handleReplaysApi(req: Request, action: string): Promise<Response> {
 // ── List (DISABLED) ──
 if (action === "" && req.method === "GET") {
 return json({
 error: "Replays are now stored locally in your browser. The public archive endpoint has been removed.",
 }, 410);
 }

 // ── Submit (LEGACY no-op) ──
 if (action === "" && req.method === "POST") {
 // Accept the request, validate it for logging purposes, but DON'T store
 // anything. v0.4 clients never call this; v0.3 clients get a polite 200
 // so they don't error out.
 const bodyRes = await readJsonBody(req);
 if (!bodyRes.ok) return jsonBodyError(bodyRes);
 const body = bodyRes.body;
 if (!body.replayId || !body.gameModule || typeof body.seed !== "number") {
 return jsonError("Invalid replay data", 400);
 }
 // Silently drop. v0.4 clients store their own replays locally.
 return json({ ok: true, note: "Replay accepted but not stored. Use local archive in v0.4." });
 }

 // ── Get specific (DISABLED) ──
 if (action && req.method === "GET") {
 return json({
 error: "Replays are now stored locally in your browser. The public replay-fetch endpoint has been removed.",
 }, 410);
 }

 return jsonError("Not found", 404);
}

// ─── HTTP API: Game Config (dynamic) ────────────────────────────────────────

/**
 * Reads games.config.json to determine the current game, then reads the
 * game module file to extract the description from the first comment block.
 *
 * The game name is derived from the directory name (e.g. "team-chess").
 * The description is the first block comment ("star-slash terminated") in
 * the module file.
 */
async function handleGameConfigApi(): Promise<Response> {
 try {
 // Read the games config to find which game is active
 const gamesConfigText = await Deno.readTextFile("games.config.json");
 const gamesConfig = JSON.parse(gamesConfigText);
 const currentGame = gamesConfig.current_game;
 if (!currentGame) {
 return jsonError("No current_game set in games.config.json", 500);
 }

 const modulePath = `games/${currentGame}/mod.js`;

 // Read the module file to extract description from first comment
 let description = "";
 let moduleText = "";
 try {
 moduleText = await Deno.readTextFile(modulePath);
 // Extract first block comment: /** ... */
 const commentMatch = moduleText.match(/\/\*\*?([\s\S]*?)\*\//);
 if (commentMatch && commentMatch[1]) {
 // Clean up the comment: remove leading * on each line, trim
 description = commentMatch[1]
 .split("\n")
 .map((line) => line.replace(/^\s*\*\s?/, "").trim())
 .filter((line) => line.length > 0)
 .join(" ");
 }
 } catch {
 // Module not found fall through to error
 }

 // Derive game name from directory: "team-chess" → "Team Chess"
 const gameName = currentGame
 .split("-")
 .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
 .join(" ");

 const config = {
 gameId: currentGame,
 gameModulePath: `/${modulePath}`,
 gameName,
 description: description || `${gameName} play and win.`,
 maxPlayers: 20,
 canvasWidth: 600,
 canvasHeight: 650,
 };

 return applySecurityHeaders(new Response(JSON.stringify(config), {
 status: 200,
 headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" },
 }));
 } catch (e) {
 console.error("[API] game-config failed:", e);
 return jsonError("Game configuration unavailable", 500);
 }
}

// ─── HTTP API Router ─────────────────────────────────────────────────────────

async function handleApi(req: Request, urlPath: string): Promise<Response> {
 const [resource, ...rest] = urlPath.split("/");
 let action = rest.join("/");
  // Normalize: strip trailing slash and query string
  if (action.endsWith("/")) action = action.slice(0, -1);
  const qIdx = action.indexOf("?");
  if (qIdx >= 0) action = action.slice(0, qIdx);

 if (resource === "auth") return handleAuthApi(req, action);
 if (resource === "csrf") return handleCsrfApi(req);
 if (resource === "lobbies") return handleLobbiesApi(req, action);
 if (resource === "replays") return handleReplaysApi(req, action);
 if (resource === "replay") {
 // LEGACY singular-form route (v0.3 and earlier). Also disabled as of v0.4
 // replays are local to each user's browser now.
 if (action === "" && req.method === "GET") {
 return json({
 error: "Replays are now stored locally in your browser. The public replay-fetch endpoint has been removed.",
 }, 410);
 }
 if (action === "" && req.method === "POST") return handleReplaysApi(req, "");
 }
 if (resource === "game-config") return handleGameConfigApi();
 if (resource === "admin") {
 const auth = await getAuthState(req);
 return handleAdminApi(req, action, auth);
 }

 return jsonError("Not found", 404);
}

// ─── Startup: Purge all lobbies for clean state ──────────────────────────────
// This is the FIRST thing the server does purge all lobbies, signups,
// peer entries, and stored signals from the database so we start fresh
// every restart. No ghost players or stale lobbies.

console.log("[Startup] Purging all lobbies and related data...");
// Startup purge is now OPT-IN: on Deno Deploy every isolate cold-start
// (including routine deploys while old isolates still serve traffic) used to
// delete ALL lobbies and pending WebRTC signals cluster-wide, killing active
// matches. Run with PURGE_ON_BOOT=1 only for explicit maintenance.
if (Deno.env.get("PURGE_ON_BOOT") === "1") {
 const purgedCount = await purgeAllLobbies();
 console.log(`[Startup] Purged ${purgedCount} lobbies.`);
}

// ─── Main Server ─────────────────────────────────────────────────────────────

/** Concurrent WebSocket connections allowed per client IP. */
const MAX_WS_PER_IP = 10;
const wsConnectionsByIp = new Map<string, number>();

// ─── WS Idle Sweeper ─────────────────────────────────────────────────────────
// Started lazily on the first WebSocket connection so importing this module
// (e.g. from tests) never leaves a timer running. Half-open sockets that
// never send another frame are closed after the idle timeout.
const WS_SWEEP_INTERVAL_MS = 60 * 1000;
let idleSweeperStarted = false;
function ensureIdleSweeper(): void {
 if (idleSweeperStarted) return;
 idleSweeperStarted = true;
 setInterval(() => {
 const closed = sweepIdleConnections();
 if (closed > 0) console.log(`[WS] Idle sweeper closed ${closed} stale connection(s)`);
 }, WS_SWEEP_INTERVAL_MS);
}

const EXTRA_ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "")
 .split(",").map((s) => s.trim()).filter(Boolean);

function wsOriginAllowed(origin: string | null, selfOrigin: string): boolean {
 if (!origin) return true; // non-browser client
 if (origin === selfOrigin) return true;
 if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
 if (origin === "https://moelanoby.github.io") return true; // deployed frontend
 return EXTRA_ALLOWED_ORIGINS.includes(origin);
}

// ─── Request Logging (dev-gated) ─────────────────────────────────────────────
// Quiet by default; set REQUEST_LOGGING=1 (or "true") for one structured
// line per request in dev: method path status ms.
const REQUEST_LOGGING = ["1", "true"].includes(
 (Deno.env.get("REQUEST_LOGGING") || "").toLowerCase().trim(),
);

function withRequestLogging(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
 if (!REQUEST_LOGGING) return handler;
 return async (req: Request) => {
 const start = performance.now();
 let response: Response;
 try {
 response = await handler(req);
 } catch (err) {
 console.error("[HTTP] Unhandled handler error:", err);
 response = jsonError("Internal server error", 500);
 }
 const ms = Math.round(performance.now() - start);
 const path = new URL(req.url).pathname;
 console.log(`${req.method} ${path} ${response.status} ${ms}ms`);
 return response;
 };
}

// ─── Graceful Shutdown (SIGINT / SIGTERM) ────────────────────────────────────

let shuttingDown = false;
async function gracefulShutdown(server: Deno.HttpServer, signal: string): Promise<void> {
 if (shuttingDown) return;
 shuttingDown = true;
 console.log(`[Shutdown] ${signal} received, closing server...`);
 // Close all live WebSocket connections first so clients see 1001
 // ("Going Away") instead of a dropped socket.
 for (const [pid, info] of connections.entries()) {
 try {
 info.ws.close(1001, "Server shutting down");
 } catch { /* already closing */ }
 connections.delete(pid);
 }
 try {
 await server.shutdown();
 console.log("[Shutdown] HTTP server closed. Bye.");
 } catch (err) {
 console.error("[Shutdown] Error while shutting down:", err);
 }
 Deno.exit(0);
}

const server = Deno.serve(withRequestLogging(async (req: Request) => {
 const url = new URL(req.url);
 const path = url.pathname;

 // ── CORS preflight ──
 if (req.method === "OPTIONS") {
 return new Response(null, {
 status: 204,
 headers: {
 "Access-Control-Allow-Origin": "*",
 "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
 "Access-Control-Allow-Headers": "Content-Type, Cookie, X-CSRF-Token",
 "Access-Control-Allow-Credentials": "true",
 "Access-Control-Max-Age": "86400",
 },
 });
 }

 // ── WebSocket upgrade ──
 if (path === "/ws" || path === "/signaling") {
 const upgradeHeader = req.headers.get("upgrade");
 if (upgradeHeader?.toLowerCase() === "websocket") {
 // Origin allowlist: block cross-site WebSocket hijacking. Browsers
 // always send Origin; non-browser clients may omit it. Defaults cover
 // same-origin, localhost dev, and the GitHub Pages deploy origin;
 // override with ALLOWED_ORIGINS="a,b,c".
 const origin = req.headers.get("origin");
 if (!wsOriginAllowed(origin, url.origin)) {
 console.warn(`[WS] rejected upgrade from origin: ${origin ?? "(none)"}`);
 return new Response("Forbidden", { status: 403 });
 }
 // Per-IP concurrent connection cap: without it one machine can open
 // hundreds of sockets, each with its own rate budget.
 const wsIp = getClientIp(req);
 const ipCount = wsConnectionsByIp.get(wsIp) ?? 0;
 if (ipCount >= MAX_WS_PER_IP) {
 console.warn(`[WS] connection cap reached for ${wsIp}`);
 return new Response("Too many connections", { status: 429 });
 }
 const cookies = req.headers.get("cookie") || "";
 const match = cookies.match(/tgn_session=([^;]+)/);
 let userId: string | null = null;
 let username: string | null = null;
 let banned = false;
 if (match) {
 try {
 const session = await getSession(match[1]!);
 if (session) {
 const { getUserById } = await import("./auth.ts");
 const user = await getUserById(session.userId);
 if (user) {
 if (user.banned) {
 banned = true;
 } else {
 userId = user.id;
 username = user.username;
 }
 }
 }
 } catch { /* ignore */ }
 }

 const playerId = crypto.randomUUID();
 try {
 const { socket, response } = Deno.upgradeWebSocket(req);

 if (banned) {
 // Accept the socket but immediately send a banned message and close
 socket.onopen = () => {
 safeSendLocal(socket, { type: "error", message: "Account banned" });
 socket.close(4003, "Account banned");
 };
 return response;
 }

 // Kick any existing connection for the same user (handles browser refresh).
 // When a player refreshes, their old WS may still be open. We close it
 // here so the old playerId is removed from its lobby.
 if (userId || username) {
 for (const [existingPlayerId, info] of connections.entries()) {
 if (existingPlayerId === playerId) continue;
 const sameUser = userId && info.userId === userId;
 const sameName = username && info.username === username;
 if (sameUser || sameName) {
 console.log(`[WS] Kicking old connection ${existingPlayerId.slice(0, 8)} (same user reconnected)`);
 try {
 info.ws.close(4001, "Reconnected from another tab");
 } catch { /* ignore */ }
 // Don't delete from connections here onclose handler will do it
 }
 }
 }

 const connInfo: ConnectionInfo = { lobbyId: null, ws: socket, userId, username };
 connections.set(playerId, connInfo);
 wsConnectionsByIp.set(wsIp, ipCount + 1);
 touchConnection(playerId);
 ensureIdleSweeper();

 socket.onopen = () => {
 safeSendLocal(socket, {
 type: "assign-id",
 playerId,
 username,
 userId,
 iceConfig: ICE_CONFIG,
 });
 console.log(`[WS] Player ${playerId} connected (user: ${username || "anon"})`);
 };

 socket.onmessage = (event: MessageEvent) => {
 const ctx: HandleContext = { playerId, userId, username };
 handleWebSocketMessage(socket, ctx, event.data).catch((err) => {
 console.error("[WS] handler error:", err);
 });
 };

 socket.onclose = () => {
 handleWebSocketClose(playerId).catch((err) => {
 console.error("[WS] close handler error:", err);
 });
 const c = wsConnectionsByIp.get(wsIp) ?? 1;
 if (c <= 1) wsConnectionsByIp.delete(wsIp);
 else wsConnectionsByIp.set(wsIp, c - 1);
 console.log(`[WS] Player ${playerId} disconnected`);
 };

 socket.onerror = () => {
 console.error(`[WS] Error for player ${playerId}`);
 };

 return response;
 } catch (err) {
 console.error("[WS] Upgrade failed:", err);
 return new Response("WebSocket upgrade failed", { status: 400 });
 }
 }
 return new Response("Expected WebSocket upgrade", { status: 426 });
 }

 // ── API routes ──
 if (path.startsWith("/api/")) {
 const apiPath = path.slice(5);
 try {
 return await handleApi(req, apiPath);
 } catch (err) {
 console.error("[API] Error:", err);
 return jsonError("Internal server error", 500);
 }
 }

 // ── Static files ──
 return await serveStaticFile(path);
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
 try {
 Deno.addSignalListener(signal, () => gracefulShutdown(server, signal));
 } catch (err) {
 // Some platforms (e.g. Deno Deploy) do not support signal listeners.
 console.warn(`[Shutdown] ${signal} listener unavailable:`, err);
 }
}

function safeSendLocal(ws: WebSocket, data: unknown): void {
 try {
 if (ws.readyState === WebSocket.OPEN) {
 ws.send(JSON.stringify(data));
 }
 } catch (e) {
 console.warn("[WS] safeSendLocal failed:", e);
 }
}

console.log("TournGames server ready.");
