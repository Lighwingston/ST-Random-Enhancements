/**
 * Enhanced TTS Feature
 *
 * Multi-voice narration for AI responses. The AI wraps spoken dialogue in
 * voice-slot markers — [v2]"line"[/v2] — and this feature synthesizes each
 * quote with the voice configured for that slot, assembles every fragment into
 * one audio file per response, shows progress, and offers per-message replay.
 *
 * Design notes:
 *  - Markers are square-bracket wrappers so they can never collide with Gemini's
 *    angle-bracket expression tags (<gasp>, <sigh>, ...). Expression tags ride
 *    along to TTS inside a quote but are stripped from the visible message.
 *  - Only Gemini (Google AI Studio) is wired. OpenAI / custom are placeholders.
 *  - All synthesis goes through SillyTavern's own authenticated route
 *    /api/google/generate-native-tts, so the API key never leaves the server.
 *
 * Pure logic (parsing, splitting, WAV assembly) lives in ./enhanced-tts-core.js
 * and is unit-tested under tests/.
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { oai_settings } from '../../../../openai.js';
import { copyText, isValidUrl, getStringHash } from '../../../../utils.js';

import {
    parseVoiceMarkup,
    extractSpeakableSegments,
    prepareVoiceSegments,
    buildGeminiTtsPayload,
    makeVoiceCacheKey,
    buildInstructionBlock,
    concatWavBuffers,
    cleanForDisplay,
} from './enhanced-tts-core.js';

const SETTINGS_KEY = 'enhancements';
const FEATURE_KEY = 'enhancedTts';
const LOG_PREFIX = '[Enhancements:EnhancedTts]';
const MAX_SLOTS = 10;

// Known Gemini TTS models (a custom name can also be typed).
const GEMINI_TTS_MODELS = [
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-flash-preview-tts',
];

// Max number of fragments synthesized at once (keeps the API happy).
const SYNTH_CONCURRENCY = 2;

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
        maxCharsPerFragment: 1800,
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
// Voice list (fetched once, cached in-module)
// ---------------------------------------------------------------------------

let voiceCache = null;

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
    } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to load voices:`, err);
        voiceCache = [];
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

function slotById(id) {
    return cfg().slots.find(s => s.id === Number(id));
}

/**
 * Synthesize a single fragment via SillyTavern's Google TTS route.
 * @returns {Promise<ArrayBuffer>}
 */
async function synthesizeFragment(fragment) {
    const slot = slotById(fragment.slot) || slotById(cfg().narratorSlot);
    const voice = slot?.voiceName || '';
    const instruction = slot?.stylePrompt || '';
    const model = activeModel();
    const gapMs = cfg().gapMs;

    if (!voice) {
        throw new Error(`Slot ${fragment.slot} has no voice assigned.`);
    }

    const cacheKey = makeVoiceCacheKey({ text: fragment.text, slot: fragment.slot, voice, model, instruction, gapMs });
    if (fragmentCache.has(cacheKey)) return fragmentCache.get(cacheKey);

    const payload = buildGeminiTtsPayload({ text: fragment.text, voice, model, instruction, api: 'makersuite' });
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
        throw new Error(message);
    }

    const buffer = await response.arrayBuffer();
    fragmentCache.set(cacheKey, buffer);
    return buffer;
}

/**
 * Build the full assembled audio for a message. Reports progress through
 * onProgress(done, total). Returns an object URL, or null if nothing to speak.
 */
async function buildAudioForMessage(rawText, onProgress) {
    const c = cfg();
    const { segments, warnings } = parseVoiceMarkup(rawText, { narratorSlot: c.narratorSlot, maxSlots: MAX_SLOTS });
    for (const w of warnings) console.debug(`${LOG_PREFIX} ${w}`);

    const speakable = extractSpeakableSegments(segments, { mode: c.narrationMode, narratorSlot: c.narratorSlot });
    const fragments = prepareVoiceSegments(speakable, c.maxCharsPerFragment);
    if (fragments.length === 0) return null;

    const total = fragments.length;
    let done = 0;
    onProgress?.(done, total);

    // Synthesize in order with a small concurrency cap, preserving positions.
    const buffers = new Array(total);
    let next = 0;
    async function worker() {
        while (next < total) {
            const index = next++;
            buffers[index] = await synthesizeFragment(fragments[index]);
            done++;
            onProgress?.(done, total);
        }
    }
    await Promise.all(Array.from({ length: Math.min(SYNTH_CONCURRENCY, total) }, worker));

    const wav = concatWavBuffers(buffers, { gapMs: c.gapMs });
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
    return String(getStringHash(String(rawText ?? '')));
}

function getMessageEl(messageId) {
    return $(`#chat .mes[mesid="${messageId}"]`);
}

/** Reflect progress / ready state on a message's replay button. */
function setButtonState($btn, state, label) {
    $btn.removeClass('enh_tts_busy enh_tts_ready enh_tts_error');
    if (state === 'busy') $btn.addClass('enh_tts_busy');
    if (state === 'ready') $btn.addClass('enh_tts_ready');
    if (state === 'error') $btn.addClass('enh_tts_error');
    if (label !== undefined) $btn.attr('title', label);
}

