/**
 * Regression tests for features/structured-prefill.js
 *
 *   node --test tests/
 *
 * The headline case is "GPT model freezes on {"response": "" — a truncated or
 * scaffolding-only reply must never reach the chat, and must not trigger a
 * pointless downgrade ladder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFeature } from './load-feature.mjs';

const SETTINGS = {};
const { sp, state } = await loadFeature('structured-prefill.js', SETTINGS);

const URL_GEN = 'http://host/api/backends/chat-completions/generate';
const PRE = '<thinking>';
const TAIL = 'She turned slowly, weighing the question. ' + 'The room felt smaller than before. '.repeat(3);
const enc = new TextEncoder();

function configure(over = {}) {
    Object.keys(SETTINGS).forEach(k => delete SETTINGS[k]);
    Object.assign(SETTINGS, {
        structuredPrefillEnabled: true, spMode: 'auto', spHidePrefill: true, spNewlineToken: '\\n',
        spMinCharsAfterPrefix: 80, bannedWordsEnabled: false, spBannedWords: '', spCompatCache: {},
        spCompatVersion: 2, spValidateRetry: true, spMaxRetries: 2, spFewShot: false,
    }, over);
    state.calls.length = 0;
    state.warnings.length = 0;
}

function request(prefill = PRE, { stream = true, source = 'openai', model = 'gpt-5.1' } = {}) {
    return {
        method: 'POST',
        body: JSON.stringify({
            chat_completion_source: source, model, stream, max_tokens: 300,
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: prefill },
            ],
        }),
    };
}

function jsonReply(content, finishReason = 'stop') {
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function streamReply(deltas, shape = 'openai') {
    return new Response(new ReadableStream({
        start(c) {
            for (const d of deltas) {
                const payload = shape === 'google'
                    ? { candidates: [{ content: { parts: [{ text: d }], role: 'model' } }] }
                    : { choices: [{ delta: { content: d } }] };
                c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// What SillyTavern would accumulate from our response.
async function displayed(res, shape = 'openai') {
    if (!(res.headers.get('Content-Type') || '').includes('event-stream')) {
        return (await res.json())?.choices?.[0]?.message?.content ?? '';
    }
    return (await res.text()).split('\n')
        .filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(p => p !== '[DONE]')
        .map(p => {
            const j = JSON.parse(p);
            return shape === 'google'
                ? (j.candidates?.[0]?.content?.parts?.filter(x => !x.thought).map(x => x.text)[0] || '')
                : (j.choices?.[0]?.delta?.content || '');
        }).join('');
}
// ── Request shaping ────────────────────────────────────────────────────────

test('schema travels in body.json_schema, the only field SillyTavern forwards', () => {
    configure();
    const body = JSON.parse(request().body);
    const ctx = sp.prepareRequest(body);
    assert.equal(ctx.tier, 'json_schema');
    assert.equal(body.json_schema.name, 'response');
    assert.equal(body.json_schema.strict, true);
    assert.equal(typeof body.json_schema.value.properties.response.pattern, 'string');
    assert.ok(!('response_format' in body), 'response_format is dropped server-side');
    assert.ok(!('custom_include_body' in body), 'no YAML side-channel');
    assert.ok(!body.messages.some(m => m.role === 'assistant'), 'prefill is pulled out');
    assert.equal(body.messages.at(-1).role, 'system', 'instruction goes last');
});

test('the pattern locks the prefill and carries no lookaround', () => {
    configure();
    const body = JSON.parse(request().body);
    sp.prepareRequest(body);
    const pattern = body.json_schema.value.properties.response.pattern;
    assert.ok(!/\(\?[=!<]/.test(pattern), 'grammar engines reject lookarounds');
    assert.ok(new RegExp(pattern).test(PRE + 'x'.repeat(80)));
    assert.ok(!new RegExp(pattern).test('Hello' + 'x'.repeat(80)));
});

test('weaker tiers drop the pattern, then the schema', () => {
    configure({ spMode: 'json_object' });
    const shapeOnly = JSON.parse(request().body);
    sp.prepareRequest(shapeOnly);
    assert.ok(!('pattern' in shapeOnly.json_schema.value.properties.response));
    assert.deepEqual(shapeOnly.json_schema.value.required, ['response']);

    configure({ spMode: 'prompt_only' });
    const promptOnly = JSON.parse(request().body);
    sp.prepareRequest(promptOnly);
    assert.ok(!('json_schema' in promptOnly));
    assert.match(promptOnly.messages.at(-1).content, /JSON/i);
});

test('sources with a real assistant prefill are left alone', () => {
    for (const source of ['claude', 'deepseek', 'moonshot']) {
        configure();
        const body = JSON.parse(request(PRE, { source, model: 'm' }).body);
        const before = JSON.stringify(body);
        assert.equal(sp.prepareRequest(body), null, source);
        assert.equal(JSON.stringify(body), before, `${source} body untouched`);
    }
});

test('sources whose reply shape we cannot rewrite are skipped', () => {
    configure();
    const body = JSON.parse(request(PRE, { source: 'cohere', model: 'command-r' }).body);
    assert.equal(sp.prepareRequest(body), null);
    assert.ok(!('json_schema' in body));
});

test('Gemini is capped at shape-only (responseSchema has no pattern)', () => {
    configure();
    const body = JSON.parse(request(PRE, { source: 'makersuite', model: 'gemini-2.5-pro' }).body);
    const ctx = sp.prepareRequest(body);
    assert.equal(ctx.tier, 'json_object');
    assert.equal(ctx.shape, 'google');
    assert.ok(!('pattern' in body.json_schema.value.properties.response));
});

test('another extension\'s structured request is never hijacked', () => {
    configure();
    const body = JSON.parse(request().body);
    body.json_schema = { name: 'classify', strict: true, value: { type: 'object' } };
    assert.equal(sp.prepareStructuredPrefill(body), null);
    assert.equal(body.json_schema.name, 'classify');
});

test('compat cache only accepts known tiers', () => {
    configure({ spCompatCache: { 'openai|gpt-5.1': 'prompt_only' } });
    assert.equal(sp.prepareRequest(JSON.parse(request().body)).tier, 'prompt_only');
    configure({ spCompatCache: { 'openai|gpt-5.1': { tier: 'prompt_only' } } });
    assert.equal(sp.prepareRequest(JSON.parse(request().body)).tier, 'json_schema');
});

test('verdicts cached by older builds are discarded once', () => {
    configure({ spCompatCache: { 'openai|gpt-5.1': 'prompt_only' }, spCompatVersion: undefined });
    sp.ensureDefaults();
    assert.deepEqual(SETTINGS.spCompatCache, {});
    assert.equal(SETTINGS.spCompatVersion, 2);
    SETTINGS.spCompatCache['openai|gpt-5.1'] = 'json_object';
    sp.ensureDefaults();
    assert.deepEqual(SETTINGS.spCompatCache, { 'openai|gpt-5.1': 'json_object' }, 'kept on later loads');
});

test('buffering is skipped once the schema is proven, so streaming stays live', () => {
    configure();
    const ctx = sp.prepareRequest(JSON.parse(request().body));
    assert.equal(sp.needsBuffering(ctx, SETTINGS), true);
    SETTINGS.spCompatCache['openai|gpt-5.1'] = 'json_schema';
    assert.equal(sp.needsBuffering(ctx, SETTINGS), false);
    ctx.bannedWords = ['foo'];
    assert.equal(sp.needsBuffering(ctx, SETTINGS), true, 'banned words need inspection');
    ctx.bannedWords = [];
    SETTINGS.spValidateRetry = false;
    assert.equal(sp.needsBuffering(ctx, SETTINGS), false);
});

test('banned words without a prefill add no JSON wrapper', () => {
    configure({ structuredPrefillEnabled: false, bannedWordsEnabled: true, spBannedWords: 'foo\nbar' });
    const body = JSON.parse(request().body);
    const ctx = sp.prepareRequest(body);
    assert.equal(ctx.plain, true);
    assert.ok(!('json_schema' in body));
    assert.equal(body.messages.at(-1).role, 'assistant', 'prefill stays put');
    assert.match(body.messages[0].content, /Do NOT use/);
});
// ── Streaming transform ────────────────────────────────────────────────────

async function throughTransform(deltas, { prefill = PRE, hide = true, shape = 'openai' } = {}) {
    configure({ spHidePrefill: hide });
    const ctx = { tier: 'json_schema', shape, sourceKey: 'openai|gpt-5.1', newlineToken: '\\n', bannedWords: [],
        hidePrefill: hide, expectedPrefill: prefill, hidePrefillLiteral: '', hidePrefillRegex: null };
    sp.buildPrefillStripper(ctx, prefill);
    sp.buildEnforcementValidator(ctx);
    const src = streamReply(deltas, shape).body;
    const out = new Response(src.pipeThrough(sp.createUnwrapStreamTransform(ctx, () => {})),
        { headers: { 'Content-Type': 'text/event-stream' } });
    return displayed(out, shape);
}

test('a scaffolding-only stream shows nothing at all', async () => {
    assert.equal(await throughTransform(['{"response": "']), '');
    assert.equal(await throughTransform(['{']), '');
    assert.equal(await throughTransform(['{"resp']), '');
});

test('a wrapped reply streams as clean text', async () => {
    assert.equal(
        await throughTransform(['{"', 'response', '":', ' "', '<thi', 'nking>', 'Hello', ' there', ', friend.', '"}']),
        'Hello there, friend.');
});

test('a reply that ignores the format streams verbatim', async () => {
    assert.equal(await throughTransform(['Hello', ' there', ', friend.']), 'Hello there, friend.');
});

test('fenced JSON is unwrapped, not shown as a code block', async () => {
    assert.equal(await throughTransform(['```json\n', '{"response": "<thinking>fenced ok"}', '\n```']), 'fenced ok');
});

test('escaped newlines are decoded and the prefill can be kept', async () => {
    assert.equal(await throughTransform(['{"response": "<thinking>line1\\nline2"}']), 'line1\nline2');
    assert.equal(await throughTransform(['{"response": "<thinking>abc"}'], { hide: false }), '<thinking>abc');
});

test('a value cut off mid-sentence keeps what arrived', async () => {
    assert.equal(await throughTransform(['{"response": "<thinking>She looked up']), 'She looked up');
});

test('Gemini chunks are read and re-emitted in Google shape', async () => {
    assert.equal(await throughTransform(['{"response": "<thinking>Gemini reply."}'], { shape: 'google' }), 'Gemini reply.');
});

test('reasoning chunks are forwarded without polluting the reply', async () => {
    configure();
    const ctx = { tier: 'json_schema', shape: 'openai', sourceKey: 'k', newlineToken: '\\n', bannedWords: [],
        hidePrefill: true, expectedPrefill: PRE, hidePrefillLiteral: '', hidePrefillRegex: null };
    sp.buildPrefillStripper(ctx, PRE);
    sp.buildEnforcementValidator(ctx);
    const src = new ReadableStream({ start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking hard' } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"response": "<thinking>ok"}' } }] })}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
    }});
    const raw = await new Response(src.pipeThrough(sp.createUnwrapStreamTransform(ctx, () => {}))).text();
    assert.ok(raw.includes('thinking hard'), 'side channel preserved');
    const body = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(p => p !== '[DONE]')
        .map(p => JSON.parse(p).choices?.[0]?.delta?.content || '').join('');
    assert.equal(body, 'ok');
});

test('a templated prefill is held back until it can be stripped', async () => {
    const inner = 'I should stay in character and keep it vivid.';
    const full = `<thinking>${inner}</thinking>${TAIL}`;
    const deltas = ['{"response": "'];
    for (let i = 0; i < full.length; i += 7) deltas.push(full.slice(i, i + 7));
    deltas.push('"}');
    const shown = await throughTransform(deltas, { prefill: '<thinking>[[any]]</thinking>' });
    assert.equal(shown, TAIL, 'emitting early would freeze the message');
});

test('an unclosed template still shows the whole reply once', async () => {
    const shown = await throughTransform(['{"response": "<thinking>never closes, just keeps going."}'],
        { prefill: '<thinking>[[any]]</thinking>' });
    assert.equal(shown, '<thinking>never closes, just keeps going.');
});

test('[[keep]] leaves the marked tail visible', async () => {
    const shown = await throughTransform(['{"response": "<thinking>hidden partVisible: ' + TAIL + '"}'],
        { prefill: '<thinking>hidden part[[keep]]Visible: ' });
    assert.equal(shown, 'Visible: ' + TAIL);
});
test('continue and quiet generations are left alone', async () => {
    for (const type of ['continue', 'quiet']) {
        configure();
        state.emitGenerationStarted(type);
        const body = JSON.parse(request('An unfinished sentence that is being ').body);
        const before = JSON.stringify(body);
        assert.equal(sp.prepareRequest(body), null, type);
        assert.equal(JSON.stringify(body), before, `${type} body untouched`);
    }
});

test('the generation type is consumed, so it cannot leak into the next message', async () => {
    configure();
    state.emitGenerationStarted('continue');
    assert.equal(sp.prepareRequest(JSON.parse(request().body)), null);
    const body = JSON.parse(request().body);
    assert.ok(sp.prepareRequest(body), 'next generation engages again');
    assert.ok(body.json_schema);
});

test('normal, swipe and impersonate generations still engage', async () => {
    for (const type of ['normal', 'regenerate', 'swipe', 'impersonate', undefined]) {
        configure();
        state.emitGenerationStarted(type);
        const body = JSON.parse(request().body);
        assert.ok(sp.prepareRequest(body), String(type));
        assert.ok(body.json_schema, String(type));
    }
});

// ── End to end through the fetch interceptor ───────────────────────────────

test('a reasoning model that spends its budget thinking shows nothing and warns', async () => {
    configure();
    state.upstream = async () => jsonReply('{"response": "', 'length');
    const res = await sp.interceptedFetch(URL_GEN, request());
    assert.equal(await displayed(res), '', 'no {"response": " in the chat');
    assert.equal(state.calls.length, 1, 'truncation is not a schema failure — do not re-generate');
    assert.match(state.warnings[0] ?? '', /token budget/);
    assert.equal(SETTINGS.spCompatCache['openai|gpt-5.1'], undefined, 'tier not blamed');
});

test('a compliant reply is unwrapped, stripped and confirms the tier', async () => {
    configure();
    state.upstream = async () => jsonReply(JSON.stringify({ response: PRE + TAIL }));
    const res = await sp.interceptedFetch(URL_GEN, request());
    assert.equal(await displayed(res), TAIL);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].stream, false, 'buffered for inspection');
    assert.ok(state.calls[0].json_schema);
    assert.equal(SETTINGS.spCompatCache['openai|gpt-5.1'], 'json_schema');
});

test('a partial reply is kept as-is without a retry', async () => {
    configure();
    state.upstream = async () => jsonReply('{"response": "<thinking>She turned slowly, weighing', 'length');
    const res = await sp.interceptedFetch(URL_GEN, request());
    assert.equal(await displayed(res), 'She turned slowly, weighing');
    assert.equal(state.calls.length, 1);
    assert.equal(state.warnings.length, 0, 'no toast for an ordinary short budget');
});

test('a model that ignores the format walks the ladder and still shows text', async () => {
    configure();
    const prose = 'She turned slowly and said nothing for a long moment. '.repeat(3);
    state.upstream = async () => jsonReply(prose);
    const res = await sp.interceptedFetch(URL_GEN, request());
    assert.ok((await displayed(res)).length > 0, 'never blank the message');
    assert.deepEqual(
        state.calls.map(c => c.json_schema
            ? (c.json_schema.value.properties.response.pattern ? 'schema' : 'shape')
            : 'none'),
        ['schema', 'shape', 'none']);
    assert.equal(SETTINGS.spCompatCache['openai|gpt-5.1'], 'prompt_only');
});

test('a schema rejected with 4xx is retried at a weaker tier', async () => {
    configure();
    let n = 0;
    state.upstream = async () => (++n === 1)
        ? new Response(JSON.stringify({ error: { message: 'pattern not supported' } }), { status: 400 })
        : jsonReply(JSON.stringify({ response: PRE + TAIL }));
    const res = await sp.interceptedFetch(URL_GEN, request());
    assert.equal(await displayed(res), TAIL);
    assert.equal(state.calls.length, 2);
    assert.ok(!state.calls[1].json_schema?.value?.properties?.response?.pattern);
});

test('a proven connection streams live and leaks no scaffolding', async () => {
    configure({ spCompatCache: { 'openai|gpt-5.1': 'json_schema' } });
    state.upstream = async () => streamReply(['{"', 'response": "', '<thinking>', 'She turned', ' slowly.', '"}']);
    const res = await sp.interceptedFetch(URL_GEN, request());
    const shown = await displayed(res);
    assert.equal(shown, 'She turned slowly.');
    assert.equal(state.calls[0].stream, true);
});

test('a non-streaming request comes back as JSON', async () => {
    configure();
    state.upstream = async () => jsonReply(JSON.stringify({ response: PRE + TAIL }));
    const res = await sp.interceptedFetch(URL_GEN, request(PRE, { stream: false }));
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(await displayed(res), TAIL);
});

test('Gemini works end to end', async () => {
    configure();
    // SillyTavern re-wraps Google replies into OpenAI shape before we see them.
    state.upstream = async () => jsonReply(JSON.stringify({ response: PRE + TAIL }));
    const res = await sp.interceptedFetch(URL_GEN, request(PRE, { source: 'makersuite', model: 'gemini-2.5-pro' }));
    assert.equal(await displayed(res, 'google'), TAIL);
    assert.ok(!state.calls[0].json_schema.value.properties.response.pattern);
});

test('the custom source gets a schema, not a YAML side-channel', async () => {
    configure();
    state.upstream = async () => jsonReply(JSON.stringify({ response: PRE + TAIL }));
    const res = await sp.interceptedFetch(URL_GEN, request(PRE, { stream: false, source: 'custom', model: 'local' }));
    assert.ok(state.calls[0].json_schema);
    assert.ok(!('custom_include_body' in state.calls[0]));
    assert.ok(!('response_format' in state.calls[0]));
    assert.equal(await displayed(res), TAIL);
});

test('disabled means byte-identical passthrough', async () => {
    configure({ structuredPrefillEnabled: false });
    state.upstream = async () => jsonReply('untouched');
    const init = request();
    const res = await sp.interceptedFetch(URL_GEN, init);
    assert.equal(JSON.stringify(state.calls[0]), init.body);
    assert.equal(await displayed(res), 'untouched');
});
