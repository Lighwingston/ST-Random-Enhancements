/**
 * Prompt Optimizer Feature
 *
 * Speeds up SillyTavern's prompt generation by intercepting token counting
 * AJAX calls and handling them locally, eliminating 40-150+ HTTP round-trips
 * per generation.
 *
 * How it works:
 *  - Patches jQuery.ajax to intercept calls to /api/tokenizers/* endpoints
 *  - In "Accurate" mode: lets the first call through to the server, caches
 *    the result in a global LRU cache (not per-chat, not padding-scoped),
 *    and serves subsequent identical requests from cache
 *  - In "Fast" mode: uses a local heuristic estimator (no HTTP at all),
 *    with a configurable safety margin to avoid context overflow
 *  - In "Server" mode: passes everything through unchanged (disabled)
 *
 * SillyTavern's built-in token cache has three weaknesses this addresses:
 *  1. Per-chat scoping — same system prompt is re-tokenized for each chat
 *  2. Padding baked into cache key — same text with different padding = miss
 *  3. Growing strings (world-info budget loop) always miss
 *
 * This intercept operates below ST's cache, catching the AJAX calls that
 * slip through. In "Fast" mode it eliminates all network calls entirely.
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX = '[Enhancements:PromptOptimizer]';

const defaultSettings = {
    promptOptimizerEnabled: true,
    tokenCountMode: 'accurate',   // 'fast' | 'accurate' | 'server'
    fastModeSafetyMargin: 5,      // percentage overestimate in fast mode
    tokenCacheSizeLimit: 10000,   // max LRU cache entries
};

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

class LRUCache {
    /** @param {number} maxSize */
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        /** @type {Map<string, any>} */
        this.cache = new Map();
    }

    /**
     * Get a value and promote it to most-recently-used.
     * @param {string} key
     * @returns {any|undefined}
     */
    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        // Move to end (most recent)
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    /**
     * Set a value, evicting the oldest entry if at capacity.
     * @param {string} key
     * @param {any} value
     */
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict oldest (first) entry
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {LRUCache} */
let tokenCache = null;

/** Saved reference to the real jQuery.ajax */
let originalAjax = null;

/** Whether the patch is currently installed */
let patchInstalled = false;

/** Statistics for the current session */
const stats = {
    hits: 0,
    misses: 0,
    heuristicCalls: 0,
    serverCalls: 0,
    reset() {
        this.hits = 0;
        this.misses = 0;
        this.heuristicCalls = 0;
        this.serverCalls = 0;
    },
};

/** Shared UTF-8 encoder for the heuristic */
const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

function isEnabled() {
    const s = getSettings();
    return s?.promptOptimizerEnabled && s?.tokenCountMode !== 'server';
}

function getMode() {
    return getSettings()?.tokenCountMode || 'accurate';
}

/**
 * Fast 32-bit string hash (same algorithm SillyTavern uses).
 * @param {string} str
 * @returns {string}
 */
function fastHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Heuristic token estimator
// ---------------------------------------------------------------------------

/**
 * Estimates the token count for a given text string.
 *
 * Uses UTF-8 byte length divided by a bytes-per-token ratio.
 * This matches SillyTavern's own `guesstimate()` approach (byteLength / 3.35)
 * but operates at the AJAX intercept level, eliminating HTTP overhead.
 *
 * The safety margin is applied by the caller, not here.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    const byteLength = textEncoder.encode(text).length;

    // 3.35 bytes per token — same ratio as SillyTavern's guesstimate().
    // This slightly overestimates for most modern tokenizers (which average
    // ~3.5-3.8 bytes/token for English), making it conservative/safe for
    // budget calculations.
    return Math.ceil(byteLength / 3.35);
}

// ---------------------------------------------------------------------------
// AJAX intercept
// ---------------------------------------------------------------------------

/**
 * Checks whether a URL is a SillyTavern tokenizer endpoint.
 * @param {string} url
 * @returns {boolean}
 */
function isTokenizerEndpoint(url) {
    return typeof url === 'string' && url.includes('/api/tokenizers/');
}

/**
 * Checks whether a URL is the OpenAI-specific token counting endpoint.
 * OpenAI uses a different request/response format:
 *  - Request body: JSON array of messages [{role, content}]
 *  - Response: { token_count: N }  (vs. { count: N } for others)
 * @param {string} url
 * @returns {boolean}
 */
function isOpenAIEndpoint(url) {
    return typeof url === 'string' && url.includes('/api/tokenizers/openai/');
}