/**
 * Ensure a message has an Enhanced-TTS replay button in its extra-buttons row.
 */
function ensureReplayButton(messageId) {
    const $mes = getMessageEl(messageId);
    if ($mes.length === 0) return;
    const $row = $mes.find('.extraMesButtons').first();
    if ($row.length === 0 || $row.find('.enh_tts_replay').length) return;
    const $btn = $(
        '<div class="mes_button enh_tts_replay fa-solid fa-wave-square" ' +
        'title="Play narrated audio" tabindex="0"></div>');
    $row.prepend($btn);
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
        setButtonState($btn, 'ready', 'Play narrated audio');
        return;
    }

    try {
        setButtonState($btn, 'busy', 'Generating…');
        const url = await buildAudioForMessage(rawText, (done, total) => {
            setButtonState($btn, 'busy', `Generating ${done}/${total}…`);
        });
        if (!url) {
            setButtonState($btn, 'ready', 'Nothing to narrate');
            return;
        }
        assembledCache.set(hash, { url });
        setButtonState($btn, 'ready', 'Play narrated audio');
        if (forcePlay) {
            stopPlayback();
            audioElement.src = url;
            audioElement.play().catch(() => {});
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Synthesis failed:`, err);
        setButtonState($btn, 'error', `TTS error: ${err.message}`);
        window.toastr?.error(`Enhanced TTS: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Display cleanup (strip markup/expression tags from the rendered message)
// ---------------------------------------------------------------------------

const MARKER_PROBE_RE = /\[\/?v\d+\]|<\/?[a-z][a-z0-9 _-]{0,30}>/i;

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

function onMessageRendered(messageId) {
    const c = cfg();
    if (!c?.enabled) return;
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;

    cleanRenderedMessage(id);
    ensureReplayButton(id);

    if (c.autoPlay) {
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

    const block = buildInstructionBlock(c.slots, { narratorSlot: c.narratorSlot, narrationMode: c.narrationMode });

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
    The AI wraps dialogue in <code>[v2]"line"[/v2]</code> markers; each slot is
    voiced separately and all fragments are stitched into one audio file per
    reply. Use the <i>Copy AI instructions</i> button (or auto-inject) to teach
    the model the markup. Requires a Google AI Studio key saved in your
    connection settings.
</small>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_tts_provider">TTS endpoint</label>
    <select id="enh_tts_provider" class="text_pole">
        <option value="gemini">Google Gemini (native TTS)</option>
        <option value="openai" disabled>OpenAI-compatible (coming soon)</option>
        <option value="custom" disabled>Custom (coming soon)</option>
    </select>
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
        <option value="quotes">Quotes only — speak wrapped dialogue</option>
        <option value="audiobook">Audiobook — also read prose (narrator slot)</option>
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
    <label for="enh_tts_gap">Gap between fragments (ms)</label>
    <input type="number" id="enh_tts_gap" class="text_pole" min="0" max="3000" step="50" />
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
    Assign a label (character), a Gemini voice, and an optional style prompt
    (e.g. "elderly, weary, slow") to each slot. Disabled slots are omitted from
    the AI instructions.
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
    <input type="text" class="enh_tts_slot_style text_pole" placeholder="Style prompt (optional) — e.g. elderly, weary" />
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
    c.maxCharsPerFragment = Number(preset.maxCharsPerFragment) || 1800;
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

export function init(contentContainer) {
    ensureDefaults();
    contentContainer.append(settingsHtml);
    loadSettings();

    // Global controls
    $('#enh_tts_enabled, #enh_tts_provider, #enh_tts_model, #enh_tts_use_custom_model, ' +
      '#enh_tts_mode, #enh_tts_narrator, #enh_tts_autoplay, #enh_tts_autoinject')
        .on('change', onGlobalChange);
    $('#enh_tts_custom_model').on('input', onGlobalChange);
    $('#enh_tts_gap').on('input', onGlobalChange);

    // Slot editor (delegated — rows are rebuilt on preset load)
    $('#enh_tts_slots')
        .on('change input', '.enh_tts_slot_enabled, .enh_tts_slot_label, .enh_tts_slot_voice, .enh_tts_slot_style',
            function () { onSlotChange($(this).closest('.enh_tts_slot')); })
        .on('click', '.enh_tts_slot_preview',
            function () { previewSlot(Number($(this).closest('.enh_tts_slot').data('slot'))); });

    // Copy AI instructions
    $('#enh_tts_copy_btn').on('click', () => {
        const block = buildInstructionBlock(cfg().slots, { narratorSlot: cfg().narratorSlot, narrationMode: cfg().narrationMode });
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
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.CHAT_CHANGED, () => stopPlayback());

    console.log(`${LOG_PREFIX} Feature initialized`);
}
