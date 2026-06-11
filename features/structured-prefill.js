/**
 * Structured Prefill Feature
 *
 * Prefill-like behaviour for chat completions using *structured outputs*
 * instead of an assistant-role prefill. Forces the model to begin its reply
 * with your exact prefill text by disguising the prefill as a JSON formatting
 * constraint, then strips the JSON wrapper before the message is displayed.
 *
 * Ported and adapted from the "StructuredPrefill" Spindle/Lumiverse fork
 * (itself a fork of mia13165's SillyTavern extension). Reworked here to run
 * entirely client-side inside the Enhancements extension via window.fetch
 * interception — no SillyTavern core files are modified.
 *
 * Two capabilities are bundled:
 *
 *  1. Structured Prefill
 *     The last assistant message (your "Start Reply With" / prefill) is pulled
 *     out of the request and re-expressed as a constraint:
 *
 *        response_format: { type: 'json_schema', json_schema: { schema: {
 *          response: { type:'string', pattern: '^<prefill>...<min chars>$' }
 *        }}}
 *
 *     The model is then forced to emit  {"response": "<prefill><continuation>"}
 *     and we unwrap that JSON back into clean text for display.
 *
 *  2. Banned Words (anti-slop)
 *     A list of words/phrases that must never appear in the output. On the
 *     json_schema tier these are baked into the regex via negative lookaheads;
 *     on weaker tiers they are added to a system instruction.
 *
 * Compatibility ladder (three tiers, same idea as the Spindle fork):
 *   json_schema  — full regex-locked structured output (real OpenAI / proxies)
 *   json_object  — JSON-shape only + system nudge (most OpenAI-compatible proxies)
 *   prompt_only  — no response_format, system instruction only (works anywhere)
 *
 * In "auto" mode the strongest supported tier is tried, and if a response comes
 * back empty / not in our JSON shape (and isn't a model refusal), the tier is
 * downgraded and cached per source+model for subsequent generations.
 *
 * NOTE: response_format is injected via custom_include_body for the "custom"
 * (OpenAI-compatible) source — the only source guaranteed to forward arbitrary
 * body fields — and also set top-level as a best-effort for other sources.
 * Claude / Gemini sources fall back to the prompt_only tier automatically.
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const SETTINGS_KEY = 'enhancements';
const LOG_PREFIX = '[Enhancements:StructuredPrefill]';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaultSettings = {
    structuredPrefillEnabled: false,
    spMode: 'auto',               // 'auto' | 'json_schema' | 'json_object' | 'prompt_only'
    spHidePrefill: true,          // strip the prefill text from the displayed message
    spNewlineToken: '\\n',        // how newlines are encoded inside the JSON pattern
    spMinCharsAfterPrefix: 80,    // min chars the model must generate after the prefill
    spBannedWords: '',            // one banned word/phrase per line
    spCompatCache: {},            // { 'source|model': tier }  — auto-mode downgrade cache
};

const TIER_ORDER = ['json_schema', 'json_object', 'prompt_only'];

function nextTier(current) {
    const idx = TIER_ORDER.indexOf(current);
    if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
    return TIER_ORDER[idx + 1];
}

function weakerOf(a, b) {
    // Higher index = weaker. Return the weaker of the two tiers.
    const ia = TIER_ORDER.indexOf(a);
    const ib = TIER_ORDER.indexOf(b);
    return TIER_ORDER[Math.max(ia < 0 ? 0 : ia, ib < 0 ? 0 : ib)];
}

function getSettings() {
    return extension_settings[SETTINGS_KEY];
}

// ---------------------------------------------------------------------------
// Pure utilities (ported from the Spindle backend)
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Allow an arbitrary number of escaping backslashes before a literal quote —
// the wire text may JSON-escape quotes, so a `"` could arrive as `\"`.
function escapePrefixLiteral(str) {
    return escapeRegExp(str).replace(/"/g, '(?:\\\\)*"');
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    return Math.min(max, Math.max(min, int));
}

function normalizeNewlines(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function prefixHasSlots(prefix) {
    return /\[\[[^\]]+?\]\]/.test(String(prefix ?? ''));
}

// Detect model refusal responses so we don't wrongly downgrade a working tier.
function looksLikeModelRefusal(text) {
    const s = String(text ?? '').trim().toLowerCase();
    if (s.length === 0 || s.length > 800) return false;
    const patterns = [
        /^i('m| am) (unable|not able|sorry|afraid)/,
        /^i (can't|cannot|won't|will not) (assist|help|generate|create|produce|write|comply)/,
        /^sorry,? (but )?(i |this )/,
        /^i (can't|cannot) (fulfill|complete|process) (this|that|your)/,
        /^this (request|content|prompt) (is |goes |violates )/,
        /^as an ai/,
        /content policy/,
        /against (my|our) (guidelines|policy|policies)/,
        /not (able|going) to (generate|create|write|produce|assist)/,
    ];
    return patterns.some(p => p.test(s));
}

// ── Newline token handling ──────────────────────────────────────────────────

function chooseNewlineToken(prefix, preferredToken) {
    const token = String(preferredToken ?? '\\n') || '\\n';
    const candidates = [token, '<NL>', '⏎', '\\n', '<NEWLINE>'];
    for (const candidate of candidates) {
        if (candidate && !prefix.includes(candidate)) return candidate;
    }
    return token;
}

function encodeNewlines(text, newlineToken) {
    if (!newlineToken) return text;
    return String(text ?? '').replace(/\n/g, newlineToken);
}

function decodeNewlines(text, newlineToken) {
    if (!newlineToken) return text;
    const escaped = escapeRegExp(newlineToken);
    return String(text ?? '').replace(new RegExp(escaped, 'g'), '\n');
}

// ── Quote handling ──────────────────────────────────────────────────────────

function curlyQuoteLiteralsOutsideSlots(template) {
    const parts = String(template ?? '').split(/(\[\[[^\]]*\]\])/g);
    return parts
        .map((part, i) => {
            if (i % 2 === 1) return part; // inside [[...]] — leave as-is
            return part.replace(/"/g, '“').replace(/'/g, '‘');
        })
        .join('');
}

function straightenCurlyQuotes(s) {
    return String(s ?? '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");
}

// ── Template parsing ────────────────────────────────────────────────────────

function splitHidePrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { hideTemplate: '', hasKeepMarker: false };
    const m = /\[\[\s*keep\s*\]\]/i.exec(normalized);
    if (!m) return { hideTemplate: normalized, hasKeepMarker: false };
    return { hideTemplate: normalized.slice(0, m.index), hasKeepMarker: true };
}

function splitEndPrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { template: '', hasEndMarker: false };
    const m = /\[\[\s*(end|stop|eos)\s*\]\]/i.exec(normalized);
    if (!m) return { template: normalized, hasEndMarker: false };
    return { template: normalized.slice(0, m.index), hasEndMarker: true };
}

// ── Regex pattern building ──────────────────────────────────────────────────

function anyCharIncludingNewlineExpr() {
    return '[\\t\\n\\r \\x21-\\x7E\\x80-\\uFFFF]';
}

function buildSlotRegex(slotContent) {
    const inner = String(slotContent ?? '').trim();
    if (!inner) return '(?:.*?)';

    // [[re:...]] — raw regex passthrough
    const reMatch = /^re:\s*([\s\S]+)$/i.exec(inner);
    if (reMatch) return reMatch[1];

    // [[name]] — name resolution not available client-side; match anything
    if (/^name$/i.test(inner)) return '(?:.*?)';

    // [[any]] — match anything (non-greedy)
    if (/^any$/i.test(inner)) return '(?:.*?)';

    // Structural markers — empty in regex
    if (/^(keep|end|stop|eos)$/i.test(inner)) return '';

    // Unknown slot — treat as literal
    return escapePrefixLiteral(`[[${inner}]]`);
}

function buildPrefixRegexFromWireTemplate(wireTemplate) {
    const template = String(wireTemplate ?? '');
    if (!template) return '';
    const parts = template.split(/(\[\[[^\]]*?\]\])/g);
    let regex = '';
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i % 2 === 0) {
            regex += escapePrefixLiteral(part);
        } else {
            regex += buildSlotRegex(part.slice(2, -2));
        }
    }
    return regex;
}

function parseBannedWords(raw) {
    return String(raw ?? '')
        .split(/\r?\n/g)
        .map(w => w.trim())
        .filter(Boolean);
}

// Build an any-char expression that forbids the banned words/phrases.
function buildAntiSlopContinuation(bannedWords) {
    if (!bannedWords || bannedWords.length === 0) return '';
    const lookaheads = bannedWords.map(w => `(?!${escapeRegExp(w)})`).join('');
    return `(?:${lookaheads}${anyCharIncludingNewlineExpr()})`;
}

/**
 * Build the OpenAI json_schema object whose `response` string is regex-locked
 * to start with the prefill and (optionally) avoid the banned words.
 *
 * @returns {{name:string, strict:boolean, schema:object}}
 */
