/**
 * FreeModel Profile Feature
 *
 * One-click setup for connecting SillyTavern to FreeModel.dev's API.
 * FreeModel.dev provides an Anthropic-compatible API proxy service
 * at https://cc.freemodel.dev.
 *
 * How it works:
 *  - User enters their FreeModel.dev API key in the Enhancements drawer
 *  - "Quick Connect" configures SillyTavern to use Claude source with
 *    FreeModel.dev as the reverse proxy (https://cc.freemodel.dev/v1)
 *  - The API key is sent as the proxy password (x-api-key header)
 *  - Automatically triggers model fetching via Auto Model Fetch if enabled
 *  - "Create Profile" optionally saves a Connection Manager profile
 *    for easy switching between API providers
 *
 * URL structure:
 *  - FreeModel's ANTHROPIC_BASE_URL = https://cc.freemodel.dev
 *  - SillyTavern appends /messages to the reverse_proxy URL
 *  - So reverse_proxy = https://cc.freemodel.dev/v1
 *    → final request URL = https://cc.freemodel.dev/v1/messages
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { oai_settings, chat_completion_sources } from '../../../../openai.js';

const FREEMODEL_PROXY_URL = 'https://cc.freemodel.dev/v1';
const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX = '[Enhancements:FreeModelProfile]';

const defaultSettings = {
    freemodelApiKey: '',
};

// ---------------------------------------------------------------------------
// Settings HTML
// ---------------------------------------------------------------------------

const settingsHtml = `
<hr>
<h4>FreeModel.dev</h4>
<small class="textAlignCenter">
    One-click setup for <b>FreeModel.dev</b>'s Anthropic-compatible API proxy.
    Enter your API key from the
    <a href="https://freemodel.dev/" target="_blank" rel="noopener">FreeModel dashboard</a>
    and click "Quick Connect" to configure SillyTavern automatically.
</small>
<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enhancements_freemodel_api_key">
        FreeModel API Key
    </label>
    <input id="enhancements_freemodel_api_key" class="text_pole" type="password"
           placeholder="Paste your FreeModel.dev API key" />
</div>
<small class="textAlignCenter" style="opacity: 0.7;">
    Proxy endpoint: <code>${FREEMODEL_PROXY_URL}</code>
</small>
<div class="flex-container marginTopBot5" style="gap: 8px;">
    <div id="enhancements_freemodel_connect_btn" class="menu_button menu_button_icon" style="flex: 1;">
        <i class="fa-solid fa-plug"></i>
        <span>Quick Connect</span>
    </div>
    <div id="enhancements_freemodel_profile_btn" class="menu_button menu_button_icon" style="flex: 1;">
        <i class="fa-solid fa-bookmark"></i>
        <span>Create Profile</span>
    </div>
</div>
<small id="enhancements_freemodel_status" class="textAlignCenter" style="display:none;"></small>`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

function loadSettings() {
    const settings = getSettings();
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }
    $('#enhancements_freemodel_api_key').val(settings.freemodelApiKey || '');
}

function onApiKeyInput() {
    getSettings().freemodelApiKey = String($('#enhancements_freemodel_api_key').val());
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Show a brief status message below the buttons.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
function showStatus(message, type = 'info') {
    const $el = $('#enhancements_freemodel_status');
    $el.text(message)
        .removeClass('neutral_warning failure_warning success_warning')
        .addClass(type === 'error' ? 'failure_warning' : type === 'success' ? 'success_warning' : 'neutral_warning')
        .show();

    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => $el.fadeOut(300), 10000);
}

/**
 * Set the disabled/loading state on a button.
 * @param {string} btnSelector
 * @param {boolean} loading
 */
function setButtonLoading(btnSelector, loading) {
    const $btn = $(btnSelector);
    if (loading) {
        $btn.addClass('disabled');
    } else {
        $btn.removeClass('disabled');
    }
}

// ---------------------------------------------------------------------------
// Core — apply FreeModel settings
// ---------------------------------------------------------------------------

/**
 * Configures SillyTavern to use FreeModel.dev's API by:
 *  1. Switching to Chat Completion mode (main_api = 'openai')
 *  2. Switching to Claude source
 *  3. Setting the reverse proxy URL to FreeModel's endpoint
 *  4. Setting the proxy password to the user's API key
 *  5. Triggering the Connect button
 *
 * @returns {Promise<boolean>} Whether the settings were applied successfully
 */
