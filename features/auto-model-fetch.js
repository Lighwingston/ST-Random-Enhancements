/**
 * Auto Model Fetch Feature
 *
 * Automatically fetches available model lists from reverse proxy endpoints
 * for API sources that normally only show hardcoded models in SillyTavern.
 *
 * Supported sources:
 *  - Claude (Anthropic) — normally static-only, this adds dynamic proxy fetching
 *  - Vertex AI — normally static-only, this adds dynamic proxy fetching
 *  - OpenAI — already supports dynamic fetching, this auto-triggers it with proxies
 *  - Google AI Studio — already supports dynamic fetching, this provides manual re-fetch
 *
 * How it works:
 *  - Injects "Proxy Models" optgroups into Claude and Vertex AI model selectors
 *  - When the user clicks "Connect" (or manually triggers), the extension calls
 *    SillyTavern's backend /api/backends/chat-completions/status with source=openai
 *    and the reverse proxy URL, which makes the server fetch /v1/models from the proxy
 *  - The returned model list is then populated into the appropriate dropdown
 *  - Injects a small "Fetch" button next to each supported model selector
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { oai_settings, chat_completion_sources } from '../../../../openai.js';

const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX = '[Enhancements:AutoModelFetch]';

const defaultSettings = {
    autoModelFetchEnabled: true,
};

// ---------------------------------------------------------------------------
// Source configurations
// ---------------------------------------------------------------------------

/**
 * Configuration for each supported source.
 * @typedef {Object} SourceConfig
 * @property {string} selectId - jQuery selector for the model dropdown
 * @property {string} externalGroupId - ID for the injected optgroup (without #)
 * @property {string} settingKey - oai_settings key for the selected model
 * @property {string} groupLabel - Label for the injected optgroup
 * @property {boolean} needsOptgroup - Whether we need to inject an optgroup
 * @property {boolean} isNoValidate - Whether ST normally skips model fetching for this source
 */
const SOURCE_CONFIGS = {
    [chat_completion_sources.CLAUDE]: {
        selectId: '#model_claude_select',
        externalGroupId: 'claude_proxy_models',
        settingKey: 'claude_model',
        groupLabel: 'Proxy Models',
        needsOptgroup: true,
        isNoValidate: true,
    },
    [chat_completion_sources.VERTEXAI]: {
        selectId: '#model_vertexai_select',
        externalGroupId: 'vertexai_proxy_models',
        settingKey: 'vertexai_model',
        groupLabel: 'Proxy Models',
        needsOptgroup: true,
        isNoValidate: true,
    },
    [chat_completion_sources.OPENAI]: {
        selectId: '#model_openai_select',
        externalGroupId: 'openai_external_category',  // already exists in ST
        settingKey: 'openai_model',
        groupLabel: 'External',
        needsOptgroup: false,  // already exists
        isNoValidate: false,
    },
    [chat_completion_sources.MAKERSUITE]: {
        selectId: '#model_google_select',
        externalGroupId: 'google_other_models',  // already exists in ST
        settingKey: 'google_model',
        groupLabel: 'Other',
        needsOptgroup: false,  // already exists
        isNoValidate: false,
    },
};

// ---------------------------------------------------------------------------
// Settings HTML
// ---------------------------------------------------------------------------

const settingsHtml = `
<hr>
<h4>Auto Model Fetch</h4>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enhancements_auto_model_fetch_enabled">
        <input type="checkbox" id="enhancements_auto_model_fetch_enabled" />
        <span>Fetch models from proxy on connect</span>
    </label>
</div>
<small class="textAlignCenter">
    When enabled and a reverse proxy is configured, automatically fetches the
    available model list from the proxy when you click "Connect". Works with
    Claude, Vertex AI, OpenAI, and Google AI Studio sources. The proxy must
    expose an OpenAI-compatible <code>/v1/models</code> endpoint.
</small>
<div class="flex-container marginTopBot5">
    <div id="enhancements_fetch_models_btn" class="menu_button menu_button_icon">
        <i class="fa-solid fa-arrows-rotate"></i>
        <span>Fetch Proxy Models Now</span>
    </div>
</div>
<small id="enhancements_fetch_status" class="textAlignCenter" style="display:none;"></small>`;

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
    $('#enhancements_auto_model_fetch_enabled').prop('checked', settings.autoModelFetchEnabled);
}

