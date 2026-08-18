# Anti-Cheat Strategy

TournGames uses a **host-authoritative P2P architecture**: the host player's browser runs the authoritative game simulation, and game state/inputs flow peer-to-peer via WebRTC data channels. The server acts as a lobby manager and signaling relay only — it does not validate game logic.

This document outlines the inherent cheat vectors in this architecture, what mitigations are already in place, and what you can do to make cheating harder.

---

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │           Tourngames Server         │
                    │  (Deno Deploy)                      │
                    │                                     │
                    │  ┌──────────┐ ┌──────────┐         │
                    │  │ KV Store │ │ Rate     │         │
                    │  │ (lobbies,│ │ Limiting │         │
                    │  │  users,  │ │  & Auth  │         │
                    │  │  audit)  │ │          │         │
                    │  └────┬─────┘ └─────┬─────┘         │
                    │       │              │               │
                    │       │  WebSocket   │               │
                    │       │  Signaling   │               │
                    │       └──────┬───────┘               │
                    └──────────────┼──────────────────────┘
                                   │
                    ┌──────────────┼─────────────────────┐
                    │    WebRTC P2P Mesh (game state    │
                    │    and inputs flow P2P, NOT       │
                    │    through the server)            │
                    │                                   │
                    │   ┌───────┐   ┌───────┐ ┌───────┐ │
                    │   │Peer A │   │Peer B │ │Peer C │ │
                    │   │ (Host)│◄─►│       │◄─►│       │ │
                    │   └───────┘   └───────┘ └───────┘ │
                    │   ▲ Auth simulation  ◄─ Mesh relay│ │
                    └───────────────────────────────────┘
