# Security Operations Checklist

A practical, actionable checklist for maintaining TournGames security after deployment. Update this file as you implement fixes and run security audits.

---

## ✅ Pre-Deployment Checklist

### Infrastructure
- [ ] **Deploy behind HTTPS** (Deno Deploy provides automatic TLS with a custom domain)
- [ ] **Set `TURN_SERVER_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`** environment variables for NAT traversal
- [ ] **Set up a custom domain** (enables `Secure` cookie flag, HSTS is effective)
- [ ] **Replace CORS origin placeholder** — update `allowedOrigins` in `mod.ts` with your real domain
- [ ] **Replace `YOUR_DOMAIN.com`** placeholders in all files with your actual domain
- [ ] **Set `DENO_DEPLOYMENT_ID`** — automatically set by Deno Deploy, don't set manually
- [ ] **Configure log shipping** — stream `auditLog` entries to an external service for alerting

### Secrets Management
- [ ] **`.env` is in `.gitignore`** (already done — do NOT commit secrets)
- [ ] **Rotate all API keys** in `.env` before deploying to production
- [ ] **Don't commit `.env`** — verified via `git status` (should show nothing)
- [ ] **Consider using Deno Deploy Secrets** instead of `.env` for production

### Database
- [ ] **Verify `purgeAllLobbies()` runs on startup** — ensures clean state on deploy
- [ ] **Review KV key structure** — ensure no sensitive data (passwords, tokens) is stored unencrypted

## 🚀 Post-Deployment Checklist (First Week)

### Monitor for Attacks
- [ ] **Check audit logs** (`GET /api/admin/audit`) for unusual activity
  - Rapid lobby creation
  - Failed login spikes
  - Suspicious admin actions
- [ ] **Monitor HTTP 429 responses** — identify rate-limited IPs/attackers
- [ ] **Watch for WebSocket abuse** — check connection counts, message rates
- [ ] **Verify `.env` is not publicly accessible** — try `curl https://yourdomain/.env` (should 404)

### Verify Security Headers
- [ ] **Check response headers** with `curl -I https://yourdomain.com/`:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
  - `Content-Security-Policy` with `script-src 'self'` (no `'unsafe-inline'`)
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
- [ ] **Submit to HSTS preload list** — https://hstspreload.org/ (after HTTPS is confirmed stable)

### Test Authentication
- [ ] **Register a new account** and verify rate limiting works
- [ ] **Fail login 5 times** — verify account lockout triggers
- [ ] **Test CSRF** — verify POST requests without `x-csrf-token` header are rejected
- [ ] **Test admin access** — verify non-admin users get 403 on admin endpoints

## 📅 Weekly Checklist

### Security Monitoring
- [ ] **Audit log review** — scan for new admin actions, ban events, lobby creation spikes
- [ ] **Rate limit violations** — check for IPs that hit rate limits
- [ ] **User enumeration** — check if "Username already taken" messages are being probed
- [ ] **Profanity filter efficacy** — review usernames/lobby names that passed the filter