function onSettingsChange() {
    const settings = getSettings();
    settings.autoModelFetchEnabled = $('#enhancements_auto_model_fetch_enabled').is(':checked');
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Show a brief status message below the fetch button.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
function showStatus(message, type = 'info') {
    const $el = $('#enhancements_fetch_status');
    $el.text(message)
        .removeClass('neutral_warning failure_warning success_warning')
        .addClass(type === 'error' ? 'failure_warning' : type === 'success' ? 'success_warning' : 'neutral_warning')
        .show();

    // Auto-hide after 8 seconds
    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => $el.fadeOut(300), 8000);
}

/**
 * Set the spinner state on the fetch button.
 * @param {boolean} spinning
 */
function setFetchButtonSpinning(spinning) {
    const $btn = $('#enhancements_fetch_models_btn');
    const $icon = $btn.find('i');
    if (spinning) {
        $icon.addClass('fa-spin');
        $btn.addClass('disabled');
    } else {
        $icon.removeClass('fa-spin');
        $btn.removeClass('disabled');
    }
}

// ---------------------------------------------------------------------------
// Optgroup injection
// ---------------------------------------------------------------------------

/**
 * Inject "Proxy Models" optgroups into model selectors that don't have one.
 * This is needed for Claude and Vertex AI which have no dynamic model support.
 */
function injectOptgroups() {
    for (const [source, config] of Object.entries(SOURCE_CONFIGS)) {
        if (!config.needsOptgroup) continue;

        const $select = $(config.selectId);
        if (!$select.length) {
            console.warn(`${LOG_PREFIX} Select ${config.selectId} not found`);
            continue;
        }

        // Only inject if not already present
        if ($(`#${config.externalGroupId}`).length) continue;

        const $optgroup = $('<optgroup>', {
            id: config.externalGroupId,
            label: config.groupLabel,
        });
        $select.append($optgroup);
        console.log(`${LOG_PREFIX} Injected "${config.groupLabel}" optgroup into ${config.selectId}`);
    }
}

// ---------------------------------------------------------------------------
// Fetch button injection near model selectors
// ---------------------------------------------------------------------------

/**
 * Inject small "Fetch" buttons next to the model selectors for Claude
 * and Vertex AI (the sources that normally have no dynamic model support).
 */
function injectFetchButtons() {
    const injectTargets = [
        {
            source: chat_completion_sources.CLAUDE,
            selectId: '#model_claude_select',
            btnId: 'enhancements_fetch_claude_btn',
        },
        {
            source: chat_completion_sources.VERTEXAI,
            selectId: '#model_vertexai_select',
            btnId: 'enhancements_fetch_vertexai_btn',
        },
    ];

    for (const target of injectTargets) {
        if ($(`#${target.btnId}`).length) continue;  // already injected

        const $select = $(target.selectId);
        if (!$select.length) continue;

        const $btn = $(`
            <div id="${target.btnId}" class="menu_button fa-solid fa-arrows-rotate"
                 title="Fetch models from proxy"
                 style="margin-left: 5px; padding: 6px 8px; font-size: 14px; cursor: pointer;">
            </div>
        `);

        // Insert the button right after the select element
        const $selectParent = $select.parent();
        if ($selectParent.hasClass('flex-container') || $selectParent.is('div')) {
            $selectParent.css('display', 'flex').css('align-items', 'center');
            $select.after($btn);
        } else {
            $select.after($btn);
        }

        $btn.on('click', async () => {
            // Temporarily force the source for fetching
            await fetchModels(target.source);
        });

        console.log(`${LOG_PREFIX} Injected fetch button next to ${target.selectId}`);
    }
}

