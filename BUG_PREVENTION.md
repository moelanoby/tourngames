# Bug Prevention Strategy

This document explains the mathematical tools and techniques used to
eliminate bugs in the TournGames codebase.

## What's in place

### 1. TypeScript Strict Mode (compile-time)

Enabled in `deno.json`:
```json
"compilerOptions": {
 "strict": true,
 "noUncheckedIndexedAccess": true,
 "noImplicitOverride": true,
 "noFallthroughCasesInSwitch": true
}
```

**What it catches:**
- `noUncheckedIndexedAccess`: Array access like `arr[0]` returns `T | undefined` instead of `T`, forcing you to handle the missing case. This would have caught the `lobby.signups.length` crash at compile time.
- `strict`: All the standard strict checks (null checks, implicit any, etc.)
- `noFallthroughCasesInSwitch`: Prevents missing `break` statements.

**Run:** `deno task check`

### 2. Property-Based Testing (test-time)

Files: `server/tests/chess_property_test.ts`, `server/tests/chess_thorough_test.ts`

Instead of writing individual test cases, we define **invariants** that must always hold true, then generate 100+ random game states to try to break them.

**Chess invariants tested (27 tests):**
- No move targets a same-color piece
- Pawns never move backward
- Knights only move in L-shape
- Bishops only move diagonally
- Rooks only move straight
- Queen moves diagonally OR straight
- King moves at most 1 square
- All moves stay on the board
- Every player has exactly one piece assignment
- Teams differ by at most 1 player
- Pawn starting position allows 2-square move
- Initial board has 32 pieces
- Each team has exactly 16 pieces at start
- Each team has exactly 1 king
- Game starts in voting phase with white to move
- Turn switches after voting deadline
- Empty voting round skips turn (no crash)
- Player status is always 'alive' (can vote even when captured)
- Capturing a king ends the game
- Captured pieces are marked as captured
- Random game never enters invalid state
- Same seed produces identical games
- Click on empty square does nothing
- Click during wrong team's turn does nothing

### 3. Fuzz Testing (test-time)

File: `server/tests/ws_fuzz_test.ts`

Generates 500+ random/malformed WebSocket messages and sends them to the handler, verifying it never crashes.

**What it tests:**
- 500 random messages with fuzzed fields
- 14 malformed JSON inputs (null, empty, syntax errors, wrong types)

### 4. Auth & Security Tests

File: `server/tests/auth_test.ts`

**33 tests covering:**
- Password hashing (salt uniqueness, correct/wrong password verification)
- Username validation (length, special chars, profanity)
- Password validation (length, strength scoring)
- Password strength (weak passwords rejected, strong accepted)
- Session token generation (uniqueness, length, hex format)
- Rate limiting (under/over threshold, per-key isolation, login/register limits)
- CSRF tokens (generation, validation, wrong session, empty inputs, regen)
- Input sanitization (control chars, length limits, non-string input)
- Client IP extraction (X-Forwarded-For, X-Real-IP, fallback)

### 5. Invariant Tests

File: `server/tests/invariant_test.ts`

**18 tests covering:**
- Valid lobbies pass validation
- Corrupt lobbies (null, undefined, wrong types) rejected
- Missing/empty fields rejected
- Invalid status values rejected
- minPlayers > maxPlayers rejected
- All valid statuses accepted

### 6. Runtime Invariant Checking (production)

File: `server/invariants.ts`

Validates internal state at runtime. In development, throws on violation. In production, logs but doesn't crash.

### 7. Defensive Sanitization

All external input is sanitized before being stored in KV:
- `sanitizeString()` strips control characters and limits length
- `sanitizeLobbyName()` for lobby names
- All KV writes use `try/catch` to prevent crashes
- `JSON.stringify` round-trip validates serializability before KV writes

## How to use

```bash
# Type check (fast catches compile-time bugs)
deno task check

# Run all tests (153 tests: property + fuzz + auth + invariant + chess edge + replay round-trip + local archive + phonebook)
deno task test
```

## Test summary

| Test file | Tests | What it covers |
|-----------|-------|----------------|
| `chess_property_test.ts` | 6 | Basic chess invariants |
| `chess_thorough_test.ts` | 21 | Move validation, game state, capture logic, edge cases |
| `chess_edge_cases_test.ts` | 20 | Pawn/knight/king edge cases, blocked paths, castling/promotion limitations |
| `chess_replay_roundtrip_test.ts` | 10 | loadReplay determinism, round-trip state reconstruction, null/NaN/corrupt input handling |
| `local_archive_test.ts` | 27 | localStorage replay storage: auto-numbering, rename, cap, corrupt JSON, quota exceeded, no-storage |
| `phonebook_test.ts` | 16 | Peer registration, heartbeat, unregister, signal store-and-forward, non-serializable data |
| `ws_fuzz_test.ts` | 2 | 500 random messages + 14 malformed inputs |
| `auth_test.ts` | 33 | Passwords, sessions, rate limiting, CSRF, sanitization |
| `invariant_test.ts` | 18 | Lobby validation across corrupt data |
| **Total** | **153** | **All pass in ~2s** |

## What each tool catches

| Bug type | Example | Caught by |
|----------|---------|-----------|
| Null/undefined access | `lobby.signups.length` when signups is undefined | Strict mode |
| Array out of bounds | `players[0].id` when players is empty | `noUncheckedIndexedAccess` |
| Invalid game state | Pawn moving backward | Property tests |
| Malformed input crash | `null` message crashing handler | Fuzz tests |
| Non-serializable KV write | Storing `undefined` in Deno KV | Defensive sanitization |
| State corruption | Lobby with missing fields | Runtime invariants |
| Weak password | "qwerty12" accepted as strong | Strength checker |
| CSRF token reuse | Old token still valid after regen | CSRF tests |
| Rate limit bypass | 11th login attempt not blocked | Rate limit tests |
