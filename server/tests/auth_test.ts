/**
 * Auth & security tests.
 *
 * Tests password hashing, username validation, password strength,
 * rate limiting logic, and CSRF token management.
 *
 * Run: deno test -A --unstable-kv server/tests/auth_test.ts
 */

import { assertEquals, assert, assertNotEquals } from "jsr:@std/assert@1.0.0";
import {
 hashPassword,
 verifyPassword,
 validateUsername,
 validatePassword,
 generateSessionToken,
} from "../auth.ts";
import {
 rateLimit,
 rateLimitLogin,
 rateLimitRegister,
 validatePasswordStrength,
 generateCSRFToken,
 validateCSRFToken,
 sanitizeString,
 sanitizeLobbyName,
 getClientIp,
} from "../security.ts";

// ─── Password Hashing ───────────────────────────────────────────────────────

Deno.test("AUTH: hashPassword produces different hashes for same password (salt)", async () => {
 const password = "MyPassword123!";
 const { hash: hash1, salt: salt1 } = await hashPassword(password);
 const { hash: hash2, salt: salt2 } = await hashPassword(password);
 assertNotEquals(hash1, hash2, "Bug! Same password produces same hash (salt not working)");
 assertNotEquals(salt1, salt2, "Bug! Same salt for same password");
});

Deno.test("AUTH: verifyPassword accepts correct password", async () => {
 const password = "CorrectPass1!";
 const { hash, salt } = await hashPassword(password);
 const ok = await verifyPassword(password, hash, salt);
 assertEquals(ok, true, "Bug! Correct password rejected");
});

Deno.test("AUTH: verifyPassword rejects wrong password", async () => {
 const password = "CorrectPass1!";
 const wrong = "WrongPass2!";
 const { hash, salt } = await hashPassword(password);
 const ok = await verifyPassword(wrong, hash, salt);
 assertEquals(ok, false, "Bug! Wrong password accepted");
});

Deno.test("AUTH: verifyPassword rejects empty password", async () => {
 const password = "SomePass1!";
 const { hash, salt } = await hashPassword(password);
 const ok = await verifyPassword("", hash, salt);
 assertEquals(ok, false, "Bug! Empty password accepted");
});

Deno.test("AUTH: verifyPassword rejects when salt is wrong", async () => {
 const password = "MyPass1!";
 const { hash, salt } = await hashPassword(password);
 const wrongSalt = "0".repeat(salt.length);
 const ok = await verifyPassword(password, hash, wrongSalt);
 assertEquals(ok, false, "Bug! Wrong salt accepted");
});

// ─── Username Validation ────────────────────────────────────────────────────

Deno.test("AUTH: Valid usernames accepted", () => {
 const valid = ["alice", "Bob_123", "user-name", "ABC", "a_b-c", "Player1"];
 for (const name of valid) {
 const result = validateUsername(name);
 assertEquals(result.ok, true, `Bug! Valid username "${name}" rejected: ${result.msg}`);
 }
});

Deno.test("AUTH: Too short username rejected", () => {
 assertEquals(validateUsername("ab").ok, false);
 assertEquals(validateUsername("a").ok, false);
 assertEquals(validateUsername("").ok, false);
});

Deno.test("AUTH: Too long username rejected", () => {
 assertEquals(validateUsername("a".repeat(17)).ok, false);
 assertEquals(validateUsername("a".repeat(100)).ok, false);
});

Deno.test("AUTH: Username with special chars rejected", () => {
 const invalid = ["user@name", "user.name", "user!", "user#name", "user name", "用户名"];
 for (const name of invalid) {
 assertEquals(validateUsername(name).ok, false, `Bug! Invalid username "${name}" accepted`);
 }
});

// ─── Password Validation ───────────────────────────────────────────────────

Deno.test("AUTH: Password too short rejected", () => {
 assertEquals(validatePassword("Short1!").ok, false);
 assertEquals(validatePassword("1234567").ok, false); // 7 chars
});

Deno.test("AUTH: Password 8+ chars accepted", () => {
 assertEquals(validatePassword("12345678").ok, true);
 assertEquals(validatePassword("LongPassword123!").ok, true);
});

Deno.test("AUTH: Password too long rejected", () => {
 assertEquals(validatePassword("a".repeat(129)).ok, false);
});

// ─── Password Strength ─────────────────────────────────────────────────────

