/**
 * Enhanced TTS Feature
 *
 * Multi-voice narration for AI responses. The AI wraps spoken dialogue in
 * voice-slot markers — [v2]"line"[/v2] or [v2: whispering]"line"[/v2] — and
 * this feature turns the reply into ordered speech turns (narration and
 * dialogue in reading order), packs them into as few Gemini requests as
 * possible, assembles one audio file per response, shows progress, and offers
 * per-message replay.
 *
 * Design notes:
 *  - Markers are square-bracket wrappers so they can never collide with Gemini's
 *    angle-bracket expression tags (<gasp>, <sigh>, ...). Expression tags ride
 *    along to TTS inside a quote but are stripped from the visible message.
 *  - Gemini's multi-speaker mode takes two voices per request with a style per
 *    turn, so a narrator plus one character is a single request. A third voice
 *    starts a new request; order is never changed.
 *  - Only Gemini (Google AI Studio) is wired. OpenAI / custom are placeholders.
 *  - All synthesis goes through SillyTavern's own authenticated route
 *    /api/google/generate-native-tts, so the API key never leaves the server.
 *    Ordered turns need the extended route (see capabilities in
 *    /list-native-voices); without it each request carries one voice.
 *
 * Pure logic (parsing, packing, splitting, WAV assembly) lives in
 * ./enhanced-tts-core.js and is unit-tested under tests/.
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { oai_settings } from '../../../../openai.js';
import { copyText, isValidUrl, getStringHash } from '../../../../utils.js';

import {
    parseVoiceMarkup,
    prepareSpeechText,
    extractSpeakableSegments,
    splitVoiceSegment,
    packTurns,
    supportsStructuredTurns,
    buildGeminiTtsPayload,
    buildGeminiTurnsPayload,
    makeVoiceCacheKey,
    buildInstructionBlock,
    concatWavBuffers,
    cleanForDisplay,
} from './enhanced-tts-core.js';

const SETTINGS_KEY = 'enhancements';
const FEATURE_KEY = 'enhancedTts';
const LOG_PREFIX = '[Enhancements:EnhancedTts]';
const MAX_SLOTS = 10;
const ASSEMBLED_CACHE_VERSION = 4;

// Known Gemini TTS models (a custom name can also be typed).
const GEMINI_TTS_MODELS = [
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-flash-preview-tts',
];

// Max number of requests synthesized at once (keeps the API happy).
const SYNTH_CONCURRENCY = 2;

// A long request can exceed the provider/proxy request timeout (524). The
// per-request character budget is the user's maxCharsPerFragment setting;
// requests that still time out are halved down to this size.
const DEFAULT_MAX_REQUEST_CHARS = 1800;
const MIN_524_SPLIT_CHARS = 900;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function makeDefaultSlots() {
    return Array.from({ length: MAX_SLOTS }, (_, i) => ({
        id: i + 1,
        label: i === 0 ? 'Narrator' : '',
        voiceName: '',
        stylePrompt: '',
        enabled: i === 0, // narrator on by default, the rest opt-in
    }));
}

function defaultFeatureSettings() {
    return {
        enabled: false,
        provider: 'gemini',             // 'gemini' | 'openai'(ph) | 'custom'(ph)
        model: GEMINI_TTS_MODELS[0],
        customModel: '',
        useCustomModel: false,
        narrationMode: 'quotes',        // 'quotes' | 'audiobook'
        narratorSlot: 1,
        autoInject: false,
        autoPlay: false,
        gapMs: 250,
        maxCharsPerFragment: DEFAULT_MAX_REQUEST_CHARS,
        slots: makeDefaultSlots(),
        presets: {},
        activePreset: '',
    };
}

/** @returns {ReturnType<typeof defaultFeatureSettings>} */
function cfg() {
    return extension_settings[SETTINGS_KEY][FEATURE_KEY];
}

function ensureDefaults() {
    const root = extension_settings[SETTINGS_KEY];
    if (!root[FEATURE_KEY]) {
        root[FEATURE_KEY] = defaultFeatureSettings();
        return;
    }
    // Shallow-merge any missing top-level keys (forward-compat).
    const defaults = defaultFeatureSettings();
    for (const [key, value] of Object.entries(defaults)) {
        if (root[FEATURE_KEY][key] === undefined) root[FEATURE_KEY][key] = value;
    }
    // Repair the slots array shape.
    if (!Array.isArray(root[FEATURE_KEY].slots) || root[FEATURE_KEY].slots.length !== MAX_SLOTS) {
        const existing = Array.isArray(root[FEATURE_KEY].slots) ? root[FEATURE_KEY].slots : [];
        root[FEATURE_KEY].slots = makeDefaultSlots().map((slot, i) => ({ ...slot, ...(existing[i] || {}), id: i + 1 }));
    }
}

/** The model string actually sent to the API. */
function activeModel() {
    const c = cfg();
    return (c.useCustomModel && c.customModel.trim()) ? c.customModel.trim() : c.model;
}

// ---------------------------------------------------------------------------
// AI instruction context
// ---------------------------------------------------------------------------

const MAX_CONTEXT_LABEL_LENGTH = 80;

/**
 * Keep conversation identity metadata short and line-safe. In particular, do
 * not pass chat messages through this path: the instruction block only needs
 * names to help the model map speakers to configured voice slots.
 */
function shortContextLabel(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[\[\]<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_CONTEXT_LABEL_LENGTH);
}

/**
 * Read only the active conversation's identity fields from SillyTavern.
 * Context is optional because this module is also used by previews and while
 * no chat is selected. Returns null rather than allowing a partial/odd
 * context object to affect the normal instructions.
 */