```

### Key Principle: Game state NEVER touches the server.
- Inputs (votes, moves) are exchanged P2P.
- The host runs `updateGameState()` and broadcasts results P2P.
- The server only sees: lobby joins/leaves, signaling (offer/answer/ICE), and the final match-over report.

---

## Known Cheat Vectors

### 1. Host Client-Side Game State Modification (EASIEST CHEAT TO DO)

**Threat:** The host opens browser DevTools and modifies `gameMgr.state` directly — giving themselves extra pieces, capturing the enemy king, or teleporting pieces.

**Current mitigations:** None. The host's state is the source of truth.

**Possible mitigations:**
- **Client-side obfuscation:** Minify and obfuscate `app.js` to make it harder to find the game state object. *(Low effort, easily bypassed by skilled attackers.)*
- **Server-side checksumming:** Have the host periodically sign game state checkpoints (`JSON.stringify(state)` + HMAC with a server-issued key) and broadcast them. Other peers verify the signature. If they detect an invalid state, they flag the host. *(Moderate effort — requires adding a signing key to the WebSocket session and implementing checkpoint broadcasting in the game module.)*
- **Multi-host validation:** Elect multiple players as co-hosts; each runs the simulation independently and compares results. If they disagree, the game is flagged. *(High effort.)*
- **Server-authoritative simulation:** Move game logic to the server. This is a fundamental architectural change but eliminates this cheat vector entirely. *(Very high effort, requires significant infra changes.)*

### 2. Host Ignores Peer Inputs (VOTE MANIPULATION)

**Threat:** In Chess Royale, players vote on moves. The host collects votes via P2P, but can simply ignore any vote it doesn't like. A dishonest host can force its own move regardless of peer votes.

**Current mitigations:** None.

**Possible mitigations:**
- **Peer input echo:** Each peer broadcasts "I submitted this vote" to all other peers. If a peer detects its vote was ignored, it can flag the host. *(Moderate effort.)*
- **Vote commitment scheme:** Peers commit to their votes (hashed) before seeing others' votes, then reveal. The host can't cherry-pick. *(Moderate effort — requires protocol changes.)*
- **Input logging:** Peers log all inputs they send. If the final game-state differs from what the inputs should have produced, the host is flagged. *(Moderate effort.)*

### 3. P2P Mesh Relay Manipulation

**Threat:** The P2P mesh allows peers to relay messages for other peers. A malicious peer (not the host) can:
- **Drop packets:** Prevent specific players from receiving game state or inputs, effectively freezing them out.
- **Delay packets:** Introduce artificial lag to specific players, giving them an unfair disadvantage.
- **Reorder packets:** Mess up the timing of game state updates.

**Current mitigations:**
- `maxRelayHops = 2` — prevents infinite relay loops.

**Possible mitigations:**
- **Message sequence numbers:** Add a sequence number to each game-state broadcast. Peers can detect dropped or reordered messages. *(Low effort.)*
- **Direct connection preference:** Try to establish direct P2P connections before falling back to mesh relay. If a direct connection exists, the mesh is only used as a backup. *(Already partially implemented — the `_relayMessage` function tries direct first.)*
- **Peer health voting:** If a peer reports that another peer dropped its packets, the lobby votes to eject the offender. *(Moderate effort.)*

### 4. Fake Match-Over Report

**Threat:** Any player (not just the host) can send `{ type: "match-over", winner: "<player-id>" }` to the server. The server records wins/losses based on the report.

**Status:** **UNPATCHED — see [`VULNERABILITY-ASSESSMENT.md`](./VULNERABILITY-ASSESSMENT.md#high-match-over-accepted-from-any-player) and [`HARDENING-GUIDE.md`](./HARDENING-GUIDE.md#4-validate-match-over-reports).**

**Impact:** Win-loss record manipulation. A non-host player can credit wins to themselves or damage another player's record.

**Mitigation (implement the fix from HARDENING-GUIDE.md):**
- Add an `isHost` check in the `match-over` WebSocket handler, identical to the `start-match` handler.
- Only accept `match-over` from the lobby host.

### 5. Signaling Relay Abuse (Cross-Lobby Communication)

**Threat:** Any connected player can send WebRTC signaling messages (offer/answer/ICE) to any other connected player, even from different lobbies.

**Status:** **UNPATCHED — see [`HARDENING-GUIDE.md`](./HARDENING-GUIDE.md#3-scope-websocket-signaling-to-lobbies).**

**Impact:** WebRTC IP address leakage between players in different lobbies. Cross-lobby harassment. Potential for a malicious peer to infiltrate a game's P2P mesh.

**Mitigation (implement the fix from HARDENING-GUIDE.md):**
- Before relaying a signaling message, verify that the sender and recipient are in the same lobby.

### 6. Guest Account Impersonation

**Threat:** Non-authenticated players can choose any display name (up to 16 chars, validated with `sanitizeString`). A guest can impersonate an authenticated player by using the same name.

**Current mitigations:**
- Server-side username validation: `/^[a-zA-Z0-9_-]+$/` (alphanumeric, underscore, hyphen only — blocks HTML special chars).
- Profanity filter on usernames.
- Player IDs are server-generated UUIDs — they can't be spoofed.

**Possible mitigations:**
- Visually distinguish authenticated users from guests (e.g., a "guest" badge in the UI).
- Require authentication to join games (optional setting per lobby).
- Display user IDs alongside names to make impersonation obvious.

### 7. Replay Integrity (Local Storage)

**Threat:** Replays are stored in `localStorage`, which any JavaScript on the page can read or modify. A user could:
- Edit their replay to show a fake winner.
- Replace the replay data with arbitrary content (including a malicious `gameModule` path that triggers a dynamic import of attacker-controlled JavaScript — though this would require the attacker to also place a JS file on the server).

**Current mitigations:**
- `isValidReplay()` checks that `replayId`, `gameModule`, and `seed` exist and have correct types.
- `gameModulePath` is constructed as `"/games/" + gameModule + "/mod.js"` — the `/games/` prefix prevents path traversal to other directories.

**Possible mitigations:**
- Validate `gameModule` against a whitelist of known game IDs.
- Sign replay data with a key derived from the user's session (if authenticated).
- Store replays in IndexedDB with a more restrictive origin policy (not really more secure than localStorage, but offers API-based access control).

---

## Existing Protections (Keep These)

These are already implemented and effective — do not remove them:

| Protection | Strength | What It Prevents |
|---|---|---|
| **WebSocket message rate limiting** (60 msg/s) | Strong | Flooding the server with WebSocket messages |
| **Invite code for private lobbies** | Medium | Unauthorized lobby access (6-char alphanumeric = ~36^6 combinations ≈ 2 billion, but see timing attack note) |
| **Lobby player cap** (max 20, enforced server-side) | Strong | Overloading a game with too many players |
| **Host-only start-match** | Strong | Non-hosts starting games prematurely |
| **Profanity filter** on usernames, lobby names, player names | Medium | Toxic/offensive names |
| **Sanitization** of all user inputs (`sanitizeString`, `sanitizeLobbyName`) | Medium | Control character injection, excessive length |
| **Audit logging** of lobby creation, user bans, admin actions | High | Post-incident forensics |
| **Account lockout** (5 failed logins → 15 min lock) | Strong | Brute-force password attacks |
| **Ban revokes all sessions** | Strong | Banned users can't rejoin via old sessions |
| **First-user-is-admin bootstrap** | Design | Ensures there's always an admin |

---

## Monitoring & Detection

### Audit Log Analysis

The server logs these events to Deno KV under the `["audit"]` key:

- `first-admin-created` — When the first user registers as admin
- `user-registered` — Account creation
- `login-failed` — Failed login attempts
- `login-success` — Successful login
- `login-attempt-banned` — Login attempt by a banned user
- `logout` — Logout
- `lobby-created` — Lobby creation (includes lobby type, max players)
- `user-banned` / `user-unbanned` — Ban management
- `user-promoted-admin` / `user-demoted-admin` — Admin role changes
- `user-deleted` — User deletion

**What to monitor:**
- **Rapid `lobby-created` events from a single IP** → potential lobby spam/DoS
- **Multiple `login-failed` events from the same user/IP** → brute-force attack (though account lockout should trigger first)
- **`user-registered` spikes** → potential account farming
- **`match-over` without a preceding `lobby-created`** → investigate possible fake reports

### Rate Limit Monitoring

Rate-limited requests return HTTP 429 with a `Retry-After` header. Log these to identify:
- Registration flooding (multiple accounts from one IP)
- Login brute-force (even if account lockout triggers)
- API abuse (excessive lobby listing, etc.)

### WebSocket Abuse

Monitor for:
- Players joining lobbies they don't participate in (signaling relay abuse)
- Players sending `match-over` claims (once fixed, rejected non-hosts will show as errors)
- WebSocket connection floods (once the connection rate limiter is implemented)


---

## Additional Cheat Vectors (Part 2)

### 6. P2P Player ID Spoofing (INPUT FORGERY)

**File:** `public/app.js`, P2P message handler (line 1733-1736)

The host receives inputs via P2P data channels. The `playerId` in the input payload is taken from the P2P message, NOT authenticated:

```typescript
// In P2P message handler:
if (p2p.isHost) {
    if (msg.type === "input") {
        gameMgr.pendingInputs[msg.playerId] = msg.input;
    }
}
```

**Problem:** Any peer connected to the host can send:
```json
{ "type": "input", "playerId": "<victim-player-id>", "input": { "action": "propose-move", "from": [0,4], "to": [7,4] } }
```
The host will process this input as if it came from the victim player. This allows:
- **Vote hijacking:** An attacker can propose moves on behalf of other players, stealing their turn.
- **Illegal move injection:** Even though `isLegalMove()` is called, a malicious host (who controls the game module in DevTools) can bypass this check.

**Mitigation:** Since P2P data channels don't have message-level authentication, the host cannot verify the sender's identity from the message alone. Options:
- **Sign inputs:** Each peer signs its inputs with a key derived from the server-assigned player ID + session token. The host verifies the signature. *(Moderate effort.)*
- **Server-side input relay:** Route all game inputs through the server WebSocket (not P2P) so the server can authenticate them. This adds latency but eliminates spoofing. *(Moderate effort, requires architecture change.)*
- **Input consistency checking:** Non-host peers monitor the host's state for impossible moves (e.g., a player voting when it's not their team's turn). If detected, they can vote to kick the host. *(Moderate effort.)*

### 7. P2P Game-State Injection (FAKE STATE OVERRIDE)

**File:** `public/app.js`, P2P message handler (line 1738-1739)

Non-host peers blindly accept `game-state` messages from ANY peer, not just the host:

```typescript
if (msg.type === "game-state") {
    gameMgr.receiveState(msg.state, msg.tick);
}
```

**Problem:** A malicious non-host peer can broadcast:
```json
{ "type": "game-state", "state": { ...fake win state... }, "tick": 999999 }
```
Since `receiveState` just replaces the local state (`this.state = newState`), the fake state with a high tick number will override the host's legitimate state on all other non-host peers.

**Exploit scenario:** In the final moments of a chess match, a malicious peer broadcasts a fake state showing the attacker's piece capturing the enemy king, along with a fake `match-over` message. All non-host peers see the attacker as the winner, even though the actual game result was different.

**Mitigation:**
- **Tag game states with the sender's peer ID** and only accept states from the host.
- **Tick validation:** Only accept states with `tick <= hostTick + 1` (allowing for one-tick network delay).
- **State delta validation:** Compare received states to previous states and reject impossible transitions (e.g., piece teleportation, illegal captures).

### 8. P2P Match-Over Forgery (PREMATURE GAME END)

**File:** `public/app.js`, P2P message handler (line 1741-1742)

Any peer can broadcast a `match-over` message via P2P:

```typescript
if (msg.type === "match-over") {
    gameMgr.receiveMatchOver(msg.winner, msg.winnerName);
}
```

**Problem:** `receiveMatchOver` immediately sets `state.matchEnded = true` and shows results, with no check that the message came from the host:

```typescript
receiveMatchOver(winnerId, winnerName) {
    if (state.matchEnded) return;
    state.matchEnded = true;
    this.showResults(winnerId, winnerName, this.state?.timestamp || 0);
}
```

**Exploit scenario:** A player who is about to lose sends `{ type: "match-over", winner: "<their-own-id>", winnerName: "hacker" }` via P2P broadcast. All other peers immediately see the match as over with the attacker as the winner.

**Mitigation:** Only accept `match-over` from the host (check `peerId === state.hostId` in the `onMessage` handler). Or, require the host's `match-over` to be confirmed by at least one other peer before accepting it.

### 9. Chat Name and Team Spoofing

**File:** `public/app.js`, chat handling (lines 1718-1732, 1526)

**Problem:** When a peer receives a chat message, the `playerName` comes from the P2P message (forgeable), not verified:

```typescript
displayChatMessage(msg.playerName, msg.message, "team", msg.senderTeam);
```

The `escapeHTML` function protects against XSS, but a malicious peer can:
- Use any name (including `"ADMIN"` or another player's name)
- Forge `senderTeam` to receive team-only chat they shouldn't see

**Mitigation:**
- Use a verified player name from the lobby roster (matched by `peerId`), not the `playerName` in the chat message.
- Verify team membership server-side (via the lobby's player-to-team mapping).
- Include a sequence number in chat messages to prevent replay.

### 10. Replay gameModule Path Injection

**File:** `public/ui/archive.js`, line 1904 and `public/app.js`, line 1904

```typescript
const gameModulePath = "/games/" + (replay.gameModule || "chess-royale") + "/mod.js";
const imported = await import(gameModulePath);
```

**Problem:** `replay.gameModule` comes from localStorage (user-editable). If a user crafts a malicious replay with `gameModule: "../../api/auth/login"`, the import path becomes `/games/../../api/auth/login/mod.js` which resolves to `/api/auth/login/mod.js`. While this doesn't directly execute code (the server returns JSON, not JS), a clever attacker who has placed a JS file somewhere on the server (e.g., via an upload vulnerability) could load it.

More practically, if `gameModule` contains `../../../` it could escape the `games/` directory and load an arbitrary file as a JS module. The browser would try to execute it, potentially leading to XSS if the file contains HTML/JS content.

**Mitigation:** Validate `replay.gameModule` against a whitelist of known game IDs. The game config endpoint (`/api/game-config`) returns the current game, so the client should only allow importing from the set of known games.

### 11. Lobby Enumeration via WebSocket

**File:** `server/signaling.ts`, `list-lobbies` handler (line 161)

**Problem:** The `list-lobbies` WebSocket handler has no rate limiting. While HTTP API endpoints have rate limiting, WebSocket messages bypass it. Any connected player can send thousands of `list-lobbies` messages per second, each triggering a `kv.list()` scan.

**Exploit scenario:** An attacker opens multiple WebSocket connections and floods the server with `list-lobbies` requests, causing excessive KV reads and potential performance degradation.

**Mitigation:** Apply the same rate limiting to WebSocket `list-lobbies` as HTTP API endpoints.

### 12. Session Token Not Bound to IP/User-Agent

**File:** `server/auth.ts`

**Problem:** Session tokens are stored in Deno KV with no binding to IP address or User-Agent. If a session token is stolen (via XSS, network sniffing, or log exposure), it can be used from any IP and any browser.

**Mitigation:** Store the client's IP address and User-Agent hash alongside the session. On each request, verify they match. Allow IP changes for mobile users, but block User-Agent changes (which indicate token theft from a different browser). This adds complexity but significantly reduces the window of opportunity for stolen tokens.

### 13. Predictable Game Seed

**File:** `server/lobbies.ts`, `generateSeed()` (line 26)

```typescript
function generateSeed(): number {
    return Math.floor(Math.random() * 2147483647) + 1;
}
```

**Problem:** `Math.random()` is not cryptographically secure. In V8 (used by Deno), `Math.random()` is a xorshift128+ PRNG seeded from system entropy, which is unpredictable in practice. However, it's not guaranteed to be cryptographically secure. If an attacker can observe multiple seeds, they might be able to predict future seeds.

**Note:** The seed controls piece assignment in Chess Royale, not game mechanics. Predicting the seed would allow an attacker to know which pieces they and their teammates will get, which is a minor information leak at best.

**Mitigation:** Use `crypto.getRandomValues()` for seed generation:
```typescript
function generateSeed(): number {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
}
```

### 14. No Host Migration on Host Disconnect

**File:** `server/signaling.ts`, `handleWebSocketClose`

**Problem:** When the host disconnects, no new host is elected. The remaining players are stuck — they can't start a new match, and the host's game simulation stops. An attacker could exploit this by intentionally disconnecting at a critical moment to freeze the game.

**Mitigation:** When the host leaves, automatically elect the next player (or the first connected player) as the new host. Reset the lobby to "waiting" status and broadcast the new host to all players.

### 15. No Server-Side Logging of WebSocket IPs

**File:** `server/mod.ts`

**Problem:** When a WebSocket connects, the server logs the player ID and username, but not the client IP address. This makes it harder to trace abuse (lobby spam, signaling relay abuse, etc.) back to the offending IP.

**Mitigation:** Log the client IP alongside WebSocket connection/disconnection events. Add IP tracking to the `ConnectionInfo` interface.

---

## Additional Existing Protections (More Items)

| Protection | Strength | What It Prevents |
|---|---|---|
| **Lobby timeout** (30 min idle expiry) | Medium | Stale lobbies consuming KV space |
| **Signal TTL** (5 min auto-expiry) | Medium | Stale signaling data in phonebook |
| **Peer TTL** (2 min auto-expiry) | Medium | Stale peer entries in phonebook |
| **Signal max-per-peer** (50 limit, trims oldest) | Medium | Signal storage DoS |
| **Host-only match start** | Strong | Non-hosts starting games prematurely |
| **Banned users blocked on WS connect** | Strong | Banned users can't join via WebSocket |
| **WebSocket kick on same-user reconnect** | Medium | Prevents duplicate connections |
| **Player name length limit** (16 chars) | Medium | Excessively long names in UI |
| **Lobby name length limit** (60 chars) | Medium | Excessively long lobby names |
| **Game ID whitelist** (chess-royale is default) | Medium | Unknown game module injection (partially) |
| **Lobby type validation** (open/signup/private only) | Strong | Invalid lobby types |
| **Max players clamped** (2-20) | Strong | Excessive player counts |
| **Min players clamped** (2-10) | Strong | Impossible player requirements |
| **Seed nullified on lobby reset** | Medium | Seed reuse across matches |