/**
 * Extracts the text content from a tokenizer AJAX request body.
 * @param {string} bodyString  The JSON-stringified request body
 * @param {boolean} isOpenAI   Whether this is the OpenAI endpoint format
 * @returns {string}           The text to be tokenized
 */
function extractText(bodyString, isOpenAI) {
    try {
        const parsed = JSON.parse(bodyString);

        if (isOpenAI) {
            // OpenAI sends [{role: 'system', content: '...'}]
            if (Array.isArray(parsed)) {
                return parsed.map(m => m.content || '').join('\n');
            }
            return '';
        }

        // Standard format: { text: '...' }
        return parsed.text || '';
    } catch {
        return '';
    }
}

/**
 * Builds a fake AJAX response for a given token count.
 * @param {number} count
 * @param {boolean} isOpenAI
 * @returns {object}
 */
function buildResponse(count, isOpenAI) {
    if (isOpenAI) {
        // OpenAI endpoint expects { token_count: N }
        // countTokensOpenAI/Async reads data.token_count
        return { token_count: count };
    }
    // Standard endpoint expects { count: N }
    // countTokensFromServer reads data.count
    return { count };
}

/**
 * Resolves a jQuery.ajax call synchronously with cached/heuristic data.
 * Calls the `success` callback (which sets the caller's tokenCount variable)
 * and returns a resolved jQuery Deferred for chaining.
 *
 * @param {object} settings  The jQuery.ajax settings object
 * @param {object} data      The response data to return
 * @returns {object}         A resolved jQuery Deferred promise
 */
function respondImmediately(settings, data) {
    // Call success callback synchronously — this is what sets the token count
    // in countTokensFromServer's outer scope variable
    if (typeof settings.success === 'function') {
        settings.success.call(null, data);
    }

    // Return a resolved Deferred so any .done()/.then() chains work
    const deferred = jQuery.Deferred();
    deferred.resolve(data, 'success');
    return deferred.promise();
}

/**
 * The patched jQuery.ajax function.
 * Intercepts tokenizer endpoint calls; passes everything else through.
 */
function patchedAjax(...args) {
    // Normalize jQuery.ajax(url, settings) vs jQuery.ajax(settings)
    const url = typeof args[0] === 'string'
        ? args[0]
        : (args[0]?.url || '');
    const settings = typeof args[0] === 'string'
        ? (args[1] || {})
        : (args[0] || {});

    // Only intercept tokenizer POST calls
    if (!isEnabled() || !isTokenizerEndpoint(url) || (settings.type || settings.method || 'GET').toUpperCase() !== 'POST') {
        return originalAjax.apply(jQuery, args);
    }

    const bodyString = settings.data || '';
    const isOpenAI = isOpenAIEndpoint(url);
    const text = extractText(bodyString, isOpenAI);

    // Can't extract text → pass through
    if (!text) {
        return originalAjax.apply(jQuery, args);
    }

    // Build cache key from URL + full request body.
    // Using the full body (not just extracted text) ensures that remote
    // tokenizer calls (Kobold, TextGenWebUI) which include a server URL
    // and model in the body get separate cache entries per server/model.
    const cacheKey = fastHash(url + '|' + bodyString);

    // ── Cache hit ──────────────────────────────────────────────────────
    const cached = tokenCache.get(cacheKey);
    if (cached !== undefined) {
        stats.hits++;
        return respondImmediately(settings, cached);
    }

    stats.misses++;

    // ── Fast mode: heuristic estimation ────────────────────────────────
    if (getMode() === 'fast') {
        let estimated = estimateTokens(text);

        // For OpenAI message format, add per-message overhead (~4 tokens each)
        if (isOpenAI) {
            try {
                const messages = JSON.parse(bodyString);
                if (Array.isArray(messages)) {
                    estimated += messages.length * 4;
                }
            } catch { /* ignore */ }
        }

        // Apply safety margin
        const margin = getSettings().fastModeSafetyMargin || 0;
        if (margin > 0) {
            estimated = Math.ceil(estimated * (1 + margin / 100));
        }

        const response = buildResponse(estimated, isOpenAI);
        tokenCache.set(cacheKey, response);
        stats.heuristicCalls++;

        return respondImmediately(settings, response);
    }

    // ── Accurate mode: pass through, cache the server response ─────────
    stats.serverCalls++;

    const originalSuccess = settings.success;
    settings.success = function (data, textStatus, jqXHR) {
        // Cache the real server response for future identical requests
        tokenCache.set(cacheKey, data);
        if (typeof originalSuccess === 'function') {
            originalSuccess.call(this, data, textStatus, jqXHR);
        }
    };

    // Pass through with the wrapped success callback
    // Reconstruct args to include the modified settings
    if (typeof args[0] === 'string') {
        return originalAjax.call(jQuery, args[0], settings);
    }
    return originalAjax.call(jQuery, settings);
}

