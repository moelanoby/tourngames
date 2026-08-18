# Hardening Guide

Step-by-step instructions for fixing each vulnerability identified in [`VULNERABILITY-ASSESSMENT.md`](./VULNERABILITY-ASSESSMENT.md). Each fix is independent — you can copy and paste the changes without breaking existing functionality.

---

## 1. Fix CORS Wildcard with Credentials

**File:** `server/mod.ts`, lines 625-629

**Before:**
```typescript
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
```

**After:**
```typescript
if (req.method === "OPTIONS") {
    // Only allow requests from the same origin (your deployed domain)
    const origin = req.headers.get("origin");
    const allowedOrigins = [
        "https://YOUR_DOMAIN.com",       // ← Replace with your actual domain
        "http://localhost:8000",          // ← Local dev
    ];
    const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Cookie, X-CSRF-Token",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age": "86400",
        },
    });
}
```

**Why:** `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` is invalid per spec and allows any website to make cross-origin requests. Echoing back only whitelisted origins prevents unauthorized cross-origin access.

**Alternative (simpler):** If the frontend is always served from the same origin as the API (which it appears to be — both served from the same Deno Deploy instance), you can simply remove the entire `OPTIONS` handler. The browser will default to same-origin requests, and `credentials: "include"` in `fetch` calls will work correctly for same-origin requests.

---

## 2. Validate WebSocket Origin

**File:** `server/mod.ts`, ~line 650 (before `Deno.upgradeWebSocket`)

**Add this check right before the WebSocket upgrade:**
```typescript
if (path === "/ws" || path === "/signaling") {
    // ── Origin validation (prevents CSWSH) ──
    const allowedOrigins = [
        "https://YOUR_DOMAIN.com",  // ← Replace with your actual domain
        "http://localhost:8000",    // ← Local dev — remove in prod
    ];
    const origin = req.headers.get("origin");
    if (!origin || !allowedOrigins.includes(origin)) {
        return new Response("Forbidden: invalid origin", { status: 403 });
    }

    const upgradeHeader = req.headers.get("upgrade");
    // ... rest of existing WS handler
}
```

**Why:** Without origin validation, any website can open a WebSocket connection to your server, enabling Cross-Site WebSocket Hijacking (CSWSH). An attacker could flood your server with connections, create lobbies, or spam signaling messages through a victim's browser.

**Note:** In Deno Deploy, the origin is the scheme + host + port. For example: `https://tourngames.deno.dev`. You can also check `req.headers.get("host")` as an additional signal.

---

## 3. Scope WebSocket Signaling to Lobbies

**File:** `server/signaling.ts`, lines 367-382 (offer/answer/ice-candidate handler)

**Before:**
```typescript
case "offer":
case "answer":
case "ice-candidate": {
    await storeSignal(msg.to, playerId, msg.type, msg.data);
    const target = connections.get(msg.to);
    if (target) {
        safeSend(target.ws, {
            type: msg.type,
            from: playerId,
            to: msg.to,
            data: msg.data,
        });
    }
    break;
}
```

**After:**
```typescript
case "offer":
case "answer":
case "ice-candidate": {
    // ── Validate sender and recipient are in the same lobby ──
    if (!info?.lobbyId) {
        safeSend(ws, { type: "error", message: "Not in a lobby" });
        return;
    }
    const target = connections.get(msg.to);
    if (!target) {
        safeSend(ws, { type: "error", message: "Target player not connected" });
        return;
    }
    // Verify both sender and recipient are in the same lobby
    if (target.lobbyId !== info.lobbyId) {
        safeSend(ws, { type: "error", message: "Cannot signal players outside your lobby" });
        return;
    }
    // Store in KV (phonebook backup)
    await storeSignal(msg.to, playerId, msg.type, msg.data);
    // Relay in real-time via WS
    safeSend(target.ws, {
        type: msg.type,
        from: playerId,
        to: msg.to,
        data: msg.data,
    });
    break;
}
```

**Why:** Without lobby scoping, any connected player can send WebRTC signaling messages to any other connected player — even from different lobbies. This enables WebRTC IP address leakage and cross-lobby harassment.

---

## 4. Validate Match-Over Reports

**File:** `server/signaling.ts`, lines 422-436 (match-over handler)

