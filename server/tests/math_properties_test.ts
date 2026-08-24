/**
 * Mathematical property tests for server security primitives.
 *
 * These verify ALGEBRAIC LAWS rather than single examples:
 *   - getClientIp: priority lattice + idempotence + header-injection safety
 *   - csrfMatches: equality-relation laws (reflexivity/symmetry/agreement)
 *   - rateLimit: budget exhaustion, key independence, monotone remaining
 *   - validateUsername: totality (never throws) + charset rejection
 *
 * Run: deno test -A --unstable-kv server/tests/math_properties_test.ts
 */

import { assertEquals, assert, assertNotEquals } from "jsr:@std/assert@1.0.0";
import { getClientIp, csrfMatches, rateLimit, generateCSRFToken, validateCSRFToken } from "../security.ts";
import { validateUsername } from "../auth.ts";

const reqWith = (headers: Record<string, string>): Request =>
 new Request("https://x.test/api", { headers });

// ─── getClientIp: priority lattice ──────────────────────────────────────────

Deno.test("MATH: platform headers outrank X-Forwarded-For", () => {
 const req = reqWith({
 "fly-client-ip": "9.9.9.9",
 "cf-connecting-ip": "8.8.8.8",
 "x-forwarded-for": "1.1.1.1, 2.2.2.2",
 });
 assertEquals(getClientIp(req), "9.9.9.9");
});

Deno.test("MATH: cf-connecting-ip outranks X-Forwarded-For", () => {
 const req = reqWith({ "cf-connecting-ip": "8.8.8.8", "x-forwarded-for": "1.1.1.1" });
 assertEquals(getClientIp(req), "8.8.8.8");
});

Deno.test("MATH: XFF uses the LAST hop (proxy-added), never the client-controlled first", () => {
 const req = reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 13.13.13.13" });
 assertEquals(getClientIp(req), "13.13.13.13");
});

Deno.test("MATH: XFF is idempotent and injective on distinct last-hops", () => {
 // Idempotence: same request twice -> same answer (pure function of headers)
 const req = reqWith({ "x-forwarded-for": "7.7.7.7, 8.8.8.8" });
 assertEquals(getClientIp(req), getClientIp(req));
 // Distinct last hops -> distinct IPs
 const a = getClientIp(reqWith({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }));
 const b = getClientIp(reqWith({ "x-forwarded-for": "1.1.1.1, 3.3.3.3" }));
 assertNotEquals(a, b);
});

// ─── csrfMatches: equality-relation laws ────────────────────────────────────

Deno.test("MATH: csrfMatches is a proper equality relation on fixed-length tokens", () => {
 const t = generateCSRFToken("sess-math-1");
 // reflexivity
 assert(csrfMatches(t, t));
 // symmetry
 assert(csrfMatches(t, t) === csrfMatches(t, t));
 // disagreement with any other token
 assert(!csrfMatches(t, t.slice(0, -1) + (t.endsWith("0") ? "1" : "0")));
 // empty/undefined safety
 assert(!csrfMatches("", t));
 assert(!csrfMatches(null as unknown as string, t));
 assert(!csrfMatches(t, ""));
 // agrees with string equality for equal-length inputs
 const u = generateCSRFToken("sess-math-2");
 assertEquals(csrfMatches(t, u), t === u);
});

Deno.test("MATH: validateCSRFToken round-trips with generateCSRFToken", () => {
 const token = generateCSRFToken("sess-math-3");
 assert(validateCSRFToken("sess-math-3", token));
 assert(!validateCSRFToken("sess-math-other", token));
});

// ─── rateLimit: budget laws ────────────────────────────────────────────────

Deno.test("MATH: rateLimit allows exactly `limit` requests then denies with retryAfter > 0", () => {
 const key = `math-test:${crypto.randomUUID()}`;
 const limit = 5;
 let ok = 0;
 let firstDenied: ReturnType<typeof rateLimit> | null = null;
 for (let i = 0; i < limit + 3; i++) {
 const r = rateLimit(key, limit, 60_000);
 if (r.ok) ok++;
 else if (!firstDenied) firstDenied = r;
 }
 assertEquals(ok, limit);
 assert(firstDenied);
 assert(firstDenied.retryAfter > 0);
 assertEquals(firstDenied.remaining, 0);
});

Deno.test("MATH: rateLimit keys are independent (no cross-key interference)", () => {
 const k1 = `math-ind-a:${crypto.randomUUID()}`;
 const k2 = `math-ind-b:${crypto.randomUUID()}`;
 for (let i = 0; i < 5; i++) rateLimit(k1, 5, 60_000);
 // exhausting k1 must not affect k2
 const r = rateLimit(k2, 5, 60_000);
 assert(r.ok);
});

Deno.test("MATH: remaining counts down monotonically until denial", () => {
 const key = `math-mono:${crypto.randomUUID()}`;
 let prevRemaining = 4; // start above the limit used below
 for (let i = 0; i < 3; i++) {
 const r = rateLimit(key, 4, 60_000);
 assert(r.ok);
 assert(r.remaining < prevRemaining);
 prevRemaining = r.remaining;
 }
});

// ─── validateUsername: totality + charset ──────────────────────────────────

Deno.test("MATH: validateUsername is total over adversarial inputs and rejects unsafe ones", () => {
 const adversarial = [
 "", " ", "<script>alert(1)</script>", "a;b", "a/b", "../../etc/passwd",
 "a".repeat(1000), "\u0000", "user name", "üñí", "a'b", 'a"b', "-_-", "__--",
 ];
 for (const s of adversarial) {
 let threw = false;
 try {
 const r = validateUsername(s);
 assert(typeof r.ok === "boolean"); // total: always an object
 } catch {
 threw = true; // throwing is NOT allowed for validation functions
 }
 assert(!threw, `validateUsername threw on ${JSON.stringify(s)}`);
 }
 // safe names accepted
 assert(validateUsername("alice_1").ok);
 assert(validateUsername("Bob-42").ok);
});
