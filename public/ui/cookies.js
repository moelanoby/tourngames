/**
 * cookies.js - Tiny cookie utilities for TournGames
 *
 * Cookies let the site remember you across visits even when localStorage
 * is cleared by the browser (e.g. Safari ITP splits storage per-site but
 * keeps first-party cookies). Values are URI-encoded.
 *
 * All cookies are first-party, set with path=/, SameSite=Lax and Secure,
 * and expire after one year unless stated otherwise.
 */

const DEFAULT_DAYS = 365;

export function setCookie(name, value, days = DEFAULT_DAYS) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  const encoded = encodeURIComponent(String(value));
  document.cookie =
    `${name}=${encoded}; expires=${expires}; path=/; SameSite=Lax; Secure`;
}

export function getCookie(name) {
  const prefix = name + "=";
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return null;
}

export function deleteCookie(name) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
}

/** True once the visitor has accepted (or declined) the cookie notice. */
export function hasCookieConsent() {
  return getCookie("tgn_cookie_consent") !== null;
}

export function rememberCookieConsent(accepted) {
  // Store the choice itself so we never ask again either way.
  setCookie("tgn_cookie_consent", accepted ? "accepted" : "essential-only");
}

/**
 * Persist a value in a cookie AND localStorage. Reads prefer the cookie
 * (it survives storage clears) and fall back to localStorage.
 */
export function persist(key, value) {
  const str = String(value);
  try { setCookie(key, str); } catch { /* ignore */ }
  try { localStorage.setItem(key, str); } catch { /* ignore */ }
}

export function restore(key) {
  const fromCookie = getCookie(key);
  if (fromCookie !== null) return fromCookie;
  try { return localStorage.getItem(key); } catch { return null; }
}