**Add an `isHost` check at the beginning of the `match-over` case:**
```typescript
case "match-over": {
    if (!info?.lobbyId) return;
    const lobby = await getLobby(info.lobbyId);
    if (!lobby) return;

    // ── Only the host can report match results ──
    const isHost = lobby.hostId === playerId ||
        (lobby.hostUserId && lobby.hostUserId === ctx.userId);
    if (!isHost) {
        safeSend(ws, { type: "error", message: "Only the host can report match results" });
        return;
    }

    const lobbyPlayers = Array.isArray(lobby.players) ? lobby.players : [];
    // ... rest of existing match-over handler
}
```

**Why:** Without this check, any player in a lobby can report a match-over and credit wins/losses to arbitrary players. This enables win-trading and record manipulation.

---

## 5. Tighten Content Security Policy (CSP)

**File:** `server/security.ts`, line 60

**Before:**
```typescript
"script-src 'self' 'unsafe-inline'",
```

**After:**
```typescript
"script-src 'self'",
```

**Why:** The application has no inline `<script>` blocks in `index.html` — only an external `<script type="module" src="/app.js">`. Removing `'unsafe-inline'` from `script-src` provides strong XSS protection. If you need inline scripts in the future, use a CSP nonce:
```html
<script nonce="{{NONCE}}">...</script>
```

**For styles:** You can keep `'unsafe-inline'` for `style-src` temporarily (since `index.html` has 14 inline `style="..."` attributes), but the long-term goal is to move all styles to CSS classes and remove `'unsafe-inline'` from `style-src` too.

---

## 6. Escape Username in Auth UI

**File:** `public/ui/auth.js`, line 179

**Before:**
```typescript
let display = user.username;
if (user.wins) display += ` · ${user.wins}w`;
if (user.role === "admin") {
    display += ' <span class="user-badge user-badge-admin">ADMIN</span>';
}
dom.userDisplay.innerHTML = display;
```

**After:**
```typescript
let display = escapeHtml(user.username);
if (user.wins) display += ` · ${user.wins}w`;
if (user.role === "admin") {
    display += ' <span class="user-badge user-badge-admin">ADMIN</span>';
}
dom.userDisplay.innerHTML = display;
```

**Why:** Defense-in-depth. The server validates usernames with `/^[a-zA-Z0-9_-]+$/`, but if that validation is ever loosened, this becomes a stored XSS vector. The `escapeHtml` function is already defined in the same file.

---

## 7. Constant-Time Invite Code Comparison

**File:** `server/signaling.ts`, line 240

**Before:**
```typescript
if (lobby.type === "private" && lobby.inviteCode && msg.inviteCode !== lobby.inviteCode) {
```

**After:**
```typescript
import { timingSafeEqual } from "node:crypto";  // or use Deno's equivalent

// ... inside the handler:
if (lobby.type === "private" && lobby.inviteCode) {
    // Constant-time comparison to prevent timing attacks
    const provided = String(msg.inviteCode || "");
    const expected = lobby.inviteCode;
    if (provided.length !== expected.length || !timingSafeEqual(
        new TextEncoder().encode(provided),
        new TextEncoder().encode(expected)
    )) {
        safeSend(ws, { type: "error", message: "Invalid invite code" });
        return;
    }
}
```

**Alternative (no new import):** Use a simple constant-time loop:
```typescript
function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
```

Also, add rate limiting to the `join-specific` WebSocket handler to prevent brute-force:
```typescript
const rl = rateLimit(`invite:${info ? info.lobbyId : "unknown"}:${msg.inviteCode || "unknown"}`, 5, 60 * 1000);
if (!rl.ok) {
    safeSend(ws, { type: "error", message: "Too many attempts, try again later" });
    return;
}
```

**Why:** JavaScript's `!==` comparison short-circuits at the first differing character. By measuring response time across many requests, an attacker can determine the correct invite code character-by-character.

---

## 8. Limit Request Body Size

**File:** `server/mod.ts`, add a helper and use it in `readJsonBody`

