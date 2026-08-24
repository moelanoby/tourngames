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
} from "./auth.ts";
import {
 createLobby,
 getLobby,
 listLobbies,
 addSignup,
 removeSignup,
 purgeAllLobbies,
} from "./lobbies.ts";
// (Replays are now stored locally in the browser as of v0.4; the server's
// old replays.ts module is dead code kept for archival reference, but
// no endpoint imports from it anymore.)
import {
 handleWebSocketMessage,
 handleWebSocketClose,
 connections,
 ICE_CONFIG,
} from "./signaling.ts";
import type { HandleContext } from "./signaling.ts";
import type { LobbyType } from "./types.ts";
import { handleAdminApi } from "./admin.ts";
import {
 applySecurityHeaders,
 getClientIp,
 rateLimitLogin,
 rateLimitRegister,
 rateLimitApi,
 rateLimitLobbyCreate,
 rateLimitSignup,
 validateCSRFToken,
 validatePasswordStrength,
 sanitizeString,
 sanitizeLobbyName,
 auditLog,
 isProfane,
 cleanProfanity,
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
function resolveStaticPath(urlPath: string): string | null {
  console.log("[DEBUG] resolveStaticPath:", urlPath);
  let p = urlPath.replace(/^\/+/, "");
  if (p.includes("..") || p.includes("\\")) return null;
  if (p === "" || p === "index.html") return new URL("public/index.html", import.meta.url).pathname;
  if (p.startsWith("public/")) p = p.slice("public/".length);
  if (p.startsWith("ui/")) return new URL("public/ui/" + p.slice("ui/".length), import.meta.url).pathname;
  if (p.startsWith("games/")) return new URL(p, import.meta.url).pathname;
  if (p.startsWith("assets/")) return new URL("public/assets/" + p.slice("assets/".length), import.meta.url).pathname;
  if (p.startsWith("sdk/")) return new URL("sdk/" + p.slice("sdk/".length), import.meta.url).pathname;
  return new URL("public/" + p, import.meta.url).pathname;
}

async function serveStaticFile(urlPath: string): Promise<Response> {
  console.log("[DEBUG] serveStaticFile called with:", urlPath);
 const filePath = resolveStaticPath(urlPath);
  console.log("[DEBUG] resolveStaticPath returned:", filePath);
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

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
 const headers: Record<string, string> = {
 "Content-Type": "application/json; charset=utf-8",
 "Cache-Control": "no-store",
 };
 if (extraHeaders) Object.assign(headers, extraHeaders);
 return applySecurityHeaders(new Response(JSON.stringify(data), { status, headers }));
}

function rateLimitedResponse(retryAfter: number): Response {
 return json({ error: "Too many requests. Please try again later." }, 429, {
 "Retry-After": String(retryAfter),
 });
}

async function readJsonBody(req: Request): Promise<any> {
 try {
 return await req.json();
 } catch {
 return null;
 }
}

function getSessionToken(req: Request): string | null {
 const cookies = req.headers.get("cookie") || "";
 const match = cookies.match(/tgn_session=([^;]+)/);
 return match ? match[1]! : null;
}

function checkCSRF(req: Request): boolean {
 const sessionToken = getSessionToken(req);
 if (!sessionToken) return false;
 const csrfToken = req.headers.get("x-csrf-token");
 if (!csrfToken) return false;
 return validateCSRFToken(sessionToken, csrfToken);
}

/** Require CSRF for state-changing requests. Returns error response if invalid. */
function requireCSRF(req: Request): Response | null {
 if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
 if (!checkCSRF(req)) {
 return json({ error: "Invalid or missing CSRF token. Refresh the page and try again." }, 403);
 }
 return null;
}

// ─── HTTP API: Auth ──────────────────────────────────────────────────────────

async function handleAuthApi(req: Request, action: string): Promise<Response> {
 const ip = getClientIp(req);

 // ── Register ──
 if (action === "register" && req.method === "POST") {
 const rl = rateLimitRegister(ip);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

 const body = await readJsonBody(req);
 if (!body) return json({ error: "Invalid JSON" }, 400);
 const username = sanitizeString(body.username, 16);
 const password = (body.password || "").toString();
 const uCheck = validateUsername(username);
 if (!uCheck.ok) return json({ error: uCheck.msg }, 400);
 // Server-side profanity check (uses bad-words npm + custom leetspeak filter)
 if (await isProfane(username)) {
 return json({ error: "Username contains inappropriate language" }, 400);
 }
 const pCheck = validatePassword(password);
 if (!pCheck.ok) return json({ error: pCheck.msg }, 400);
 const strength = validatePasswordStrength(password);
 if (!strength.ok) return json({ error: strength.msg }, 400);

 try {
 const user = await createUser(username, password, ip);
 const session = await createSession(user.id);
 return json({
 user: publicUser(user),
 csrfToken: session.csrfToken,
 }, 200, {
 "Set-Cookie": setSessionCookie(session.token),
 });
 } catch (e: any) {
 return json({ error: String(e?.message || e) }, 400);
 }
 }

 // ── Login ──
 if (action === "login" && req.method === "POST") {
 const body = await readJsonBody(req);
 if (!body) return json({ error: "Invalid JSON" }, 400);
 const username = sanitizeString(body.username, 16);
 const password = (body.password || "").toString();

 const rl = rateLimitLogin(ip, username);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

 const user = await getUserByUsername(username);
 // Don't reveal whether user exists same error message
 if (!user) return json({ error: "Invalid username or password" }, 401);

 // Check ban
 if (user.banned) {
 await auditLog({
 action: "login-attempt-banned",
 actorId: user.id,
 actorName: user.username,
 actorIp: ip,
 details: user.bannedReason || undefined,
 });
 return json({ error: "Account banned: " + (user.bannedReason || "No reason provided") }, 403);
 }

 // Check lockout
 if (isAccountLocked(user)) {
 const remaining = Math.ceil(getLockoutRemaining(user) / 1000);
 return json({ error: `Account locked. Try again in ${remaining} seconds.` }, 423);
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
 return json({ error: "Too many failed attempts. Account locked for 15 minutes." }, 423);
 }
 return json({ error: "Invalid username or password" }, 401);
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

 return json({ error: "Not found" }, 404);
}

// ─── HTTP API: CSRF ──────────────────────────────────────────────────────────

async function handleCsrfApi(req: Request): Promise<Response> {
 if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
 const auth = await getAuthState(req);
 if (!auth.user) return json({ error: "Not authenticated" }, 401);
 const token = getSessionToken(req);
 if (!token) return json({ error: "No session" }, 401);
 const session = await getSession(token);
 if (!session) return json({ error: "Session expired" }, 401);
 return json({ csrfToken: session.csrfToken }, 200);
}

// ─── HTTP API: Lobbies ───────────────────────────────────────────────────────

function lobbySummary(lobby: any) {
 return {
 id: lobby.id,
 name: lobby.name,
 gameId: lobby.gameId,
 type: lobby.type,
 status: lobby.status,
 playerCount: lobby.players?.length || 0,
 signupCount: lobby.signups?.length || 0,
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
 const csrfErr = requireCSRF(req);
 if (csrfErr) return csrfErr;

 const auth = await getAuthState(req);
 if (auth.user?.banned) return json({ error: "Account banned" }, 403);
 if (auth.user) {
 const rl = rateLimitLobbyCreate(auth.user.id);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
 }

 const body = await readJsonBody(req);
 if (!body) return json({ error: "Invalid JSON" }, 400);
 const lobbyName = sanitizeLobbyName(body.name) || "Untitled Lobby";
 // Profanity check on lobby name
 if (await isProfane(lobbyName)) {
 return json({ error: "Lobby name contains inappropriate language" }, 400);
 }
 const lobby = await createLobby({
 name: lobbyName,
 gameId: sanitizeString(body.gameId, 50) || "team-chess",
 hostName: sanitizeString(body.hostName, 16) || auth.user?.username || "Host",
 hostUserId: auth.user?.id || null,
 type: (body.type as LobbyType) || "open",
 maxPlayers: Math.min(20, Math.max(2, parseInt(body.maxPlayers, 10) || 10)),
 minPlayers: Math.min(10, Math.max(2, parseInt(body.minPlayers, 10) || 2)),
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
 if (!lobby) return json({ error: "Lobby not found" }, 404);
 // Sanitized summary only: the raw lobby object leaked inviteCode (making
 // the private-lobby gate worthless), players[].userId and signup lists.
 return json({ lobby: lobbySummary(lobby) });
 }

 // ── Signup actions ──
 if (action && action.includes("/")) {
 const [lobbyId, sub] = action.split("/");
 const lobby = await getLobby(lobbyId!);
 if (!lobby) return json({ error: "Lobby not found" }, 404);

 if (sub === "signup" && req.method === "POST") {
 const csrfErr = requireCSRF(req);
 if (csrfErr) return csrfErr;

 const auth = await getAuthState(req);
 if (!auth.user) return json({ error: "Must be logged in to sign up" }, 401);
 if (auth.user.banned) return json({ error: "Account banned" }, 403);

 const rl = rateLimitSignup(auth.user.id);
 if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

 const res = await addSignup(lobby, auth.user.id, auth.user.username);
 if (!res.ok) return json({ error: res.reason }, 400);
 return json({ lobby: res.lobby });
 }

 if (sub === "signup" && req.method === "DELETE") {
 const csrfErr = requireCSRF(req);
 if (csrfErr) return csrfErr;

 const auth = await getAuthState(req);
 if (!auth.user) return json({ error: "Must be logged in" }, 401);
 const updated = await removeSignup(lobby, auth.user.id);
 return json({ lobby: updated });
 }

 if (sub === "signups" && req.method === "GET") {
 return json({ signups: lobby.signups });
 }
 }

 return json({ error: "Not found" }, 404);
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
 const body = await readJsonBody(req);
 if (!body) return json({ error: "Invalid JSON" }, 400);
 if (!body.replayId || !body.gameModule || typeof body.seed !== "number") {
 return json({ error: "Invalid replay data" }, 400);
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

 return json({ error: "Not found" }, 404);
}

// ─── HTTP API: Game Config (dynamic) ────────────────────────────────────────

/**
 * Reads games.config.json to determine the current game, then reads the
 * game module file to extract the description from the first comment block.
 *
 * The game name is derived from the directory name (e.g. "team-chess").
 * The description is the first block comment (/** ... *​/) in the module file.
 */
async function handleGameConfigApi(): Promise<Response> {
 try {
 // Read the games config to find which game is active
 const gamesConfigText = await Deno.readTextFile("games.config.json");
 const gamesConfig = JSON.parse(gamesConfigText);
 const currentGame = gamesConfig.current_game;
 if (!currentGame) {
 return json({ error: "No current_game set in games.config.json" }, 500);
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
 return json({ error: "Game config not found: " + String(e) }, 500);
 }
}

// ─── HTTP API Router ─────────────────────────────────────────────────────────

async function handleApi(req: Request, urlPath: string): Promise<Response> {
  console.log("[DEBUG] handleApi:", urlPath);
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

 return json({ error: "Not found" }, 404);
}

// ─── Startup: Purge all lobbies for clean state ──────────────────────────────
// This is the FIRST thing the server does purge all lobbies, signups,
// peer entries, and stored signals from the database so we start fresh
// every restart. No ghost players or stale lobbies.

console.log("[Startup] Purging all lobbies and related data...");
const purgedCount = await purgeAllLobbies();
console.log(`[Startup] Purged ${purgedCount} lobbies.`);

// ─── Main Server ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
 const url = new URL(req.url);
 const path = url.pathname;
  console.log("[DEBUG] Request:", req.method, path, "from", req.headers.get("origin") || "unknown");

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

 connections.set(playerId, { lobbyId: null, ws: socket, userId, username });

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
 return json({ error: "Internal server error" }, 500);
 }
 }

 // ── Static files ──
 return await serveStaticFile(path);
});

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
