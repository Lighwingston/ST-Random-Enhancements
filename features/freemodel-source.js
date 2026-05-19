/**
 * FreeModel Source Feature
 *
 * Registers FreeModel.dev as a first-class Chat Completion source in
 * SillyTavern's endpoint dropdown, alongside OpenAI, Claude, etc.
 *
 * FreeModel.dev is an Anthropic-compatible API proxy. This feature:
 *  - Injects a "FreeModel.dev" option into the #chat_completion_source dropdown
 *  - Adds a source-specific settings panel (API key + model selector)
 *  - Patches shared settings panels so Claude-compatible controls
 *    (thinking budget, streaming, temperature, etc.) also appear for FreeModel
 *  - Intercepts the Connect button to handle API key saving and model fetching
 *  - Intercepts outgoing fetch() calls to route FreeModel requests through
 *    the Claude API handler with the correct proxy URL and credentials
 *
 * URL structure:
 *  - FreeModel proxy: https://cc.freemodel.dev/v1
 *  - SillyTavern's Claude handler appends /messages
 *  - Final endpoint: https://cc.freemodel.dev/v1/messages
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { oai_settings } from '../../../../openai.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FREEMODEL_SOURCE = 'freemodel';
const FREEMODEL_PROXY_URL = 'https://cc.freemodel.dev/v1';
const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX = '[Enhancements:FreeModelSource]';

const defaultSettings = {
    freemodelApiKey: '',
    freemodelModel: '',
};

// ---------------------------------------------------------------------------
// Settings panel HTML — mirrors the pattern of built-in sources
// (e.g. electronhub_form, deepseek_form)
// ---------------------------------------------------------------------------

const panelHtml = `
<div id="freemodel_form" data-source="${FREEMODEL_SOURCE}">
    <h4>FreeModel.dev API Key</h4>
    <div>
        <a href="https://freemodel.dev/" target="_blank">Get your key from the FreeModel dashboard</a>
    </div>
    <div class="flex-container">
        <input id="api_key_freemodel" name="api_key_freemodel" class="text_pole flex1"
               value="" type="text" autocomplete="off"
               placeholder="Paste your FreeModel API key">
    </div>
    <div data-for="api_key_freemodel" class="neutral_warning">
        Your API key is stored locally in extension settings.
    </div>
    <div>
        <h4>FreeModel Model</h4>
        <select id="model_freemodel_select">
            <option value="">-- Connect to the API --</option>
        </select>
    </div>
    <small id="freemodel_connect_status" class="textAlignCenter" style="display:none;"></small>
</div>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

/** Saved reference to the real window.fetch (before our patch). */
let previousFetch = null;

/**
 * Show a status message inside the FreeModel panel.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
function showStatus(message, type = 'info') {
    const $el = $('#freemodel_connect_status');
    $el.text(message)
        .removeClass('neutral_warning failure_warning success_warning')
        .addClass(type === 'error' ? 'failure_warning' : type === 'success' ? 'success_warning' : 'neutral_warning')
        .show();
    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => $el.fadeOut(300), 10000);
}

// ---------------------------------------------------------------------------
// 1. UI injection
// ---------------------------------------------------------------------------

/**
 * Injects the FreeModel.dev option into the Chat Completion Source dropdown.
 * Placed alphabetically in the second optgroup (after Fireworks AI).
 */
function injectDropdownOption() {
    const $select = $('#chat_completion_source');
    if (!$select.length) {
        console.warn(`${LOG_PREFIX} #chat_completion_source not found`);
        return;
    }

    // Already injected?
    if ($select.find(`option[value="${FREEMODEL_SOURCE}"]`).length) return;

    const $option = $('<option>', { value: FREEMODEL_SOURCE, text: 'FreeModel.dev' });

    // Insert alphabetically — after "Fireworks AI", before "Groq"
    const $fireworks = $select.find('option[value="fireworks"]');
    if ($fireworks.length) {
        $fireworks.after($option);
    } else {
        // Fallback: append to the second optgroup
        $select.find('optgroup').last().append($option);
    }

    console.log(`${LOG_PREFIX} Injected "FreeModel.dev" option into source dropdown`);
}

/**
 * Injects the FreeModel settings panel into the DOM.
 * Placed after the last source-specific form/div.
 */
function injectSettingsPanel() {
    if ($('#freemodel_form').length) return;  // already injected

    // Find the last source panel and insert after it
    const $lastPanel = $('[data-source]:last');
    if ($lastPanel.length) {
        $lastPanel.after(panelHtml);
    } else {
        // Fallback: append to the openai settings container
        $('#openai_form').parent().append(panelHtml);
    }

    console.log(`${LOG_PREFIX} Injected settings panel`);
}