function buildJsonSchemaForPrefill(ctx, prefix, minCharsAfterPrefix, mustEndAfterTemplate) {
    const minChars = mustEndAfterTemplate ? 0 : clampInt(minCharsAfterPrefix, 1, 10000, 1);
    const newlineToken = ctx.newlineToken || '\\n';
    const wirePrefix = encodeNewlines(prefix, newlineToken);

    let prefixRegex = buildPrefixRegexFromWireTemplate(wirePrefix);

    // Allow both the encoded newline token and a real \n in the pattern.
    if (newlineToken) {
        const escapedToken = escapeRegExp(newlineToken);
        prefixRegex = prefixRegex.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
    }

    const defaultAnyChar = anyCharIncludingNewlineExpr();
    const antiSlopExpr = buildAntiSlopContinuation(ctx.bannedWords);
    const anyChar = antiSlopExpr || defaultAnyChar;

    let pattern;
    if (mustEndAfterTemplate) {
        const escapedToken = escapeRegExp(newlineToken);
        const trailing = `[\\t ]*(?:${escapedToken}|\\n)?(?:[\\t ]*(?:${escapedToken}|\\n)[\\t ]*)*`;
        pattern = `^(?:${prefixRegex})${trailing}$`;
    } else {
        pattern = `^(?:${prefixRegex})${anyChar}{${minChars},}$`;
    }

    // Validate locally; fall back to a minimal-safe pattern on failure.
    try {
        new RegExp(pattern);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Invalid regex pattern, using minimal-safe fallback:`, err);
        pattern = mustEndAfterTemplate
            ? `^(?:${prefixRegex})[\\t \\r\\n]*$`
            : `^(?:${prefixRegex})${anyChar}{${minChars},}$`;
        try { new RegExp(pattern); } catch { pattern = `^[\\s\\S]{${minChars},}$`; }
    }

    return {
        name: 'response',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                response: { type: 'string', pattern },
            },
            required: ['response'],
            additionalProperties: false,
        },
    };
}

// ---------------------------------------------------------------------------
// JSON extraction & unwrapping (handles streaming / unterminated strings)
// ---------------------------------------------------------------------------

function extractJsonStringField(rawText, fieldName, loose) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;
    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    let index = match.index + match[0].length;
    let out = '';
    let escaped = false;

    while (index < rawText.length) {
        const ch = rawText[index];
        if (escaped) {
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    const hex = rawText.slice(index + 1, index + 5);
                    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                        out += String.fromCharCode(parseInt(hex, 16));
                        index += 4;
                    } else {
                        out += '\\u';
                    }
                    break;
                }
                default: out += '\\' + ch;
            }
            escaped = false;
        } else if (ch === '\\') {
            escaped = true;
        } else if (ch === '"') {
            if (loose) {
                // In loose mode, treat a quote as a terminator only when the
                // next non-space char is } or , — otherwise it's content.
                const rest = rawText.slice(index + 1).trimStart();
                if (!rest || rest[0] === '}' || rest[0] === ',') return out;
                out += ch;
            } else {
                return out;
            }
        } else {
            out += ch;
        }
        index++;
    }

    // Unterminated string — return what we have (useful while streaming).
    return out.length > 0 ? out : null;
}

/**
 * Try to pull the clean text out of a (possibly partial) structured response.
 * Accepts {"response":"..."}, {"value":"..."}, or {"prefix"/"content"}.
 * Returns null when the text isn't (yet) recognisable as our JSON shape.
 */
function tryUnwrapStructuredOutput(text, ctx) {
    if (typeof text !== 'string' || text.length === 0) return null;
    const decode = (s) => straightenCurlyQuotes(decodeNewlines(s, ctx.newlineToken));

    // Full parse first.
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.response === 'string') return decode(parsed.response);
            if (typeof parsed.value === 'string') return decode(parsed.value);
            if (typeof parsed.prefix === 'string' || typeof parsed.content === 'string') {
                const prefix = typeof parsed.prefix === 'string' ? decode(parsed.prefix) : '';
                const content = typeof parsed.content === 'string' ? decode(parsed.content) : '';
                return prefix + content;
            }
        }
    } catch {
        // Loose extraction (model emitted unescaped quotes etc.)
        const looseResponse = extractJsonStringField(text, 'response', true);
        if (typeof looseResponse === 'string') return decode(looseResponse);
        const looseValue = extractJsonStringField(text, 'value', true);
        if (typeof looseValue === 'string') return decode(looseValue);
    }

    // Partial extraction (streaming / unterminated).
    const response = extractJsonStringField(text, 'response', false);
    if (typeof response === 'string') return decode(response);
    const legacy = extractJsonStringField(text, 'value', false);
    if (typeof legacy === 'string') return decode(legacy);

    return null;
}

// ---------------------------------------------------------------------------
// Hide-prefill stripping
// ---------------------------------------------------------------------------

function buildPrefillStripper(ctx, prefixTemplate) {
    ctx.hidePrefillLiteral = '';
    ctx.hidePrefillRegex = null;

    const { hideTemplate } = splitHidePrefillTemplate(prefixTemplate);
    if (!hideTemplate) return;

    if (!prefixHasSlots(hideTemplate)) {
        ctx.hidePrefillLiteral = hideTemplate;
        return;
    }
    const prefixRegex = buildPrefixRegexFromWireTemplate(hideTemplate);
    try {
        ctx.hidePrefillRegex = new RegExp(`^((?:${prefixRegex}))`);
    } catch {
        ctx.hidePrefillRegex = null;
        ctx.hidePrefillLiteral = hideTemplate;
    }
}

function stripHidePrefill(text, ctx) {
    if (!ctx.hidePrefill) return text;
    if (!ctx.hidePrefillLiteral && !ctx.hidePrefillRegex) return text;
    const s = String(text ?? '');
    if (ctx.hidePrefillRegex) {
        const m = ctx.hidePrefillRegex.exec(s);
        if (m) return s.slice(m[0].length);
    }
    if (ctx.hidePrefillLiteral && s.startsWith(ctx.hidePrefillLiteral)) {
        return s.slice(ctx.hidePrefillLiteral.length);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Provider awareness
// ---------------------------------------------------------------------------

// Sources whose structured output isn't OpenAI-`response_format`-shaped. For
// these we fall back to the universal prompt_only tier (system instruction).
function providerTierFloor(source, model) {
    const s = String(source ?? '').toLowerCase();
    const m = String(model ?? '').toLowerCase();
    if (s === 'claude' || s === 'anthropic') return 'prompt_only';
    if (s === 'makersuite' || s === 'google' || s === 'vertexai' || s === 'gemini') return 'prompt_only';
    if (s === 'openrouter') {
        if (m.includes('claude') || m.includes('anthropic') || m.includes('gemini') || m.startsWith('google/')) {
            return 'prompt_only';
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Compat cache (auto-mode tier memory, persisted in settings)
// ---------------------------------------------------------------------------

function getCachedTier(sourceKey) {
    const cache = getSettings().spCompatCache || {};
    return cache[sourceKey] || null;
}

function setCachedTier(sourceKey, tier) {
    const s = getSettings();
    if (!s.spCompatCache) s.spCompatCache = {};
    if (s.spCompatCache[sourceKey] === tier) return;
    s.spCompatCache[sourceKey] = tier;
    saveSettingsDebounced();
    console.log(`${LOG_PREFIX} Cached tier for ${sourceKey} → ${tier}`);
}

// ---------------------------------------------------------------------------
// System-instruction builders (for json_object / prompt_only tiers)
// ---------------------------------------------------------------------------

function plainPrefillForInstruction(template) {
    // Strip slot markers so the instruction shows literal prefill text.
    return straightenCurlyQuotes(String(template ?? '').replace(/\[\[[^\]]*\]\]/g, '')).trim();
}

function buildSystemInstruction(tier, ctx) {
    const prefill = plainPrefillForInstruction(ctx.expectedPrefill);
    const prefillClause = prefill
        ? `\n\nCRITICAL: The value of "response" MUST begin with the following text EXACTLY — copy it verbatim, do not paraphrase, skip, or summarize it:\n${prefill}`
        : '';
    const banClause = (ctx.bannedWords && ctx.bannedWords.length)
        ? `\n\nDo NOT use any of the following words or phrases anywhere in "response": ${ctx.bannedWords.join(', ')}.`
        : '';

    if (tier === 'json_object') {
        return `You MUST respond with a JSON object of the form {"response": "your full reply as a single string"}. No other keys. No prose outside the JSON.${prefillClause}${banClause}`;
    }
    // prompt_only
    return `Your entire response must be a single JSON object of the form {"response":"your full reply as a single string, with all newlines escaped as \\n"}. Do not include any text before or after the JSON. Do not use markdown code fences. Start with { and end with }.${prefillClause}${banClause}`;
}

// ---------------------------------------------------------------------------
// Request body injection helpers
// ---------------------------------------------------------------------------

function setResponseFormat(body, source, formatObj) {
    // Best-effort generic top-level field (forwarded by some sources).
    body.response_format = formatObj;
    // Guaranteed forwarding for the OpenAI-compatible "custom" source.
    if (String(source).toLowerCase() === 'custom') {
        const line = `response_format: ${JSON.stringify(formatObj)}`;
        body.custom_include_body = line + '\n' + (body.custom_include_body || '');
    }
}

function prependSystemMessage(body, content) {
    if (!Array.isArray(body.messages)) return;
    body.messages.unshift({ role: 'system', content });
}

// ---------------------------------------------------------------------------
// Streaming response transform — unwrap JSON deltas into clean text
// ---------------------------------------------------------------------------

function buildSseChunk(deltaContent, finish) {
    const choice = finish
        ? { index: 0, delta: {}, finish_reason: 'stop' }
        : { index: 0, delta: { content: deltaContent }, finish_reason: null };
    return `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [choice] })}\n\n`;
}

function createUnwrapStreamTransform(ctx, onComplete) {
    let rawContent = '';
    let lastDisplay = '';
    let buf = '';
    let finished = false;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    function recomputeDisplay() {
        const unwrapped = tryUnwrapStructuredOutput(rawContent, ctx);
        return (unwrapped !== null) ? stripHidePrefill(unwrapped, ctx) : rawContent;
    }

    function emitProgress(ctl) {
        const display = recomputeDisplay();
        if (display.length > lastDisplay.length && display.startsWith(lastDisplay)) {
            ctl.enqueue(enc.encode(buildSseChunk(display.slice(lastDisplay.length), false)));
            lastDisplay = display;
        }
    }

    function finalize(ctl) {
        if (finished) return;
        finished = true;
        const display = recomputeDisplay();
        if (display.length > lastDisplay.length && display.startsWith(lastDisplay)) {
            ctl.enqueue(enc.encode(buildSseChunk(display.slice(lastDisplay.length), false)));
            lastDisplay = display;
        }
        ctl.enqueue(enc.encode(buildSseChunk('', true)));
        ctl.enqueue(enc.encode('data: [DONE]\n\n'));
        try { onComplete?.(rawContent); } catch { /* ignore */ }
    }

    return new TransformStream({
        transform(chunk, ctl) {
            buf += dec.decode(chunk, { stream: true }).replace(/\r/g, '');
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data:')) continue; // drop comments / blanks
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') { finalize(ctl); continue; }
                try {
                    const d = JSON.parse(payload);
                    const delta = d.choices?.[0]?.delta;
                    // Skip reasoning/CoT deltas — they aren't part of the JSON body.
                    if (delta && typeof delta.content === 'string') {
                        rawContent += delta.content;
                        emitProgress(ctl);
                    } else if (typeof d.choices?.[0]?.message?.content === 'string') {
                        rawContent += d.choices[0].message.content;
                        emitProgress(ctl);
                    }
                } catch { /* skip malformed line */ }
            }
        },
        flush(ctl) {
            finalize(ctl);
        },
    });
}

// ---------------------------------------------------------------------------
// Non-streaming response transform
// ---------------------------------------------------------------------------

async function wrapNonStreamingResponse(response, ctx, onComplete) {
    const clone = response.clone();
    let json;
    try {
        json = await response.json();
    } catch {
        return clone;
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
        const unwrapped = tryUnwrapStructuredOutput(content, ctx);
        const finalText = (unwrapped !== null) ? unwrapped : content;
        const display = stripHidePrefill(finalText, ctx);
        json.choices[0].message.content = display;
        try { onComplete?.(content); } catch { /* ignore */ }
    }

    return new Response(JSON.stringify(json), {
        status: clone.status,
        statusText: clone.statusText,
        headers: clone.headers,
    });
}

// ---------------------------------------------------------------------------
// Auto-mode tier evaluation (downgrade on failure)
// ---------------------------------------------------------------------------

function evaluateAndMaybeDowngrade(rawContent, ctx) {
    const s = getSettings();
    if (s.spMode !== 'auto') return;                 // only auto mode self-tunes
    if (ctx.tier !== 'json_schema' && ctx.tier !== 'json_object') return;

    const empty = !rawContent || String(rawContent).trim().length === 0;
    const ourJson = tryUnwrapStructuredOutput(rawContent, ctx) !== null;
    const refusal = looksLikeModelRefusal(rawContent);

    if (empty || (!ourJson && !refusal)) {
        const downgraded = nextTier(ctx.tier);
        if (downgraded) {
            setCachedTier(ctx.sourceKey, downgraded);
            try {
                window.toastr?.warning(
                    `Structured Prefill: "${ctx.tier}" mode didn't work on this connection — switching to "${downgraded}" for future messages.`,
                    'Enhancements',
                    { timeOut: 8000 },
                );
            } catch { /* ignore */ }
        }
    } else if (ourJson) {
        // Confirm the working tier in the cache.
        setCachedTier(ctx.sourceKey, ctx.tier);
    }
}

