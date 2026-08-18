/**
 * TournGames Server Security Module
 *
 * Provides:
 * - Sliding-window rate limiting (in-memory)
 * - CSRF token generation and validation
 * - Security headers (CSP, HSTS, X-Frame-Options, etc.)
 * - Input sanitization helpers
 * - Audit logging to Deno KV
 * - Client IP extraction (behind proxy)
 */

import type { AuditEntry } from "./types.ts";

// ─── Rate Limiting (in-memory, fixed window) ────────────────────────────────

interface RateBucket {
 count: number;
 resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

// Periodic cleanup of expired buckets
let cleanupScheduled = false;
function scheduleCleanup() {
 if (cleanupScheduled) return;
 cleanupScheduled = true;
 setTimeout(() => {
 cleanupScheduled = false;
 const now = Date.now();
 for (const [key, bucket] of rateBuckets) {
 if (bucket.resetAt < now) rateBuckets.delete(key);
 }
 if (rateBuckets.size > 0) scheduleCleanup();
 }, 5 * 60 * 1000);
}

export interface RateLimitResult {
 ok: boolean;
 remaining: number;
 resetAt: number;
 retryAfter: number; // seconds until reset, for HTTP Retry-After header
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
 const now = Date.now();
 const bucket = rateBuckets.get(key);
 if (!bucket || bucket.resetAt < now) {
 const resetAt = now + windowMs;
 rateBuckets.set(key, { count: 1, resetAt });
 scheduleCleanup();
 return { ok: true, remaining: limit - 1, resetAt, retryAfter: Math.ceil(windowMs / 1000) };
 }
 if (bucket.count >= limit) {
 return { ok: false, remaining: 0, resetAt: bucket.resetAt, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
 }
 bucket.count++;
 return { ok: true, remaining: limit - bucket.count, resetAt: bucket.resetAt, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

// Convenience helpers for common rate limit policies
export function rateLimitLogin(ip: string, username?: string): RateLimitResult {
 const ipResult = rateLimit(`login:ip:${ip}`, 10, 60 * 1000); // 10/min per IP
 if (!ipResult.ok) return ipResult;
 if (username) {
 const userResult = rateLimit(`login:user:${username.toLowerCase()}`, 5, 15 * 60 * 1000); // 5 per 15min per user
 if (!userResult.ok) return userResult;
 }
 return ipResult;
}

export function rateLimitRegister(ip: string): RateLimitResult {
 return rateLimit(`register:ip:${ip}`, 5, 60 * 60 * 1000); // 5/hour per IP
}

export function rateLimitApi(ip: string): RateLimitResult {
 return rateLimit(`api:ip:${ip}`, 120, 60 * 1000); // 120/min per IP
}

export function rateLimitLobbyCreate(userId: string): RateLimitResult {
 return rateLimit(`lobby-create:user:${userId}`, 10, 60 * 1000); // 10/min per user
}

export function rateLimitSignup(userId: string): RateLimitResult {
 return rateLimit(`signup:user:${userId}`, 20, 60 * 1000); // 20/min per user
}

// ─── Client IP ───────────────────────────────────────────────────────────────

export function getClientIp(req: Request): string {
 const forwarded = req.headers.get("x-forwarded-for");
 if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
 const realIp = req.headers.get("x-real-ip");
 if (realIp) return realIp.trim();
 const cfIp = req.headers.get("cf-connecting-ip");
 if (cfIp) return cfIp.trim();
 return "unknown";
}

// ─── Security Headers ────────────────────────────────────────────────────────

export const SECURITY_HEADERS: Record<string, string> = {
 "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
 "X-Frame-Options": "DENY",
 "X-Content-Type-Options": "nosniff",
 "Referrer-Policy": "strict-origin-when-cross-origin",
 "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
 "Cross-Origin-Opener-Policy": "same-origin",
 "Cross-Origin-Resource-Policy": "same-origin",
 "X-DNS-Prefetch-Control": "off",
 "X-Download-Options": "noopen",
 "Content-Security-Policy": [
 "default-src 'self'",
 "script-src 'self' 'unsafe-inline'",
 "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
 "font-src 'self' https://fonts.gstatic.com",
 "img-src 'self' data: https:",
 "connect-src 'self' wss: ws:",
 "frame-ancestors 'none'",
 "form-action 'self'",
 "base-uri 'self'",
 "object-src 'none'",
 ].join("; "),
};

export function applySecurityHeaders(response: Response): Response {
 for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
 response.headers.set(key, value);
 }
 return response;
}

// ─── CSRF Protection ─────────────────────────────────────────────────────────
// CSRF tokens are stored in-memory, keyed by session token.
// This is sufficient because sessions are single-server (Deno Deploy isolates).

const csrfTokens = new Map<string, { token: string; expiresAt: number }>();
const CSRF_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function generateCSRFToken(sessionToken: string): string {
 // Invalidate any old token for this session
 csrfTokens.delete(sessionToken);
 const token = bufToHex(randomBytes(32));
 csrfTokens.set(sessionToken, { token, expiresAt: Date.now() + CSRF_TTL_MS });
 return token;
}

export function validateCSRFToken(sessionToken: string, csrfToken: string): boolean {
 if (!sessionToken || !csrfToken) return false;
 const entry = csrfTokens.get(sessionToken);
 if (!entry) return false;
 if (entry.expiresAt < Date.now()) {
 csrfTokens.delete(sessionToken);
 return false;
 }
 // Constant-time comparison
 if (entry.token.length !== csrfToken.length) return false;
 let diff = 0;
 for (let i = 0; i < entry.token.length; i++) {
 diff |= entry.token.charCodeAt(i) ^ csrfToken.charCodeAt(i);
 }
 return diff === 0;
}

export function revokeCSRFToken(sessionToken: string): void {
 csrfTokens.delete(sessionToken);
}

// ─── Input Sanitization ──────────────────────────────────────────────────────

export function sanitizeString(str: unknown, maxLen = 1000): string {
 if (typeof str !== "string") return "";
 return str
 .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
 .slice(0, maxLen)
 .trim();
}

export function sanitizeLobbyName(str: unknown): string {
 return sanitizeString(str, 60);
}

// ─── Profanity Filter (server-side) ──────────────────────────────────────────
// Uses the `bad-words` npm package (always-updated word list from
// badwords-list, maintained on npm) combined with our custom leetspeak
// normalizer for extra coverage.
//
// The bad-words package is updated independently on npm, so new profanity
// is automatically picked up when Deno fetches the latest version.

let _badWordsFilter: any = null;
async function getBadWordsFilter() {
 if (_badWordsFilter) return _badWordsFilter;
 try {
 const Filter = (await import("npm:bad-words@3.0.0")).default;
 _badWordsFilter = new Filter();
 } catch (e) {
 console.warn("[Security] Failed to load bad-words filter:", e);
 _badWordsFilter = null;
 }
 return _badWordsFilter;
}

// Custom leetspeak normalizer (catches what bad-words misses)
// Maps leet chars to their possible letter equivalents
const LEET_MAP: Record<string, string> = {
 '4': 'a', '@': 'a', '8': 'b', '(': 'c', '<': 'c', '[': 'c', '{': 'c',
 '3': 'e', '!': 'i', '1': 'i', '|': 'i', '0': 'o', '$': 's', '5': 's',
 'z': 's', '7': 't', '+': 't', '9': 'g', '6': 'g',
 '`': 't', '\'': '', '"': '',
};

const CUSTOM_BANNED_ROOTS = [
 'fuck', 'shit', 'piss', 'cunt', 'cock', 'dick', 'ass', 'bitch', 'whore', 'slut',
 'nigger', 'nigga', 'niggy', 'nigguh', 'nigg', 'nigr', 'nigra',
 'fag', 'faggot', 'retard', 'kike', 'chink', 'spic', 'gook',
 'cum', 'jizz', 'rape', 'pedo', 'pedophile', 'nazi', 'hitler', 'kkk',
 'bastard', 'bollocks', 'bugger', 'crap', 'damn', 'dildo', 'dyke',
 'felch', 'homo', 'horny', 'jerk', 'masturbate', 'muff', 'nob',
 'orgasm', 'penis', 'phallus', 'porn', 'prick', 'pube', 'pussy', 'queer',
 'rimjob', 'scrotum', 'sex', 'shemale', 'skank', 'snatch', 'sodomy', 'spunk',
 'suck', 'tard', 'testicle', 'tit', 'tits', 'twat', 'vagina', 'wank', 'wanker',
];

/**
 * Generate all possible normalizations of a string by replacing leet chars
 * with their letter equivalents. This catches "f4ck" → "fuck" even though
 * 4→a (giving "fack"), because we also try 4→u (common substitution).
 */
function normalizeLeet(text: string): string {
 let out = "";
 for (const ch of text.toLowerCase()) {
 const mapped = LEET_MAP[ch];
 if (mapped) out += mapped;
 else if (/[a-z0-9]/.test(ch)) out += ch;
 }
 return out;
}

/**
 * Additional leet substitutions to try (vowel swaps and common patterns).
 * "f4ck" → try "fuck" (4→u), "fack" (4→a), "feck" (4→e), etc.
 */
const VOWEL_SUBS: Record<string, string[]> = {
 'a': ['a', 'u', 'e', 'o'],
 '4': ['a', 'u', 'e', 'o'],
 '@': ['a', 'u', 'e', 'o'],
 '3': ['e', 'i'],
 '1': ['i', 'l', '1'],
 '0': ['o', '0'],
 '5': ['s', '5'],
 '7': ['t', '7'],
 '$': ['s', '$'],
};

function checkProfaneVariants(text: string): boolean {
 const lower = text.toLowerCase();
 // Check the original text
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (lower.includes(root)) return true;
 }
 // Check the basic leet normalization
 const normalized = normalizeLeet(text);
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (normalized.includes(root)) return true;
 }
 // Check vowel-substituted versions (catches f4ck→fuck, sh1t→shit, etc.)
 // We do this by replacing each leet char with each possible vowel
 // and checking if any banned root appears.
 // Optimization: only do this if the text contains leet chars
 const hasLeet = /[4@310$57!|]/i.test(text);
 if (!hasLeet) return false;