function getMarkupInstructionContext() {
    try {
        if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') return null;
        const context = SillyTavern.getContext();
        if (!context || typeof context !== 'object') return null;

        // An empty chat is a settings/preview state, not an active conversation.
        // Do not use or inspect message contents here.
        if (!Array.isArray(context.chat) || context.chat.length === 0) return null;

        const characters = Array.isArray(context.characters) ? context.characters : [];
        const characterId = context.characterId;
        const indexedCharacter = characterId !== undefined && characterId !== null
            ? characters[Number(characterId)]
            : null;
        const namedCharacter = !indexedCharacter && context.name2
            ? characters.find(character => character?.name === context.name2)
            : null;
        const characterName = shortContextLabel(
            indexedCharacter?.name || namedCharacter?.name || context.name2,
        );
        const userName = shortContextLabel(context.name1);

        const groupId = context.groupId;
        const groups = Array.isArray(context.groups) ? context.groups : [];
        const group = groupId !== undefined && groupId !== null && groupId !== ''
            ? groups.find(candidate => String(candidate?.id) === String(groupId))
            : null;
        const groupName = shortContextLabel(group?.name);
        const groupMembers = Array.isArray(group?.members)
            ? group.members
                .map(memberId => characters.find(character =>
                    character?.avatar === memberId ||
                    (character?.id !== undefined && String(character.id) === String(memberId)) ||
                    character?.name === memberId,
                ))
                .map(character => shortContextLabel(character?.name))
                .filter(Boolean)
                .filter((name, index, names) => names.indexOf(name) === index)
                .slice(0, 6)
            : [];

        const lines = [];
        if (userName) lines.push(`  User: ${userName}`);
        if (characterName) lines.push(`  Character/speaker: ${characterName}`);
        const hasGroup = groupId !== undefined && groupId !== null && groupId !== '';
        if (hasGroup) {
            const suffix = groupMembers.length ? ` (members: ${groupMembers.join(', ')})` : '';
            lines.push(`  Group: ${groupName || 'active group'}${suffix}`);
        }
        return lines.length ? lines : null;
    } catch {
        // getContext() is not guaranteed during extension startup or previews.
        return null;
    }
}

/**
 * Build the one instruction block used by both auto-injection and the copy
 * button. The context section is metadata for speaker selection, never text
 * to be narrated or repeated in the response.
 */
function buildContextAwareInstructionBlock(slots, options = {}) {
    const block = buildInstructionBlock(slots, options);
    const contextLines = getMarkupInstructionContext();
    if (!contextLines) return block;

    return [
        block,
        '',
        '[Conversation speaker context — metadata/instructions only; never spoken]',
        ...contextLines,
        '  Use these names only to choose the matching voice-slot marker; do not repeat this metadata as dialogue.',
        '[/Conversation speaker context]',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Voice list (fetched once, cached in-module)
// ---------------------------------------------------------------------------

let voiceCache = null;
// What the server's /generate-native-tts accepts. A server without the
// extended route takes one text, voice and style per request.
let routeCapabilities = { turns: false, maxSpeakers: 1 };
let warnedOutdatedRoute = false;

async function fetchVoices() {
    if (voiceCache) return voiceCache;
    try {
        const response = await fetch('/api/google/list-native-voices', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        voiceCache = Array.isArray(json.voices) ? json.voices : [];
        routeCapabilities = {
            turns: json.capabilities?.turns === true,
            maxSpeakers: Math.min(2, Math.max(1, Number(json.capabilities?.maxSpeakers) || 1)),
        };
    } catch (err) {
        // Not cached, so the next call retries.
        console.warn(`${LOG_PREFIX} Failed to load voices:`, err);
        return [];
    }
    return voiceCache;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** key -> ArrayBuffer (one synthesized fragment) */
const fragmentCache = new Map();
/** messageHash -> { url, blob } (one assembled response) */
const assembledCache = new Map();
/** messageHashes whose audio is being generated right now */
const generating = new Set();

function slotById(id) {
    return cfg().slots.find(s => s.id === Number(id));
}

/**
 * The voice that reads a slot's lines: its own, else the narrator's, else any
 * configured voice, so a line is never dropped for a missing assignment.
 */
function voiceForSlot(slotId) {
    const own = slotById(slotId)?.voiceName?.trim();
    if (own) return own;
    const fallback = slotById(cfg().narratorSlot)?.voiceName?.trim()
        || cfg().slots.find(slot => slot.voiceName?.trim())?.voiceName.trim();
    if (fallback) console.warn(`${LOG_PREFIX} Slot ${slotId} has no voice; using ${fallback} for its lines.`);
    return fallback || '';
}

/**
 * Turn a message into ordered speech turns — narration and dialogue in reading
 * order, each with the voice and delivery style that should read it.
 */
function buildTurns(rawText) {
    const c = cfg();
    const { segments, warnings } = parseVoiceMarkup(prepareSpeechText(rawText), { narratorSlot: c.narratorSlot, maxSlots: MAX_SLOTS });
    for (const w of warnings) console.debug(`${LOG_PREFIX} ${w}`);

    const structured = supportsStructuredTurns(activeModel());
    return extractSpeakableSegments(segments, { mode: c.narrationMode, narratorSlot: c.narratorSlot })
        .flatMap(segment => splitVoiceSegment(segment, maxRequestChars()))
        .map(segment => ({
            slot: segment.slot,
            text: segment.text,
            voice: voiceForSlot(segment.slot),
            // A cue the AI wrote for this line wins over the slot's baseline.
            // Older preview models take no style at all.
            style: structured ? (segment.style || slotById(segment.slot)?.stylePrompt?.trim() || '') : '',
        }));
}

function maxRequestChars() {
    return Math.max(100, Number(cfg().maxCharsPerFragment) || DEFAULT_MAX_REQUEST_CHARS);
}

/**
 * Ordered turns with two voices per request need the extended server route
 * and a model that understands per-turn metadata (Gemini 3.8+).
 */
function usesTurnsRoute() {
    return routeCapabilities.turns && supportsStructuredTurns(activeModel());
}

function toPayload(turns, turnsRoute) {
    const model = activeModel();
    if (turnsRoute) return buildGeminiTurnsPayload(turns, { model });
    // The plain route reads one text with one voice and one style; packTurns
    // only groups turns that share both.
    return buildGeminiTtsPayload({
        text: turns.map(turn => turn.text).join('\n'),
        voice: turns[0].voice,
        model,
        instruction: turns[0].style,
    });
}

/**
 * Synthesize one request (a run of ordered turns) via SillyTavern's Google
 * TTS route.
 * @returns {Promise<ArrayBuffer>}
 */
async function synthesizeRequest(turns, turnsRoute) {
    const payload = toPayload(turns, turnsRoute);
    const cacheKey = makeVoiceCacheKey(payload);
    if (fragmentCache.has(cacheKey)) return fragmentCache.get(cacheKey);

    const useReverseProxy = oai_settings.reverse_proxy && isValidUrl(oai_settings.reverse_proxy);

    const response = await fetch('/api/google/generate-native-tts', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...payload,
            reverse_proxy: useReverseProxy ? oai_settings.reverse_proxy : '',
            proxy_password: useReverseProxy ? oai_settings.proxy_password : '',
            vertexai_auth_mode: oai_settings.vertexai_auth_mode,
            vertexai_region: oai_settings.vertexai_region,
            vertexai_express_project_id: oai_settings.vertexai_express_project_id,
        }),
    });

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { message = (await response.json()).error || message; } catch { /* keep http error */ }
        const err = new Error(message);
        err.status = response.status;
        err.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), message);
        throw err;
    }

    const buffer = await response.arrayBuffer();
    fragmentCache.set(cacheKey, buffer);
    return buffer;
}

