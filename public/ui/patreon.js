/**
 * patreon.js Patreon UI component
 *
 * The Patreon page content is largely static (defined in index.html).
 * This module handles any dynamic interactions.
 */

export function initPatreon() {
 // The Patreon section is static HTML just set the active nav
 const navBtn = document.getElementById("nav-patreon");
 if (navBtn) {
 navBtn.classList.add("text-esports-accent", "border-esports-accent");
 }
}
