/**
 * TournGames Server Admin API Module
 *
 * All admin endpoints require:
 * 1. Authenticated session
 * 2. User role === "admin"
 * 3. Valid CSRF token for state-changing actions
 *
 * Endpoints:
 * GET /api/admin/users list all users
 * POST /api/admin/users/:id/ban ban user (body: {reason})
 * POST /api/admin/users/:id/unban unban user
 * POST /api/admin/users/:id/promote promote to admin
 * POST /api/admin/users/:id/demote demote from admin
 * DELETE /api/admin/users/:id delete user
 * GET /api/admin/lobbies list ALL lobbies (including private)
 * DELETE /api/admin/lobbies/:id delete lobby
 * POST /api/admin/lobbies/:id/end force-end match
 * GET /api/admin/audit view audit log
 */

import type { User } from "./types.ts";
import {
 getUserById,
 banUser,
 unbanUser,
 promoteToAdmin,
 demoteFromAdmin,
 deleteUser,
 listUsers,
 adminUserView,
 isAdmin,
} from "./auth.ts";
import {
 getLobby,
 deleteLobby,
 listLobbies,
 resetLobbyToWaiting,
} from "./lobbies.ts";
import { listAuditLogs, validateCSRFToken, getClientIp, auditLog } from "./security.ts";

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
 const headers: Record<string, string> = {
 "Content-Type": "application/json; charset=utf-8",
 "Cache-Control": "no-store",
 };
 if (extraHeaders) Object.assign(headers, extraHeaders);
 return new Response(JSON.stringify(data), { status, headers });
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

/** Returns the admin user if authorized, or a Response error if not. */
async function requireAdmin(req: Request, auth: { user: User | null }): Promise<{ ok: true; admin: User & { role: "admin" } } | { ok: false; response: Response }> {
 if (!isAdmin(auth.user)) {
 return { ok: false, response: json({ error: "Forbidden admin access required" }, 403) };
 }
 // For state-changing requests, validate CSRF
 if (req.method !== "GET") {
 if (!checkCSRF(req)) {
 return { ok: false, response: json({ error: "Invalid CSRF token" }, 403) };
 }
 }
 return { ok: true, admin: auth.user };
}

// ─── Admin API Router ────────────────────────────────────────────────────────

export async function handleAdminApi(
 req: Request,
 action: string,
 auth: { user: User | null },
): Promise<Response> {
 const adminCheck = await requireAdmin(req, auth);
 if (!adminCheck.ok) return adminCheck.response;
 const admin = adminCheck.admin;
 const adminIp = getClientIp(req);

 // ── List Users ──
 if (action === "users" && req.method === "GET") {
 const users = await listUsers();
 return json({ users: users.map(adminUserView) });
 }

 // ── List ALL Lobbies (including private) ──
 if (action === "lobbies" && req.method === "GET") {
 const lobbies = await listLobbies(undefined, true);
 return json({ lobbies });
 }

 // ── Audit Log ──
 if (action === "audit" && req.method === "GET") {
 const url = new URL(req.url);
 const limit = parseInt(url.searchParams.get("limit") || "100", 10);
 const logs = await listAuditLogs(Math.min(500, limit));
 return json({ logs });
 }

 // ── User actions: /api/admin/users/:id/{ban,unban,promote,demote} ──
 if (action.startsWith("users/")) {
 const parts = action.split("/");
 if (parts.length < 3) return json({ error: "Invalid path" }, 404);
 const userId = parts[1];
 const sub = parts[2];

 const targetUser = await getUserById(userId!);
 if (!targetUser) return json({ error: "User not found" }, 404);

 if (sub === "ban" && req.method === "POST") {
 const body = await readJsonBody(req);
 const reason = (body?.reason || "").toString().slice(0, 200);
 try {
 const updated = await banUser(targetUser, admin, reason, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e: any) {
 return json({ error: e?.message || "Failed to ban user" }, 400);
 }
 }

 if (sub === "unban" && req.method === "POST") {
 try {
 const updated = await unbanUser(targetUser, admin, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e: any) {
 return json({ error: e?.message || "Failed to unban user" }, 400);
 }
 }

 if (sub === "promote" && req.method === "POST") {
 try {
 const updated = await promoteToAdmin(targetUser, admin, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e: any) {
 return json({ error: e?.message || "Failed to promote user" }, 400);
 }
 }

 if (sub === "demote" && req.method === "POST") {
 try {
 const updated = await demoteFromAdmin(targetUser, admin, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e: any) {
 return json({ error: e?.message || "Failed to demote user" }, 400);
 }
 }

 if (sub === "" && req.method === "DELETE") {
 // /api/admin/users/:id (DELETE)
 try {
 await deleteUser(targetUser, admin, adminIp);
 return json({ ok: true });
 } catch (e: any) {
 return json({ error: e?.message || "Failed to delete user" }, 400);
 }
 }
 }

 // ── Lobby actions: /api/admin/lobbies/:id/{end} ──
 if (action.startsWith("lobbies/")) {
 const parts = action.split("/");
 if (parts.length < 2) return json({ error: "Invalid path" }, 404);
 const lobbyId = parts[1];
 const sub = parts[2] || "";

 const lobby = await getLobby(lobbyId!);
 if (!lobby) return json({ error: "Lobby not found" }, 404);

 if (sub === "" && req.method === "DELETE") {
 await deleteLobby(lobbyId!);
 await auditLog({
 action: "lobby-deleted-admin",
 actorId: admin.id,
 actorName: admin.username,
 actorIp: adminIp,
 targetId: lobbyId,
 targetName: lobby.name,
 });
 return json({ ok: true });
 }

 if (sub === "end" && req.method === "POST") {
 const updated = await resetLobbyToWaiting(lobbyId!);
 await auditLog({
 action: "lobby-force-ended-admin",
 actorId: admin.id,
 actorName: admin.username,
 actorIp: adminIp,
 targetId: lobbyId,
 targetName: lobby.name,
 });
 return json({ lobby: updated });
 }
 }

 return json({ error: "Not found" }, 404);
}
