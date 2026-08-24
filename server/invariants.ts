/**
 * Runtime invariant checker for the TournGames server.
 *
 * In production, these assertions validate that internal state stays
 * consistent. If an invariant is violated, we log it (and optionally
 * throw) this catches bugs that slip past the type system.
 *
 * Usage:
 * import { checkLobbyInvariant } from "./invariants.ts";
 * checkLobbyInvariant(lobby); // throws if corrupt
 */

/** Ensure a lobby's internal state is consistent. Returns list of violations. */
export function validateLobby(lobby: unknown): string[] {
 const violations: string[] = [];
 if (!lobby || typeof lobby !== "object") {
 violations.push("lobby is not an object");
 return violations;
 }
 const l = lobby as Record<string, unknown>;

 if (typeof l.id !== "string" || l.id.length === 0) violations.push("id missing or empty");
 if (typeof l.name !== "string") violations.push("name is not a string");
 if (!Array.isArray(l.players)) violations.push("players is not an array");
 if (!Array.isArray(l.signups)) violations.push("signups is not an array");
 if (typeof l.maxPlayers !== "number" || l.maxPlayers < 2) violations.push("maxPlayers invalid");
 if (typeof l.minPlayers !== "number" || l.minPlayers < 2) violations.push("minPlayers invalid");
 if (l.minPlayers && l.maxPlayers && l.minPlayers > l.maxPlayers) {
 violations.push("minPlayers > maxPlayers");
 }
 if (!Array.isArray(l.players) && l.players !== undefined) {
 violations.push("players is neither array nor undefined");
 }
 // Status must be one of the valid values
 const validStatuses = ["waiting", "starting", "playing", "ended"];
 if (!validStatuses.includes(l.status as string)) {
 violations.push(`status "${l.status}" is not valid`);
 }
 return violations;
}

/** Throws if the lobby is corrupt. Use in dev/test; log-only in prod. */
export function checkLobbyInvariant(lobby: unknown, context = ""): void {
 const violations = validateLobby(lobby);
 if (violations.length > 0) {
 const msg = `[Invariant Violation] ${context}\n ${violations.join("\n ")}`;
 if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
 // Production: log but don't crash
 console.error(msg);
 } else {
 // Dev: crash so we notice
 throw new Error(msg);
 }
 }
}

/** Returns true if the lobby has all required fields populated. */
export function isLobbyValid(lobby: unknown): boolean {
 return validateLobby(lobby).length === 0;
}
