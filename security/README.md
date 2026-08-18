# Security & Anti-Cheat Documentation

This folder contains security hardening guides, vulnerability assessments, anti-cheat strategies, and operational checklists for the **TournGames** application.

## Quick Start

1. **New here?** Read [`VULNERABILITY-ASSESSMENT.md`](./VULNERABILITY-ASSESSMENT.md) first — it catalogs every vulnerability found in the codebase with severity ratings and exploit scenarios.
2. **Immediate fixes** are listed in the [Quick Fix Checklist](#quick-fix-checklist) at the bottom of this file.
3. **Step-by-step hardening** instructions are in [`HARDENING-GUIDE.md`](./HARDENING-GUIDE.md).
4. **Game-specific anti-cheat** guidance is in [`ANTI-CHEAT.md`](./ANTI-CHEAT.md).
5. **Ongoing security operations** (monitoring, updates, audits) are in [`CHECKLIST.md`](./CHECKLIST.md).

## What This Covers

| Area | Scope |
|---|---|
| **Server-side** | Deno HTTP API, WebSocket signaling, Deno KV storage, auth/sessions, rate limiting, CSRF |
| **Client-side** | Browser JS (app.js, UI modules), P2P WebRTC mesh, game module loading |
| **Game logic** | Host-authoritative simulation, P2P input voting, match-over reporting, replay integrity |
| **Infrastructure** | Deno Deploy config, TLS, HSTS, CSP, CORS |

## Threat Model

**Assets to protect:**
- User accounts (credentials, session cookies)
- Game fairness (prevent cheating, score manipulation)
- Peer identity and privacy (prevent doxxing via WebRTC)
- Server integrity (prevent DoS, account takeover)

**Adversaries:**
- **Script kiddies:** Use off-the-shelf tools, basic XSS, CORS abuse, WebSocket hijacking
- **Low-skill attackers:** Can read code, modify browser JS, intercept/forge P2P messages
- **Skilled attackers:** Can run MITM, exploit race conditions, forge game states, abuse P2P mesh

---

## Quick Fix Checklist

These are the highest-impact fixes. Each can be applied independently without breaking the application.

1. **Fix CORS wildcard** — Replace `Access-Control-Allow-Origin: *` with your actual domain (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#1-fix-cors-wildcard-with-credentials))
2. **Add WebSocket Origin validation** — Only allow WS connections from your domain (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#2-validate-websocket-origin))
3. **Scope WebSocket signaling to lobbies** — Validate that sender and recipient are in the same lobby (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#3-scope-websocket-signaling-to-lobbies))
4. **Require host for match-over** — Verify `isHost` before accepting match results (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#4-validate-match-over-reports))
5. **Tighten CSP** — Remove `'unsafe-inline'` from `script-src` (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#5-tighten-content-security-policy-csp))
6. **Escape username in auth.js** — Wrap `user.username` in `escapeHtml()` (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#6-escape-username-in-auth-ui))
7. **Use constant-time comparison for invite codes** — Prevent timing attacks (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#7-constant-time-invite-code-comparison))
8. **Add request body size limits** — Prevent oversized payload DoS (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#8-limit-request-body-size))
9. **Rotate session tokens on login** — Prevent session fixation (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#9-rotate-session-tokens))
10. **Rate-limit WebSocket connections per IP** — Prevent WS connection flooding (see [HARDENING-GUIDE](./HARDENING-GUIDE.md#10-rate-limit-websocket-connections))
