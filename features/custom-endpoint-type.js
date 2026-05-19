/**
 * Custom Endpoint Type Feature
 *
 * Adds an "Endpoint Type" selector to SillyTavern's built-in Custom
 * (OpenAI-compatible) source, letting users choose between:
 *   /chat/completions  (default — no changes)
 *   /messages           (Anthropic Messages API format)
 *   /responses          (OpenAI Responses API format)
 *
 * Works entirely through DOM injection and window.fetch interception —
 * no SillyTavern core files are modified.
 *
 * Technique:
 *   URL fragment hack — the server always appends "/chat/completions"
 *   to custom_url.  By rewriting custom_url to "{url}/messages#", the
 *   server produces "{url}/messages#/chat/completions".  HTTP strips
 *   fragments, so the actual request hits "{url}/messages".
 *
 *   Request body is reshaped via the existing custom_include_body /
 *   custom_exclude_body YAML mechanism (prepended, not replaced, so
 *   the user's own Additional Parameters still apply).
 *
 *   Responses are transformed client-side back to OpenAI Chat
 *   Completions format (both streaming SSE and non-streaming JSON).
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX  = '[Enhancements:CustomEndpointType]';

const defaultSettings = {
    customEndpointType: 'chat_completions',
    // /messages (Anthropic) — sampling params forbidden on thinking-enabled
    // and noSampling models (opus-4-7, sonnet-4-6 w/ thinking, etc.)
    messagesExcludeTopP: false,
    messagesExcludeTemperature: false,
    messagesExcludeTopK: false,
    // /responses (OpenAI) — store responses server-side for later retrieval
    responsesStore: false,
};

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

// ───────────────────────────────────────────────────────────────────
// UI injection
// ───────────────────────────────────────────────────────────────────

/** Show/hide the endpoint-specific option panels */
function updateEndpointOptionsVisibility() {
    const type = getSettings().customEndpointType || 'chat_completions';
    $('#enhancements_endpoint_opts_messages').toggle(type === 'messages');
    $('#enhancements_endpoint_opts_responses').toggle(type === 'responses');
}