**Add this helper function:**
```typescript
const MAX_BODY_BYTES = 100 * 1024; // 100 KB

async function readJsonBody(req: Request): Promise<any> {
    try {
        const contentLength = req.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
            throw new Error("Request body too large");
        }
        // Use a TransformStream to enforce the size limit even if Content-Length is missing
        const body = req.body;
        if (!body) return null;
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_BODY_BYTES) {
                reader.cancel();
                throw new Error("Request body too large");
            }
            chunks.push(value);
        }
        const text = new TextDecoder().decode(
            Uint8Array.from(chunks.flatMap(c => Array.from(c)))
        );
        return JSON.parse(text);
    } catch {
        return null;
    }
}
```

**Simpler alternative using Deno's body:**
```typescript
async function readJsonBody(req: Request): Promise<any> {
    try {
        const contentLength = req.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > 100_000) {
            return null;  // silently reject oversized bodies
        }
        const text = await req.text();
        if (text.length > 100_000) return null;
        return JSON.parse(text);
    } catch {
        return null;
    }
}
```

**Why:** Without a body size limit, an attacker can send extremely large JSON payloads to exhaust server memory, causing DoS.

---

## 9. Rotate Session Tokens on Login

**File:** `server/auth.ts`, `recordSuccessfulLogin` function

**Before:**
```typescript
export async function recordSuccessfulLogin(user: User, ip: string): Promise<User> {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = Date.now();
    user.lastLoginIp = ip;
    await kv.set(["user", user.id], user);
    return user;
}
```

**After:**
```typescript
export async function recordSuccessfulLogin(user: User, ip: string): Promise<User> {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = Date.now();
    user.lastLoginIp = ip;
    await kv.set(["user", user.id], user);
    // Invalidate ALL existing sessions so old stolen tokens stop working
    await revokeAllUserSessions(user.id);
    return user;
}
```

**Why:** Without session rotation, a stolen session token remains valid even after the user re-authenticates. This prevents session fixation attacks where an attacker steals a token and waits for the victim to log in (giving the token higher privileges).

**Note:** Calling `revokeAllUserSessions` on every successful login means all other tabs/devices will be logged out when the user logs in again. This is standard security practice (e.g., GitHub does this). If you want to preserve multi-device sessions, you should only invalidate the session associated with the current request's cookie.

---

## 10. Rate-Limit WebSocket Connections

**File:** `server/mod.ts`, WebSocket upgrade handler

**Add a per-IP connection counter:**

At the top of `mod.ts`, add:
```typescript
const wsConnectionsPerIp = new Map<string, { count: number; resetAt: number }>();
const WS_IP_LIMIT = 5;        // max connections per IP
const WS_IP_WINDOW = 60_000;  // 60 second window
```

Before `Deno.upgradeWebSocket(req)`:
```typescript
const clientIp = getClientIp(req);
const now = Date.now();
const bucket = wsConnectionsPerIp.get(clientIp);
if (bucket && bucket.resetAt > now) {
    if (bucket.count >= WS_IP_LIMIT) {
        return new Response("Too many WebSocket connections", { status: 429 });
    }
    bucket.count++;
} else {
    wsConnectionsPerIp.set(clientIp, { count: 1, resetAt: now + WS_IP_WINDOW });
}
```

After WebSocket close (in `socket.onclose`):
```typescript
socket.onclose = () => {
    const b = wsConnectionsPerIp.get(clientIp);
    if (b && b.count > 0) b.count--;
    // ... rest of close handler
};
```

**Why:** Without connection limits, a single attacker can open hundreds of WebSocket connections, each consuming memory and creating lobbies/signals, leading to resource exhaustion.

---

## 11. (Optional) Increase PBKDF2 Iterations

**File:** `server/auth.ts`, line 15

**Before:**
```typescript
const PBKDF2_ITERATIONS = 100_000;
```

**After:**
```typescript
const PBKDF2_ITERATIONS = 310_000;
```

**Why:** OWASP 2023 recommends ≥310,000 iterations for PBKDF2-SHA256. This increases the computational cost for attackers brute-forcing password hashes. Note: existing password hashes remain valid (the salt is stored per-user, and verification uses the stored salt). New passwords will use the higher iteration count automatically.

**Note:** This change only affects new password hashing. To upgrade existing hashes, you would need to re-hash on next login (using `verifyPassword` to confirm the old hash works, then re-hashing with the new iteration count).

---

## 12. (Optional) Add Security.txt

