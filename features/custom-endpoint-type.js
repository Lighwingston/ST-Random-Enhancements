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

// ── Claude Code spoof — stable per-session identifiers ──
// Claude Code generates these once per CLI invocation and reuses them
// across all requests in that session.  We mirror that behaviour.
function generateUUID() {
    return crypto.randomUUID?.() ||
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
}

// metadata.user_id format used by Claude Code:
//   user_<64-hex>_account__session_<uuid>
function generateClaudeCodeUserId() {
    const hexChars = '0123456789abcdef';
    let userHash = '';
    for (let i = 0; i < 64; i++) {
        userHash += hexChars[Math.floor(Math.random() * 16)];
    }
    return `user_${userHash}_account__session_${generateUUID()}`;
}

const SPOOF_USER_ID    = generateClaudeCodeUserId();
const SPOOF_SESSION_ID = generateUUID();   // x-session-id / parent_tool_use_id

// Claude Code identity prefix — THE single most important detection vector.
// Every real Claude Code request starts its system array with exactly this
// string as the first content block.  APIs that gate access on Claude-Code
// usage check for this verbatim text.
const CLAUDE_CODE_IDENTITY =
    "You are Claude Code, Anthropic's official CLI for Claude.";

// Version we identify as.  Bump occasionally to follow upstream releases.
const CLAUDE_CODE_VERSION = '1.0.43';

// ── Claude Code tool definitions for request spoofing ──
// Minimal but realistic schemas matching the official CLI toolset.
// cache_control on the last tool mirrors Claude Code's prompt-caching pattern.
const CLAUDE_CODE_TOOLS = [
    {
        name: 'Read',
        description: 'Read a file or directory from the local filesystem.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'The absolute path to the file to read' },
                offset: { type: 'integer', description: 'Line offset to start reading from' },
                limit: { type: 'integer', description: 'Maximum number of lines to read' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'Write',
        description: 'Write a file to the local filesystem. Overwrites existing files.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'The absolute path to the file to write' },
                content: { type: 'string', description: 'The content to write' },
            },
            required: ['file_path', 'content'],
        },
    },
    {
        name: 'Edit',
        description: 'Perform exact string replacements in files.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'The absolute path to the file to modify' },
                old_string: { type: 'string', description: 'The text to replace' },
                new_string: { type: 'string', description: 'The replacement text' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'Bash',
        description: 'Execute a bash command in a persistent shell session.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command to execute' },
                timeout: { type: 'integer', description: 'Optional timeout in milliseconds' },
                workdir: { type: 'string', description: 'Working directory for the command' },
            },
            required: ['command'],
        },
    },
    {
        name: 'Glob',
        description: 'Fast file pattern matching tool that works with any codebase size.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The glob pattern to match files against' },
                path: { type: 'string', description: 'The directory to search in' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'Grep',
        description: 'Fast content search tool that works with any codebase size.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The regex pattern to search for' },
                path: { type: 'string', description: 'The directory to search in' },
                include: { type: 'string', description: 'File pattern to include in the search' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'WebFetch',
        description: 'Fetch content from a specified URL.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to fetch content from' },
                format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Output format' },
            },
            required: ['url'],
        },
    },
    {
        name: 'TodoRead',
        description: 'Read the current task list.',
        input_schema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'TodoWrite',
        description: 'Create and manage a structured task list.',
        input_schema: {
            type: 'object',
            properties: {
                todos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: 'Task description' },
                            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                        },
                        required: ['content', 'status'],
                    },
                },
            },
            required: ['todos'],
        },
    },
    {
        name: 'Task',
        description: 'Launch a new agent to handle complex tasks autonomously.',
        input_schema: {
            type: 'object',
            properties: {
                description: { type: 'string', description: 'Short task description' },
                prompt: { type: 'string', description: 'The task for the agent to perform' },
            },
            required: ['description', 'prompt'],
        },
        cache_control: { type: 'ephemeral' },
    },
];