// ---------------------------------------------------------------------------
// Core: prepare the request (returns a decode ctx if engaged, else null)
// ---------------------------------------------------------------------------

function prepareStructuredPrefill(body) {
    const s = getSettings();
    if (!s.structuredPrefillEnabled) return null;
    if (!Array.isArray(body.messages) || body.messages.length === 0) return null;

    const source = String(body.chat_completion_source || '');
    const model = String(body.model || '');
    const bannedWords = parseBannedWords(s.spBannedWords);

    // Find the tail assistant message (the prefill), skipping trailing system.
    let tailIndex = body.messages.length - 1;
    while (tailIndex >= 0 && body.messages[tailIndex]?.role === 'system') tailIndex--;
    const tail = tailIndex >= 0 ? body.messages[tailIndex] : null;
    const hasPrefill = !!(tail && tail.role === 'assistant' && typeof tail.content === 'string' && tail.content.trim());

    // Engage only when there's something to enforce.
    if (!hasPrefill && bannedWords.length === 0) return null;

    // ── Resolve tier ──
    const sourceKey = `${source}|${model}`;
    let tier;
    if (s.spMode === 'auto') {
        tier = getCachedTier(sourceKey) || 'json_schema';
    } else {
        tier = s.spMode;
    }
    const floor = providerTierFloor(source, model);
    if (floor) tier = weakerOf(tier, floor);

    // ── Build the prefill template ──
    let prefillTemplate = '';
    let mustEndAfterTemplate = false;

    if (hasPrefill) {
        prefillTemplate = String(tail.content);
        // Remove the assistant prefill from the outgoing messages.
        body.messages.splice(tailIndex, 1);
        // Quote-harden then split off the [[end]] marker.
        prefillTemplate = curlyQuoteLiteralsOutsideSlots(prefillTemplate);
        const endSplit = splitEndPrefillTemplate(prefillTemplate);
        prefillTemplate = endSplit.template;
        mustEndAfterTemplate = endSplit.hasEndMarker;
    }

    // Many providers reject a request whose last message is assistant-role.
    if (body.messages.length > 0 && body.messages[body.messages.length - 1]?.role === 'assistant') {
        // Re-insert prefill so we don't break the request, then bail out.
        if (hasPrefill) body.messages.splice(tailIndex, 0, tail);
        return null;
    }

    const newlineToken = chooseNewlineToken(prefillTemplate, s.spNewlineToken);

    // Decode context carried into the response transform.
    const ctx = {
        tier,
        sourceKey,
        newlineToken,
        bannedWords,
        hidePrefill: !!s.spHidePrefill,
        expectedPrefill: straightenCurlyQuotes(prefillTemplate),
        hidePrefillLiteral: '',
        hidePrefillRegex: null,
    };
    if (ctx.hidePrefill) buildPrefillStripper(ctx, straightenCurlyQuotes(prefillTemplate));

    // ── Inject the constraint per tier ──
    if (tier === 'json_schema') {
        const minChars = mustEndAfterTemplate ? 0 : clampInt(s.spMinCharsAfterPrefix, 1, 10000, 80);
        const schema = buildJsonSchemaForPrefill(ctx, prefillTemplate, minChars, mustEndAfterTemplate);
        setResponseFormat(body, source, { type: 'json_schema', json_schema: schema });
    } else if (tier === 'json_object') {
        setResponseFormat(body, source, { type: 'json_object' });
        prependSystemMessage(body, buildSystemInstruction('json_object', ctx));
    } else {
        prependSystemMessage(body, buildSystemInstruction('prompt_only', ctx));
    }

    console.log(`${LOG_PREFIX} Engaged: source=${source || '(?)'} tier=${tier} prefill=${ctx.expectedPrefill.length}ch banned=${bannedWords.length}`);
    return ctx;
}