Deno.test("SECURITY: Weak password rejected", () => {
 const weak = ["password", "12345678", "aaaaaaaa", "qwerty12"];
 for (const pw of weak) {
 const result = validatePasswordStrength(pw);
 assertEquals(result.ok, false, `Bug! Weak password "${pw}" accepted`);
 }
});

Deno.test("SECURITY: Strong password accepted", () => {
 const strong = ["MyStr0ng!Pass", "C0mpl3x#Password", "Abc123!@#xyz"];
 for (const pw of strong) {
 const result = validatePasswordStrength(pw);
 assertEquals(result.ok, true, `Bug! Strong password "${pw}" rejected: ${result.msg}`);
 }
});

// ─── Session Token ──────────────────────────────────────────────────────────

Deno.test("AUTH: generateSessionToken produces unique tokens", () => {
 const tokens = new Set<string>();
 for (let i = 0; i < 100; i++) {
 tokens.add(generateSessionToken());
 }
 assertEquals(tokens.size, 100, "Bug! Session tokens not unique");
});

Deno.test("AUTH: Session tokens are 64 hex chars (256 bits)", () => {
 const token = generateSessionToken();
 assertEquals(token.length, 64, `Bug! Token length ${token.length}, expected 64`);
 assert(/^[0-9a-f]+$/.test(token), "Bug! Token contains non-hex chars");
});

// ─── Rate Limiting ──────────────────────────────────────────────────────────

Deno.test("SECURITY: Rate limit allows under threshold", { sanitizeResources: false, sanitizeOps: false }, () => {
 // Fresh key each test
 const key = `test-under-${Math.random()}`;
 for (let i = 0; i < 5; i++) {
 const result = rateLimit(key, 10, 60000);
 assertEquals(result.ok, true, `Bug! Request ${i} blocked`);
 }
});

Deno.test("SECURITY: Rate limit blocks over threshold", { sanitizeResources: false, sanitizeOps: false }, () => {
 const key = `test-over-${Math.random()}`;
 for (let i = 0; i < 10; i++) {
 rateLimit(key, 10, 60000);
 }
 const result = rateLimit(key, 10, 60000);
 assertEquals(result.ok, false, "Bug! 11th request not blocked");
 assert(result.retryAfter > 0, "Bug! retryAfter not set");
});

Deno.test("SECURITY: Rate limit independent per key", { sanitizeResources: false, sanitizeOps: false }, () => {
 const key1 = `test-k1-${Math.random()}`;
 const key2 = `test-k2-${Math.random()}`;
 // Exhaust key1
 for (let i = 0; i < 5; i++) rateLimit(key1, 5, 60000);
 // key2 should still work
 const result = rateLimit(key2, 5, 60000);
 assertEquals(result.ok, true, "Bug! key2 blocked because of key1");
});

Deno.test("SECURITY: Login rate limit allows 10/min per IP", { sanitizeResources: false, sanitizeOps: false }, () => {
 const ip = `10.0.0.${Math.floor(Math.random() * 255)}`;
 for (let i = 0; i < 10; i++) {
 const result = rateLimitLogin(ip);
 assertEquals(result.ok, true, `Bug! Login ${i} blocked`);
 }
});

Deno.test("SECURITY: Login rate limit blocks 11th attempt", { sanitizeResources: false, sanitizeOps: false }, () => {
 const ip = `10.0.0.${Math.floor(Math.random() * 255)}`;
 for (let i = 0; i < 10; i++) rateLimitLogin(ip);
 const result = rateLimitLogin(ip);
 assertEquals(result.ok, false, "Bug! 11th login not blocked");
});

Deno.test("SECURITY: Register rate limit blocks after 5/hour", { sanitizeResources: false, sanitizeOps: false }, () => {
 const ip = `10.0.1.${Math.floor(Math.random() * 255)}`;
 for (let i = 0; i < 5; i++) {
 const result = rateLimitRegister(ip);
 assertEquals(result.ok, true, `Bug! Register ${i} blocked`);
 }
 const result = rateLimitRegister(ip);
 assertEquals(result.ok, false, "Bug! 6th register not blocked");
});

// ─── CSRF Tokens ────────────────────────────────────────────────────────────

Deno.test("SECURITY: CSRF token generated and validated", () => {
 const session = "test-session-" + Math.random();
 const token = generateCSRFToken(session);
 assert(typeof token === "string", "Bug! CSRF token not a string");
 assert(token.length > 0, "Bug! CSRF token empty");
 assertEquals(validateCSRFToken(session, token), true, "Bug! Valid CSRF token rejected");
});

