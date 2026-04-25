/**
 * SillyTavern Enhancements Extension
 *
 * A collection of quality-of-life features for SillyTavern.
 *
 * Feature: Avatar Vision
 *   Sends the current character's avatar image to the AI alongside
 *   the chat completion prompt so vision-capable models can "see"
 *   the character's appearance.
 */

// Path from: /scripts/extensions/third-party/enhancements/index.js
//   ../  = /scripts/extensions/third-party/
//   ../../  = /scripts/extensions/
//   ../../../  = /scripts/
//   ../../../../  = /
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { isImageInliningSupported } from '../../../openai.js';
import { getBase64Async } from '../../../utils.js';

const EXTENSION_NAME = 'third-party/enhancements';
const SETTINGS_KEY = 'enhancements';

const defaultSettings = {
    avatarVisionEnabled: false,
    avatarVisionHint: true,
};

/**
 * Simple cache for avatar base64 data to avoid re-fetching on every generation.
 * Keyed by avatar filename (e.g. "MyChar.png").
 * @type {Map<string, string>}
 */
const avatarCache = new Map();

// ---------------------------------------------------------------------------
// Settings management
// ---------------------------------------------------------------------------

function loadSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = {};
    }

    // Merge defaults with any previously-saved values
    const settings = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    // Reflect saved state in the UI
    $('#enhancements_avatar_vision_enabled').prop('checked', settings.avatarVisionEnabled);
    $('#enhancements_avatar_vision_hint').prop('checked', settings.avatarVisionHint);
}

function onSettingsChange() {
    const settings = extension_settings[SETTINGS_KEY];
    settings.avatarVisionEnabled = $('#enhancements_avatar_vision_enabled').is(':checked');
    settings.avatarVisionHint = $('#enhancements_avatar_vision_hint').is(':checked');
    saveSettingsDebounced();
}

function bindUiEvents() {
    $('#enhancements_avatar_vision_enabled').on('change', onSettingsChange);
    $('#enhancements_avatar_vision_hint').on('change', onSettingsChange);
}

// ---------------------------------------------------------------------------
// Avatar Vision — core logic
// ---------------------------------------------------------------------------

/**
 * Fetch a character avatar and return it as a base64 data-URL string.
 * Results are cached by filename.
 *
 * @param {string} avatarFile  The avatar filename, e.g. "MyChar.png"
 * @returns {Promise<string|null>}  data:image/…;base64,… or null on failure
 */
async function getAvatarBase64(avatarFile) {
    if (avatarCache.has(avatarFile)) {
        return avatarCache.get(avatarFile);
    }

    try {
        const response = await fetch(`characters/${avatarFile}`, {
            method: 'GET',
            cache: 'force-cache',
        });

        if (!response.ok) {
            console.warn(`[Enhancements] Failed to fetch avatar "${avatarFile}": ${response.status}`);
            return null;
        }

        const blob = await response.blob();
        const base64 = await getBase64Async(blob);
        avatarCache.set(avatarFile, base64);
        return base64;
    } catch (error) {
        console.error('[Enhancements] Error fetching avatar:', error);
        return null;
    }
}

/**
 * Event handler for CHAT_COMPLETION_PROMPT_READY.
 *
 * Injects the current character's avatar image into the first system message
 * of the chat completion prompt so vision-capable models can see the character.
 *
 * @param {object} eventData  { chat: Array, dryRun: boolean }
 */
async function onPromptReady(eventData) {
    const settings = extension_settings[SETTINGS_KEY];

    // ---- Gate checks ----
    if (!settings?.avatarVisionEnabled) return;
    if (eventData.dryRun) return;
    if (!isImageInliningSupported()) return;

    // Use getContext() for live access to mutable globals
    const context = SillyTavern.getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return;

    const character = context.characters[charId];
    if (!character) return;

    const avatarFile = character.avatar;
    if (!avatarFile || avatarFile === 'none') return;

    // ---- Fetch avatar ----
    const avatarBase64 = await getAvatarBase64(avatarFile);
    if (!avatarBase64) return;

    // ---- Inject into the first system message ----
    const chat = eventData.chat;
    if (!chat || chat.length === 0) return;

    const targetMessage = chat[0];

    // Convert string content to the multi-part array format required for images
    if (typeof targetMessage.content === 'string') {
        targetMessage.content = [
            { type: 'text', text: targetMessage.content },
        ];
    } else if (!Array.isArray(targetMessage.content)) {
        // Unexpected content type — bail out gracefully
        return;
    }

    // Optionally add a text hint so the AI knows what the image represents
    if (settings.avatarVisionHint) {
        const charName = character.name || context.name2 || 'the character';
        targetMessage.content.push({
            type: 'text',
            text: `[The following image is ${charName}'s current appearance/avatar:]`,
        });
    }

    // Append the avatar image
    targetMessage.content.push({
        type: 'image_url',
        image_url: {
            url: avatarBase64,
            detail: 'low', // 85 tokens — avatars are small reference images
        },
    });

    console.debug(`[Enhancements] Injected avatar for "${character.name}" into prompt`);
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

jQuery(async () => {
    // Load the settings HTML template and mount it in the extensions panel
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    const container = $('<div id="enhancements_container" class="extension_container"></div>');
    container.append(settingsHtml);
    $('#extensions_settings2').append(container);

    loadSettings();
    bindUiEvents();

    // Register the prompt-ready hook
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);

    console.log('[Enhancements] Extension loaded');
});
