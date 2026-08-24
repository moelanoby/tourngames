/**
 * Each player is a chess piece. Vote on moves with your team. Capture the king to win.
 *
 * Thin entry point. public/app.js dynamically imports this module and
 * relies on these exact named exports (plus the default bundle):
 *
 *   metadata, isLegalMove, getLegalMoves, normalizeTimers,
 *   createGameState, handleClick, voteForProposal, getLocalInput,
 *   updateGameState, render, getPlayerStatus, validateState,
 *   isMatchOver, getWinner, compileReplay, loadReplay
 *
 * Implementation lives in focused sibling modules:
 *   engine.js - pure rules/state (no DOM)
 *   replay.js - replay compile/re-simulate (no DOM)
 *   input.js  - clicks, votes, selection state
 *   render.js - canvas drawing and UX overlays
 */

export { metadata } from "./engine.js";
export { isLegalMove, getLegalMoves, normalizeTimers, createGameState, updateGameState, getPlayerStatus, validateState, isMatchOver, getWinner } from "./engine.js";
export { handleClick, voteForProposal, getLocalInput } from "./input.js";
export { render } from "./render.js";
export { compileReplay, loadReplay } from "./replay.js";

import {
 metadata as _metadata,
 createGameState as _createGameState,
 updateGameState as _updateGameState,
 getPlayerStatus as _getPlayerStatus,
 isMatchOver as _isMatchOver,
 getWinner as _getWinner,
 validateState as _validateState,
} from "./engine.js";
import {
 handleClick as _handleClick,
 voteForProposal as _voteForProposal,
 getLocalInput as _getLocalInput,
} from "./input.js";
import { render as _render } from "./render.js";
import { compileReplay as _compileReplay, loadReplay as _loadReplay } from "./replay.js";

export default {
 metadata: _metadata,
 createGameState: _createGameState,
 updateGameState: _updateGameState,
 getLocalInput: _getLocalInput,
 handleClick: _handleClick,
 voteForProposal: _voteForProposal,
 render: _render,
 getPlayerStatus: _getPlayerStatus,
 isMatchOver: _isMatchOver,
 getWinner: _getWinner,
 compileReplay: _compileReplay,
 loadReplay: _loadReplay,
 validateState: _validateState,
};
