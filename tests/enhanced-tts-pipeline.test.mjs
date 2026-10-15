/**
 * End-to-end tests for features/enhanced-tts.js: a message goes in, and we
 * check the requests sent to SillyTavern's TTS route and the order of the
 * assembled audio. SillyTavern imports are rewritten to stubs (same idea as
 * load-feature.mjs) and fetch is mocked, so nothing reaches Google.
 *
 *   node --test "tests/*.test.mjs"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_URL = pathToFileURL(join(HERE, '..', 'features', 'enhanced-tts-core.js')).href;
const core = await import(CORE_URL);

/** A tiny WAV whose samples all equal `marker`, so assembly order is visible. */
function makeWav(marker, samples = 4) {
    const header = core.buildWavHeader(samples * 2, 24000, 1, 16);
    const out = new Uint8Array(header.length + samples * 2);
    out.set(header, 0);
    const view = new DataView(out.buffer, header.length);
    for (let i = 0; i < samples; i++) view.setInt16(i * 2, marker, true);
    return out;
}

/**
 * Load a fresh copy of the feature module against a mocked server.
 * @param {{capabilities?: object}} [server] omit capabilities to mimic an unpatched server
 */
async function loadTts(server = {}) {
    const state = { requests: [], blob: null, warnings: [] };
    globalThis.__TTS_TEST = { settings: { enhancements: {} } };
    globalThis.window = globalThis;
    globalThis.toastr = { warning: (message) => state.warnings.push(message), error() {}, info() {} };
    globalThis.document = { createElement: () => ({ pause() {}, play: async () => {} }) };
    globalThis.fetch = async (url, init) => {
        if (url === '/api/google/list-native-voices') {
            return Response.json({ voices: [], ...(server.capabilities ? { capabilities: server.capabilities } : {}) });
        }
        state.requests.push(JSON.parse(init.body));
        return new Response(makeWav(state.requests.length));
    };
    URL.createObjectURL = (blob) => { state.blob = blob; return 'blob:test'; };

    const src = readFileSync(join(HERE, '..', 'features', 'enhanced-tts.js'), 'utf8')
        .replace(/^import \{ extension_settings \}.*$/m, 'const extension_settings = globalThis.__TTS_TEST.settings;')
        .replace(/^import \{ saveSettingsDebounced, getRequestHeaders \}.*$/m,
            'const saveSettingsDebounced = () => {}; const getRequestHeaders = () => ({});')
        .replace(/^import \{ eventSource, event_types \}.*$/m, 'const eventSource = { on() {} }; const event_types = {};')
        .replace(/^import \{ oai_settings \}.*$/m, 'const oai_settings = {};')
        .replace(/^import \{ copyText, isValidUrl, getStringHash \}.*$/m,
            'const copyText = () => {}; const isValidUrl = () => false; const getStringHash = (s) => s.length;')
        .replace('from \'./enhanced-tts-core.js\'', `from '${CORE_URL}'`)
        + '\nexport const __internals = { ensureDefaults, cfg, buildAudioForMessage };\n';

    const file = join(mkdtempSync(join(tmpdir(), 'st-tts-test-')), 'enhanced-tts.mjs');
    writeFileSync(file, src);
    const mod = await import(pathToFileURL(file).href);
    mod.__internals.ensureDefaults();

    const c = mod.__internals.cfg();
    c.slots[0].voiceName = 'Charon';
    c.slots[1] = { ...c.slots[1], label: 'Kael', voiceName: 'Fenrir', stylePrompt: 'gruff', enabled: true };
    c.slots[2] = { ...c.slots[2], label: 'Mira', voiceName: 'Kore', enabled: true };
    c.gapMs = 0;

    /** Speak `text`; returns the request markers in the order they were assembled. */
    async function speak(text) {
        state.requests.length = 0;
        const url = await mod.__internals.buildAudioForMessage(text);
        if (!url) return null;
        const { data } = core.parseWav(new Uint8Array(await state.blob.arrayBuffer()));
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const markers = [];
        for (let i = 0; i < data.length; i += 2) {
            const sample = view.getInt16(i, true);
            if (sample !== markers.at(-1)) markers.push(sample);
        }
        return markers;
    }
    return { cfg: c, state, speak };
}

