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
