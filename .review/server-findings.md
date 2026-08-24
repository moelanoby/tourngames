# Server Bug-Hunt Findings — /home/moelanoby/tourngames/server/

Review scope: `mod.ts`, `signaling.ts`, `auth.ts`, `security.ts`, `lobbies.ts`,
`phonebook.ts`, `admin.ts`, `replays.ts`, `types.ts`, `invariants.ts`.
All line numbers verified against the files on disk.

Severity legend: **HIGH** = exploitable security flaw or stats/privilege
integrity break; **MED** = real logic bug, DoS vector, or data-integrity race;
**LOW** = hardening issue or minor functional defect.

---

## HIGH

### H1. First-user-becomes-admin bootstrap race — attacker can become admin
- **Where:** `auth.ts:106-109` (read of `["system","initialized"]`) and `auth.ts:135-147` (atomic insert does not include the init check; flag written non-atomically at 146-147).
- **Scenario:** The `initialized` flag is read *outside* the atomic transaction. Two concurrent registrations (e.g. an attacker polling for a fresh deploy and registering at the same moment as the owner) both observe `isFirstUser === true`. Both usernames pass the `check(existing)` guard because they are different keys. Result: two users with `role: "admin"` on a brand-new deployment. On Deno Deploy multi-isolate this window is realistic.
- **Fix:** Make initialization part of one atomic transaction:
  ```ts
  const res = await kv.atomic()
    .check({ key: existingKey, versionstamp: null })   // username free
    .check({ key: initKey, versionstamp: null })       // not yet initialized
    .set(["user", userId], user)
    .set(existingKey, userId)
    .set(initKey, true)
    .commit();
  ```
  If that commit fails, retry the whole `createUser` as a normal (non-admin) registration. Alternatively set `["system","initialized"]` in an env-var-driven bootstrap step instead of deriving it from registration order.

### H2. `GET /api/lobbies/:id` returns the full raw lobby — leaks private-lobe invite codes and account/user IDs
- **Where:** `mod.ts:443-447` (`return json({ lobby });`). Contrast with the sanitized `lobbySummary()` used everywhere else (`mod.ts:368`, `signaling.ts:505`).
- **Scenario:** Anyone — unauthenticated — can fetch any lobby by UUID. For a `private` lobby the response includes `inviteCode`, so the "invite code" gate (`signaling.ts:248`) is worthless: scrape lobby IDs (WS `lobby-list` gives public ones; private IDs can be guessed via targeted signaling probing), read the invite code, then join via WS. The response also includes `players[].userId` (links anonymous peer IDs to accounts) and full signup lists.
- **Fix:** Return `lobbySummary(lobby)` plus only what clients need, e.g. `json({ lobby: { ...lobbySummary(lobby), signups: lobby.type === "signup" ? lobby.signups.map(s => ({username: s.username})) : undefined } })`. Never serialize `inviteCode`.

### H3. WebRTC signaling relay has no sender/target validation — cross-lobby relay, signal flooding, KV pollution
- **Where:** `signaling.ts:380-396`. `storeSignal(msg.to, playerId, ...)` is called before any check that `msg.to` exists, shares a lobby with the sender, or even is a valid ID; the WS relay at 386-394 likewise only checks that a connection exists.
- **Scenarios:**
  1. Any connected client (no login required to open a WS) can send offers/ICE to *any* other player's ID (IDs leak via the H2 endpoint's `players[]` array). This enables unsolicited connection attempts/harassment and lets peers in different lobbies establish P2P channels the lobby system never authorized.
  2. `msg.to` can be arbitrary garbage: each message writes a KV entry under `["signal", <attacker-chosen-key>, uuid]` with 5-min TTL. At the WS rate limit (60 msg/s per connection, unlimited connections — see M6) an attacker can create millions of short-lived KV entries and amplify storage/IO cost. The per-target trim in `phonebook.ts` (`SIGNAL_MAX_PER_PEER`, trim loop after each write) also becomes O(n) list work per message.
- **Fix:** Before storing/relaying: look up `connections.get(playerId)?.lobbyId` and `connections.get(msg.to)?.lobbyId`; reject unless both exist, are equal, and the lobby status is `"starting"`/`"playing"`. Optionally cap signals-per-sender separately from the generic msg limiter.