const EXTENDED = { capabilities: { turns: true, maxSpeakers: 2 } };
const REPLY = '*Kael folded his arms.* [v2: whispering]"You shouldn\'t be here."[/v2] Mira laughed. [v2]"I mean it."[/v2]';

test('audiobook: narrator plus one character is one request, quotes in place', async () => {
    const { cfg, state, speak } = await loadTts(EXTENDED);
    cfg.narrationMode = 'audiobook';

    assert.deepEqual(await speak(REPLY), [1]);
    assert.equal(state.requests.length, 1);
    const [request] = state.requests;
    assert.deepEqual(request.speakers, [{ speaker: 'Charon', voice: 'Charon' }, { speaker: 'Fenrir', voice: 'Fenrir' }]);
    assert.deepEqual(request.turns, [
        { text: 'Kael folded his arms.', style: '', speaker: 'Charon' },
        { text: '"You shouldn\'t be here."', style: 'whispering', speaker: 'Fenrir' },
        { text: 'Mira laughed.', style: '', speaker: 'Charon' },
        { text: '"I mean it."', style: 'gruff', speaker: 'Fenrir' },
    ], 'the AI cue wins for its line; the slot style is the fallback; no default style');
});

test('audiobook: a third voice adds a request and the audio stays in reading order', async () => {
    const { cfg, state, speak } = await loadTts(EXTENDED);
    cfg.narrationMode = 'audiobook';

    const markers = await speak('A. [v2]"one"[/v2] B. [v3]"two"[/v3] C. [v2]"three"[/v2]');
    assert.deepEqual(state.requests.map(r => r.turns.map(t => t.text)), [['A.', '"one"', 'B.'], ['"two"', 'C.'], ['"three"']]);
    assert.deepEqual(markers, [1, 2, 3]);
});

test('quotes mode: narration is skipped, unwrapped quotes still spoken', async () => {
    const { cfg, state, speak } = await loadTts(EXTENDED);
    cfg.narrationMode = 'quotes';

    await speak('He sat down. "Hello?" [v3]"Hi."[/v3] Silence.');
    assert.equal(state.requests.length, 1);
    assert.deepEqual(state.requests[0].turns.map(t => [t.speaker, t.text]), [['Charon', '"Hello?"'], ['Kore', '"Hi."']]);
});

test('unpatched server: one voice and one style per request, still in order', async () => {
    const { cfg, state, speak } = await loadTts();
    cfg.narrationMode = 'audiobook';

    assert.deepEqual(await speak(REPLY), [1, 2, 3, 4]);
    assert.deepEqual(state.requests.map(r => [r.voice, r.style, r.text]), [
        ['Charon', '', 'Kael folded his arms.'],
        ['Fenrir', 'whispering', '"You shouldn\'t be here."'],
        ['Charon', '', 'Mira laughed.'],
        ['Fenrir', 'gruff', '"I mean it."'],
    ]);
    assert.ok(state.requests.every(r => r.turns === undefined));

    await speak(REPLY);
    assert.equal(state.warnings.length, 1, 'the outdated-route warning is shown once');
    assert.match(state.warnings[0], /enhanced-tts-server\.patch/);
});

test('patched server: no outdated-route warning', async () => {
    const { cfg, state, speak } = await loadTts(EXTENDED);
    cfg.narrationMode = 'audiobook';
    await speak(REPLY);
    assert.deepEqual(state.warnings, []);
});

test('older preview model: no multi-speaker request and no style', async () => {
    const { cfg, state, speak } = await loadTts(EXTENDED);
    cfg.narrationMode = 'audiobook';
    cfg.model = 'gemini-2.5-flash-preview-tts';

    await speak(REPLY);
    assert.equal(state.requests.length, 4);
    assert.ok(state.requests.every(r => r.style === '' && r.turns === undefined));
});

test('a slot without a voice borrows the narrator voice instead of failing', async () => {
    const { cfg, state, speak } = await loadTts(EXTENDED);
    cfg.narrationMode = 'quotes';
    cfg.slots[2].voiceName = '';

    await speak('[v3]"Who?"[/v3]');
    assert.deepEqual(state.requests.map(r => [r.voice, r.turns[0].text]), [['Charon', '"Who?"']]);
});
