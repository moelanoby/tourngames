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