### H4. `match-over` win farming — any participant can grant unlimited wins to any player
- **Where:** `signaling.ts:435-458`. No host-only check, no lobby-status check, no once-per-match guard; `winner` comes straight from the client message (`msg.winner` matched at 440); stats persisted via `auth.ts recordUserWin/recordUserMatch` (non-atomic increments).
- **Scenario:** Two colluding accounts join a lobby (minPlayers=2), start it, then one sends `{type:"match-over", winner:"<own playerId>"}` repeatedly before the 5-second reset (and again after re-joining/re-starting). Each call adds +1 win/+1 match to the chosen account. Leaderboard integrity is fully broken; also any *loser* can maliciously declare someone else the winner.
- **Fix:** Require `lobby.status === "starting" || "playing"`; restrict to host (`isHost` logic already exists in the `start-match` case, `signaling.ts:308-316`); add a per-match idempotency flag (set `lobby.resultRecorded = true` in the same KV write that resets status) so repeat messages are ignored; validate `winner` is a member of the lobby.

---

## MEDIUM

### M1. IP-based rate limits are bypassable via spoofed `X-Forwarded-For`
- **Where:** `security.ts:91-98` (`getClientIp` trusts the *first* XFF value, then `x-real-ip`, then CF header). Used for all HTTP limits: login (`rateLimitLogin`), register, API (`mod.ts:289,297,355`...).
- **Scenario:** Behind a proxy that appends client-supplied XFF (default nginx `proxy_add_x_forwarded_for` behavior when the client sends its own header), the first list element is attacker-controlled. Sending a random fake XFF per request gives a fresh rate bucket every time → unlimited credential brute force and unlimited account creation (the 5/hour register limit evaporates). It also feeds unique keys into the `rateBuckets` map (`security.ts:17`), whose cleanup only removes expired entries — memory-growth amplifier.
- **Fix:** Trust only the proxy-injected hop count appropriate to your topology: take the *last* XFF entry (or better, use platform-provided IP, e.g. Fly.io `Fly-Client-IP` / Cloudflare `CF-Connecting-IP` first if you actually sit behind them), and never let client-controlled headers be the primary key. Add an upper bound on `rateBuckets.size` with LRU-style eviction.

### M2. Account lockout turns into permanent lockout with 1 request/15 min (known-username DoS)
- **Where:** `auth.ts:222-227` (`recordFailedLogin` locks at ≥5 failures but never resets the counter after lockout expiry), `auth.ts:207-215` (`isAccountLocked` comment claims "will be persisted on next login attempt" but nothing persists a reset except a successful login).
- **Scenario:** After one lockout expires, `failedLoginAttempts` is still ≥ 5, so a *single* wrong password re-locks for another 15 minutes. An attacker who knows a victim's username keeps the account locked forever with one unauthenticated POST per 15 min. (Username enumeration is easy: register error reveals taken names.)
- **Fix:** In `recordFailedLogin`, when a new failure arrives after `lockedUntil < Date.now()`, reset `failedLoginAttempts = 1` and clear `lockedUntil` before counting. Also consider keying lockouts per (account+IP) rather than globally per account.

### M3. CSRF tokens live in a per-isolate in-memory Map — breaks on restart/multi-isolate and weakens the scheme
- **Where:** `security.ts:136-166` (`csrfTokens` Map). Tokens are generated at session creation (`auth.ts:372`, stored redundantly in the KV session object) but validated *only* against the local process Map (`security.ts:149-164`).
- **Scenarios:**
  - Availability: on Deno Deploy (or any multi-isolate/restart setup) a request lands on an isolate that never saw `generateCSRFToken` → `validateCSRFToken` returns false → **every** state-changing request (signup, lobby create, admin actions) fails with 403 until the user logs in again *on that isolate*. Server restart invalidates all CSRF tokens while sessions stay valid.
  - Security: because the KV copy of the token is ignored during validation, there are effectively N independent token stores; a future change that reads the KV copy would be needed for correctness anyway.
- **Fix:** Validate against the KV-backed `session.csrfToken` (already persisted in `auth.ts:372-379`) instead of the Map, or store CSRF tokens in KV with TTL. Keep the constant-time compare.