 // Generate variations by replacing leet chars with vowels
 const variations = generateVariations(lower);
 for (const variation of variations) {
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (variation.includes(root)) return true;
 }
 }
 return false;
}

function generateVariations(text: string): string[] {
 const results: string[] = [text];
 const leetChars = Array.from(text).filter((c) => VOWEL_SUBS[c]);
 if (leetChars.length === 0) return results;

 // For each leet char position, try all substitutions
 // Limit to avoid combinatorial explosion (max 3 leet chars)
 const positions: number[] = [];
 for (let i = 0; i < text.length; i++) {
 const ch = text[i];
 if (ch && VOWEL_SUBS[ch]) positions.push(i);
 }
 if (positions.length > 3) return [text, normalizeLeet(text)];

 // Generate all combinations
 const chars = text.split("");
 function generate(idx: number, current: string[]) {
 if (idx >= positions.length) {
 results.push(current.join(""));
 return;
 }
 const pos = positions[idx]!;
 const orig = text[pos]!;
 const subs = VOWEL_SUBS[orig] || [orig];
 for (const sub of subs) {
 current[pos] = sub;
 generate(idx + 1, current);
 }
 }
 generate(0, [...chars]);
 return results;
}

// ─── Smart Profanity Detection (word splitting + noise removal + reordering) ──