// ---------------------------------------------------------------------------
// Fetch interception
// ---------------------------------------------------------------------------

const previousFetch = window.fetch;

async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';

    if (!getSettings()?.structuredPrefillEnabled ||
        !url.includes('/api/backends/chat-completions/generate') ||
        !init?.body) {
        return previousFetch(input, init);
    }

    let body;
    try {
        body = JSON.parse(init.body);
    } catch {
        return previousFetch(input, init);
    }

    let ctx;
    try {
        ctx = prepareStructuredPrefill(body);
    } catch (err) {
        console.error(`${LOG_PREFIX} prepare failed, passing through:`, err);
        return previousFetch(input, init);
    }

    if (!ctx) {
        return previousFetch(input, init);       // not engaged — pass through
    }

    const isStreaming = body.stream === true;
    const modifiedInit = { ...init, body: JSON.stringify(body) };
    const response = await previousFetch(input, modifiedInit);

    if (!response.ok) return response;            // let ST handle errors

    if (isStreaming && response.body) {
        const xform = createUnwrapStreamTransform(ctx, (raw) => evaluateAndMaybeDowngrade(raw, ctx));
        return new Response(response.body.pipeThrough(xform), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    return wrapNonStreamingResponse(response, ctx, (raw) => evaluateAndMaybeDowngrade(raw, ctx));
}

window.fetch = interceptedFetch;

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

const settingsHtml = `
<hr>
<h4>Structured Prefill</h4>
<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enh_sp_enabled">
        <input type="checkbox" id="enh_sp_enabled" />
        <span>Enable structured prefill</span>
    </label>
</div>
<small class="textAlignCenter" style="display:block">
    Forces the model to begin its reply with your <b>Start Reply With</b> /
    last assistant prefill by wrapping it in a JSON <code>response_format</code>
    constraint, then strips the JSON wrapper before display. Works best with the
    OpenAI-compatible <b>Custom</b> source; Claude / Gemini fall back to a
    prompt-only instruction automatically.
</small>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_sp_mode">Structured output mode</label>
    <select id="enh_sp_mode" class="text_pole">
        <option value="auto">Auto-detect (probe &amp; cache strongest)</option>
        <option value="json_schema">json_schema — regex-locked (real OpenAI / proxies)</option>
        <option value="json_object">json_object — shape only (most proxies)</option>
        <option value="prompt_only">Prompt only — instruction (works anywhere, weakest)</option>
    </select>
</div>
<small class="textAlignCenter" id="enh_sp_mode_desc" style="display:block"></small>

<div class="flex-container marginTopBot5">
    <label class="checkbox_label" for="enh_sp_hide_prefill">
        <input type="checkbox" id="enh_sp_hide_prefill" />
        <span>Hide prefill text in final message (use <code>[[keep]]</code> to keep a tail visible)</span>
    </label>
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_sp_min_chars">Minimum characters after prefix</label>
    <input type="number" id="enh_sp_min_chars" class="text_pole" min="1" max="10000" step="1" />
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_sp_newline_token">Newline token (encoded in schema)</label>
    <input type="text" id="enh_sp_newline_token" class="text_pole" placeholder="\\n" />
</div>

<div class="flex-container flexFlowColumn marginTopBot5">
    <label for="enh_sp_banned_words">Banned words / anti-slop (one per line)</label>
    <textarea id="enh_sp_banned_words" class="text_pole" rows="4" placeholder="ozone&#10;Elara&#10;tapestry"></textarea>
</div>
<small class="textAlignCenter" style="display:block">
    Words/phrases the model must never output. Enforced via regex on the
    <code>json_schema</code> tier, and via a system instruction otherwise.
    Banned words alone (no prefill) will anti-slop every generation.
</small>

<div class="flex-container marginTopBot5">
    <div id="enh_sp_reset_compat_btn" class="menu_button menu_button_icon" style="flex:1;">
        <i class="fa-solid fa-rotate-left"></i>
        <span>Reset Connection Compatibility</span>
    </div>
</div>
<small class="textAlignCenter" id="enh_sp_compat_status" style="display:block; opacity:0.75;"></small>`;

const modeDescriptions = {
    auto: 'Tries json_schema first; on empty / non-JSON responses it downgrades and remembers the working mode per source + model.',
    json_schema: 'Strongest. Byte-for-byte regex lock on the response. Only real OpenAI and schema-honouring proxies support this.',
    json_object: 'Model must emit a JSON object; the prefill is enforced via a system instruction. Works on most OpenAI-compatible proxies.',
    prompt_only: 'No response_format sent — only a system instruction. Universal but weakest; relies on model compliance.',
};

// ---------------------------------------------------------------------------
// Settings logic
// ---------------------------------------------------------------------------

function updateModeDesc() {
    $('#enh_sp_mode_desc').text(modeDescriptions[getSettings().spMode] || '');
}

function ensureDefaults() {
    const s = getSettings();
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? structuredClone(v) : v;
    }
}

