/**
 * Custom OpenAI-Compatible Vectors Feature
 *
 * Adds a "Custom OpenAI Compatible" source to SillyTavern's Vector Storage
 * extension. This lets users connect any OpenAI-compatible embeddings API
 * (e.g. local servers, third-party providers) for vectorization.
 *
 * How it works:
 *  - Injects a new <option> into the #vectors_source dropdown
 *  - Shows custom settings (API URL, API Key, Model) when selected
 *  - Intercepts fetch() calls to /api/vector/* endpoints
 *  - Computes embeddings client-side by calling the custom API directly
 *  - Forwards pre-computed embeddings to ST's backend as 'webllm' source
 *    (which already handles pre-computed embeddings natively)
 *  - Uses a distinct model identifier to keep vector storage separate
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX = '[Enhancements:CustomVectors]';

// Source key used internally and in the ST vectors settings
const CUSTOM_SOURCE = 'custom_openai';
// The server-side source we masquerade as (supports pre-computed embeddings)
const SERVER_SOURCE = 'webllm';

const defaultSettings = {
    customVectorsApiUrl: '',
    customVectorsApiKey: '',
    customVectorsModel: '',
};

// ---------------------------------------------------------------------------
// Settings HTML
// ---------------------------------------------------------------------------

const settingsHtml = `
<hr>
<h4>Custom Vectors Source</h4>
<small class="textAlignCenter">
    Adds a "Custom OpenAI Compatible" source to the Vector Storage extension.
    Point it at any server that exposes an OpenAI-compatible
    <code>/v1/embeddings</code> endpoint.
</small>
<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enhancements_custom_vectors_api_url">
        API URL <small>(base URL, e.g. <code>http://localhost:1234/v1</code>)</small>
    </label>
    <input id="enhancements_custom_vectors_api_url" class="text_pole" type="text"
           placeholder="http://localhost:1234/v1" />
</div>
<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enhancements_custom_vectors_api_key">
        API Key <small>(leave blank if not required)</small>
    </label>
    <input id="enhancements_custom_vectors_api_key" class="text_pole" type="password"
           placeholder="sk-..." />
</div>
<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enhancements_custom_vectors_model">
        Embedding Model
    </label>
    <input id="enhancements_custom_vectors_model" class="text_pole" type="text"
           placeholder="text-embedding-3-small" />
</div>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

/**
 * Calls the custom OpenAI-compatible /v1/embeddings endpoint.
 * @param {string[]} texts - Texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function computeCustomEmbeddings(texts) {
    const s = getSettings();
    const apiUrl = (s.customVectorsApiUrl || '').replace(/\/+$/, '');
    const apiKey = s.customVectorsApiKey || '';
    const model = s.customVectorsModel || '';

    if (!apiUrl) throw new Error(`${LOG_PREFIX} API URL is not configured`);
    if (!model) throw new Error(`${LOG_PREFIX} Model is not configured`);

    // Build the full URL — append /embeddings if not already present
    let url = apiUrl;
    if (!url.endsWith('/embeddings')) {
        url = url.replace(/\/+$/, '');
        // If the user provided /v1, append /embeddings; otherwise /v1/embeddings
        if (url.endsWith('/v1')) {
            url += '/embeddings';
        } else {
            url += '/v1/embeddings';
        }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log(`${LOG_PREFIX} Requesting embeddings for ${texts.length} text(s) from ${url}`);

    // Use originalFetch to bypass our own interceptor
    const response = await originalFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`${LOG_PREFIX} Embeddings API error ${response.status}: ${errText}`);
    }

    const data = await response.json();

    if (!Array.isArray(data?.data)) {
        throw new Error(`${LOG_PREFIX} Unexpected API response (missing data array)`);
    }

    // Sort by index to ensure correct order
    data.data.sort((a, b) => a.index - b.index);
    return data.data.map(x => x.embedding);
}

/**
 * Returns a stable model identifier used for vector storage scoping.
 * This keeps custom vectors separate from actual webllm vectors.
 */
