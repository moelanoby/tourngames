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
import {
 listAuditLogs,
 getClientIp,
 auditLog,
 jsonResponse,
 jsonError,
 readJsonBody,
} from "./security.ts";

/** Shared success-envelope helper (same shape mod.ts uses). */
const json = jsonResponse;
import { checkCSRF } from "./auth.ts";
import { closeUserConnections } from "./signaling.ts";

/** Returns the admin user if authorized, or a Response error if not. */
async function requireAdmin(req: Request, auth: { user: User | null }): Promise<{ ok: true; admin: User & { role: "admin" } } | { ok: false; response: Response }> {
 if (!isAdmin(auth.user)) {
 return { ok: false, response: jsonError("Forbidden admin access required", 403) };
 }
 // For state-changing requests, validate CSRF
 if (req.method !== "GET") {
 if (!(await checkCSRF(req))) {
 return { ok: false, response: jsonError("Invalid CSRF token", 403) };
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
 const parsed = parseInt(url.searchParams.get("limit") || "100", 10);
 // NaN → default; clamp to [0, 500] so negatives can't hit kv.list.
 const limit = Number.isNaN(parsed) ? 100 : Math.max(0, Math.min(500, parsed));
 const logs = await listAuditLogs(limit);
 return json({ logs });
 }

 // ── User actions: /api/admin/users/:id/{ban,unban,promote,demote} and
 // ── DELETE /api/admin/users/:id. parts.length === 2 is valid for DELETE
 // (the id is the last segment; there is no trailing sub-action).
 if (action.startsWith("users/")) {
 const parts = action.split("/");
 if (parts.length < 2) return jsonError("Invalid path", 404);
 const userId = parts[1];
 const sub = parts[2] ?? "";

 const targetUser = await getUserById(userId!);
 if (!targetUser) return jsonError("User not found", 404);

 if (sub === "ban" && req.method === "POST") {
 const bodyRes = await readJsonBody(req);
 const reason = bodyRes.ok
 ? String((bodyRes.body as { reason?: unknown }).reason ?? "").slice(0, 200)
 : "";
 try {
 const updated = await banUser(targetUser, admin, reason, adminIp);
 // Drop any live WebSocket sessions: the ban must not wait for the
 // socket to close naturally before taking effect.
 const kicked = closeUserConnections(targetUser.id);
 if (kicked > 0) console.log(`[Admin] Kicked ${kicked} live session(s) of banned user ${targetUser.id}`);
 return json({ user: adminUserView(updated) });
 } catch (e) {
 const msg = e instanceof Error ? e.message : "Failed to ban user";
 return jsonError(msg, 400);
 }
 }

 if (sub === "unban" && req.method === "POST") {
 try {
 const updated = await unbanUser(targetUser, admin, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e) {
 const msg = e instanceof Error ? e.message : "Failed to unban user";
 return jsonError(msg, 400);
 }
 }

 if (sub === "promote" && req.method === "POST") {
 try {
 const updated = await promoteToAdmin(targetUser, admin, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e) {
 const msg = e instanceof Error ? e.message : "Failed to promote user";
 return jsonError(msg, 400);
 }
 }

 if (sub === "demote" && req.method === "POST") {
 try {
 const updated = await demoteFromAdmin(targetUser, admin, adminIp);
 return json({ user: adminUserView(updated) });
 } catch (e) {
 const msg = e instanceof Error ? e.message : "Failed to demote user";
 return jsonError(msg, 400);
 }
 }

 if (sub === "" && req.method === "DELETE") {
 // /api/admin/users/:id (DELETE)
 try {
 await deleteUser(targetUser, admin, adminIp);
 return json({ ok: true });
 } catch (e) {
 const msg = e instanceof Error ? e.message : "Failed to delete user";
 return jsonError(msg, 400);
 }
 }
 }

 // ── Lobby actions: /api/admin/lobbies/:id/{end} ──
 if (action.startsWith("lobbies/")) {
 const parts = action.split("/");
 if (parts.length < 2) return jsonError("Invalid path", 404);
 const lobbyId = parts[1];
 const sub = parts[2] || "";

 const lobby = await getLobby(lobbyId!);
 if (!lobby) return jsonError("Lobby not found", 404);

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

 return jsonError("Not found", 404);
}