**File:** `public/.well-known/security.txt`

Create a `security.txt` file so security researchers can report vulnerabilities responsibly:
```
{
    "name": "TournGames Security Contact",
    "contact": "mailto:security@yourdomain.com",
    "expires": "2026-12-31T23:59:59Z",
    "hiring": "https://yourdomain.com/security-hall-of-fame",
    "policy": "https://yourdomain.com/SECURITY.md"
}
```

You'll also need a route in `mod.ts` to serve this file. Add this in the static file serving section:
```typescript
if (path === "/.well-known/security.txt") {
    return applySecurityHeaders(new Response("Contact: mailto:security@yourdomain.com
Expires: 2026-12-31T23:59:59Z
",
        { status: 200, headers: { "Content-Type": "text/plain" } }));
}
```

---

## Deployment Notes

### For Deno Deploy:

1. **Environment variables:** Ensure `TURN_SERVER_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` are set if you use TURN servers (required for symmetric NAT traversal). If you don't set them, WebRTC will fall back to STUN-only, which works for most users but may fail for some corporate/firewalled networks.

2. **Custom domain:** Set up a custom domain in Deno Deploy's dashboard. This enables automatic TLS and makes the `Secure` flag on cookies work correctly.

3. **Logging:** The `auditLog` function writes to Deno KV. For production, consider also streaming audit logs to an external logging service (e.g., Logflare, Datadog) for alerting on suspicious activity.

4. **KV Consistency:** Deno KV provides eventual consistency across regions. The `purgeAllLobbies` call on startup is important — make sure it works correctly in a multi-region deployment.

5. **Rate limiting state:** The in-memory rate limiter (`rateBuckets` Map) is per-instance. Under Deno Deploy's multi-region deployment, each region has its own in-memory rate limiter. This means an attacker could potentially bypass rate limits by hitting different regions. For stronger rate limiting, consider using Deno KV (persistent across regions) or a service like Cloudflare Workers KV.


---

## Additional Hardening Fixes (Part 2)

---

### 16. P2P Input Authentication (Signature Verification)

**Problem:** The host accepts P2P inputs with any `playerId` — no authentication.

**Solution:** Implement HMAC-based input signing. Each peer gets a signing key derived from their session token + server-issued nonce.

**File:** `server/mod.ts` (add to WebSocket upgrade handler) and `public/app.js` (P2P input sending/handling)

**Step 1: Server issues signing keys on WebSocket connect**
```typescript
// In mod.ts, after generating playerId in WebSocket handler:
const signingKey = bufToHex(randomBytes(32));
connections.set(playerId, { 
    lobbyId: null, 
    ws: socket, 
    userId, 
    username, 
    signingKey  // <-- NEW
});
```

**Step 2: Client signs inputs before sending**
```typescript
// In public/app.js, collectAndSendInput:
collectAndSendInput() {
    if (!this.state || !this.state.running || state.isHost) return;
    // ... existing checks ...

    const input = this.module.getLocalInput(this.keys);
    if (input && (input.jump || input.action)) {
        const payload = { 
            type: "input", 
            playerId: state.playerId, 
            input: input,
            sig: await signInput(input, state.playerId, state.signingKey)  // <-- NEW
        };
        if (state.p2pClient) {
            state.p2pClient.sendToPeer(state.hostId, payload);
        }
    }
}

// Crypto helper (uses Web Crypto API):
async function signInput(input, playerId, key) {
    const enc = new TextEncoder();
    const message = enc.encode(JSON.stringify({ input, playerId }));
    const cryptoKey = await crypto.subtle.importKey(
        "raw", hexToBuf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, message);
    return bufToHex(signature);
}
```

**Step 3: Host verifies signatures before processing**
```typescript
// In public/app.js, P2P onMessage handler:
if (p2p.isHost) {
    if (msg.type === "input") {
        if (await verifyInputSignature(msg.input, msg.playerId, msg.sig, connections.get(msg.playerId)?.signingKey)) {
            gameMgr.pendingInputs[msg.playerId] = msg.input;
        } else {
            console.warn("[P2P] Invalid input signature from", msg.playerId);
        }
    }
}
```

**Note:** This requires sharing the `signingKey` from the server to the client via the `assign-id` WebSocket message. Update `ICE_CONFIG` in `assign-id` to include `signingKey`.