### M4. Lobby state is read-modify-write without atomicity — lost updates, overfull lobbies, double signups
- **Where:** `lobbies.ts` throughout: `addPlayerToLobby` (199-226, capacity check at 213 vs push at 216, persisted via plain `kv.set` at `updateLobby` 113), `addSignup` (253-278, capacity 266 vs push 269), `startLobbyMatch`/`resetLobbyToWaiting`, and the quick-match candidate scan in `signaling.ts:332-338` (capacity checked on a snapshot, join happens later).
- **Scenario:** Two players join the last slot concurrently: both read the same lobby document, both pass `players.length >= maxPlayers`, both write their own copy — one join is silently dropped (ghost player who believes they're in) or, depending on interleaving, the array is overwritten so a player shown in the UI isn't in the stored roster. Same pattern allows signups to exceed `maxPlayers` and lets quick-match overfill a lobby. On multi-isolate deploys this is routine, not exotic.
- **Fix:** Use Deno KV atomic transactions with `check` on the lobby's `versionstamp`: re-read inside `kv.atomic().check(lobbyEntry).set(...).commit()` and retry on conflict (Deno.KV returns the entry's versionstamp from `kv.get`). Wrap capacity mutation + host assignment in that transaction.

### M5. Admin user deletion is unreachable — documented route always 404s
- **Where:** `admin.ts:121-122` requires `parts.length >= 3` for anything under `users/`, but the DELETE branch needs `sub === ""` (`admin.ts:167`), i.e. path `/api/admin/users/:id/`. The trailing slash is stripped earlier in `mod.ts` (`handleApi`, `if (action.endsWith("/")) action.slice(0,-1)`), so `DELETE /api/admin/users/<id>` yields `parts = ["users", "<id>"]` → length 2 → 404 before `deleteUser` ever runs.
- **Scenario:** Moderators cannot delete accounts at all through the documented API (`admin.ts` header comment documents `DELETE /api/admin/users/:id`). Banned users pile up; combined with M2 this makes moderation ineffective.
- **Fix:** Accept both shapes: `const sub = parts[2] ?? "";` and drop the `< 3` requirement for DELETE (or route `DELETE users/:id` when `parts.length === 2 && req.method === "DELETE"`).

### M6. Per-connection WS limits only — unlimited connections bypass everything
- **Where:** `mod.ts:661-720` (no auth, no per-IP/per-user cap, no Origin check on upgrade); rate limiting keyed solely by fresh `playerId` UUID (`signaling.ts:170-179`).
- **Scenario:** One script opens hundreds of WebSocket upgrades from one machine. Each gets its own 60 msg/s budget → thousands of messages/sec for lobby floods (each `create-lobby` writes a KV lobby alive for 30 min, `signaling.ts:193-238`), signal spam (H3), and broadcast amplification: every `broadcastLobbyList()` sends a full list to *all* connections (`signaling.ts:493-500`), so n sockets turn each write into n deliveries (O(n²) traffic). Also no `Origin` check enables CSWSH-style browser pivots (mitigated partly by `SameSite=Strict` cookies, anonymous sockets remain abusable).
- **Fix:** Enforce per-IP (real IP, see M1) and per-userId connection caps at upgrade time; verify `Origin` against an allowlist; optionally require a valid session for `create-lobby`.

### M7. Banned users keep live WebSocket sessions and lobby membership
- **Where:** Ban revokes HTTP sessions (`auth.ts:267` `revokeAllUserSessions`) but nothing scans `connections` (`signaling.ts:44-47`); WS identity (`userId`) was fixed at upgrade time in `mod.ts:687-704`.
- **Scenario:** A toxic player is banned mid-match; their socket stays open, they keep receiving/sending signaling and can still trigger `match-over` (H4) until they disconnect naturally. `getAuthState` self-heals on the next HTTP request, but the WS channel never re-checks.
- **Fix:** In `banUser`, iterate `connections`, close matching sockets (`4003`), and remove their phonebook entries.