const defaultSettings = {
    customEndpointType: 'chat_completions',
    // /messages (Anthropic) — sampling params forbidden on thinking-enabled
    // and noSampling models (opus-4-7, sonnet-4-6 w/ thinking, etc.)
    messagesExcludeTopP: false,
    messagesExcludeTemperature: false,
    messagesExcludeTopK: false,
    // /messages (Anthropic) — spoof requests as Claude Code client
    claudeCodeSpoof: false,
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
            <hr class="marginBot5 marginTop5" />
            <label class="checkbox_label marginBot5" for="enh_msg_cc_spoof">
                <input type="checkbox" id="enh_msg_cc_spoof" />
                <span>Spoof as <b>Claude Code</b> client</span>
            </label>
            <small class="textAlignCenter" style="display:block; opacity:0.7">
                Makes the request indistinguishable from the official
                Claude Code CLI: prepends the
                <code>"You are Claude Code…"</code> identity to the
                system prompt, sets matching user-agent / x-app /
                anthropic-beta / x-stainless-* headers, attaches the
                CLI tool catalog, and uses the Claude Code
                <code>metadata.user_id</code> format. For endpoints
                that gate access to Claude Code users only.
            </small>
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
    $('#enh_msg_cc_spoof').prop('checked', !!s.claudeCodeSpoof);
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
    $('#enh_msg_cc_spoof').on('change', function () {
        getSettings().claudeCodeSpoof = $(this).prop('checked');
        saveSettingsDebounced();
        console.log(`${LOG_PREFIX} Claude Code spoof → ${getSettings().claudeCodeSpoof}`);
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

    // Claude Code spoof — structured content blocks + cache markers
    if (s.claudeCodeSpoof) {
        for (const msg of body.messages) {
            if (typeof msg.content === 'string') {
                msg.content = [{ type: 'text', text: msg.content }];
            }
        }
        // Prompt caching: cache_control on the last user message
        for (let i = body.messages.length - 1; i >= 0; i--) {
            if (body.messages[i].role === 'user' && Array.isArray(body.messages[i].content)) {
                const blocks = body.messages[i].content;
                if (blocks.length > 0) {
                    blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
                }
                break;
            }
        }
    }

    // --- custom_include_body (YAML, prepended) ---
    const includeLines = [];
    if (s.claudeCodeSpoof) {
        // Claude Code ALWAYS sends system as a two-block array:
        //   [0] = identity block ("You are Claude Code...")  — cache_control
        //   [1] = the actual prompt / env block               — cache_control
        // The first block is what gating APIs look for verbatim.
        // We always emit both blocks even when SillyTavern provided no
        // system content (e.g. on the built-in "test message" button).
        const systemBlocks = [
            {
                type: 'text',
                text: CLAUDE_CODE_IDENTITY,
                cache_control: { type: 'ephemeral' },
            },
            {
                type: 'text',
                text: systemParts.length > 0
                    ? systemParts.join('\n\n')
                    : "\nYou are an interactive CLI tool that helps users with software engineering tasks.",
                cache_control: { type: 'ephemeral' },
            },
        ];
        includeLines.push(`system: ${JSON.stringify(systemBlocks)}`);
    } else if (systemParts.length > 0) {
        includeLines.push(`system: ${JSON.stringify(systemParts.join('\n\n'))}`);
    }
    includeLines.push(`max_tokens: ${body.max_tokens || body.max_completion_tokens || 4096}`);
    if (body.stop) {
        const arr = Array.isArray(body.stop) ? body.stop : [body.stop];
        includeLines.push(`stop_sequences: ${JSON.stringify(arr)}`);
    }

    // Claude Code spoof — inject metadata and tools
    if (s.claudeCodeSpoof) {
        includeLines.push(`metadata: ${JSON.stringify({ user_id: SPOOF_USER_ID })}`);
        includeLines.push(`tools: ${JSON.stringify(CLAUDE_CODE_TOOLS)}`);
        // tool_choice:auto matches Claude Code's default — present even when
        // the model isn't expected to call a tool.
        includeLines.push(`tool_choice: ${JSON.stringify({ type: 'auto' })}`);
    }

    body.custom_include_body =
        includeLines.join('\n') + '\n' + (body.custom_include_body || '');

    // --- Direct field deletion from request body ---
    // The server reads these from request.body and puts them in requestBody;
    // deleting them here makes them undefined → omitted from final JSON.
    // This is more reliable than the YAML exclude mechanism.
    delete body.presence_penalty;
    delete body.frequency_penalty;
    delete body.logit_bias;
    delete body.seed;
    delete body.n;
    delete body.stop;
    delete body.max_completion_tokens;
    delete body.logprobs;

    // Conditional sampling-parameter exclusions
    // (Anthropic thinking-enabled / noSampling models like opus-4-7)
    if (s.messagesExcludeTopP)        delete body.top_p;
    if (s.messagesExcludeTemperature)  delete body.temperature;
    if (s.messagesExcludeTopK)         delete body.top_k;

    // --- custom_include_headers ---
    let includeHeaders = 'anthropic-version: "2023-06-01"\n';
    if (s.claudeCodeSpoof) {
        // Headers Claude Code's official CLI sends.  Detection upstream
        // typically combines several of these into a fingerprint.
        const ccHeaders = {
            'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
            'x-app': 'cli',
            'anthropic-beta': [
                'claude-code-20250219',
                'oauth-2025-04-20',
                'interleaved-thinking-2025-05-14',
                'fine-grained-tool-streaming-2025-05-14',
            ].join(','),
            'anthropic-dangerous-direct-browser-access': 'true',
            // Anthropic's JS SDK (Stainless-generated) fingerprint headers
            'x-stainless-lang': 'js',
            'x-stainless-package-version': '0.55.1',
            'x-stainless-os': 'MacOS',
            'x-stainless-arch': 'arm64',
            'x-stainless-runtime': 'node',
            'x-stainless-runtime-version': 'v22.11.0',
            'x-stainless-retry-count': '0',
            'x-stainless-timeout': '600',
            'x-stainless-helper-method': 'stream',
        };
        for (const [k, v] of Object.entries(ccHeaders)) {
            includeHeaders += `${k}: ${JSON.stringify(v)}\n`;
        }
    }
    body.custom_include_headers = includeHeaders + (body.custom_include_headers || '');

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

    // --- Direct field deletion from request body ---
    delete body.messages;
    delete body.presence_penalty;
    delete body.frequency_penalty;
    delete body.logit_bias;
    delete body.seed;
    delete body.n;
    delete body.stop;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.logprobs;
    delete body.top_k;

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