// ---------------------------------------------------------------------------
// 2. Data-source attribute patching
// ---------------------------------------------------------------------------

/**
 * Extends shared settings panels so they also appear for the FreeModel source.
 *
 * SillyTavern uses `data-source="openai,claude,..."` attributes to control
 * which panels are visible for each source. Since FreeModel is Anthropic-
 * compatible, we add 'freemodel' to every panel that already includes 'claude'.
 *
 * We skip single-source panels (like #claude_form with data-source="claude"
 * alone) — those are Claude's own API key/model panel, not shared controls.
 */
function patchDataSourceAttributes() {
    let patched = 0;

    $('[data-source]').each(function () {
        const $el = $(this);
        const sources = $el.attr('data-source');

        if (!sources || !sources.includes('claude')) return;
        if (sources.includes(FREEMODEL_SOURCE)) return;  // already patched

        // Only patch multi-source panels (shared controls) — these have commas
        // Also patch claude-only panels for thinking/reasoning controls
        const isMultiSource = sources.includes(',');
        const isCaudeThinkingPanel = (
            sources === 'claude' && (
                $el.find('[data-i18n*="thinking"]').length > 0 ||
                $el.find('[data-i18n*="Thinking"]').length > 0 ||
                $el.text().toLowerCase().includes('thinking') ||
                $el.text().toLowerCase().includes('budget')
            )
        );

        if (isMultiSource || isCaudeThinkingPanel) {
            $el.attr('data-source', sources + ',' + FREEMODEL_SOURCE);
            patched++;
        }
    });

    console.log(`${LOG_PREFIX} Patched ${patched} data-source attributes to include "${FREEMODEL_SOURCE}"`);
}

// ---------------------------------------------------------------------------
// 3. Source change handling
// ---------------------------------------------------------------------------

/**
 * Handles the source being switched to/from FreeModel.
 * Bound to the CHATCOMPLETION_SOURCE_CHANGED event (fires after ST's handler).
 */
function onSourceChanged(newSource) {
    if (newSource === FREEMODEL_SOURCE) {
        console.log(`${LOG_PREFIX} FreeModel source activated`);

        // Restore the API key into the input (it may have been cleared)
        const settings = getSettings();
        $('#api_key_freemodel').val(settings.freemodelApiKey || '');

        // Restore the selected model
        if (settings.freemodelModel) {
            const $select = $('#model_freemodel_select');
            // If the option exists, select it
            if ($select.find(`option[value="${CSS.escape(settings.freemodelModel)}"]`).length) {
                $select.val(settings.freemodelModel);
            }
        }

        // Trigger our model selector to update any dependent state
        $('#model_freemodel_select').trigger('change');
    }
}

/**
 * Handles model selection in the FreeModel model dropdown.
 */
function onFreeModelModelChange() {
    const model = String($('#model_freemodel_select').val() || '');
    const settings = getSettings();
    settings.freemodelModel = model;
    saveSettingsDebounced();
    console.log(`${LOG_PREFIX} Model changed to: "${model}"`);
}

// ---------------------------------------------------------------------------
// 4. Connect button handling
// ---------------------------------------------------------------------------

/**
 * Intercepts the Connect button click when FreeModel is the active source.
 * Uses a capture-phase event listener to run before SillyTavern's handler.
 *
 * Flow:
 *  1. Reads API key from the FreeModel input
 *  2. Saves it to extension_settings
 *  3. Fetches available models from the proxy
 *  4. Populates the model selector
 */
function hookConnectButton() {
    const btn = document.getElementById('api_button_openai');
    if (!btn) {
        console.warn(`${LOG_PREFIX} #api_button_openai not found`);
        return;
    }

    btn.addEventListener('click', async (e) => {
        if (oai_settings.chat_completion_source !== FREEMODEL_SOURCE) return;

        // Prevent SillyTavern's handler — it doesn't know about our source
        e.stopImmediatePropagation();
        e.preventDefault();

        await handleFreeModelConnect();
    }, true);  // capture phase → fires before jQuery (bubble) handlers

    console.log(`${LOG_PREFIX} Hooked connect button (capture phase)`);
}

/**
 * Handles the FreeModel connection flow.
 */