/**
 * Smart algorithm that catches disguised profanity by:
 *
 * 1. Noise removal: strips spaces, dots, dashes, underscores, etc.
 * "f u c k" → "fuck", "s.h.i.t" → "shit", "f_u_c_k" → "fuck"
 *
 * 2. Word splitting: splits on non-alphanumeric, checks each segment
 * "hello shit world" → checks "hello", "shit", "world" individually
 *
 * 3. Segment reordering: tries concatenating adjacent segments in
 * different orders to catch "fu ck" → "fuck" or "ck fu" → "fuck"
 * (catches people who split words to dodge filters)
 *
 * 4. Sliding window: checks all substrings of the noise-stripped text
 * to catch profanity embedded in longer strings like "xshitx"
 *
 * 5. Entropy-based detection: if a string has high entropy (gibberish
 * like "gshhgsgghsggniggygahsgha"), slides a window through it
 * looking for banned roots embedded in the noise.
 * If low entropy (actual words), splits into sections and matches.
 */

/**
 * Calculate Shannon entropy of a string.
 * High entropy (> 3.0) = random-looking gibberish → use letter-level sliding window
 * Low entropy (≤ 3.0) = actual words → use word splitting
 */
function shannonEntropy(text: string): number {
 const lower = text.toLowerCase().replace(/[^a-z0-9]/g, "");
 if (lower.length < 2) return 0;
 const freq: Record<string, number> = {};
 for (const ch of lower) {
 freq[ch] = (freq[ch] || 0) + 1;
 }
 let entropy = 0;
 for (const count of Object.values(freq)) {
 const p = count / lower.length;
 entropy -= p * Math.log2(p);
 }
 return entropy;
}

/**
 * High-entropy sliding window search.
 * For gibberish strings like "gshhgsgghsggniggygahsgha", we slide a
 * window of length 3-8 through the text and check every substring
 * against banned roots. This catches slurs embedded in noise.
 */