async function applyFreeModelSettings() {
    const settings = getSettings();
    const apiKey = (settings.freemodelApiKey || '').trim();

    if (!apiKey) {
        showStatus('Enter your FreeModel API key first.', 'error');
        return false;
    }

    console.log(`${LOG_PREFIX} Applying FreeModel.dev settings...`);
    showStatus('Configuring SillyTavern for FreeModel.dev...', 'info');

    try {
        // 1. Ensure Chat Completion mode is active
        const currentApi = String($('#main_api').val());
        if (currentApi !== 'openai') {
            console.log(`${LOG_PREFIX} Switching main_api from "${currentApi}" to "openai"`);
            $('#main_api').val('openai').trigger('change');
            await new Promise(r => setTimeout(r, 500));
        }

        // 2. Switch to Claude source
        const currentSource = String($('#chat_completion_source').val());
        if (currentSource !== chat_completion_sources.CLAUDE) {
            console.log(`${LOG_PREFIX} Switching chat_completion_source from "${currentSource}" to "${chat_completion_sources.CLAUDE}"`);
            $('#chat_completion_source').val(chat_completion_sources.CLAUDE).trigger('change');
            await new Promise(r => setTimeout(r, 500));
        }

        // 3. Set reverse proxy URL
        $('#openai_reverse_proxy').val(FREEMODEL_PROXY_URL).trigger('input');
        oai_settings.reverse_proxy = FREEMODEL_PROXY_URL;
        console.log(`${LOG_PREFIX} Set reverse_proxy to "${FREEMODEL_PROXY_URL}"`);

        // 4. Set proxy password (FreeModel API key)
        $('#openai_proxy_password').val(apiKey).trigger('input');
        oai_settings.proxy_password = apiKey;
        console.log(`${LOG_PREFIX} Set proxy_password`);

        // 5. Persist settings
        saveSettingsDebounced();

        // 6. Small delay then click Connect
        await new Promise(r => setTimeout(r, 300));
        $('#api_button_openai').trigger('click');
        console.log(`${LOG_PREFIX} Triggered Connect button`);

        showStatus(
            'Connected to FreeModel.dev! If Auto Model Fetch is enabled, models will be fetched automatically.',
            'success',
        );
        return true;
    } catch (err) {
        console.error(`${LOG_PREFIX} Error applying settings:`, err);
        showStatus(`Failed to configure: ${err.message}`, 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
// Core — create Connection Manager profile
// ---------------------------------------------------------------------------

/**
 * Creates a Connection Manager profile for FreeModel.dev.
 * First applies the settings, then uses SillyTavern's slash command
 * system to create a named profile from the current configuration.
 */
async function createFreeModelProfile() {
    // Apply settings first so the profile captures the right state
    const applied = await applyFreeModelSettings();
    if (!applied) return;

    // Wait for the connect to settle
    await new Promise(r => setTimeout(r, 1000));

    try {
        const context = SillyTavern.getContext();

        if (typeof context.executeSlashCommandsWithOptions === 'function') {
            await context.executeSlashCommandsWithOptions('/profile-create FreeModel.dev');
            console.log(`${LOG_PREFIX} Created Connection Manager profile "FreeModel.dev"`);
            showStatus('Connection profile "FreeModel.dev" created!', 'success');
        } else if (typeof context.executeSlashCommands === 'function') {
            await context.executeSlashCommands('/profile-create FreeModel.dev');
            console.log(`${LOG_PREFIX} Created Connection Manager profile "FreeModel.dev"`);
            showStatus('Connection profile "FreeModel.dev" created!', 'success');
        } else {
            console.warn(`${LOG_PREFIX} Slash command API not available`);
            showStatus(
                'Settings applied. To save as a profile, use the Connection Manager manually.',
                'info',
            );
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Error creating profile:`, err);
        // Settings were already applied, so partial success
        showStatus(
            `Settings applied, but profile creation failed: ${err.message}`,
            'error',
        );
    }
}

// ---------------------------------------------------------------------------
// Public init — called by the base script
// ---------------------------------------------------------------------------

/**
 * @param {JQuery} contentContainer  The .inline-drawer-content element to append settings into
 */
export function init(contentContainer) {
    // Append settings UI to the Enhancements drawer
    contentContainer.append(settingsHtml);
    loadSettings();

    // Bind API key input
    $('#enhancements_freemodel_api_key').on('input', onApiKeyInput);

    // Quick Connect button
    $('#enhancements_freemodel_connect_btn').on('click', async () => {
        if ($('#enhancements_freemodel_connect_btn').hasClass('disabled')) return;

        setButtonLoading('#enhancements_freemodel_connect_btn', true);
        setButtonLoading('#enhancements_freemodel_profile_btn', true);
        try {
            await applyFreeModelSettings();
        } finally {
            setButtonLoading('#enhancements_freemodel_connect_btn', false);
            setButtonLoading('#enhancements_freemodel_profile_btn', false);
        }
    });

    // Create Profile button
    $('#enhancements_freemodel_profile_btn').on('click', async () => {
        if ($('#enhancements_freemodel_profile_btn').hasClass('disabled')) return;

        setButtonLoading('#enhancements_freemodel_connect_btn', true);
        setButtonLoading('#enhancements_freemodel_profile_btn', true);
        try {
            await createFreeModelProfile();
        } finally {
            setButtonLoading('#enhancements_freemodel_connect_btn', false);
            setButtonLoading('#enhancements_freemodel_profile_btn', false);
        }
    });

    console.log(`${LOG_PREFIX} Feature initialized`);
}