---

### 17. P2P Game-State Validation

**Problem:** Non-host peers accept `game-state` from any peer.

**Solution:** Only accept from host, validate tick monotonicity.

**File:** `public/app.js`, P2P `onMessage` handler

```typescript
p2p.onMessage = (peerId, msg) => {
    // ... chat handling ...

    if (!p2p.isHost) {
        if (msg.type === "game-state") {
            // Only accept from host
            if (peerId !== state.hostId) {
                console.warn("[P2P] Rejected game-state from non-host:", peerId);
                return;
            }
            // Validate tick is not too far in the future
            if (msg.tick > gameMgr.tick + 2) {
                console.warn("[P2P] Rejected game-state with suspicious tick:", msg.tick);
                return;
            }
            gameMgr.receiveState(msg.state, msg.tick);
        }
        if (msg.type === "match-over") {
            // Only accept from host
            if (peerId !== state.hostId) return;
            gameMgr.receiveMatchOver(msg.winner, msg.winnerName);
        }
    }
    // ... rest ...
};
```

---

### 18. P2P Match-Over Validation

**Problem:** Any peer can broadcast `match-over`.

**Solution:** Only accept from host (already covered by fix 17).

---

### 19. Chat Message Authentication

**Problem:** Chat `playerName` and `senderTeam` are forgeable.

**Solution:** Use the lobby roster to verify player identity.

```typescript
// In public/app.js, P2P onMessage chat handler:
if (msg.type === "chat") {
    // Look up real player info from lobby roster
    const sender = state.players.find(p => p.id === peerId);
    if (!sender) return; // unknown peer

    // Use verified name and team
    const verifiedName = sender.name;
    const verifiedTeam = state.gameState?.data?.playerTeams?.[peerId];

    // For team chat, verify the sender is actually on that team
    if (msg.channel === "team" && verifiedTeam !== msg.senderTeam) {
        return; // forged team
    }

    displayChatMessage(verifiedName, msg.message, msg.channel, verifiedTeam);
    return;
}
```

---

### 20. Replay gameModule Validation

**Problem:** `replay.gameModule` from localStorage can be path-traversed.

**Solution:** Whitelist validation.

```typescript
// In public/app.js (handleGameStart) and public/ui/archive.js (loadReplay):
const KNOWN_GAMES = ["chess-royale"]; // populated from /api/game-config or games.config.json

function validateGameModule(gameModule) {
    return KNOWN_GAMES.includes(gameModule);
}

// Before import:
const gameModule = replay.gameModule || "chess-royale";
if (!validateGameModule(gameModule)) {
    showToast("Invalid game module in replay", "error");
    return;
}
const gameModulePath = "/games/" + gameModule + "/mod.js";
```

Also populate `KNOWN_GAMES` from the server's game config:
```typescript
// In app.js, after fetching game-config:
state.knownGames = [gameConfig.gameId]; // e.g., ["chess-royale"]
```

---

### 21. WebSocket Rate Limiting

**Problem:** WebSocket `list-lobbies` has no rate limit.

**Solution:** Apply same rate limiting as HTTP API.

**File:** `server/signaling.ts`

```typescript
// At top of file, import rateLimit from security.ts
import { rateLimit } from "./security.ts";

// In handleWebSocketMessage, before list-lobbies case:
case "list-lobbies": {
    const rl = rateLimit(`ws-lobby-list:${ctx.playerId}`, 30, 60 * 1000); // 30/min
    if (!rl.ok) {
        safeSend(ws, { type: "error", message: "Too many lobby list requests" });
        return;
    }
    // ... existing handler
}
```

Also add rate limiting to other WS messages:
```typescript
// create-lobby (already has rateLimitLobbyCreate on HTTP, but WS bypasses it)
case "create-lobby": {
    if (ctx.userId) {
        const rl = rateLimit(`ws-lobby-create:${ctx.userId}`, 10, 60 * 1000);
        if (!rl.ok) return safeSend(ws, { type: "error", message: rl.message });
    }
    // ...
}

// join-specific (invite code brute-force)
case "join-specific": {
    const rl = rateLimit(`ws-invite:${ctx.playerId}`, 5, 60 * 1000);
    if (!rl.ok) return safeSend(ws, { type: "error", message: "Too many join attempts" });
    // ...
}
```