function slidingWindowSearch(text: string): boolean {
 const stripped = text.toLowerCase().replace(/[^a-z0-9]/g, "");
 if (stripped.length < 3) return false;

 // Also check the leet-normalized version
 const normalized = normalizeLeet(stripped);

 // Check all substrings of length 3 to 8 (covers all banned roots)
 for (let len = 3; len <= Math.min(8, stripped.length); len++) {
 for (let i = 0; i <= stripped.length - len; i++) {
 const substr = stripped.slice(i, i + len);
 const normSubstr = normalized.slice(i, i + len);

 for (const root of CUSTOM_BANNED_ROOTS) {
 if (root.length === len) {
 if (substr === root || normSubstr === root) return true;
 }
 }
 }
 }

 // Also try vowel substitution on suspicious substrings
 const hasLeet = /[4@310$57!|]/i.test(stripped);
 if (hasLeet) {
 for (let len = 3; len <= Math.min(8, normalized.length); len++) {
 for (let i = 0; i <= normalized.length - len; i++) {
 const substr = normalized.slice(i, i + len);
 const variations = generateVariations(substr);
 for (const variation of variations) {
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (root.length === len && variation === root) return true;
 }
 }
 }
 }
 }

 return false;
}

/**
 * Remove all noise (non-alphanumeric) characters from text.
 * "f u c k" → "fuck", "s.h.i.t" → "shit"
 */
function stripNoise(text: string): string {
 return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Split text into alphanumeric segments (words).
 * "hello shit world" → ["hello", "shit", "world"]
 * "f.u.c.k" → ["f", "u", "c", "k"]
 */
function splitSegments(text: string): string[] {
 return text.toLowerCase().split(/[^a-z0-9]+/).filter((s) => s.length > 0);
}

/**
 * Check if any banned root appears as a substring in the given text.
 * Also applies leetspeak normalization and vowel substitution.
 */
function containsBannedRoot(text: string): boolean {
 const lower = text.toLowerCase();
 const normalized = normalizeLeet(text);

 // Direct check
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (lower.includes(root) || normalized.includes(root)) return true;
 }

 // Vowel substitution check (only if leet chars present)
 const hasLeet = /[4@310$57!|]/i.test(text);
 if (hasLeet) {
 const variations = generateVariations(lower);
 for (const variation of variations) {
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (variation.includes(root)) return true;
 }
 }
 }
 return false;
}

/**
 * Smart profanity check using word splitting, noise removal, reordering,
 * and entropy-based sliding window detection.
 */
function checkSmartProfanity(text: string): boolean {
 if (!text || text.length < 2) return false;

 // ── 1. Direct check on original text ──
 if (containsBannedRoot(text)) return true;

 // ── 2. Noise-stripped check (catches "f u c k", "s.h.i.t") ──
 const stripped = stripNoise(text);
 if (stripped.length >= 2 && stripped !== text.toLowerCase()) {
 if (containsBannedRoot(stripped)) return true;
 }

 // ── 3. Entropy-based detection ──
 // High entropy (gibberish like "gshhgsgghsggniggygahsgha") →
 // slide a window through looking for banned roots in the noise
 // Low entropy (actual words like "hello shit world") →
 // split into segments and check each
 const entropy = shannonEntropy(stripped);
 const isHighEntropy = entropy > 3.0 && stripped.length >= 8;

 if (isHighEntropy) {
 // High entropy: use sliding window to find slurs embedded in gibberish
 if (slidingWindowSearch(stripped)) return true;
 } else {
 // Low entropy: split into word segments
 const segments = splitSegments(text);

 // ── 3a. Per-segment check (catches "hello shit world") ──
 for (const seg of segments) {
 if (containsBannedRoot(seg)) return true;
 }

 // ── 3b. Adjacent segment reordering (catches "fu ck", "sh it") ──
 for (let i = 0; i < segments.length - 1; i++) {
 const pair = segments[i] + segments[i + 1]!;
 if (containsBannedRoot(pair)) return true;
 const revPair = segments[i + 1]! + segments[i]!;
 if (containsBannedRoot(revPair)) return true;

 if (i < segments.length - 2) {
 const triple = segments[i] + segments[i + 1]! + segments[i + 2]!;
 if (containsBannedRoot(triple)) return true;
 }
 }
 }

 // ── 4. Sliding window on stripped text (catches "xshitx", "gshhgsgghsggniggygahsgha") ──
 // This runs for ALL text (both high and low entropy) as a catch-all
 if (stripped.length >= 4) {
 if (slidingWindowSearch(stripped)) return true;
 }

 return false;
}