Deno.test("SECURITY: CSRF token rejected for wrong session", () => {
 const session1 = "test-session-1";
 const session2 = "test-session-2";
 const token = generateCSRFToken(session1);
 assertEquals(validateCSRFToken(session2, token), false, "Bug! CSRF token accepted for wrong session");
});

Deno.test("SECURITY: CSRF token rejected for empty inputs", () => {
 assertEquals(validateCSRFToken("", "sometoken"), false, "Bug! Empty session accepted");
 assertEquals(validateCSRFToken("somesession", ""), false, "Bug! Empty token accepted");
 assertEquals(validateCSRFToken("", ""), false, "Bug! Empty both accepted");
});

Deno.test("SECURITY: CSRF token invalidated after re-generation", () => {
 const session = "test-session-regen";
 const token1 = generateCSRFToken(session);
 const token2 = generateCSRFToken(session);
 assertNotEquals(token1, token2, "Bug! Regenerated token is same");
 assertEquals(validateCSRFToken(session, token1), false, "Bug! Old token still valid after regen");
 assertEquals(validateCSRFToken(session, token2), true, "Bug! New token invalid");
});

// ─── Input Sanitization ─────────────────────────────────────────────────────

Deno.test("SECURITY: sanitizeString strips control chars", () => {
 const input = "hello\x00\x01\x02world\x7f";
 const result = sanitizeString(input);
 assertEquals(result, "helloworld", `Bug! Control chars not stripped: "${result}"`);
});

Deno.test("SECURITY: sanitizeString limits length", () => {
 const input = "a".repeat(100);
 const result = sanitizeString(input, 10);
 assertEquals(result.length, 10, `Bug! Length ${result.length}, expected 10`);
});

Deno.test("SECURITY: sanitizeString handles non-string input", () => {
 assertEquals(sanitizeString(123 as unknown), "", "Bug! Number not handled");
 assertEquals(sanitizeString(null as unknown), "", "Bug! Null not handled");
 assertEquals(sanitizeString(undefined as unknown), "", "Bug! Undefined not handled");
 assertEquals(sanitizeString({ foo: "bar" } as unknown), "", "Bug! Object not handled");
});

Deno.test("SECURITY: sanitizeLobbyName limits to 60 chars", () => {
 const long = "a".repeat(100);
 const result = sanitizeLobbyName(long);
 assertEquals(result.length, 60, `Bug! Lobby name length ${result.length}, expected 60`);
});

Deno.test("SECURITY: getClientIp extracts from X-Forwarded-For", () => {
 // M1 fix: only the LAST (proxy-added) hop is trusted; earlier entries are
 // attacker-controllable via spoofed XFF headers.
 const req = new Request("https://example.com", {
 headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
 });
 assertEquals(getClientIp(req), "5.6.7.8");
});

Deno.test("SECURITY: getClientIp prefers platform headers over XFF", () => {
 const req = new Request("https://example.com", {
 headers: {
 "fly-client-ip": "10.9.8.7",
 "cf-connecting-ip": "10.9.8.6",
 "x-forwarded-for": "1.2.3.4, 5.6.7.8",
 "x-real-ip": "9.8.7.6",
 },
 });
 assertEquals(getClientIp(req), "10.9.8.7");

 const req2 = new Request("https://example.com", {
 headers: {
 "cf-connecting-ip": "10.9.8.6",
 "x-forwarded-for": "1.2.3.4, 5.6.7.8",
 },
 });
 assertEquals(getClientIp(req2), "10.9.8.6");
});

Deno.test("SECURITY: getClientIp caps XFF parsing at 10 hops", () => {
 const many = Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}`).join(", ");
 const req = new Request("https://example.com", {
 headers: { "x-forwarded-for": many },
 });
 assertEquals(getClientIp(req), "10.0.0.30"); // last of the final 10 entries
});

Deno.test("SECURITY: getClientIp extracts from X-Real-IP", () => {
 const req = new Request("https://example.com", {
 headers: { "x-real-ip": "9.8.7.6" },
 });
 assertEquals(getClientIp(req), "9.8.7.6");
});

Deno.test("SECURITY: getClientIp returns 'unknown' when no headers", () => {
 const req = new Request("https://example.com");
 assertEquals(getClientIp(req), "unknown");
});