### M8. Startup `purgeAllLobbies()` runs top-level on every isolate boot
- **Where:** `mod.ts:634-638` (module-level await).
- **Scenario:** Every cold start — including each Deno Deploy isolate spin-up while old isolates still serve traffic — deletes ALL lobbies, peers, and pending WebRTC signals cluster-wide. Mid-negotiation players lose offers/answers; active matches lose rosters. Frequent deploys make games randomly collapse.
- **Fix:** Gate the purge behind an explicit maintenance command/env var (`PURGE_ON_BOOT=1`), or replace with the age-based sweep already present in `listLobbies`.

---

## LOW

### L1. Logout has no CSRF protection (logout CSRF)
- **Where:** `mod.ts:314-333`. Unlike signup/lobby endpoints, `POST /api/auth/logout` performs no `requireCSRF`.
- **Scenario:** A third-party page auto-submits a logout form → victim is silently logged out (annoyance; also clears CSRF context mid-flow). Fix: call `requireCSRF(req)` first, or accept the risk consciously.

### L2. Session cookie regex matches substrings of other cookie names
- **Where:** `mod.ts:188` and `mod.ts:665`: `cookies.match(/tgn_session=([^;]+)/)`; also `admin.ts:56`. A cookie named `xtgn_session` (injectable via a sibling subdomain, since cookies don't match by prefix boundaries) would be picked up.
- **Fix:** Use the strict parser that already exists — `parseCookies` (`auth.ts:424-437`) — everywhere instead of regex.

### L3. Binary assets served through `readTextFile` get UTF-8-mangled
- **Where:** `mod.ts:124` and `mod.ts:147` (`Deno.readTextFile`) while MIME_TYPES serves `.png/.woff/etc.` from the same path.
- **Scenario:** PNG/font responses are lossy-decoded text → corrupted images/fonts (cacheable for an hour per `Cache-Control`). Fix: use `Deno.readFile` + `new Response(content /* Uint8Array */)`.

### L4. Path-traversal defense relies on undecoded pathname (fragile, currently safe)
- **Where:** `mod.ts:103-116`. `%2e%2e%2f` is never percent-decoded, and WHATWG `URL.pathname` collapses dot-segments, so traversal doesn't work today — but the check is a denylist on the raw string with no canonicalization, and debug logging prints every path (`mod.ts:104,119,644`).
- **Fix (defense in depth):** decode, resolve, then assert the result starts with the intended root: `const root = new URL("./public", import.meta.url); const real = new URL(root.pathname + "/" + p).pathname; if (!real.startsWith(root.pathname)) return null;` Also remove `[DEBUG] console.log` lines from production paths (log injection via crafted paths/origin headers).

### L5. Anonymous lobby creation has no rate limit
- **Where:** `mod.ts:409-412` (HTTP: limiter applied only `if (auth.user)`); `signaling.ts:193-238` (WS: only generic msg limit).
- **Scenario:** Unauthenticated flood of empty lobbies litters the listing for up to 30 min (`LOBBY_TIMEOUT_MS`, `lobbies.ts:11`) and pollutes KV. Fix: apply `rateLimitApi(ip)`-style limit to anonymous creates and to WS `create-lobby`.

### L6. Lockout counter races (non-atomic user writes)
- **Where:** `auth.ts:222-227`, `recordUserWin/Match` (`auth.ts:186-196`), ban/promote/demote (`auth.ts:237-330`) — all plain get→mutate→set. Concurrent updates lose counts/stats (two simultaneous `match-over`s may record one win instead of two; parallel failed logins undercount).
- **Fix:** `kv.atomic()` with versionstamp checks, or KV `sum` mutations for counters.

### L7. `p2p-ready` counter race
- **Where:** `signaling.ts:420-423` — concurrent ready messages read the same `fresh.p2pReadyCount`, one increment is lost, `p2p-connected` may never fire.
- **Fix:** Atomic increment or per-player boolean set (`ready[playerId] = true`) with size check.

### L8. `csrfTokens` never cleaned on logout/delete — small memory leak
- **Where:** `revokeCSRFToken` (`security.ts:165-167`) exists but is called nowhere (verified by grep); logout (`mod.ts:314-333`) and `deleteSession` leave stale entries for up to 2 h.
- **Fix:** Call `revokeCSRFToken(token)` inside `logout` and when sessions expire in `getSession`.

### L9. Rate limiter consumes successful logins against the per-username budget
- **Where:** `security.ts:63-71` — `rateLimitLogin` is called *before* credential verification (`mod.ts:297`) and counts every attempt including successes (5 per 15 min per username).
- **Scenario:** A user who logs in/out 5 times in 15 min gets 429s; also gives attackers a soft remote lockout complementing M2. Fix: raise the success budget or only count failures toward the username key.

### L10. Admin JSON responses missing security headers
- **Where:** `admin.ts:41-49` — local `json()` helper doesn't call `applySecurityHeaders` (unlike `mod.ts:272`). All `/api/admin/*` responses lack CSP/nosniff/etc.
- **Fix:** Import and apply `applySecurityHeaders` in `admin.ts`'s helper.

### L11. Audit-log `limit` accepts negative values
- **Where:** `admin.ts:114-115` — `Math.min(500, parseInt(...))` without clamping the floor; a negative `limit` reaches `kv.list(..., { limit })` and throws (caught upstream as a generic 500).
- **Fix:** `Math.max(0, Math.min(500, limit))` and treat NaN as default.

### L12. `minPlayers > maxPlayers` allowed at creation → permanently stuck lobby
- **Where:** `mod.ts:421-424`, `signaling.ts:206-211`, `lobbies.ts:57-61` clamp independently; nothing rejects `min > max`.
- **Scenario:** Host sets min=10/max=2; `startLobbyMatch` (`lobbies.ts:288-290`) demands 10 players but `addPlayerToLobby` caps at 2 → lobby can never start, occupies listings until the 30-min sweep. Fix: after clamping, `safeMin = Math.min(safeMin, safeMax)`.

### L13. Cookie `Secure` flag depends on `DENO_DEPLOYMENT_ID` only
- **Where:** `auth.ts:440-450`. Self-hosted HTTPS deployments (nginx/caddy in front) don't set that env var → cookie sent over plaintext HTTP if the site is ever reached that way.
- **Fix:** Derive from request protocol (`url.protocol === "https:"` passed into `setSessionCookie`) or an explicit `SECURE_COOKIES=1` env.

### L14. CSP weak points
- **Where:** `security.ts:105-125`: `script-src 'unsafe-inline'` defeats most XSS mitigation, and `connect-src ws: wss:` permits WebSocket connections to any host (exfil channel if XSS does occur).
- **Fix:** Nonce/hash-based script policy; restrict `connect-src 'self'`.

### L15. Dead modules kept in tree: `replays.ts` (unused import-wise; verified nothing imports it) and `invariants.ts` (`checkLobbyInvariant` never called)
- **Where:** `replays.ts:1-44`, `invariants.ts:1-62`; comment in `mod.ts:52-55` confirms intent.
- **Risk:** dead code drifts (e.g. `saveReplay` would happily persist unvalidated client data if ever rewired). Either delete or wire `checkLobbyInvariant` into `updateLobby` as intended.

### L16. `match-over` reset timer uses stale captured `info.lobbyId`
- **Where:** `signaling.ts:452-457`. If the reporting player leaves and joins a different lobby within the 5 s delay, the *old* lobby is reset (or a lobby they're no longer part of), and multiple rapid match-overs schedule overlapping resets.
- **Fix:** Capture `const lid = info.lobbyId` and verify current lobby state/status inside the timeout before resetting.

---

## Verified non-issues

- **Password comparison** (`auth.ts:78-86`) and **CSRF comparison** (`security.ts:155-163`) are constant-time with a length pre-check that leaks nothing (fixed-length tokens).
- **Static path traversal**: `%2e%2e` is never decoded and leading slashes/backslashes/dot-segments are handled (see L4 for hardening advice); `..` anywhere in the path is rejected.
- **Replay endpoints**: legacy POST is a validated no-op (`mod.ts:486-505`); GETs return 410 — no injection surface reachable (dead `replays.ts` aside, see L15).
- **Session expiry** is enforced server-side on every `getSession` (`auth.ts:388-395`); banned users' sessions are invalidated lazily in `getAuthState` (`auth.ts:462-465`).