function injectUI() {
    const $form = $('#custom_form');
    if (!$form.length) {
        console.warn(`${LOG_PREFIX} #custom_form not found`);
        return;
    }

    // Guard against double-injection
    if ($('#enhancements_custom_endpoint_type').length) return;

    // ── Rename the dropdown label (visual only) ──
    $('#chat_completion_source option[value="custom"]')
        .text('ENHANCED Custom Endpoint');

    // ── Endpoint type selector + per-endpoint options ──
    const html = `
        <h4>Endpoint Type</h4>
        <div class="flex-container marginBot5">
            <select id="enhancements_custom_endpoint_type" class="text_pole wide100p">
                <option value="chat_completions">/chat/completions</option>
                <option value="messages">/messages</option>
                <option value="responses">/responses</option>
            </select>
        </div>

        <div id="enhancements_endpoint_opts_messages" style="display:none">
            <small class="textAlignCenter marginBot5" style="display:block">
                Anthropic models restrict sampling parameters when extended
                thinking is active, or on newer no-sampling models.
            </small>
            <label class="checkbox_label marginBot5" for="enh_msg_no_top_p">
                <input type="checkbox" id="enh_msg_no_top_p" />
                <span>Exclude <code>top_p</code> from request</span>
            </label>
            <label class="checkbox_label marginBot5" for="enh_msg_no_temperature">
                <input type="checkbox" id="enh_msg_no_temperature" />
                <span>Exclude <code>temperature</code> from request</span>
            </label>
            <label class="checkbox_label marginBot5" for="enh_msg_no_top_k">
                <input type="checkbox" id="enh_msg_no_top_k" />
                <span>Exclude <code>top_k</code> from request</span>
            </label>
        </div>

        <div id="enhancements_endpoint_opts_responses" style="display:none">
            <small class="textAlignCenter marginBot5" style="display:block">
                Responses API options. Unsupported Chat-Completions
                parameters are excluded automatically.
            </small>
            <label class="checkbox_label marginBot5" for="enh_resp_store">
                <input type="checkbox" id="enh_resp_store" />
                <span>Enable <code>store</code> (persist response server-side)</span>
            </label>
        </div>`;

    $form.prepend(html);

    // ── Restore saved values ──
    const s = getSettings();
    $('#enhancements_custom_endpoint_type')
        .val(s.customEndpointType || 'chat_completions');
    $('#enh_msg_no_top_p').prop('checked', !!s.messagesExcludeTopP);
    $('#enh_msg_no_temperature').prop('checked', !!s.messagesExcludeTemperature);
    $('#enh_msg_no_top_k').prop('checked', !!s.messagesExcludeTopK);
    $('#enh_resp_store').prop('checked', !!s.responsesStore);

    updateEndpointOptionsVisibility();

    // ── Persist on change ──
    $('#enhancements_custom_endpoint_type').on('change', function () {
        getSettings().customEndpointType = String($(this).val());
        saveSettingsDebounced();
        updateEndpointOptionsVisibility();
        console.log(`${LOG_PREFIX} Endpoint type → ${getSettings().customEndpointType}`);
    });

    $('#enh_msg_no_top_p').on('change', function () {
        getSettings().messagesExcludeTopP = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#enh_msg_no_temperature').on('change', function () {
        getSettings().messagesExcludeTemperature = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#enh_msg_no_top_k').on('change', function () {
        getSettings().messagesExcludeTopK = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#enh_resp_store').on('change', function () {
        getSettings().responsesStore = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

// ───────────────────────────────────────────────────────────────────
// Request-body transformers
// ───────────────────────────────────────────────────────────────────

/**
 * Reshape for Anthropic /messages.
 * - Extracts system-role messages → `system` field (via custom_include_body)
 * - Converts stop → stop_sequences
 * - Ensures max_tokens is present
 * - Adds anthropic-version header
 * - Excludes OpenAI-only body keys
 */
function transformRequestForMessages(body) {
    const messages = body.messages || [];
    const s = getSettings();

    // Pull system messages out of the array
    const systemParts = [];
    const nonSystemMessages = [];
    for (const m of messages) {
        if (m.role === 'system') {
            if (typeof m.content === 'string') {
                systemParts.push(m.content);
            } else if (Array.isArray(m.content)) {
                systemParts.push(m.content.map(c => c.text || '').join(''));
            }
        } else {
            nonSystemMessages.push(m);
        }
    }
    body.messages = nonSystemMessages;

    // --- custom_include_body (YAML, prepended) ---
    const includeLines = [];
    if (systemParts.length > 0) {
        includeLines.push(`system: ${JSON.stringify(systemParts.join('\n\n'))}`);
    }
    includeLines.push(`max_tokens: ${body.max_tokens || body.max_completion_tokens || 4096}`);
    if (body.stop) {
        const arr = Array.isArray(body.stop) ? body.stop : [body.stop];
        includeLines.push(`stop_sequences: ${JSON.stringify(arr)}`);
    }
    body.custom_include_body =
        includeLines.join('\n') + '\n' + (body.custom_include_body || '');

    // --- custom_exclude_body (YAML array, prepended) ---
    const excludes = [
        '- presence_penalty',
        '- frequency_penalty',
        '- logit_bias',
        '- seed',
        '- "n"',
        '- stop',
        '- max_completion_tokens',
        '- prompt',
        '- logprobs',
        '- top_logprobs',
    ];
    // Conditional sampling-parameter exclusions (Anthropic thinking / noSampling models)
    if (s.messagesExcludeTopP)       excludes.push('- top_p');
    if (s.messagesExcludeTemperature) excludes.push('- temperature');
    if (s.messagesExcludeTopK)       excludes.push('- top_k');

    body.custom_exclude_body =
        excludes.join('\n') + '\n' + (body.custom_exclude_body || '');

    // --- custom_include_headers (add anthropic-version) ---
    body.custom_include_headers =
        'anthropic-version: "2023-06-01"\n' + (body.custom_include_headers || '');

    // --- URL fragment hack ---
    body.custom_url =
        (body.custom_url || '').replace(/[#/]+$/, '') + '/messages#';
}

/**
 * Reshape for OpenAI Responses API /responses.
 * - Puts messages into `input` field (via custom_include_body)
 * - Converts max_tokens → max_output_tokens
 * - Excludes chat-completions-only body keys
 */
function transformRequestForResponses(body) {
    const messages = body.messages || [];
    const s = getSettings();

    // --- custom_include_body ---
    const includeLines = [];
    includeLines.push(`input: ${JSON.stringify(messages)}`);
    const maxTok = body.max_completion_tokens || body.max_tokens;
    if (maxTok) {
        includeLines.push(`max_output_tokens: ${maxTok}`);
    }
    // Responses API "store" parameter — persists responses server-side
    if (s.responsesStore) {
        includeLines.push('store: true');
    }
    body.custom_include_body =
        includeLines.join('\n') + '\n' + (body.custom_include_body || '');

    // --- custom_exclude_body ---
    body.custom_exclude_body = [
        '- messages',
        '- presence_penalty',
        '- frequency_penalty',
        '- logit_bias',
        '- seed',
        '- "n"',
        '- stop',
        '- max_tokens',
        '- max_completion_tokens',
        '- prompt',
        '- logprobs',
        '- top_logprobs',
        '- top_k',
    ].join('\n') + '\n' + (body.custom_exclude_body || '');

    // --- URL fragment hack ---
    body.custom_url =
        (body.custom_url || '').replace(/[#/]+$/, '') + '/responses#';
}

// ───────────────────────────────────────────────────────────────────
// Streaming response transformers  (TransformStream based)
// ───────────────────────────────────────────────────────────────────

/** Anthropic SSE → OpenAI Chat-Completions SSE */
function createAnthropicStreamTransform() {
    let buf = '';
    let evt = '';
    const enc = new TextEncoder();

    return new TransformStream({
        transform(chunk, ctl) {
            buf += new TextDecoder().decode(chunk).replace(/\r/g, '');
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    evt = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (evt === 'content_block_delta' &&
                            d.delta?.type === 'text_delta') {
                            const out = { choices: [{ index: 0, delta: { content: d.delta.text } }] };
                            ctl.enqueue(enc.encode(`data: ${JSON.stringify(out)}\n\n`));
                        } else if (evt === 'message_stop') {
                            ctl.enqueue(enc.encode('data: [DONE]\n\n'));
                        }
                    } catch { /* skip */ }
                    evt = '';
                }
            }
        },
        flush(ctl) {
            ctl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
    });
}

/** OpenAI Responses-API SSE → OpenAI Chat-Completions SSE */
function createResponsesStreamTransform() {
    let buf = '';
    let evt = '';
    const enc = new TextEncoder();

    return new TransformStream({
        transform(chunk, ctl) {
            buf += new TextDecoder().decode(chunk).replace(/\r/g, '');
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    evt = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (evt === 'response.output_text.delta' && d.delta) {
                            const out = { choices: [{ index: 0, delta: { content: d.delta } }] };
                            ctl.enqueue(enc.encode(`data: ${JSON.stringify(out)}\n\n`));
                        } else if (evt === 'response.completed') {
                            ctl.enqueue(enc.encode('data: [DONE]\n\n'));
                        }
                    } catch { /* skip */ }
                    evt = '';
                }
            }
        },
        flush(ctl) {
            ctl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
    });
}

// ───────────────────────────────────────────────────────────────────
// Non-streaming response transformer
// ───────────────────────────────────────────────────────────────────

/**
 * Reads the upstream JSON and wraps it in OpenAI Chat-Completions
 * format so the rest of SillyTavern can consume it normally.
 */
async function wrapNonStreamingResponse(response, endpointType) {
    const clone = response.clone();          // safety net
    let json;
    try {
        json = await response.json();
    } catch {
        return clone;                         // not JSON — return as-is
    }

    // Already in OAI format? (e.g. proxy that auto-converts)
    if (json.choices) {
        return new Response(JSON.stringify(json), {
            status: clone.status,
            statusText: clone.statusText,
            headers: clone.headers,
        });
    }

    let content = '';

    if (endpointType === 'messages') {
        // Anthropic: { content: [{ type:"text", text:"…" }, …] }
        if (Array.isArray(json.content)) {
            content = json.content.map(c => c.text || '').join('');
        }
    } else if (endpointType === 'responses') {
        // Responses API: { output: [{ type:"message", content:[{ type:"output_text", text:"…" }] }] }
        for (const item of (json.output || [])) {
            if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part.type === 'output_text') {
                        content += part.text || '';
                    }
                }
            }
        }
    }

    const oai = { choices: [{ message: { content } }] };
    // Preserve original Anthropic content array for extensions that need it
    if (endpointType === 'messages' && json.content) {
        oai.content = json.content;
    }

    return new Response(JSON.stringify(oai), {
        status: clone.status,
        statusText: clone.statusText,
        headers: clone.headers,
    });
}