// ---------------------------------------------------------------------------
// Core model fetching
// ---------------------------------------------------------------------------

/**
 * Fetch models from the reverse proxy for a given source.
 * Uses SillyTavern's backend /api/backends/chat-completions/status endpoint
 * with source=openai to leverage the generic /v1/models fetcher.
 *
 * @param {string} [sourceOverride] - Force a specific source (defaults to current)
 * @returns {Promise<boolean>} - Whether models were successfully fetched
 */
async function fetchModels(sourceOverride) {
    const source = sourceOverride || oai_settings.chat_completion_source;
    const config = SOURCE_CONFIGS[source];

    if (!config) {
        console.log(`${LOG_PREFIX} Source "${source}" is not supported for auto model fetch`);
        return false;
    }

    const proxyUrl = oai_settings.reverse_proxy;
    const proxyPassword = oai_settings.proxy_password;

    if (!proxyUrl) {
        showStatus('No reverse proxy configured. Enter a proxy URL first.', 'error');
        console.log(`${LOG_PREFIX} No reverse proxy configured for source "${source}"`);
        return false;
    }

    console.log(`${LOG_PREFIX} Fetching models for source "${source}" from proxy: ${proxyUrl}`);
    setFetchButtonSpinning(true);
    showStatus('Fetching models from proxy...', 'info');

    // Also set the inline button spinning if it exists
    const inlineBtnId = source === chat_completion_sources.CLAUDE
        ? '#enhancements_fetch_claude_btn'
        : source === chat_completion_sources.VERTEXAI
            ? '#enhancements_fetch_vertexai_btn'
            : null;
    if (inlineBtnId) {
        $(inlineBtnId).addClass('fa-spin disabled');
    }

    try {
        // We use the 'openai' source in the request body to leverage
        // the server's generic OpenAI-compatible /v1/models fetcher.
        // The server will:
        //  1. Set apiUrl = reverse_proxy
        //  2. Set apiKey = proxy_password (as Bearer token)
        //  3. Fetch GET {apiUrl}/models
        //  4. Return the model list
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: chat_completion_sources.OPENAI,
                reverse_proxy: proxyUrl,
                proxy_password: proxyPassword || '',
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`Server returned HTTP ${response.status}: ${errorText}`);
        }

        const responseData = await response.json();

        if (!responseData.data || !Array.isArray(responseData.data)) {
            throw new Error('Server response did not contain a valid model list');
        }

        const models = responseData.data;
        console.log(`${LOG_PREFIX} Fetched ${models.length} models for source "${source}"`);

        // Populate the dropdown
        populateModels(source, config, models);

        showStatus(`Fetched ${models.length} model(s) from proxy.`, 'success');

        // For OpenAI, auto-enable show_external_models so the user can see them
        if (source === chat_completion_sources.OPENAI && !oai_settings.show_external_models) {
            oai_settings.show_external_models = true;
            $('#openai_show_external_models').prop('checked', true);
            $('#openai_external_category').show();
            saveSettingsDebounced();
            console.log(`${LOG_PREFIX} Auto-enabled "Show External Models" for OpenAI`);
        }

        return true;
    } catch (err) {
        console.error(`${LOG_PREFIX} Error fetching models:`, err);
        showStatus(`Failed to fetch models: ${err.message}`, 'error');
        return false;
    } finally {
        setFetchButtonSpinning(false);
        if (inlineBtnId) {
            $(inlineBtnId).removeClass('fa-spin disabled');
        }
    }
}

/**
 * Populate the model dropdown for a source with fetched models.
 *
 * @param {string} source - The chat completion source key
 * @param {SourceConfig} config - The source configuration
 * @param {Array<{id: string}>} models - Array of model objects with at least an `id` field
 */