async function handleFreeModelConnect() {
    const settings = getSettings();
    const apiKey = String($('#api_key_freemodel').val() || '').trim();

    if (!apiKey) {
        showStatus('Please enter your FreeModel API key.', 'error');
        return;
    }

    // Save the API key
    settings.freemodelApiKey = apiKey;
    saveSettingsDebounced();

    // Clear the input for privacy (mimics SillyTavern's behavior)
    $('#api_key_freemodel').val('');

    showStatus('Connecting to FreeModel.dev...', 'info');
    console.log(`${LOG_PREFIX} Connecting to FreeModel.dev...`);

    try {
        // Fetch models using SillyTavern's backend as a proxy.
        // We use source='openai' which triggers the generic /v1/models fetcher
        // on the server side, pointed at our reverse proxy URL.
        const fetchFn = previousFetch || window.fetch;
        const response = await fetchFn('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy: FREEMODEL_PROXY_URL,
                proxy_password: apiKey,
            }),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json();

        // Populate models
        if (data?.data && Array.isArray(data.data)) {
            populateModels(data.data);
            showStatus(`Connected! Found ${data.data.length} model(s).`, 'success');
        } else {
            // Connection succeeded but no model list — populate with defaults
            populateDefaultModels();
            showStatus('Connected! Using default model list.', 'success');
        }

        // Visual feedback — add a green tint to the connect button briefly
        const $btn = $('#api_button_openai');
        $btn.addClass('successLink');
        setTimeout(() => $btn.removeClass('successLink'), 3000);

        console.log(`${LOG_PREFIX} Connected successfully`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Connection failed:`, err);

        // Fall back to default models even on error — the user can still try to generate
        populateDefaultModels();
        showStatus(`Connection check failed: ${err.message}. Default models loaded.`, 'error');
    }
}

/**
 * Populates the FreeModel model selector with models from the API response.
 * @param {Array<{id: string}>} models
 */
function populateModels(models) {
    const $select = $('#model_freemodel_select');
    const currentModel = getSettings().freemodelModel;

    $select.empty();

    // Sort alphabetically
    const sorted = [...models]
        .filter(m => m && m.id)
        .sort((a, b) => a.id.localeCompare(b.id));

    if (sorted.length === 0) {
        $select.append($('<option>', { value: '', text: '-- No models found --' }));
        return;
    }

    for (const model of sorted) {
        $select.append($('<option>', { value: model.id, text: model.id }));
    }

    // Restore previous selection if it exists in the new list
    if (currentModel && $select.find(`option[value="${CSS.escape(currentModel)}"]`).length) {
        $select.val(currentModel);
    } else {
        // Select the first model
        $select.prop('selectedIndex', 0);
    }

    $select.trigger('change');

    console.log(`${LOG_PREFIX} Populated ${sorted.length} models`);
}

/**
 * Populates the model selector with common Anthropic model names.
 * Used as a fallback when the /v1/models endpoint is unavailable.
 */
function populateDefaultModels() {
    const defaultModels = [
        'claude-sonnet-4-5',
        'claude-sonnet-4-0',
        'claude-opus-4-0',
        'claude-haiku-4-5',
        'claude-3-7-sonnet-latest',
        'claude-3-5-sonnet-latest',
        'claude-3-5-haiku-latest',
        'claude-3-opus-20240229',
    ];

    populateModels(defaultModels.map(id => ({ id })));
}

// ---------------------------------------------------------------------------
// 5. Fetch interception
// ---------------------------------------------------------------------------

/**
 * Intercepts outgoing fetch() calls to transform FreeModel requests.
 *
 * When the active source is 'freemodel', modifies requests to:
 *  - /api/backends/chat-completions/generate → source='claude' + proxy settings
 *  - /api/backends/chat-completions/status  → source='claude' + proxy settings
 *
 * The SillyTavern backend then processes these as standard Claude-via-proxy
 * requests, which are fully supported.
 */
function installFetchInterceptor() {
    previousFetch = window.fetch;

    window.fetch = async function (input, init) {
        // Only intercept when FreeModel is the active source
        if (oai_settings.chat_completion_source !== FREEMODEL_SOURCE) {
            return previousFetch.call(window, input, init);
        }

        const url = typeof input === 'string' ? input : input?.url || '';

        // Only intercept chat-completions API calls
        const isGenerate = url.includes('/api/backends/chat-completions/generate');
        const isStatus = url.includes('/api/backends/chat-completions/status');

        if (!isGenerate && !isStatus) {
            return previousFetch.call(window, input, init);
        }

        // Only intercept POST requests with a body
        if (!init?.body || init.method !== 'POST') {
            return previousFetch.call(window, input, init);
        }

        try {
            const body = JSON.parse(init.body);

            // Only transform if the request source is 'freemodel'
            if (body.chat_completion_source !== FREEMODEL_SOURCE) {
                return previousFetch.call(window, input, init);
            }

            const settings = getSettings();

            // Transform: route through Claude handler with FreeModel proxy
            body.chat_completion_source = 'claude';
            body.reverse_proxy = FREEMODEL_PROXY_URL;
            body.proxy_password = settings.freemodelApiKey || '';

            // Set the model from our settings
            if (settings.freemodelModel) {
                body.model = settings.freemodelModel;
            }

            console.log(`${LOG_PREFIX} Intercepted ${isGenerate ? 'generate' : 'status'} request → routing as Claude via proxy`);

            init.body = JSON.stringify(body);
        } catch (err) {
            console.error(`${LOG_PREFIX} Fetch intercept error:`, err);
            // On error, pass through unmodified
        }

        return previousFetch.call(window, input, init);
    };

    console.log(`${LOG_PREFIX} Fetch interceptor installed`);
}

// ---------------------------------------------------------------------------
// 6. Settings persistence & restoration
// ---------------------------------------------------------------------------

function loadSettings() {
    const settings = getSettings();
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }
}

/**
 * Restores FreeModel as the active source on page load, if it was active
 * when the user last left the page.
 *
 * SillyTavern saves oai_settings.chat_completion_source as 'freemodel',
 * but since the option didn't exist in the dropdown at load time, the UI
 * may be in a broken state. This function fixes it once the extension loads.
 */
function restoreIfActive() {
    if (oai_settings.chat_completion_source === FREEMODEL_SOURCE) {
        console.log(`${LOG_PREFIX} Restoring FreeModel as active source (was saved from previous session)`);

        // The dropdown option and panel are now injected — select the option
        $('#chat_completion_source').val(FREEMODEL_SOURCE);

        // Re-run the visibility toggle manually since toggleChatCompletionForms
        // already ran with 'freemodel' before our data-source patches were applied.
        // Now that patches are in place, we need to re-evaluate panel visibility.
        $('[data-source]').each(function () {
            const $el = $(this);
            const mode = $el.data('source-mode');
            const sources = String($el.attr('data-source')).split(',');
            const matches = sources.includes(FREEMODEL_SOURCE);
            $el.toggle(mode !== 'except' ? matches : !matches);
        });

        // Restore model selection
        const settings = getSettings();
        if (settings.freemodelModel) {
            const $select = $('#model_freemodel_select');
            if (!$select.find(`option[value="${CSS.escape(settings.freemodelModel)}"]`).length) {
                // Add the model as an option if it doesn't exist yet
                $select.append($('<option>', {
                    value: settings.freemodelModel,
                    text: settings.freemodelModel,
                }));
            }
            $select.val(settings.freemodelModel);
        }

        // Restore API key indicator
        if (settings.freemodelApiKey) {
            showStatus('API key loaded from settings. Click Connect to verify and refresh models.', 'info');
        }
    }
}

// ---------------------------------------------------------------------------
// Public init — called by the base script
// ---------------------------------------------------------------------------

/**
 * @param {JQuery} _contentContainer  The Enhancements drawer (unused — this
 *                                    feature injects into ST's main UI instead)
 */
export function init(_contentContainer) {
    loadSettings();

    // 1. Inject UI into SillyTavern's chat completion settings area
    injectDropdownOption();
    injectSettingsPanel();

    // 2. Patch data-source attributes so shared panels appear for FreeModel
    patchDataSourceAttributes();

    // 3. Listen for source changes
    //    Use the ST event system via SillyTavern.getContext() if available,
    //    otherwise fall back to jQuery change event on the dropdown.
    try {
        const context = SillyTavern.getContext();
        if (context?.eventSource && context?.eventTypes?.CHATCOMPLETION_SOURCE_CHANGED) {
            context.eventSource.on(
                context.eventTypes.CHATCOMPLETION_SOURCE_CHANGED,
                (source) => onSourceChanged(source),
            );
            console.log(`${LOG_PREFIX} Bound to CHATCOMPLETION_SOURCE_CHANGED event`);
        } else {
            throw new Error('Event system not available');
        }
    } catch {
        // Fallback: use jQuery on the dropdown
        $('#chat_completion_source').on('change.freemodel', function () {
            const val = String($(this).val());
            onSourceChanged(val);
        });
        console.log(`${LOG_PREFIX} Bound to #chat_completion_source change (fallback)`);
    }

    // 4. Model selector change handler
    $(document).on('change', '#model_freemodel_select', onFreeModelModelChange);

    // 5. Hook into the Connect button (capture phase)
    hookConnectButton();

    // 6. Install the fetch interceptor for API call routing
    installFetchInterceptor();

    // 7. Restore state if FreeModel was the active source on previous page load
    restoreIfActive();

    console.log(`${LOG_PREFIX} Feature initialized`);
}