/**
 * Status codes worth waiting out rather than failing on — free-tier rate limits
 * (429) and transient server/overload responses.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Pull a retry delay (ms) from a Retry-After header or a Google error body that
 * mentions "retry in 34s". Returns 0 when nothing usable is found.
 */
function parseRetryAfter(headerValue, message = '') {
    if (headerValue) {
        const secs = Number(headerValue);
        if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120000);
        const when = Date.parse(headerValue);
        if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 120000);
    }
    const m = /retry.{0,12}?(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i.exec(String(message));
    if (m) {
        const n = Number(m[1]);
        return Math.min(/ms/i.test(m[2]) ? n : n * 1000, 120000);
    }
    return 0;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Split a request that keeps timing out: between turns when it has several,
 * otherwise inside its single turn. Returns null when it is too small to be
 * worth splitting.
 */
function splitTurnsForRetry(turns) {
    const chars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    if (chars < MIN_524_SPLIT_CHARS) return null;
    if (turns.length > 1) {
        let cut = 0;
        let running = 0;
        while (cut < turns.length - 1 && running + turns[cut].text.length <= chars / 2) {
            running += turns[cut].text.length;
            cut++;
        }
        cut = Math.max(1, cut);
        return [turns.slice(0, cut), turns.slice(cut)];
    }
    const pieces = splitVoiceSegment(turns[0], Math.ceil(turns[0].text.length / 2));
    return pieces.length > 1 ? pieces.map(piece => [piece]) : null;
}

/**
 * Synthesize one request, waiting out rate limits instead of aborting. Reports
 * a 'waiting' beat through onBeat so the UI can show the countdown; retries with
 * exponential backoff (capped) until it succeeds or hits a non-retryable error.
 */
async function synthesizeRequestResilient(turns, turnsRoute, onBeat, recoveryDepth = 0) {
    let attempt = 0;
    for (;;) {
        try {
            return await synthesizeRequest(turns, turnsRoute);
        } catch (err) {
            // 524 is normally a proxy timeout for a request whose generated
            // audio is too long. Retry for a transient timeout; if it
            // persists, split only this request and stitch its parts back
            // together, keeping the turns in order.
            if (err.status === 524) {
                if (attempt < 2) {
                    attempt++;
                    const waitMs = 3000;
                    console.debug(`${LOG_PREFIX} request hit 524; retrying in ${waitMs}ms (attempt ${attempt})`);
                    onBeat?.(waitMs);
                    await sleep(waitMs);
                    continue;
                }

                const parts = recoveryDepth < 4 ? splitTurnsForRetry(turns) : null;
                if (parts) {
                    console.warn(`${LOG_PREFIX} request still timed out; splitting into ${parts.length} smaller requests`);
                    const buffers = [];
                    for (const part of parts) {
                        buffers.push(await synthesizeRequestResilient(part, turnsRoute, onBeat, recoveryDepth + 1));
                    }
                    return concatWavBuffers(buffers, { gapMs: 0 });
                }
                throw err;
            }

            if (!RETRYABLE_STATUS.has(err.status)) throw err;
            attempt++;
            const backoff = Math.min(2000 * 2 ** (attempt - 1), 32000);
            const waitMs = Math.max(err.retryAfterMs || 0, backoff);
            console.debug(`${LOG_PREFIX} request hit ${err.status}; waiting ${waitMs}ms (attempt ${attempt})`);
            onBeat?.(waitMs);
            await sleep(waitMs);
        }
    }
}

/**
 * Build the full assembled audio for a message. Reports progress through
 * onProgress(done, total, info) where info is { waitingMs } during a rate-limit
 * wait. Returns an object URL, or null if nothing to speak.
 */
async function buildAudioForMessage(rawText, onProgress) {
    await fetchVoices(); // learns which request shape the server accepts
    const turns = buildTurns(rawText);
    if (turns.length === 0) return null;
    if (turns.some(turn => !turn.voice)) {
        throw new Error('No voice assigned. Pick a voice for the narrator or a character slot.');
    }

    // Narration and dialogue stay in reading order. With the extended route a
    // request carries two voices, so a narrator plus one character is one
    // request per reply; a third voice starts the next request.
    const turnsRoute = usesTurnsRoute();
    if (voiceCache && !routeCapabilities.turns && supportsStructuredTurns(activeModel()) && !warnedOutdatedRoute) {
        warnedOutdatedRoute = true;
        window.toastr?.warning(`Enhanced TTS: SillyTavern's TTS route is outdated, so each request carries one voice (more requests). ${OUTDATED_ROUTE_HINT}`);
    }
    const requests = packTurns(turns, {
        maxSpeakers: turnsRoute ? routeCapabilities.maxSpeakers : 1,
        maxChars: maxRequestChars(),
        perTurnStyle: turnsRoute,
    });
    console.debug(`${LOG_PREFIX} ${turns.length} turn(s) in ${requests.length} request(s):`, requests.map(request => ({
        voices: [...new Set(request.map(turn => turn.voice))],
        turns: request.length,
        chars: request.reduce((sum, turn) => sum + turn.text.length, 0),
    })));

    const total = requests.length;
    let done = 0;
    onProgress?.(done, total);

    // Synthesize with a small concurrency cap, keeping each result in its slot.
    // Rate limits (429) are waited out, not thrown — a slow reply beats a dead one.
    const buffers = new Array(total);
    let next = 0;
    async function worker() {
        while (next < total) {
            const index = next++;
            buffers[index] = await synthesizeRequestResilient(
                requests[index],
                turnsRoute,
                (waitingMs) => onProgress?.(done, total, { waitingMs }),
            );
            done++;
            onProgress?.(done, total);
        }
    }
    await Promise.all(Array.from({ length: Math.min(SYNTH_CONCURRENCY, total) }, worker));

    const wav = concatWavBuffers(buffers, { gapMs: cfg().gapMs });
    const blob = new Blob([wav], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------------------
// Playback + per-message UI
// ---------------------------------------------------------------------------

const audioElement = document.createElement('audio');

function stopPlayback() {
    audioElement.pause();
    audioElement.currentTime = 0;
}

function msgHash(rawText) {
    const c = cfg();
    // Include the voice routing configuration so an audio file made before a
    // slot was fixed/configured cannot mask the corrected quote audio.
    const routing = (c.slots || []).map(slot => ({
        id: slot.id,
        enabled: !!slot.enabled,
        voiceName: slot.voiceName || '',
        stylePrompt: slot.stylePrompt || '',
    }));
    return String(getStringHash(JSON.stringify({
        version: ASSEMBLED_CACHE_VERSION,
        text: String(rawText ?? ''),
        model: activeModel(),
        narrationMode: c.narrationMode,
        narratorSlot: c.narratorSlot,
        gapMs: c.gapMs,
        maxChars: maxRequestChars(),
        routing,
    })));
}

function getMessageEl(messageId) {
    return $(`#chat .mes[mesid="${messageId}"]`);
}

/** Reflect progress / ready state on a message's replay button + visible badge. */
function setButtonState($btn, state, label, badge) {
    $btn.removeClass('enh_tts_busy enh_tts_ready enh_tts_error');
    if (state === 'busy') $btn.addClass('enh_tts_busy');
    if (state === 'ready') $btn.addClass('enh_tts_ready');
    if (state === 'error') $btn.addClass('enh_tts_error');
    if (label !== undefined) $btn.attr('title', label);

    // Visible progress badge lives inside the button so the user can watch
    // generation advance without hovering for the tooltip.
    const $badge = $btn.find('.enh_tts_progress').first();
    if ($badge.length === 0) return;
    if (badge === undefined || badge === null || badge === '') {
        $badge.hide().text('');
    } else {
        $badge.text(badge).toggleClass('enh_tts_progress_wait', state === 'busy' && /wait|retry/i.test(String(badge))).show();
    }
}

/**
 * Ensure a message has an Enhanced-TTS replay button + progress badge in its
 * extra-buttons row.
 */
function ensureReplayButton(messageId) {
    const $mes = getMessageEl(messageId);
    if ($mes.length === 0) return;
    // Anchor in the always-visible name row, NOT in .extraMesButtons — that row
    // is collapsed behind the "⋯" Message Actions hint and is display:none by
    // default (and on mobile), so a progress badge placed there stays invisible
    // until the user manually expands the menu.
    const $anchor = $mes.find('.ch_name .flex-container.flex1').first();
    if ($anchor.length === 0 || $anchor.find('.enh_tts_replay').length) return;
    const $btn = $(
        '<div class="enh_tts_replay" title="Play narrated audio" role="button" tabindex="0">' +
        '<i class="enh_tts_icon fa-solid fa-wave-square"></i>' +
        '<span class="enh_tts_progress" style="display:none"></span>' +
        '</div>');
    $anchor.append($btn);
}

/** Format a progress badge like "3/8" or "waiting 12s". */
function progressBadge(done, total, info) {
    if (info?.waitingMs) {
        const secs = Math.ceil(info.waitingMs / 1000);
        return `rate-limited · retry ${secs}s (${done}/${total})`;
    }
    return `${done}/${total}`;
}

/**
 * Generate (if needed) and play the assembled audio for a message.
 * @param {number} messageId
 * @param {boolean} forcePlay
 */
async function playMessage(messageId, { forcePlay = true } = {}) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message || message.is_system) return;

    const rawText = message.mes || '';
    const hash = msgHash(rawText);
    const $btn = getMessageEl(messageId).find('.enh_tts_replay');

    // Serve a cached assembly instantly.
    if (assembledCache.has(hash)) {
        if (forcePlay) {
            stopPlayback();
            audioElement.src = assembledCache.get(hash).url;
            audioElement.play().catch(() => {});
        }
        setButtonState($btn, 'ready', 'Play narrated audio', null);
        return;
    }

    // Auto-play racing a click (or a double click) on the same reply must not
    // pay for the same requests twice; the running generation plays when done.
    if (generating.has(hash)) return;
    generating.add(hash);

    try {
        setButtonState($btn, 'busy', 'Generating…', 'starting…');
        const url = await buildAudioForMessage(rawText, (done, total, info) => {
            const badge = progressBadge(done, total, info);
            const title = info?.waitingMs
                ? `Rate-limited — waiting to resume (${done}/${total} done)`
                : `Generating ${done}/${total}…`;
            setButtonState($btn, 'busy', title, badge);
        });
        if (!url) {
            setButtonState($btn, 'ready', 'Nothing to narrate', null);
            return;
        }
        assembledCache.set(hash, { url });
        setButtonState($btn, 'ready', 'Play narrated audio', null);
        if (forcePlay) {
            stopPlayback();
            audioElement.src = url;
            audioElement.play().catch(() => {});
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Synthesis failed:`, err);
        setButtonState($btn, 'error', `TTS error: ${err.message}`, 'error');
        window.toastr?.error(`Enhanced TTS: ${err.message}`);
    } finally {
        generating.delete(hash);
    }
}

// ---------------------------------------------------------------------------
// Display cleanup (strip markup/expression tags from the rendered message)
// ---------------------------------------------------------------------------

const MARKER_PROBE_RE = /\[\/?v\d+(?:\s*:[^\]\n]*)?\]|<\/?[a-z][a-z0-9 _-]{0,30}>/i;

/**
 * Walk a message's rendered text nodes and strip voice markers + expression
 * tags so the reader sees clean prose. The chat model keeps the raw markers.
 */
function cleanRenderedMessage(messageId) {
    const el = getMessageEl(messageId).find('.mes_text').get(0);
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const dirty = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (MARKER_PROBE_RE.test(node.nodeValue)) dirty.push(node);
    }
    for (const node of dirty) {
        node.nodeValue = cleanForDisplay(node.nodeValue);
    }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onMessageRendered(messageId, { autoPlay = false } = {}) {
    const c = cfg();
    if (!c?.enabled) return;
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;

    cleanRenderedMessage(id);
    ensureReplayButton(id);

    // Only new character replies auto-play; voicing the user's own message
    // would spend quota on text they just typed. Its button still works.
    if (autoPlay && c.autoPlay) {
        // Fire-and-forget; progress shows on the button.
        playMessage(id, { forcePlay: true });
    }
}

/**
 * Inject the AI instruction block as a leading system note.
 * @param {{chat: Array, dryRun: boolean}} eventData
 */
function onPromptReady(eventData) {
    const c = cfg();
    if (!c?.enabled || !c.autoInject) return;
    if (eventData?.dryRun) return;
    const chat = eventData?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const block = buildContextAwareInstructionBlock(c.slots, { narratorSlot: c.narratorSlot, narrationMode: c.narrationMode });

    let insertIndex = 0;
    for (let i = 0; i < chat.length; i++) {
        if (chat[i].role === 'system') insertIndex = i + 1;
        else break;
    }
    chat.splice(insertIndex, 0, { role: 'system', content: block });
}

// ---------------------------------------------------------------------------
// Settings HTML
// ---------------------------------------------------------------------------

const settingsHtml = `
<hr>
<h4>Enhanced TTS <small style="opacity:0.6">(multi-voice)</small></h4>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enh_tts_enabled">
        <input type="checkbox" id="enh_tts_enabled" />
        <span>Enable Enhanced TTS</span>
    </label>
</div>
<small class="textAlignCenter" style="display:block">
    The AI wraps dialogue in <code>[v2]"line"[/v2]</code> markers (optionally with
    a delivery cue: <code>[v2: whispering]</code>). Narration and dialogue are
    read in order, two voices per request — a narrator plus one character is a
    single request per reply — and stitched into one audio file. Use the
    <i>Copy AI instructions</i> button (or auto-inject) to teach the model the
    markup. Requires a Google AI Studio key saved in your connection settings.
</small>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_provider">TTS endpoint</label>
    <select id="enh_tts_provider" class="text_pole">
        <option value="gemini">Google Gemini (native TTS)</option>
        <option value="openai" disabled>OpenAI-compatible (coming soon)</option>
        <option value="custom" disabled>Custom (coming soon)</option>
    </select>
    <small id="enh_tts_route_status" style="display:block; opacity:0.85"></small>
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_model">Model</label>
    <select id="enh_tts_model" class="text_pole"></select>
</div>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enh_tts_use_custom_model">
        <input type="checkbox" id="enh_tts_use_custom_model" />
        <span>Use custom model name</span>
    </label>
</div>
<div class="flex-container flexFlowColumn marginTopBot5" id="enh_tts_custom_model_row" style="display:none">
    <input type="text" id="enh_tts_custom_model" class="text_pole" placeholder="e.g. gemini-3.8-flash-tts" />
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_mode">Narration scope</label>
    <select id="enh_tts_mode" class="text_pole">
        <option value="quotes">Quotes only — speak dialogue (unwrapped quotes use the narrator voice)</option>
        <option value="audiobook">Audiobook — narrator reads prose, characters speak their lines</option>
    </select>
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_narrator">Narrator slot (unwrapped prose)</label>
    <select id="enh_tts_narrator" class="text_pole"></select>
</div>

<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enh_tts_autoplay">
        <input type="checkbox" id="enh_tts_autoplay" />
        <span>Auto-play each new reply</span>
    </label>
</div>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enh_tts_autoinject">
        <input type="checkbox" id="enh_tts_autoinject" />
        <span>Auto-inject markup instructions into the prompt</span>
    </label>
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_gap">Pause between requests (ms)</label>
    <input type="number" id="enh_tts_gap" class="text_pole" min="0" max="3000" step="50" />
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_max_chars">Max characters per request</label>
    <input type="number" id="enh_tts_max_chars" class="text_pole" min="300" max="20000" step="100" />
    <small>Higher = fewer requests for long replies. Lower it if you get 524 timeouts (e.g. behind Cloudflare).</small>
</div>

<div class="flex-container marginTopBot5">
    <div id="enh_tts_copy_btn" class="menu_button menu_button_icon" style="flex:1;">
        <i class="fa-solid fa-clipboard"></i>
        <span>Copy AI instructions</span>
    </div>
</div>

<hr>
<h4>Voice slots</h4>
<small class="textAlignCenter" style="display:block">
    Assign a label (character) and a Gemini voice to each slot. The voice
    carries the character; the optional style is a <i>short</i> baseline
    delivery cue — e.g. "weary, slow" — sent as turn-level direction
    (<code>speech_metadata.style</code>), so it is <b>not read aloud</b>. Leave it
    empty for the most natural delivery; a per-line cue the AI writes
    (<code>[v2: furious]</code>) replaces it for that line. Long "director's notes"
    cause voice drift. Disabled slots are omitted from the AI instructions.
</small>
<div id="enh_tts_slots"></div>

<hr>
<h4>Presets</h4>
<div class="flex-container marginTopBot5" style="gap:4px">
    <input type="text" id="enh_tts_preset_name" class="text_pole" style="flex:2" placeholder="Preset name" />
    <select id="enh_tts_preset_select" class="text_pole" style="flex:2"></select>
</div>
<div class="flex-container marginTopBot5" style="gap:4px">
    <div id="enh_tts_preset_save" class="menu_button menu_button_icon" style="flex:1">
        <i class="fa-solid fa-floppy-disk"></i><span>Save</span>
    </div>
    <div id="enh_tts_preset_load" class="menu_button menu_button_icon" style="flex:1">
        <i class="fa-solid fa-folder-open"></i><span>Load</span>
    </div>
    <div id="enh_tts_preset_delete" class="menu_button menu_button_icon" style="flex:1">
        <i class="fa-solid fa-trash"></i><span>Delete</span>
    </div>
</div>
<div class="flex-container marginTopBot5" style="gap:4px">
    <div id="enh_tts_preset_export" class="menu_button menu_button_icon" style="flex:1">
        <i class="fa-solid fa-file-export"></i><span>Export JSON</span>
    </div>
    <div id="enh_tts_preset_import" class="menu_button menu_button_icon" style="flex:1">
        <i class="fa-solid fa-file-import"></i><span>Import JSON</span>
    </div>
</div>
<input type="file" id="enh_tts_preset_file" accept="application/json,.json" style="display:none" />`;

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function populateModelSelect() {
    const $sel = $('#enh_tts_model');
    $sel.empty();
    for (const m of GEMINI_TTS_MODELS) {
        $sel.append($('<option></option>').val(m).text(m));
    }
    $sel.val(cfg().model);
}

function slotRowHtml(slot) {
    return `
<div class="enh_tts_slot flex-container flexFlowColumn marginTopBot5" data-slot="${slot.id}"
     style="border:1px solid var(--SmartThemeBorderColor); border-radius:6px; padding:6px; gap:4px">
    <div class="flex-container alignitemscenter" style="gap:6px">
        <label class="checkbox_label" style="flex:0 0 auto">
            <input type="checkbox" class="enh_tts_slot_enabled" />
            <span style="font-weight:bold">Slot ${slot.id}</span>
        </label>
        <input type="text" class="enh_tts_slot_label text_pole" style="flex:1" placeholder="Character / label" />
        <div class="menu_button enh_tts_slot_preview fa-solid fa-play" title="Preview voice" style="flex:0 0 auto"></div>
    </div>
    <select class="enh_tts_slot_voice text_pole"></select>
    <input type="text" class="enh_tts_slot_style text_pole" placeholder="Short style cue (optional) — e.g. weary, slow / whispering" />
</div>`;
}

async function renderSlots() {
    const $container = $('#enh_tts_slots');
    $container.empty();
    for (const slot of cfg().slots) $container.append(slotRowHtml(slot));

    const voices = await fetchVoices();
    $('.enh_tts_slot').each(function () {
        const id = Number($(this).data('slot'));
        const slot = slotById(id);
        const $voice = $(this).find('.enh_tts_slot_voice');
        $voice.empty().append($('<option></option>').val('').text('— no voice —'));
        for (const v of voices) {
            const label = v.description ? `${v.name} (${v.description})` : v.name;
            $voice.append($('<option></option>').val(v.voice_id || v.name).text(label));
        }
        $voice.val(slot.voiceName || '');
        $(this).find('.enh_tts_slot_enabled').prop('checked', !!slot.enabled);
        $(this).find('.enh_tts_slot_label').val(slot.label || '');
        $(this).find('.enh_tts_slot_style').val(slot.stylePrompt || '');
    });
    updateRouteStatus();
}

const OUTDATED_ROUTE_HINT = 'Apply enhanced-tts-server.patch to SillyTavern\'s src/endpoints/google.js and restart the server.';

/** Show whether the server route can take two voices per request. */
function updateRouteStatus() {
    const $status = $('#enh_tts_route_status');
    if (!voiceCache) {
        $status.text('⚠ Could not reach /api/google/list-native-voices — check that SillyTavern is running.');
    } else if (routeCapabilities.turns) {
        $status.text('Server route: multi-voice ready — up to two voices, each line with its own style, per request.');
    } else {
        $status.text('⚠ Server route is outdated: each request carries one voice, so replies take more requests '
            + `and per-line cues may be ignored. ${OUTDATED_ROUTE_HINT}`);
    }
}

function populateNarratorSelect() {
    const $sel = $('#enh_tts_narrator');
    $sel.empty();
    for (const slot of cfg().slots) {
        const name = slot.label ? `Slot ${slot.id} — ${slot.label}` : `Slot ${slot.id}`;
        $sel.append($('<option></option>').val(slot.id).text(name));
    }
    $sel.val(cfg().narratorSlot);
}

function populatePresetSelect() {
    const $sel = $('#enh_tts_preset_select');
    const names = Object.keys(cfg().presets).sort();
    $sel.empty().append($('<option></option>').val('').text(names.length ? '— select preset —' : '(no presets)'));
    for (const name of names) $sel.append($('<option></option>').val(name).text(name));
    $sel.val(cfg().activePreset || '');
}

function loadSettings() {
    const c = cfg();
    $('#enh_tts_enabled').prop('checked', c.enabled);
    $('#enh_tts_provider').val(c.provider);
    $('#enh_tts_use_custom_model').prop('checked', c.useCustomModel);
    $('#enh_tts_custom_model').val(c.customModel);
    $('#enh_tts_custom_model_row').toggle(c.useCustomModel);
    $('#enh_tts_mode').val(c.narrationMode);
    $('#enh_tts_autoplay').prop('checked', c.autoPlay);
    $('#enh_tts_autoinject').prop('checked', c.autoInject);
    $('#enh_tts_gap').val(c.gapMs);
    $('#enh_tts_max_chars').val(maxRequestChars());
    populateModelSelect();
    populateNarratorSelect();
    populatePresetSelect();
    renderSlots();
}

function onGlobalChange() {
    const c = cfg();
    c.enabled = $('#enh_tts_enabled').is(':checked');
    c.useCustomModel = $('#enh_tts_use_custom_model').is(':checked');
    c.customModel = String($('#enh_tts_custom_model').val() || '');
    c.model = String($('#enh_tts_model').val() || GEMINI_TTS_MODELS[0]);
    c.narrationMode = $('#enh_tts_mode').val() === 'audiobook' ? 'audiobook' : 'quotes';
    c.narratorSlot = Number($('#enh_tts_narrator').val()) || 1;
    c.autoPlay = $('#enh_tts_autoplay').is(':checked');
    c.autoInject = $('#enh_tts_autoinject').is(':checked');
    c.gapMs = Math.max(0, Number($('#enh_tts_gap').val()) || 0);
    c.maxCharsPerFragment = Math.max(300, Number($('#enh_tts_max_chars').val()) || DEFAULT_MAX_REQUEST_CHARS);
    $('#enh_tts_custom_model_row').toggle(c.useCustomModel);
    saveSettingsDebounced();
}

function onSlotChange($slotEl) {
    const id = Number($slotEl.data('slot'));
    const slot = slotById(id);
    if (!slot) return;
    slot.enabled = $slotEl.find('.enh_tts_slot_enabled').is(':checked');
    slot.label = String($slotEl.find('.enh_tts_slot_label').val() || '');
    slot.voiceName = String($slotEl.find('.enh_tts_slot_voice').val() || '');
    slot.stylePrompt = String($slotEl.find('.enh_tts_slot_style').val() || '');
    populateNarratorSelect();
    saveSettingsDebounced();
}

async function previewSlot(id) {
    const slot = slotById(id);
    if (!slot?.voiceName) { window.toastr?.warning('Assign a voice to this slot first.'); return; }
    try {
        const url = await buildAudioForMessage(`[v${id}]"Hello, this is a voice preview."[/v${id}]`);
        if (!url) return;
        stopPlayback();
        audioElement.src = url;
        audioElement.play().catch(() => {});
    } catch (err) {
        window.toastr?.error(`Preview failed: ${err.message}`);
    }
}

// ---------- Presets ----------

function snapshotPreset() {
    const c = cfg();
    return {
        model: c.model,
        customModel: c.customModel,
        useCustomModel: c.useCustomModel,
        narrationMode: c.narrationMode,
        narratorSlot: c.narratorSlot,
        gapMs: c.gapMs,
        maxCharsPerFragment: c.maxCharsPerFragment,
        slots: c.slots.map(s => ({ ...s })),
    };
}

function applyPreset(preset) {
    const c = cfg();
    if (!preset || !Array.isArray(preset.slots)) return false;
    c.model = preset.model ?? c.model;
    c.customModel = preset.customModel ?? c.customModel;
    c.useCustomModel = !!preset.useCustomModel;
    c.narrationMode = preset.narrationMode === 'audiobook' ? 'audiobook' : 'quotes';
    c.narratorSlot = Number(preset.narratorSlot) || 1;
    c.gapMs = Math.max(0, Number(preset.gapMs) || 0);
    c.maxCharsPerFragment = Number(preset.maxCharsPerFragment) || DEFAULT_MAX_REQUEST_CHARS;
    c.slots = makeDefaultSlots().map((slot, i) => ({ ...slot, ...(preset.slots[i] || {}), id: i + 1 }));
    return true;
}

function onPresetSave() {
    const name = String($('#enh_tts_preset_name').val() || '').trim();
    if (!name) { window.toastr?.warning('Enter a preset name.'); return; }
    cfg().presets[name] = snapshotPreset();
    cfg().activePreset = name;
    saveSettingsDebounced();
    populatePresetSelect();
    window.toastr?.success(`Preset "${name}" saved.`);
}

function onPresetLoad() {
    const name = String($('#enh_tts_preset_select').val() || '');
    const preset = cfg().presets[name];
    if (!preset) { window.toastr?.warning('Select a preset to load.'); return; }
    if (!applyPreset(preset)) { window.toastr?.error('Preset is malformed.'); return; }
    cfg().activePreset = name;
    saveSettingsDebounced();
    loadSettings();
    window.toastr?.success(`Preset "${name}" loaded.`);
}

function onPresetDelete() {
    const name = String($('#enh_tts_preset_select').val() || '');
    if (!name || !cfg().presets[name]) { window.toastr?.warning('Select a preset to delete.'); return; }
    delete cfg().presets[name];
    if (cfg().activePreset === name) cfg().activePreset = '';
    saveSettingsDebounced();
    populatePresetSelect();
}

function onPresetExport() {
    const name = String($('#enh_tts_preset_select').val() || '') || 'current';
    const preset = cfg().presets[name] || snapshotPreset();
    const blob = new Blob([JSON.stringify({ enhancedTtsPreset: preset, name }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enhanced-tts-${name}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onPresetImport(file) {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const preset = parsed.enhancedTtsPreset || parsed;
        const name = (parsed.name || file.name.replace(/\.json$/i, '') || 'imported').trim();
        if (!applyPreset(preset)) { window.toastr?.error('Not a valid Enhanced TTS preset.'); return; }
        cfg().presets[name] = snapshotPreset();
        cfg().activePreset = name;
        saveSettingsDebounced();
        loadSettings();
        window.toastr?.success(`Preset "${name}" imported.`);
    } catch (err) {
        window.toastr?.error(`Import failed: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let stylesInjected = false;

/** Inject the small stylesheet for the per-message progress badge once. */
function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
.enh_tts_replay {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 8px;
    cursor: pointer;
    vertical-align: middle;
    opacity: 0.8;
    transition: opacity var(--animation-duration-2x, 0.2s) ease-in-out;
}
.enh_tts_replay:hover { opacity: 1; }
.enh_tts_icon {
    filter: drop-shadow(0px 0px 2px black);
    font-size: 0.95em;
}
.enh_tts_replay.enh_tts_busy .enh_tts_icon { color: #c8a24a; }
.enh_tts_replay.enh_tts_error .enh_tts_icon { color: #c0392b; }
.enh_tts_replay.enh_tts_ready .enh_tts_icon { color: inherit; }
.enh_tts_progress {
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    height: 1.5em;
    border-radius: 8px;
    font-size: 0.72em;
    font-weight: 600;
    line-height: 1.5em;
    white-space: nowrap;
    background: var(--SmartThemeBotMesBlurTintColor, rgba(0,0,0,0.25));
    color: var(--SmartThemeBodyColor, inherit);
    border: 1px solid var(--SmartThemeBorderColor, transparent);
}
.enh_tts_progress_wait {
    background: #a6761d;
    color: #fff;
    border-color: #a6761d;
    animation: enh_tts_pulse 1s ease-in-out infinite;
}
@keyframes enh_tts_pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }
`;
    $('<style id="enh_tts_styles"></style>').text(css).appendTo(document.head);
}

export function init(contentContainer) {
    ensureDefaults();
    injectStyles();
    contentContainer.append(settingsHtml);
    loadSettings();

    // Global controls
    $('#enh_tts_enabled, #enh_tts_provider, #enh_tts_model, #enh_tts_use_custom_model, ' +
      '#enh_tts_mode, #enh_tts_narrator, #enh_tts_autoplay, #enh_tts_autoinject')
        .on('change', onGlobalChange);
    $('#enh_tts_custom_model').on('input', onGlobalChange);
    $('#enh_tts_gap').on('input', onGlobalChange);
    // 'change', not 'input': a half-typed number would be clamped mid-edit.
    $('#enh_tts_max_chars').on('change', onGlobalChange);

    // Slot editor (delegated — rows are rebuilt on preset load)
    $('#enh_tts_slots')
        .on('change input', '.enh_tts_slot_enabled, .enh_tts_slot_label, .enh_tts_slot_voice, .enh_tts_slot_style',
            function () { onSlotChange($(this).closest('.enh_tts_slot')); })
        .on('click', '.enh_tts_slot_preview',
            function () { previewSlot(Number($(this).closest('.enh_tts_slot').data('slot'))); });

    // Copy AI instructions
    $('#enh_tts_copy_btn').on('click', () => {
        const block = buildContextAwareInstructionBlock(cfg().slots, { narratorSlot: cfg().narratorSlot, narrationMode: cfg().narrationMode });
        copyText(block);
        window.toastr?.info('AI instructions copied to clipboard.');
    });

    // Presets
    $('#enh_tts_preset_save').on('click', onPresetSave);
    $('#enh_tts_preset_load').on('click', onPresetLoad);
    $('#enh_tts_preset_delete').on('click', onPresetDelete);
    $('#enh_tts_preset_export').on('click', onPresetExport);
    $('#enh_tts_preset_import').on('click', () => $('#enh_tts_preset_file').trigger('click'));
    $('#enh_tts_preset_file').on('change', function () {
        const file = this.files?.[0];
        if (file) onPresetImport(file);
        this.value = '';
    });

    // Per-message replay button (delegated — survives re-renders)
    $(document).on('click', '.enh_tts_replay', function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(id)) playMessage(id, { forcePlay: true });
    });

    // Message lifecycle
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => onMessageRendered(messageId, { autoPlay: true }));
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => onMessageRendered(messageId));
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.CHAT_CHANGED, () => stopPlayback());

    console.log(`${LOG_PREFIX} Feature initialized`);
}