### Dependency Updates
- [ ] **Check `bad-words` npm package** — run `deno cache` to check for updates: `npm:bad-words@3.0.0` → latest
- [ ] **Update Deno version** — check deno.land for latest stable Deno 2.x release
- [ ] **Review game modules** for new vulnerabilities (they're loaded as native JS — any `eval` or `document.write` would be catastrophic)

### Penetration Testing
- [ ] **CSRF test** — verify all POST/PUT/DELETE endpoints reject requests without valid CSRF token
- [ ] **CORS test** — from a different origin, try reading API responses (should be blocked)
- [ ] **XSS test** — register with usernames containing `<script>` tags (should be rejected by validation)
- [ ] **WebSocket CSWSH test** — from a different origin, try opening a WebSocket connection

## 📆 Monthly Checklist

### Deep Security Review
- [ ] **Password policy review** — ensure PBKDF2 iterations meet current OWASP recommendations
- [ ] **Session management audit** — review session TTL (30 days), cookie flags (HttpOnly, SameSite=Strict, Secure)
- [ ] **Invite code audit** — verify invite codes use sufficient entropy (6 chars from 32-char alphabet = ~30 bits of entropy — consider increasing to 8 chars)
- [ ] **Deno KV permissions** — review KV access patterns, ensure no unnecessary read/write access
- [ ] **Game module integrity** — verify game modules haven't been modified (compare checksums)
- [ ] **Replay a past penetration test** — re-run any manual tests from the previous month

### Code Review
- [ ] **Review new PRs** for common vulnerability patterns:
  - `innerHTML` assignments with user data (should use `escapeHtml` or `textContent`)
  - `new Function()` or `eval()` calls (should be banned)
  - Dynamic `import()` with user-controlled paths (should validate against whitelist)
  - `JSON.parse()` of untrusted data (should wrap in try/catch — already done)
  - Missing CSRF checks on state-changing endpoints
  - Missing rate limiting on new endpoints
  - Missing authentication checks on admin endpoints
  - Non-constant-time comparisons for secrets (invite codes, tokens)

## 🎯 Quarterly Checklist

### Architecture Review
- [ ] **Assess host-authoritative model** — re-evaluate whether server-side game state validation is feasible
- [ ] **Review P2P mesh routing** — consider switching to host-relay-only topology to reduce attack surface
- [ ] **Evaluate multi-region rate limiting** — the in-memory rate limiter doesn't share state across Deno Deploy regions
- [ ] **Consider Web Application Firewall (WAF)** — Deno Deploy doesn't have a built-in WAF; consider CloudFlare in front
- [ ] **Penetration test by external party** — hire a security firm for a full penetration test
- [ ] **Update threat model** — review and update this document based on new threats

### Incident Response
- [ ] **Review incident response plan** — ensure team knows how to respond to breaches
- [ ] **Test breach notification** — verify you can notify affected users
- [ ] **Rotate all secrets** — session signing keys, API keys, TURN credentials
- [ ] **Review and prune access logs** — ensure logs are retained for compliance

## 🔍 Ongoing: How to Triage New Vulnerabilities

When a new vulnerability is reported:

1. **Can a script kiddie exploit it?** If yes → **immediate fix** (push within 24 hours)
2. **Can a low-skill attacker exploit it?** If yes → **fix within 7 days**
3. **Requires skilled attacker + specific conditions?** If yes → **fix within 30 days**
4. **Theoretical / requires physical access / requires server compromise?** → **document and monitor**

### Priority Order for Known Issues

| Priority | Issue | Effort | ETA |
|---|---|---|---|
| P0 | Fix CORS wildcard with credentials | Easy | Immediate |
| P0 | Add WebSocket Origin validation | Easy | Immediate |
| P0 | Scope signaling to same-lobby peers | Easy | 1-2 days |
| P1 | Require host for match-over reports | Easy | 1-2 days |
| P1 | Tighten CSP (remove `unsafe-inline` from script-src) | Easy | 1-2 days |
| P1 | Escape username in auth.js `innerHTML` | Easy | 1-2 days |
| P2 | Increase PBKDF2 iterations to 310k | Easy | Next deploy |
| P2 | Add request body size limiting | Medium | Next deploy |
| P2 | Rate-limit WebSocket connections per IP | Medium | Next deploy |
| P2 | Rotate sessions on login | Easy | Next deploy |
| P3 | Constant-time invite code comparison | Easy | Next deploy |
| P3 | Add security.txt | Easy | Next deploy |
| P4 | Server-authoritative game simulation | Very Hard | Future refactor |
| P4 | Multi-region rate limiting with KV | Hard | Future |
| P4 | Message signing for P2P relay | Hard | Future |

---

## 📞 Emergency Contacts

- **GitHub security advisory:** https://github.com/moelanoby/tourngames/security/advisories
- **Report a vulnerability:** Open a private security advisory on GitHub (do NOT open a public issue)
- **Breach response:** Check [`VULNERABILITY-ASSESSMENT.md`](./VULNERABILITY-ASSESSMENT.md) for affected components

## 📚 Further Reading

- [OWASP Top 10](https://owasp.org/Top10/)
- [OWASP CORS Misconfiguration](https://owasp.org/www-community/attacks/csrf)
- [OWASP Cross-Site WebSocket Hijacking](https://owasp.org/www-community/attacks/csrf)
- [OWASP Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [Deno Security Guide](https://docs.deno.com/deploy/security/)
- [WebRTC Security](https://webrtc-security.github.io/)


---

## 📅 Additional Checklist Items

### 🚀 Post-Deployment (Extended)

#### P2P Security
- [ ] **Verify P2P input signing** — test that forged inputs are rejected by host
- [ ] **Verify game-state source validation** — test that non-host game-state messages are rejected
- [ ] **Verify match-over source validation** — test that only host can end match
- [ ] **Verify chat message authentication** — test that forged names/teams are rejected
- [ ] **Test replay gameModule whitelist** — attempt to load invalid game module

#### Rate Limiting
- [ ] **Verify WebSocket rate limiting** — send 31+ `list-lobbies` in a minute, verify 429/block
- [ ] **Verify invite code rate limiting** — attempt 6+ `join-specific` in a minute
- [ ] **Verify lobby create rate limiting via WS** — attempt 11+ `create-lobby` in a minute

#### Session Security
- [ ] **Test session User-Agent binding** — login, change UA header, verify session rejected
- [ ] **Test session IP change tolerance** — login from IP A, use session from IP B, verify it works (mobile-friendly)

### 📅 Weekly (Extended)

#### P2P Monitoring
- [ ] **P2P signature failure rate** — check logs for `Invalid input signature` warnings
- [ ] **Game-state rejection rate** — check for `Rejected game-state from non-host` warnings
- [ ] **Match-over forgery attempts** — check for non-host peers sending `match-over`
- [ ] **Chat impersonation attempts** — check for same IP sending as multiple names

#### Rate Limit Monitoring
- [ ] **WebSocket rate limit hits** — check for IPs hitting WS rate limits
- [ ] **Invite code brute force** — check for repeated `join-specific` with wrong codes

#### Session Anomalies
- [ ] **User-Agent mismatch sessions** — check for sessions invalidated due to UA change
- [ ] **Concurrent sessions per user** — users with > 5 active sessions (potential account sharing)

### 📆 Monthly (Extended)

#### Deep P2P Audit
- [ ] **Review all P2P message types** — ensure each has sender validation
- [ ] **Test input replay resistance** — verify inputs can't be replayed across matches
- [ ] **Verify seed cryptographic quality** — check `generateSeed` uses `crypto.getRandomValues`
- [ ] **Test host migration** — disconnect host mid-match, verify new host elected

#### Cheat Detection
- [ ] **Run property-based tests** — ensure `deno task test` passes all chess invariants
- [ ] **Review fuzz test coverage** — check `ws_fuzz_test.ts` covers new message types
- [ ] **Manual cheat attempt** — try DevTools manipulation of game state, verify detection

#### Dependency & Code Review
- [ ] **Check `bad-words` npm version** — ensure latest profanity list
- [ ] **Review game module integrity** — compare `games/chess-royale/mod.js` hash to known good
- [ ] **Audit new PRs for P2P patterns** — ensure new message types follow validation pattern

### 🎯 Quarterly (Extended)

#### Architecture Review
- [ ] **Evaluate P2P vs server-relay tradeoffs** — consider moving critical messages (match-over, game-state) to server-relay
- [ ] **Assess input signing overhead** — measure latency impact of HMAC signing
- [ ] **Consider server-authoritative simulation** — evaluate moving game logic to server

#### Advanced Testing
- [ ] **Run full penetration test** — include P2P layer, WebSocket, WebRTC
- [ ] **Test WebRTC IP leakage** — verify STUN/TURN config doesn't expose local IPs
- [ ] **Load test with malicious clients** — simulate 100 clients with forged inputs

---

## 🔍 How to Test P2P Security Features

### Test Input Signature Rejection
1. Open two browser tabs (or use two browsers)
2. Join same lobby as non-host players
3. In DevTools on one tab, modify the input sending code to send a fake `sig`
4. Send an input, verify host logs `Invalid input signature`

### Test Game-State Source Validation
1. In a match, on a non-host tab, run in console:
```javascript
state.p2pClient.broadcast({ type: "game-state", state: { fake: "state" }, tick: 9999 });
```
2. Verify other non-host peers log `Rejected game-state from non-host`
3. Verify the fake state is NOT applied (game continues normally)

### Test Match-Over Forgery Prevention
1. On a non-host tab, run in console:
```javascript
state.p2pClient.broadcast({ type: "match-over", winner: state.playerId, winnerName: "hacker" });
```
2. Verify other non-host peers do NOT show match-over screen
3. Verify the host's match continues normally

### Test Chat Impersonation Prevention
1. On a non-host tab, run in console:
```javascript
state.p2pClient.broadcast({ 
    type: "chat", 
    channel: "team", 
    playerId: state.playerId, 
    playerName: "ADMIN", 
    message: "You are banned", 
    senderTeam: 1,
    timestamp: Date.now() 
});
```
2. Verify other players see the message with the REAL sender's name, not "ADMIN"
3. Verify team chat only shows if sender is actually on that team

### Test Replay gameModule Whitelist
1. In DevTools, edit localStorage:
```javascript
localStorage.setItem("tgn_replays", JSON.stringify([{
    replayId: "test",
    gameModule: "../../api/auth/login",  // path traversal attempt
    seed: 123,
    winner: "test",
    winnerName: "test",
    players: [],
    inputs: {},
    createdAt: Date.now()
}]));
```
2. Go to Archive tab, try to load the replay
3. Verify error "Invalid game module in replay" appears

### Test Host Migration
1. Host a match, then close the host's browser tab
2. Verify remaining players see "host-changed" notification
3. Verify new host can start a new match

---

## 📊 Recommended Metrics to Track

| Metric | Target | Alert Threshold |
|---|---|---|
| P2P input signature failure rate | < 0.1% | > 1% |
| Game-state rejection rate (non-host source) | 0 | > 0 |
| Match-over forgery attempts | 0 | > 0 |
| Chat impersonation attempts | 0 | > 0 |
| WebSocket rate limit hits | < 5/min | > 20/min |
| Session UA mismatch invalidations | < 1/day | > 10/day |
| Host disconnect during active match | < 0.1% | > 1% |
| Average game duration | < 10 min | > 30 min (stalled game?) |
| KV read/write latency (p99) | < 50ms | > 200ms |
| WebSocket connection success rate | > 99% | < 95% |

---

## 🛡️ Defense-in-Depth Layers Summary

| Layer | What It Protects | Implementation |
|---|---|---|
| **Network** | CSWSH, CORS abuse | Origin validation, CORS allowlist |
| **Transport** | Session theft | HttpOnly, SameSite=Strict, Secure cookies |
| **Application** | CSRF, rate limiting | Per-session CSRF tokens, sliding-window rate limits |
| **P2P** | Input forgery, state injection | HMAC signing, source validation, tick checks |
| **Game Logic** | Cheating | Host-authoritative, input validation, isLegalMove |
| **Data** | KV injection, enumeration | Key prefixes, atomic ops, auth checks |
| **Monitoring** | Detection | Audit logs, rate limit metrics, P2P rejection metrics |
| **Incident Response** | Containment | Session revocation, ban system, admin tools |

---

## 📝 Notes for Future Game Modules

When adding new games to `games/`, ensure they follow these security patterns:

1. **Validate all inputs** in `updateGameState` — never trust client input
2. **Use `isLegalMove` or equivalent** for every player action
3. **Expose only required exports** — don't expose internal state mutators
4. **Keep `metadata.tickRate` reasonable** — too fast = CPU abuse, too slow = poor UX
5. **Implement `compileReplay` without eval** — use JSON-safe data structures
5. **No `eval`, `new Function`, `document.write`** — these are XSS vectors
6. **Use `escapeHTML`/`escapeHtml`** for any user data rendered to DOM
7. **No inline event handlers** — use `addEventListener`
8. **No dynamic imports from user data** — whitelist game modules
9. **Validate replay data** in `loadReplay` — check required fields exist
10. **Test with property-based tests** — add invariants to `chess_property_test.ts` pattern
