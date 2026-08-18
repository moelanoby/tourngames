/**
 * TournGames Server Auth Module
 *
 * Handles user registration, login, sessions, password hashing,
 * account lockout, banning, and admin role management.
 *
 * Security features:
 * - PBKDF2 password hashing (100k iterations, SHA-256)
 * - Account lockout after 5 failed login attempts (15 min)
 * - Banned users cannot log in or create/join lobbies
 * - First registered user becomes admin
 * - CSRF token bound to each session
 * - Session cookies: HttpOnly, SameSite=Strict
 */

import type { User, Session, AuthState, UserRole } from "./types.ts";
import { generateCSRFToken, auditLog } from "./security.ts";

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const TOKEN_LENGTH = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = "tgn_session";
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// ─── Crypto Utilities ────────────────────────────────────────────────────────

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
 const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
 return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
 const bytes = new Uint8Array(hex.length / 2);
 for (let i = 0; i < hex.length; i += 2) {
 bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
 }
 return bytes;
}

function randomBytes(n: number): Uint8Array {
 const bytes = new Uint8Array(n);
 crypto.getRandomValues(bytes);
 return bytes;
}

async function pbkdf2Hash(password: string, salt: Uint8Array): Promise<string> {
 const enc = new TextEncoder();
 const keyMaterial = await crypto.subtle.importKey(
 "raw",
 enc.encode(password),
 { name: "PBKDF2" },
 false,
 ["deriveBits"],
 );
 const bits = await crypto.subtle.deriveBits(
 {
 name: "PBKDF2",
 salt: salt as BufferSource,
 iterations: PBKDF2_ITERATIONS,
 hash: "SHA-256",
 },
 keyMaterial,
 256,
 );
 return bufToHex(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
 const salt = randomBytes(SALT_LENGTH);
 const hash = await pbkdf2Hash(password, salt);
 return { hash, salt: bufToHex(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
 const saltBytes = hexToBuf(salt);
 const computedHash = await pbkdf2Hash(password, saltBytes);
 // Constant-time comparison
 if (computedHash.length !== hash.length) return false;
 let diff = 0;
 for (let i = 0; i < computedHash.length; i++) {
 diff |= computedHash.charCodeAt(i) ^ hash.charCodeAt(i);
 }
 return diff === 0;
}

export function generateSessionToken(): string {
 return bufToHex(randomBytes(TOKEN_LENGTH));
}

// ─── User Storage ────────────────────────────────────────────────────────────

const kv = await Deno.openKv();

export async function createUser(username: string, password: string, actorIp = "unknown"): Promise<User> {
 const usernameLower = username.toLowerCase().trim();

 // Check if username is taken (atomic check)
 const existingKey = ["user-username", usernameLower];
 const existing = await kv.get<User>(existingKey);
 if (existing.value) {
 throw new Error("Username already taken");
 }

 // Check if this is the first user (becomes admin)
 const initKey = ["system", "initialized"];
 const initialized = await kv.get<boolean>(initKey);
 const isFirstUser = !initialized.value;

 const userId = crypto.randomUUID();
 const { hash, salt } = await hashPassword(password);

 const user: User = {
 id: userId,
 username: username.trim(),
 usernameLower,
 passwordHash: hash,
 passwordSalt: salt,
 createdAt: Date.now(),
 wins: 0,
 matchesPlayed: 0,
 role: isFirstUser ? "admin" : "user",
 banned: false,
 bannedAt: null,
 bannedReason: null,
 bannedBy: null,
 failedLoginAttempts: 0,
 lockedUntil: null,
 lastLoginAt: null,
 lastLoginIp: null,
 };

 // Atomic insert: only succeeds if username still free
 const res = await kv.atomic()
 .check(existing)
 .set(["user", userId], user)
 .set(existingKey, userId)
 .commit();

 if (!res.ok) {
 throw new Error("Username already taken (race)");
 }

 // Mark system as initialized
 if (isFirstUser) {
 await kv.set(initKey, true);
 await auditLog({
 action: "first-admin-created",
 actorId: userId,
 actorName: user.username,
 actorIp,
 details: "First user registered automatically granted admin role",
 });
 }

 await auditLog({
 action: "user-registered",
 actorId: userId,
 actorName: user.username,
 actorIp,
 });

 return user;
}

export async function getUserById(userId: string): Promise<User | null> {
 const res = await kv.get<User>(["user", userId]);
 return res.value || null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
 const usernameLower = username.toLowerCase().trim();
 const idRes = await kv.get<string>(["user-username", usernameLower]);
 if (!idRes.value) return null;
 return getUserById(idRes.value);
}

export async function listUsers(limit = 100): Promise<User[]> {
 const out: User[] = [];
 for await (const entry of kv.list<User>({ prefix: ["user"] }, { limit })) {
 // Only include entries where key is exactly ["user", userId]
 // (skip ["user-username", ...] which also matches the prefix)
 if (entry.value && entry.key[0] === "user" && entry.key.length === 2) {
 out.push(entry.value);
 }
 }
 return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function recordUserWin(userId: string): Promise<void> {
 const user = await getUserById(userId);
 if (!user) return;
 user.wins = (user.wins || 0) + 1;
 user.matchesPlayed = (user.matchesPlayed || 0) + 1;
 await kv.set(["user", userId], user);
}

export async function recordUserMatch(userId: string): Promise<void> {
 const user = await getUserById(userId);
 if (!user) return;
 user.matchesPlayed = (user.matchesPlayed || 0) + 1;
 await kv.set(["user", userId], user);
}

// ─── Account Lockout ─────────────────────────────────────────────────────────

export function isAccountLocked(user: User): boolean {
 if (!user.lockedUntil) return false;
 if (user.lockedUntil < Date.now()) {
 // Lock expired reset (will be persisted on next login attempt)
 return false;
 }
 return true;
}

export function getLockoutRemaining(user: User): number {
 if (!user.lockedUntil) return 0;
 return Math.max(0, user.lockedUntil - Date.now());
}

export async function recordFailedLogin(user: User): Promise<User> {
 user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
 if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
 user.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
 }
 await kv.set(["user", user.id], user);
 return user;
}

export async function recordSuccessfulLogin(user: User, ip: string): Promise<User> {
 user.failedLoginAttempts = 0;
 user.lockedUntil = null;
 user.lastLoginAt = Date.now();
 user.lastLoginIp = ip;
 await kv.set(["user", user.id], user);
 return user;
}

// ─── Ban Management ──────────────────────────────────────────────────────────

export async function banUser(
 targetUser: User,
 adminUser: User,
 reason: string,
 adminIp: string,
): Promise<User> {
 if (targetUser.role === "admin") {
 throw new Error("Cannot ban an admin demote first");
 }
 targetUser.banned = true;
 targetUser.bannedAt = Date.now();
 targetUser.bannedReason = reason || "No reason provided";
 targetUser.bannedBy = adminUser.id;
 await kv.set(["user", targetUser.id], targetUser);

 await auditLog({
 action: "user-banned",
 actorId: adminUser.id,
 actorName: adminUser.username,
 actorIp: adminIp,
 targetId: targetUser.id,
 targetName: targetUser.username,
 details: reason,
 });

 // Revoke all sessions for this user
 await revokeAllUserSessions(targetUser.id);

 return targetUser;
}

export async function unbanUser(
 targetUser: User,
 adminUser: User,
 adminIp: string,
): Promise<User> {
 targetUser.banned = false;
 targetUser.bannedAt = null;
 targetUser.bannedReason = null;
 targetUser.bannedBy = null;
 targetUser.failedLoginAttempts = 0;
 targetUser.lockedUntil = null;
 await kv.set(["user", targetUser.id], targetUser);

 await auditLog({
 action: "user-unbanned",
 actorId: adminUser.id,
 actorName: adminUser.username,
 actorIp: adminIp,
 targetId: targetUser.id,
 targetName: targetUser.username,
 });

 return targetUser;
}

export async function promoteToAdmin(
 targetUser: User,
 adminUser: User,
 adminIp: string,
): Promise<User> {
 targetUser.role = "admin";
 await kv.set(["user", targetUser.id], targetUser);

 await auditLog({
 action: "user-promoted-admin",
 actorId: adminUser.id,
 actorName: adminUser.username,
 actorIp: adminIp,
 targetId: targetUser.id,
 targetName: targetUser.username,
 });

 return targetUser;
}

export async function demoteFromAdmin(
 targetUser: User,
 adminUser: User,
 adminIp: string,
): Promise<User> {
 if (targetUser.id === adminUser.id) {
 throw new Error("Cannot demote yourself");
 }
 targetUser.role = "user";
 await kv.set(["user", targetUser.id], targetUser);

 await auditLog({
 action: "user-demoted-admin",
 actorId: adminUser.id,
 actorName: adminUser.username,
 actorIp: adminIp,
 targetId: targetUser.id,
 targetName: targetUser.username,
 });

 return targetUser;
}

export async function deleteUser(
 targetUser: User,
 adminUser: User,
 adminIp: string,
): Promise<void> {
 if (targetUser.id === adminUser.id) {
 throw new Error("Cannot delete yourself");
 }
 if (targetUser.role === "admin") {
 throw new Error("Cannot delete an admin demote first");
 }
 await kv.delete(["user", targetUser.id]);
 await kv.delete(["user-username", targetUser.usernameLower]);
 await revokeAllUserSessions(targetUser.id);

 await auditLog({
 action: "user-deleted",
 actorId: adminUser.id,
 actorName: adminUser.username,
 actorIp: adminIp,
 targetId: targetUser.id,
 targetName: targetUser.username,
 });
}

// ─── Session Storage ─────────────────────────────────────────────────────────

// Track sessions per user (for revocation on ban/delete)
const userSessions = new Map<string, Set<string>>(); // userId -> Set<sessionToken>

export async function createSession(userId: string): Promise<Session> {
 const token = generateSessionToken();
 const csrfToken = generateCSRFToken(token);
 const session: Session = {
 token,
 userId,
 csrfToken,
 expiresAt: Date.now() + SESSION_TTL_MS,
 createdAt: Date.now(),
 };
 await kv.set(["session", token], session);
 await kv.set(["session-user", userId, token], true); // for revocation

 // Track in memory
 if (!userSessions.has(userId)) userSessions.set(userId, new Set());
 userSessions.get(userId)!.add(token);

 return session;
}

export async function getSession(token: string): Promise<Session | null> {
 if (!token) return null;
 const res = await kv.get<Session>(["session", token]);
 if (!res.value) return null;
 if (res.value.expiresAt < Date.now()) {
 await kv.delete(["session", token]);
 await kv.delete(["session-user", res.value.userId, token]);
 return null;
 }
 return res.value;
}

export async function deleteSession(token: string): Promise<void> {
 if (!token) return;
 const session = await getSession(token);
 if (session) {
 await kv.delete(["session-user", session.userId, token]);
 userSessions.get(session.userId)?.delete(token);
 }
 await kv.delete(["session", token]);
}

async function revokeAllUserSessions(userId: string): Promise<void> {
 // KV-based revocation
 for await (const entry of kv.list({ prefix: ["session-user", userId] })) {
 const token = entry.key[2] as string;
 await kv.delete(["session", token]);
 await kv.delete(entry.key);
 }
 // In-memory tracking
 userSessions.get(userId)?.clear();
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

export function parseCookies(cookieHeader: string | null): Record<string, string> {
 const out: Record<string, string> = {};
 if (!cookieHeader) return out;
 for (const part of cookieHeader.split(";")) {
 const idx = part.indexOf("=");
 if (idx === -1) continue;
 const key = part.slice(0, idx).trim();
 const val = part.slice(idx + 1).trim();
 out[key] = val;
 }
 return out;
}

export function setSessionCookie(token: string): string {
 return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${isSecureContext() ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
 return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecureContext() ? "; Secure" : ""}`;
}

function isSecureContext(): boolean {
 // On Deno Deploy (https) we want Secure flag; locally (http) we don't
 return Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
}

export function getCookieName(): string {
 return COOKIE_NAME;
}

export async function getAuthState(req: Request): Promise<AuthState> {
 const cookies = parseCookies(req.headers.get("cookie"));
 const token = cookies[COOKIE_NAME];
 if (!token) return { user: null };
 const session = await getSession(token);
 if (!session) return { user: null };
 const user = await getUserById(session.userId);
 if (!user) return { user: null };
 // Backward compat: migrate old users to have role/banned fields
 if (!user.role) user.role = "user";
 if (user.banned === undefined) user.banned = false;
 // If user was banned after session was created, invalidate session
 if (user.banned) {
 await deleteSession(token);
 return { user: null };
 }
 return { user };
}

// ─── Username & Password Validation ──────────────────────────────────────────

const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;

export function validateUsername(name: string): { ok: boolean; msg?: string } {
 const trimmed = name.trim();
 if (trimmed.length < 3) return { ok: false, msg: "Username must be at least 3 characters" };
 if (trimmed.length > 16) return { ok: false, msg: "Username must be at most 16 characters" };
 if (!USERNAME_RE.test(trimmed)) return { ok: false, msg: "Only letters, numbers, _ and - allowed" };
 return { ok: true };
}

export function validatePassword(pw: string): { ok: boolean; msg?: string } {
 if (pw.length < 8) return { ok: false, msg: "Password must be at least 8 characters" };
 if (pw.length > 128) return { ok: false, msg: "Password too long" };
 return { ok: true };
}

export function isAdmin(user: User | null): user is User & { role: "admin" } {
 return !!user && (user.role === "admin");
}

// ─── Public User View (no secrets) ───────────────────────────────────────────

export function publicUser(u: User) {
 // Handle old users that may not have all fields (backward compat)
 return {
 id: u.id,
 username: u.username,
 createdAt: u.createdAt,
 wins: u.wins || 0,
 matchesPlayed: u.matchesPlayed || 0,
 role: u.role || "user",
 banned: u.banned || false,
 bannedReason: u.bannedReason || null,
 };
}

export function adminUserView(u: User) {
 return {
 ...publicUser(u),
 bannedAt: u.bannedAt || null,
 bannedBy: u.bannedBy || null,
 failedLoginAttempts: u.failedLoginAttempts || 0,
 lockedUntil: u.lockedUntil || null,
 lastLoginAt: u.lastLoginAt || null,
 lastLoginIp: u.lastLoginIp || null,
 };
}