function getStorageModelId() {
    const s = getSettings();
    const url = s.customVectorsApiUrl || 'unknown';
    const model = s.customVectorsModel || 'default';
    return `custom_openai__${model}__${simpleHash(url)}`;
}

/** Simple numeric hash for a string */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Fetch interception
// ---------------------------------------------------------------------------

/** Whether our custom source is currently active in vectors settings */
function isCustomSourceActive() {
    try {
        return extension_settings?.vectors?.source === CUSTOM_SOURCE;
    } catch {
        return false;
    }
}

const originalFetch = window.fetch.bind(window);

/**
 * Intercepts vector API calls when the custom source is active.
 * Computes embeddings client-side and masquerades as 'webllm'.
 */
async function interceptedFetch(input, init) {
    // Only intercept when our custom source is active
    if (!isCustomSourceActive()) {
        return originalFetch(input, init);
    }

    // Only intercept /api/vector/* POST calls
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/vector/') || init?.method !== 'POST') {
        return originalFetch(input, init);
    }

    try {
        const body = JSON.parse(init.body);

        // Only intercept if the body source matches our custom source
        if (body.source !== CUSTOM_SOURCE) {
            return originalFetch(input, init);
        }

        console.log(`${LOG_PREFIX} Intercepting ${url}`);

        const storageModel = getStorageModelId();

        if (url.includes('/api/vector/insert')) {
            // Pre-compute embeddings for all items being inserted
            const texts = (body.items || []).map(item => item.text);
            if (texts.length > 0) {
                const vectors = await computeCustomEmbeddings(texts);
                const embeddings = {};
                for (let i = 0; i < texts.length; i++) {
                    embeddings[texts[i]] = vectors[i];
                }
                body.embeddings = embeddings;
            }
            body.source = SERVER_SOURCE;
            body.model = storageModel;

        } else if (url.includes('/api/vector/query-multi')) {
            // Pre-compute embedding for the search text
            const searchText = body.searchText || '';
            if (searchText) {
                const vectors = await computeCustomEmbeddings([searchText]);
                body.embeddings = { [searchText]: vectors[0] };
            }
            body.source = SERVER_SOURCE;
            body.model = storageModel;

        } else if (url.includes('/api/vector/query')) {
            // Pre-compute embedding for the search text
            const searchText = body.searchText || '';
            if (searchText) {
                const vectors = await computeCustomEmbeddings([searchText]);
                body.embeddings = { [searchText]: vectors[0] };
            }
            body.source = SERVER_SOURCE;
            body.model = storageModel;

        } else if (url.includes('/api/vector/list') ||
                   url.includes('/api/vector/delete') ||
                   url.includes('/api/vector/purge')) {
            // These don't need embeddings, just remap the source
            body.source = SERVER_SOURCE;
            body.model = storageModel;
        }

        init.body = JSON.stringify(body);
        return originalFetch(input, init);

    } catch (error) {
        console.error(`${LOG_PREFIX} Interception error:`, error);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// UI integration with vectors extension
// ---------------------------------------------------------------------------

/**
 * Injects the "Custom OpenAI Compatible" option into the vectors source dropdown.
 * Also patches toggleSettings to show/hide our custom settings panel.
 */
function patchVectorsUI() {
    const $select = $('#vectors_source');
    if (!$select.length) {
        console.warn(`${LOG_PREFIX} #vectors_source not found — vectors extension may not be loaded yet`);
        return false;
    }

    // Add option if not already present
    if (!$select.find(`option[value="${CUSTOM_SOURCE}"]`).length) {
        // Insert alphabetically — after "Cohere"
        const $insertAfter = $select.find('option[value="cohere"]');
        const $option = $('<option>', { value: CUSTOM_SOURCE, text: 'Custom OpenAI Compatible' });
        if ($insertAfter.length) {
            $insertAfter.after($option);
        } else {
            $select.append($option);
        }
        console.log(`${LOG_PREFIX} Added "Custom OpenAI Compatible" option to vectors source`);
    }

    // Create a hint panel (no settings here — they live in the Enhancements drawer)
    if (!$('#custom_openai_vectorsModel').length) {
        const $panel = $(`
            <div class="flex-container flexFlowColumn" id="custom_openai_vectorsModel" style="display:none;">
                <i>Configure the API URL, Key, and Model in the
                <b>Enhancements</b> extension drawer below.</i>
            </div>
        `);

        // Insert the panel right after the source dropdown's parent container
        const $sourceContainer = $select.closest('.flex-container');
        $sourceContainer.after($panel);
    }

    // Restore selection if custom source was previously chosen
    if (extension_settings?.vectors?.source === CUSTOM_SOURCE) {
        $select.val(CUSTOM_SOURCE);
    }

    // Patch the toggleSettings visibility to include our panel
    patchToggleSettings();

    return true;
}

/**
 * Hooks into the #vectors_source change event to toggle our panel visibility.
 * Also patches the existing toggleSettings behavior via a MutationObserver
 * on sibling panels (since we can't modify the vectors index.js directly).
 */
function patchToggleSettings() {
    // When the source dropdown changes, show/hide our panel
    $('#vectors_source').on('change.customVectors', () => {
        const source = String($('#vectors_source').val());
        $('#custom_openai_vectorsModel').toggle(source === CUSTOM_SOURCE);
    });

    // Trigger immediately to set correct initial state
    const currentSource = String($('#vectors_source').val());
    $('#custom_openai_vectorsModel').toggle(currentSource === CUSTOM_SOURCE);

    // Use a MutationObserver on the inline-drawer-content to detect when
    // toggleSettings() hides/shows panels (since it runs on source change too).
    // We re-show our panel if the source is ours after any DOM mutation in that area.
    const drawerContent = $('#custom_openai_vectorsModel').parent().get(0);
    if (drawerContent) {
        const observer = new MutationObserver(() => {
            if (isCustomSourceActive()) {
                $('#custom_openai_vectorsModel').show();
            }
        });
        observer.observe(drawerContent, { attributes: true, subtree: true, attributeFilter: ['style'] });
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
    const settings = getSettings();
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/**
 * @param {JQuery} contentContainer The .inline-drawer-content element to append settings into
 */
export function init(contentContainer) {
    loadSettings();

    // Append settings to the Enhancements drawer
    contentContainer.append(settingsHtml);

    // Bind the Enhancements drawer settings
    const s = getSettings();

    $('#enhancements_custom_vectors_api_url')
        .val(s.customVectorsApiUrl || '')
        .on('input', function () {
            getSettings().customVectorsApiUrl = String($(this).val());
            saveSettingsDebounced();
        });

    $('#enhancements_custom_vectors_api_key')
        .val(s.customVectorsApiKey || '')
        .on('input', function () {
            getSettings().customVectorsApiKey = String($(this).val());
            saveSettingsDebounced();
        });

    $('#enhancements_custom_vectors_model')
        .val(s.customVectorsModel || '')
        .on('input', function () {
            getSettings().customVectorsModel = String($(this).val());
            saveSettingsDebounced();
        });

    // Install the fetch interceptor
    window.fetch = interceptedFetch;
    console.log(`${LOG_PREFIX} Fetch interceptor installed`);

    // Patch the vectors UI — retry if vectors extension isn't loaded yet
    if (!patchVectorsUI()) {
        const retryInterval = setInterval(() => {
            if (patchVectorsUI()) {
                clearInterval(retryInterval);
            }
        }, 500);
        // Give up after 30 seconds
        setTimeout(() => clearInterval(retryInterval), 30000);
    }

    console.log(`${LOG_PREFIX} Feature initialized`);
}