function loadSettings() {
    const s = getSettings();
    $('#enh_sp_enabled').prop('checked', !!s.structuredPrefillEnabled);
    $('#enh_sp_mode').val(s.spMode);
    $('#enh_sp_hide_prefill').prop('checked', !!s.spHidePrefill);
    $('#enh_sp_min_chars').val(s.spMinCharsAfterPrefix);
    $('#enh_sp_newline_token').val(s.spNewlineToken);
    $('#enh_sp_banned_words').val(s.spBannedWords);
    updateModeDesc();
}

export function init(contentContainer) {
    ensureDefaults();
    const s = getSettings();

    contentContainer.append(settingsHtml);
    loadSettings();

    $('#enh_sp_enabled').on('change', function () {
        getSettings().structuredPrefillEnabled = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#enh_sp_mode').on('change', function () {
        getSettings().spMode = String($(this).val());
        saveSettingsDebounced();
        updateModeDesc();
    });
    $('#enh_sp_hide_prefill').on('change', function () {
        getSettings().spHidePrefill = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#enh_sp_min_chars').on('change', function () {
        getSettings().spMinCharsAfterPrefix = clampInt($(this).val(), 1, 10000, 80);
        $(this).val(getSettings().spMinCharsAfterPrefix);
        saveSettingsDebounced();
    });
    $('#enh_sp_newline_token').on('change', function () {
        getSettings().spNewlineToken = String($(this).val()) || '\\n';
        saveSettingsDebounced();
    });
    $('#enh_sp_banned_words').on('input', function () {
        getSettings().spBannedWords = String($(this).val());
        saveSettingsDebounced();
    });
    $('#enh_sp_reset_compat_btn').on('click', function () {
        getSettings().spCompatCache = {};
        saveSettingsDebounced();
        $('#enh_sp_compat_status').text('Compatibility cache cleared — next message will re-probe.');
        setTimeout(() => $('#enh_sp_compat_status').text(''), 5000);
        console.log(`${LOG_PREFIX} Compatibility cache cleared`);
    });

    console.log(`${LOG_PREFIX} Feature initialized (enabled: ${s.structuredPrefillEnabled}, mode: ${s.spMode})`);
}