// ---------------------------------------------------------------------------
// Patch management
// ---------------------------------------------------------------------------

function installPatch() {
    if (patchInstalled) return;

    originalAjax = jQuery.ajax.bind(jQuery);
    jQuery.ajax = patchedAjax;
    patchInstalled = true;
    console.log(`${LOG_PREFIX} jQuery.ajax intercept installed`);
}

function uninstallPatch() {
    if (!patchInstalled || !originalAjax) return;

    jQuery.ajax = originalAjax;
    originalAjax = null;
    patchInstalled = false;
    console.log(`${LOG_PREFIX} jQuery.ajax intercept removed`);
}

// ---------------------------------------------------------------------------
// Settings HTML
// ---------------------------------------------------------------------------

const settingsHtml = `
<hr>
<h4>Prompt Optimizer</h4>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enhancements_prompt_optimizer_enabled">
        <input type="checkbox" id="enhancements_prompt_optimizer_enabled" />
        <span>Enable prompt generation optimizer</span>
    </label>
</div>
<small class="textAlignCenter">
    Speeds up prompt generation by reducing or eliminating HTTP round-trips
    for token counting. SillyTavern makes 40-150+ sequential AJAX calls to
    count tokens during each generation — this intercepts them and serves
    results from a global cache or local heuristic.
</small>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enhancements_token_count_mode">
        Token Counting Mode
    </label>
    <select id="enhancements_token_count_mode" class="text_pole">
        <option value="accurate">Accurate — cache server results globally</option>
        <option value="fast">Fast — local heuristic estimation (no HTTP)</option>
        <option value="server">Server — original behavior (no optimization)</option>
    </select>
</div>
<small class="textAlignCenter" id="enhancements_mode_description">
    <b>Accurate:</b> First request goes to the server; identical requests served
    from a global cache that works across chats. Best balance of speed and accuracy.
</small>

<div class="flex-container flexFlowColumn marginTopBot5" id="enhancements_safety_margin_container">
    <label for="enhancements_safety_margin">
        Safety Margin: <span id="enhancements_safety_margin_value">5</span>%
    </label>
    <input type="range" id="enhancements_safety_margin" min="0" max="20" step="1" value="5" />
</div>
<small class="textAlignCenter" id="enhancements_safety_margin_desc">
    Overestimates token count by this percentage in Fast mode to prevent
    context overflow. Higher = safer but wastes more context window.
</small>

<div class="flex-container marginTopBot5" style="gap: 8px;">
    <div id="enhancements_clear_token_cache_btn" class="menu_button menu_button_icon" style="flex: 1;">
        <i class="fa-solid fa-trash"></i>
        <span>Clear Cache</span>
    </div>
    <div id="enhancements_reset_stats_btn" class="menu_button menu_button_icon" style="flex: 1;">
        <i class="fa-solid fa-rotate-left"></i>
        <span>Reset Stats</span>
    </div>
</div>

<div id="enhancements_cache_stats" style="font-size: 0.85em; opacity: 0.75; text-align: center; padding: 4px 0;">
    Cache: 0 entries &nbsp;|&nbsp; Hits: 0 &nbsp;|&nbsp; Misses: 0
</div>`;

// ---------------------------------------------------------------------------
// Mode descriptions (update on change)
// ---------------------------------------------------------------------------

const modeDescriptions = {
    accurate:
        '<b>Accurate:</b> First request goes to the server; identical requests served ' +
        'from a global cache that works across chats. Best balance of speed and accuracy.',
    fast:
        '<b>Fast:</b> All token counts estimated locally using a heuristic — zero HTTP ' +
        'calls. Fastest option, but counts may differ from the real tokenizer by ~5-15%.',
    server:
        '<b>Server:</b> Original SillyTavern behavior. All token counts go to the server. ' +
        'No optimization applied.',
};

// ---------------------------------------------------------------------------
// Settings logic
// ---------------------------------------------------------------------------