/**
 * Check if text contains profanity. Uses multiple layers:
 * 1. bad-words npm package (always-updated word list)
 * 2. Leetspeak normalization + vowel substitution
 * 3. Smart algorithm: word splitting, noise removal, segment reordering
 */
export async function isProfane(text: string): Promise<boolean> {
 if (!text || text.length < 2) return false;

 // 1. Check with bad-words npm package (always-updated word list)
 const filter = await getBadWordsFilter();
 if (filter) {
 try {
 if (filter.isProfane(text)) return true;
 } catch { /* ignore */ }
 }

 // 2. Check with our custom leetspeak-aware filter (catches f4ck, sh1t, etc.)
 if (checkProfaneVariants(text)) return true;

 // 3. Check with smart algorithm (catches "f u c k", "fu ck", "s.h.i.t")
 return checkSmartProfanity(text);
}

/**
 * Sanitize text by replacing profane words with asterisks.
 * Returns the cleaned text.
 */
export async function cleanProfanity(text: string): Promise<string> {
 if (!text) return text;
 const filter = await getBadWordsFilter();
 if (filter) {
 try {
 return filter.clean(text);
 } catch { /* fall through */ }
 }
 // Fallback: just check custom roots
 let cleaned = text;
 const normalized = normalizeLeet(text);
 for (const root of CUSTOM_BANNED_ROOTS) {
 if (normalized.includes(root)) {
 const re = new RegExp(root, "gi");
 cleaned = cleaned.replace(re, "*".repeat(root.length));
 }
 }
 return cleaned;
}

// ─── Audit Logging ───────────────────────────────────────────────────────────

const kv = await Deno.openKv();

export async function auditLog(opts: {
 action: string;
 actorId?: string | null;
 actorName?: string;
 actorIp?: string;
 targetId?: string | null;
 targetName?: string | null;
 details?: string | null;
}): Promise<void> {
 const entry: AuditEntry = {
 id: crypto.randomUUID(),
 action: opts.action,
 actorId: opts.actorId || null,
 actorName: opts.actorName || "anonymous",
 actorIp: opts.actorIp || "unknown",
 targetId: opts.targetId || null,
 targetName: opts.targetName || null,
 details: opts.details || null,
 timestamp: Date.now(),
 };
 await kv.set(["audit", entry.timestamp, entry.id], entry);
}

export async function listAuditLogs(limit = 100): Promise<AuditEntry[]> {
 const out: AuditEntry[] = [];
 for await (const entry of kv.list<AuditEntry>({ prefix: ["audit"] }, { reverse: true, limit })) {
 if (entry.value) out.push(entry.value);
 }
 return out;
}

// ─── Crypto Helpers ──────────────────────────────────────────────────────────

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
 const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
 return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(n: number): Uint8Array {
 const bytes = new Uint8Array(n);
 crypto.getRandomValues(bytes);
 return bytes;
}

// ─── Password Strength Validation ────────────────────────────────────────────

export function validatePasswordStrength(pw: string): { ok: boolean; score: number; msg?: string } {
 if (pw.length < 8) return { ok: false, score: 0, msg: "Password must be at least 8 characters" };
 if (pw.length > 128) return { ok: false, score: 0, msg: "Password too long" };

 // Reject common weak passwords (even if they pass the score check)
 const COMMON_WEAK = [
 "password", "12345678", "123456789", "qwerty12", "qwerty123",
 "abc12345", "password1", "iloveyou", "letmein1", "admin123",
 "welcome1", "monkey12", "dragon12", "master12", "sunshine1",
 ];
 if (COMMON_WEAK.includes(pw.toLowerCase())) {
 return { ok: false, score: 0, msg: "Password is too common choose something unique" };
 }

 // Reject sequential chars (abcd1234, 12345678, qwertyui)
 if (/^(?:abcdefghijklmnopqrstuvwxyz|12345678|qwertyui|asdfghjk|zxcvbnm)/i.test(pw)) {
 return { ok: false, score: 0, msg: "Password contains common sequence" };
 }

 let score = 0;
 if (pw.length >= 12) score++;
 if (/[a-z]/.test(pw)) score++;
 if (/[A-Z]/.test(pw)) score++;
 if (/[0-9]/.test(pw)) score++;
 if (/[^a-zA-Z0-9]/.test(pw)) score++;

 // Reject weak passwords (need at least 3 of: long, lowercase, uppercase, digit, symbol)
 if (score < 3) {
 return { ok: false, score, msg: "Password too weak add uppercase, numbers, or symbols" };
 }
 return { ok: true, score };
}