// ───────────────────────────────────────────────────────────────────
// Fetch interception
// ───────────────────────────────────────────────────────────────────

const previousFetch = window.fetch;

async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';

    // Only touch /generate for the custom chat-completion source
    if (!url.includes('/api/backends/chat-completions/generate') || !init?.body) {
        return previousFetch(input, init);
    }

    let body;
    try { body = JSON.parse(init.body); } catch { return previousFetch(input, init); }

    if (body.chat_completion_source !== 'custom') {
        return previousFetch(input, init);
    }

    const endpointType = getSettings().customEndpointType || 'chat_completions';
    if (endpointType === 'chat_completions') {
        return previousFetch(input, init);     // default — pass through
    }

    const isStreaming = body.stream === true;
    console.log(`${LOG_PREFIX} Intercepting → /${endpointType}` +
                (isStreaming ? ' (streaming)' : ''));

    // ── reshape request ──
    if (endpointType === 'messages')  transformRequestForMessages(body);
    if (endpointType === 'responses') transformRequestForResponses(body);

    const modifiedInit = { ...init, body: JSON.stringify(body) };
    const response = await previousFetch(input, modifiedInit);

    // Don't transform error responses
    if (!response.ok) return response;

    // ── reshape response ──
    if (isStreaming) {
        const xform = endpointType === 'messages'
            ? createAnthropicStreamTransform()
            : createResponsesStreamTransform();
        return new Response(response.body.pipeThrough(xform), {
            status:     response.status,
            statusText: response.statusText,
            headers:    response.headers,
        });
    }

    return wrapNonStreamingResponse(response, endpointType);
}

window.fetch = interceptedFetch;

// ───────────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────────

export function init(_contentContainer) {
    // Apply defaults
    const s = getSettings();
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }

    injectUI();
    console.log(`${LOG_PREFIX} Ready  (endpoint: ${s.customEndpointType})`);
}