function populateModels(source, config, models) {
    const $select = $(config.selectId);
    if (!$select.length) {
        console.warn(`${LOG_PREFIX} Select ${config.selectId} not found, cannot populate`);
        return;
    }

    const $optgroup = $(`#${config.externalGroupId}`);
    if (!$optgroup.length) {
        console.warn(`${LOG_PREFIX} Optgroup #${config.externalGroupId} not found`);
        return;
    }

    // Collect existing static model IDs to avoid duplicates
    const existingModelIds = new Set();
    $select.find('option').each(function () {
        const val = $(this).val();
        // Don't count options from our own optgroup
        if (!$(this).parent().is($optgroup) && val) {
            existingModelIds.add(val);
        }
    });

    // Clear previous proxy models
    $optgroup.empty();

    // Sort models alphabetically by ID
    const sortedModels = [...models]
        .filter(m => m && m.id)
        .sort((a, b) => a.id.localeCompare(b.id));

    let addedCount = 0;
    for (const model of sortedModels) {
        // Skip models that already exist in static options
        if (existingModelIds.has(model.id)) continue;

        $optgroup.append($('<option>', {
            value: model.id,
            text: model.id,
        }));
        addedCount++;
    }

    console.log(`${LOG_PREFIX} Added ${addedCount} new models to ${config.selectId} (${sortedModels.length - addedCount} duplicates skipped)`);

    // If the currently selected model is still valid, keep it
    const currentModel = oai_settings[config.settingKey];
    if (currentModel) {
        // Check if current model exists in the select
        const $existing = $select.find(`option[value="${CSS.escape(currentModel)}"]`);
        if ($existing.length) {
            $select.val(currentModel);
        }
    }

    // Show the optgroup if it has any models
    if (addedCount > 0) {
        $optgroup.show();
    }
}

// ---------------------------------------------------------------------------
// Connect button hook
// ---------------------------------------------------------------------------

/**
 * Hook into the "Connect" button to auto-fetch models for noValidate sources.
 * SillyTavern's default handler for Claude/VertexAI just shows "Key saved"
 * without fetching models. We intercept the click to fetch from the proxy.
 */
function hookConnectButton() {
    // The connect button for chat completion sources
    $('#api_button_openai').on('click.autoModelFetch', async () => {
        const settings = getSettings();
        if (!settings.autoModelFetchEnabled) return;

        const source = oai_settings.chat_completion_source;
        const config = SOURCE_CONFIGS[source];

        if (!config) return;
        if (!oai_settings.reverse_proxy) return;

        // For noValidate sources (Claude, VertexAI), ST skips model fetching entirely.
        // We need to do it ourselves.
        // For other sources (OpenAI, MakerSuite), ST already fetches models,
        // but we don't need to duplicate that work.
        if (config.isNoValidate) {
            // Small delay to let ST's default handler finish first
            // (it sets "Key saved" status immediately for noValidate sources)
            await new Promise(r => setTimeout(r, 300));
            console.log(`${LOG_PREFIX} Auto-fetching models after connect for "${source}"`);
            await fetchModels(source);
        }
    });

    console.log(`${LOG_PREFIX} Hooked into connect button`);
}

// ---------------------------------------------------------------------------
// Public init — called by the base script
// ---------------------------------------------------------------------------

/**
 * @param {JQuery} contentContainer  The .inline-drawer-content element to append settings into
 */
export function init(contentContainer) {
    // Append settings to the Enhancements drawer
    contentContainer.append(settingsHtml);
    loadSettings();

    // Bind settings events
    $('#enhancements_auto_model_fetch_enabled').on('change', onSettingsChange);

    // Manual fetch button
    $('#enhancements_fetch_models_btn').on('click', async () => {
        if ($('#enhancements_fetch_models_btn').hasClass('disabled')) return;
        await fetchModels();
    });

    // Inject optgroups into Claude and VertexAI selects
    injectOptgroups();

    // Inject small fetch buttons next to the model selectors
    injectFetchButtons();

    // Hook into the connect button for auto-fetching
    hookConnectButton();

    console.log(`${LOG_PREFIX} Feature initialized`);
}