---

### 22. Session Device Binding

**Problem:** Session tokens work from any IP/browser.

**Solution:** Bind sessions to User-Agent hash; allow IP changes.

**File:** `server/auth.ts`

```typescript
// In createSession:
export async function createSession(userId: string, req?: Request): Promise<Session> {
    // ... existing code ...
    const uaHash = req ? await hashUserAgent(req.headers.get("user-agent")) : null;
    const session: Session = {
        // ... existing fields ...
        uaHash,  // NEW
        ip: req ? getClientIp(req) : "unknown",  // NEW (initial IP for reference)
    };
    // ...
}

// On session validation (getSession):
export async function getSession(token: string, req?: Request): Promise<Session | null> {
    // ... existing validation ...
    if (req && res.value.uaHash) {
        const currentUAHash = await hashUserAgent(req.headers.get("user-agent"));
        if (res.value.uaHash !== currentUAHash) {
            await deleteSession(token);
            return null; // User-Agent changed = potential token theft
        }
    }
    // IP check: warn but don't block (mobile users change IPs)
    return res.value;
}

async function hashUserAgent(ua: string | null): Promise<string> {
    if (!ua) return "";
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(ua));
    return bufToHex(buf);
}
```

---

### 23. Cryptographic Game Seed

**Problem:** `Math.random()` for seed generation.

**Solution:** Use `crypto.getRandomValues()`.

**File:** `server/lobbies.ts`

```typescript
function generateSeed(): number {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
}
```

---

### 24. Host Migration on Disconnect

**Problem:** No new host when host leaves.

**Solution:** Elect next player as host.

**File:** `server/signaling.ts`, `handleWebSocketClose` / `leaveLobby`

```typescript
async function leaveLobby(playerId: string): Promise<void> {
    const info = connections.get(playerId);
    if (!info?.lobbyId) return;
    const lobby = await getLobby(info.lobbyId);
    if (lobby) {
        const wasHost = lobby.hostId === playerId;
        await removePlayerFromLobby(lobby, playerId);

        // If host left, elect new host
        if (wasHost && lobby.players.length > 0) {
            const newHost = lobby.players[0];
            lobby.hostId = newHost.id;
            lobby.hostName = newHost.name;
            lobby.hostUserId = newHost.userId || null;
            await updateLobby(lobby);

            // Notify remaining players of new host
            await broadcastLobbyState(lobby.id, {
                type: "host-changed",
                newHostId: newHost.id,
                newHostName: newHost.name,
            });
        }
        // ... rest of existing leaveLobby
    }
    // ...
}
```

Also update client-side to handle `host-changed` message.

---

### 25. WebSocket IP Logging

**Problem:** WebSocket connections don't log client IP.

**Solution:** Add IP to ConnectionInfo and log on connect/disconnect.

**File:** `server/signaling.ts`

```typescript
export interface ConnectionInfo {
    lobbyId: string | null;
    ws: WebSocket;
    userId: string | null;
    username: string | null;
    ip: string;  // NEW
}

// In mod.ts WebSocket upgrade handler:
const playerId = crypto.randomUUID();
const clientIp = getClientIp(req);
connections.set(playerId, { lobbyId: null, ws: socket, userId, username, ip: clientIp });

console.log(`[WS] Player ${playerId} connected from ${clientIp} (user: ${username || "anon"})`);

// In handleWebSocketClose:
console.log(`[WS] Player ${playerId} disconnected from ${info?.ip}`);
```

---

## Additional Monitoring Rules

Add to your monitoring/alerting:

| Rule | Trigger | Action |
|---|---|---|
| WebSocket connection spike | > 100 new WS connections/min from single IP | Alert, consider IP block |
| P2P input signature failure rate | > 5% of inputs have invalid signatures | Investigate potential attack |
| Chat impersonation attempts | Same IP sending chat as multiple different names | Alert |
| Replay gameModule validation failures | Any attempt to load unknown game module | Alert, potential path traversal attempt |
| Host disconnect frequency | Host disconnects during active matches > 3x/hour | Investigate potential griefing |
| Match-over from non-host | Any non-host peer sending match-over | Immediate alert, potential cheat |