function loadSettings() {
    const settings = getSettings();
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    $('#enhancements_prompt_optimizer_enabled').prop('checked', settings.promptOptimizerEnabled);
    $('#enhancements_token_count_mode').val(settings.tokenCountMode);
    $('#enhancements_safety_margin').val(settings.fastModeSafetyMargin);
    $('#enhancements_safety_margin_value').text(settings.fastModeSafetyMargin);

    updateModeUI(settings.tokenCountMode);
}

function updateModeUI(mode) {
    // Update description
    $('#enhancements_mode_description').html(modeDescriptions[mode] || '');

    // Show/hide safety margin (only relevant in fast mode)
    const showMargin = mode === 'fast';
    $('#enhancements_safety_margin_container').toggle(showMargin);
    $('#enhancements_safety_margin_desc').toggle(showMargin);

    // Enable/disable buttons based on mode
    const isActive = mode !== 'server' && getSettings()?.promptOptimizerEnabled;
    $('#enhancements_clear_token_cache_btn').toggleClass('disabled', !isActive);
}

function onEnabledChange() {
    const settings = getSettings();
    settings.promptOptimizerEnabled = $('#enhancements_prompt_optimizer_enabled').is(':checked');
    saveSettingsDebounced();

    if (settings.promptOptimizerEnabled && settings.tokenCountMode !== 'server') {
        installPatch();
    } else if (!settings.promptOptimizerEnabled) {
        uninstallPatch();
    }

    updateModeUI(settings.tokenCountMode);
}

function onModeChange() {
    const settings = getSettings();
    settings.tokenCountMode = String($('#enhancements_token_count_mode').val());
    saveSettingsDebounced();

    updateModeUI(settings.tokenCountMode);

    // Install or remove patch based on new mode
    if (settings.promptOptimizerEnabled && settings.tokenCountMode !== 'server') {
        installPatch();
    } else {
        uninstallPatch();
    }
}

function onSafetyMarginChange() {
    const val = parseInt($('#enhancements_safety_margin').val(), 10) || 0;
    getSettings().fastModeSafetyMargin = val;
    $('#enhancements_safety_margin_value').text(val);
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Cache stats updater
// ---------------------------------------------------------------------------

let statsInterval = null;

function updateStatsDisplay() {
    const cacheSize = tokenCache ? tokenCache.size : 0;
    const total = stats.hits + stats.misses;
    const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(1) : '—';

    $('#enhancements_cache_stats').html(
        `Cache: <b>${cacheSize}</b> entries &nbsp;|&nbsp; ` +
        `Hits: <b>${stats.hits}</b> &nbsp;|&nbsp; ` +
        `Misses: <b>${stats.misses}</b> &nbsp;|&nbsp; ` +
        `Rate: <b>${hitRate}%</b>`,
    );
}

function startStatsUpdater() {
    if (statsInterval) return;
    statsInterval = setInterval(updateStatsDisplay, 2000);
}

// ---------------------------------------------------------------------------
// Public init — called by the base script
// ---------------------------------------------------------------------------

/**
 * @param {JQuery} contentContainer  The .inline-drawer-content element to append settings into
 */
export function init(contentContainer) {
    const settings = getSettings();

    // Initialize cache
    tokenCache = new LRUCache(settings.tokenCacheSizeLimit || defaultSettings.tokenCacheSizeLimit);

    // Append settings UI
    contentContainer.append(settingsHtml);
    loadSettings();

    // Bind settings events
    $('#enhancements_prompt_optimizer_enabled').on('change', onEnabledChange);
    $('#enhancements_token_count_mode').on('change', onModeChange);
    $('#enhancements_safety_margin').on('input', onSafetyMarginChange);

    // Clear cache button
    $('#enhancements_clear_token_cache_btn').on('click', () => {
        if ($('#enhancements_clear_token_cache_btn').hasClass('disabled')) return;
        tokenCache.clear();
        console.log(`${LOG_PREFIX} Token cache cleared`);
        updateStatsDisplay();
    });

    // Reset stats button
    $('#enhancements_reset_stats_btn').on('click', () => {
        stats.reset();
        console.log(`${LOG_PREFIX} Stats reset`);
        updateStatsDisplay();
    });

    // Install the jQuery.ajax patch if enabled
    if (settings.promptOptimizerEnabled && settings.tokenCountMode !== 'server') {
        installPatch();
    }

    // Start periodic stats display update
    startStatsUpdater();

    console.log(`${LOG_PREFIX} Feature initialized (mode: ${settings.tokenCountMode})`);
}
