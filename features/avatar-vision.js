/**
 * Avatar Vision Feature
 *
 * Sends the current character's avatar image to the AI alongside
 * the chat completion prompt so vision-capable models can "see"
 * the character's appearance.
 *
 * Injects a user-role message (not system) because:
 *  - Gemini's system_instruction does NOT support images (only text parts)
 *  - OpenAI and Claude both support images in user messages natively
 *  - SillyTavern's prompt converter turns image_url into Gemini inlineData
 *    only for non-system messages
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { isImageInliningSupported } from '../../../../openai.js';
import { getBase64Async } from '../../../../utils.js';

const SETTINGS_KEY = 'enhancements';

const defaultSettings = {
    avatarVisionEnabled: false,
    avatarVisionHint: true,
};

// ---------------------------------------------------------------------------
// Settings HTML
// ---------------------------------------------------------------------------

const settingsHtml = `
<h4>Avatar Vision</h4>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enhancements_avatar_vision_enabled">
        <input type="checkbox" id="enhancements_avatar_vision_enabled" />
        <span>Send character avatar to AI</span>
    </label>
</div>
<small class="textAlignCenter">
    When enabled, the current character's avatar image is included in the
    prompt so the AI can "see" the character's appearance. Requires a
    vision-capable model and Media Inlining enabled in Chat Completion settings.
</small>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enhancements_avatar_vision_hint">
        <input type="checkbox" id="enhancements_avatar_vision_hint" />
        <span>Include text hint with avatar</span>
    </label>
</div>
<small class="textAlignCenter">
    Prepends a short text label before the image so the AI knows it
    represents the character's appearance.
</small>`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
    const settings = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    $('#enhancements_avatar_vision_enabled').prop('checked', settings.avatarVisionEnabled);
    $('#enhancements_avatar_vision_hint').prop('checked', settings.avatarVisionHint);
}

function onSettingsChange() {
    const settings = extension_settings[SETTINGS_KEY];
    settings.avatarVisionEnabled = $('#enhancements_avatar_vision_enabled').is(':checked');
    settings.avatarVisionHint = $('#enhancements_avatar_vision_hint').is(':checked');
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Fetch a character's avatar image and return it as a base64 data-URL.
 *
 * @param {string} avatarFile  The avatar filename, e.g. "MyChar.png"
 * @returns {Promise<string|null>}  data:image/…;base64,… or null on failure
 */
async function fetchAvatarAsBase64(avatarFile) {
    try {
        const url = `/characters/${encodeURIComponent(avatarFile)}`;
        console.debug(`[Enhancements:AvatarVision] Fetching avatar from: ${url}`);

        const response = await fetch(url, { method: 'GET' });

        if (!response.ok) {
            console.warn(`[Enhancements:AvatarVision] Avatar fetch failed for "${avatarFile}": HTTP ${response.status}`);
            return null;
        }

        const blob = await response.blob();
        const base64 = await getBase64Async(blob);
        console.debug(`[Enhancements:AvatarVision] Avatar fetched OK, size: ${Math.round(base64.length / 1024)}KB`);
        return base64;
    } catch (error) {
        console.error('[Enhancements:AvatarVision] Error fetching avatar:', error);
        return null;
    }
}

/**
 * Event handler for CHAT_COMPLETION_PROMPT_READY.
 * @param {object} eventData  { chat: Array, dryRun: boolean }
 */
async function onPromptReady(eventData) {
    const settings = extension_settings[SETTINGS_KEY];

    if (!settings?.avatarVisionEnabled) return;
    if (eventData.dryRun) return;
    if (!isImageInliningSupported()) {
        console.debug('[Enhancements:AvatarVision] Skipped: image inlining not supported by current model/API');
        return;
    }

    const context = SillyTavern.getContext();
    const charId = context.characterId;

    console.debug(`[Enhancements:AvatarVision] characterId = ${charId}, name2 = ${context.name2}`);

    if (charId === undefined || charId === null) {
        console.debug('[Enhancements:AvatarVision] Skipped: no character selected');
        return;
    }

    const character = context.characters[charId];
    if (!character) {
        console.debug(`[Enhancements:AvatarVision] Skipped: character not found at index ${charId}`);
        return;
    }

    const avatarFile = character.avatar;
    console.debug(`[Enhancements:AvatarVision] Character: "${character.name}", avatar file: "${avatarFile}"`);

    if (!avatarFile || avatarFile === 'none') {
        console.debug('[Enhancements:AvatarVision] Skipped: character has no avatar');
        return;
    }

    // Fetch avatar
    const avatarBase64 = await fetchAvatarAsBase64(avatarFile);
    if (!avatarBase64) return;

    // Build the injected message
    const chat = eventData.chat;
    if (!chat || chat.length === 0) return;

    const charName = character.name || context.name2 || 'the character';
    const contentParts = [];

    if (settings.avatarVisionHint) {
        contentParts.push({
            type: 'text',
            text: `[The following image is ${charName}'s current appearance/avatar; ALWAYS (every response, do not skip!) use this image to describe, or add elements to describe (if character card already has written descriptions) character's appearance:],
        });
    }

    contentParts.push({
        type: 'image_url',
        image_url: {
            url: avatarBase64,
            detail: 'high',
        },
    });

    const avatarMessage = {
        role: 'user',
        content: contentParts,
    };

    // Insert right after the leading system messages
    let insertIndex = 0;
    for (let i = 0; i < chat.length; i++) {
        if (chat[i].role === 'system') {
            insertIndex = i + 1;
        } else {
            break;
        }
    }

    chat.splice(insertIndex, 0, avatarMessage);

    console.log(`[Enhancements:AvatarVision] Injected avatar for "${charName}" (${avatarFile}) as user message at index ${insertIndex}`);
}

// ---------------------------------------------------------------------------
// Public init — called by the base script
// ---------------------------------------------------------------------------

/**
 * @param {JQuery} contentContainer  The .inline-drawer-content element to append settings into
 */
export function init(contentContainer) {
    contentContainer.append(settingsHtml);
    loadSettings();

    $('#enhancements_avatar_vision_enabled').on('change', onSettingsChange);
    $('#enhancements_avatar_vision_hint').on('change', onSettingsChange);

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);

    console.log('[Enhancements:AvatarVision] Feature initialized');
}
