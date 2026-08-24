/**
 * TournGames Server Security Module
 *
 * Provides:
 * - Sliding-window rate limiting (in-memory)
 * - CSRF token generation and validation
 * - Security headers (CSP, HSTS, X-Frame-Options, etc.)
 * - Input sanitization helpers
 * - Shared HTTP response/body helpers (JSON envelope, capped body reader)
 * - Cookie parsing
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

// Memory-growth guard: spoofed XFF headers used to be able to mint unlimited
// unique bucket keys. Cap the map and evict when it grows past the limit.
const MAX_RATE_BUCKETS = 10000;

function capRateBuckets(now: number): void {
 if (rateBuckets.size <= MAX_RATE_BUCKETS) return;
 // First drop expired entries.
 for (const [key, bucket] of rateBuckets) {
 if (bucket.resetAt < now) rateBuckets.delete(key);
 }
 if (rateBuckets.size > MAX_RATE_BUCKETS) {
 // Map preserves insertion order, so the first half is the oldest.
 const keys = [...rateBuckets.keys()];
 for (let i = 0; i < Math.floor(keys.length / 2); i++) {
 rateBuckets.delete(keys[i]!);
 }
 }
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
 const now = Date.now();
 capRateBuckets(now);
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

/**
 * Extract the best-guess client IP.
 *
 * Trust order:
 * 1. Platform-injected headers (Fly-Client-Ip, CF-Connecting-IP) — set by the
 * edge proxy from the actual socket peer, not client-supplied.
 * 2. The LAST entry of X-Forwarded-For — the hop appended by our own trusted
 * proxy. Earlier entries are attacker-controlled (a spoofed XFF header is
 * preserved as-is by append-style proxies). Parsing is capped at 10 entries
 * so absurdly long headers cannot burn CPU/memory.
 * 3. X-Real-IP (commonly set by nginx from $remote_addr).
 */
export function getClientIp(req: Request): string {
 const flyIp = req.headers.get("fly-client-ip");
 if (flyIp) return flyIp.trim();
 const cfIp = req.headers.get("cf-connecting-ip");
 if (cfIp) return cfIp.trim();
 const forwarded = req.headers.get("x-forwarded-for");
 if (forwarded) {
 const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean).slice(-10);
 const last = hops[hops.length - 1];
 if (last) return last;
 }
 const realIp = req.headers.get("x-real-ip");
 if (realIp) return realIp.trim();
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
 "connect-src 'self'",
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

// ─── Shared HTTP Helpers ─────────────────────────────────────────────────────

/** Single JSON response envelope used by every API handler. */
export function jsonResponse(
 data: unknown,
 status = 200,
 extraHeaders?: Record<string, string>,
): Response {
 const headers: Record<string, string> = {
 "Content-Type": "application/json; charset=utf-8",
 "Cache-Control": "no-store",
 };
 if (extraHeaders) Object.assign(headers, extraHeaders);
 return applySecurityHeaders(new Response(JSON.stringify(data), { status, headers }));
}

/** Consistent error envelope: { error: "<message>" } with the given status. */
export function jsonError(
 message: string,
 status = 400,
 extraHeaders?: Record<string, string>,
): Response {
 return jsonResponse({ error: message }, status, extraHeaders);
}

/** Parse a raw Cookie header into a key/value map (strict split on first '='). */
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

/** Default cap for JSON request bodies (64 KB covers every legit API payload). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export type JsonBodyResult =
 | { ok: true; body: Record<string, unknown> }
 | { ok: false; reason: "invalid-json" | "too-large" };

/**
 * Read and parse a JSON request body with a hard size cap.
 *
 * Returns a discriminated result instead of throwing so handlers can answer
 * 400 (invalid) or 413 (oversized) without leaking internals. Oversize is
 * checked both on Content-Length (fast path) and on the actual bytes read,
 * so chunked requests cannot bypass the cap.
 */
export async function readJsonBody(
 req: Request,
 maxBytes = MAX_JSON_BODY_BYTES,
): Promise<JsonBodyResult> {
 const contentLength = Number(req.headers.get("content-length") || "0");
 if (Number.isFinite(contentLength) && contentLength > maxBytes) {
 return { ok: false, reason: "too-large" };
 }
 let text: string;
 try {
 text = await req.text();
 } catch {
 return { ok: false, reason: "invalid-json" };
 }
 if (new TextEncoder().encode(text).length > maxBytes) {
 return { ok: false, reason: "too-large" };
 }
 try {
 const parsed = JSON.parse(text);
 if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
 return { ok: false, reason: "invalid-json" };
 }
 return { ok: true, body: parsed as Record<string, unknown> };
 } catch {
 return { ok: false, reason: "invalid-json" };
 }
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

/**
 * Constant-time CSRF token comparison for callers that already hold the
 * session's expected token (e.g. the KV-backed `session.csrfToken` persisted
 * at session creation). Unlike {@link validateCSRFToken}, this does not depend
 * on the per-isolate in-memory Map, so it works across restarts and on
 * multi-isolate deployments.
 */
export function csrfMatches(received: string | null | undefined, expected: string | null | undefined): boolean {
 if (!received || !expected) return false;
 // Length pre-check leaks nothing: tokens are fixed-length hex.
 if (expected.length !== received.length) return false;
 let diff = 0;
 for (let i = 0; i < expected.length; i++) {
 diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
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
 // deno-lint-ignore no-control-regex -- sanitization IS the removal of control chars
 .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
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

interface BadWordsFilter {
 isProfane(text: string): boolean;
 clean(text: string): string;
}

let _badWordsFilter: BadWordsFilter | null = null;
async function getBadWordsFilter(): Promise<BadWordsFilter | null> {
 if (_badWordsFilter) return _badWordsFilter;
 try {
 const Filter = (await import("npm:bad-words@3.0.0")).default;
 _badWordsFilter = new Filter() as BadWordsFilter;
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
