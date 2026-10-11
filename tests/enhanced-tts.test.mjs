/**
 * Unit tests for features/enhanced-tts-core.js
 *
 *   node --test tests/
 *
 * The core helpers have no SillyTavern imports, so we import the file directly
 * (unlike structured-prefill, which needs the stub rewrite in load-feature.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(HERE, '..', 'features', 'enhanced-tts-core.js')).href);

const {
    parseVoiceMarkup,
    stripVoiceMarkup,
    stripExpressionTags,
    cleanForDisplay,
    extractSpeakableSegments,
    splitVoiceSegment,
    prepareVoiceSegments,
    buildGeminiTtsPayload,
    makeVoiceCacheKey,
    buildInstructionBlock,
    parseWav,
    buildWavHeader,
    concatWavBuffers,
} = core;

// ---------------------------------------------------------------------------
// parseVoiceMarkup
// ---------------------------------------------------------------------------

test('parseVoiceMarkup: routes wrapped dialogue and narrator prose', () => {
    const { segments, warnings } = parseVoiceMarkup(
        'Kael folded his arms. [v2]"You shouldn\'t be here."[/v2] Mira laughed.',
        { narratorSlot: 1 });
    assert.deepEqual(warnings, []);
    assert.deepEqual(segments, [
        { slot: 1, text: 'Kael folded his arms. ' },
        { slot: 2, text: '"You shouldn\'t be here."' },
        { slot: 1, text: ' Mira laughed.' },
    ]);
});

test('parseVoiceMarkup: expression tags survive inside a quote', () => {
    const { segments } = parseVoiceMarkup('[v3]"<gasp> You scared me."[/v3]', { narratorSlot: 1 });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].slot, 3);
    assert.equal(segments[0].text, '"<gasp> You scared me."');
});

test('parseVoiceMarkup: honors a non-default narrator slot', () => {
    const { segments } = parseVoiceMarkup('prose [v3]"hi"[/v3] more', { narratorSlot: 5 });
    assert.deepEqual(segments.map(s => s.slot), [5, 3, 5]);
});

test('parseVoiceMarkup: invalid slot number is ignored with a warning', () => {
    const { segments, warnings } = parseVoiceMarkup('[v99]"nope"[/v99]', { narratorSlot: 1, maxSlots: 10 });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].slot, 1, 'routed to narrator');
    assert.ok(warnings.some(w => /invalid voice slot 99/i.test(w)));
});

test('parseVoiceMarkup: implicit close when a new opener interrupts', () => {
    const { warnings } = parseVoiceMarkup('[v2]"a" [v3]"b"[/v3]', { narratorSlot: 1 });
    assert.ok(warnings.some(w => /closed implicitly/i.test(w)));
});

test('parseVoiceMarkup: unmatched closing marker warns', () => {
    const { warnings } = parseVoiceMarkup('plain [/v2] text', { narratorSlot: 1 });
    assert.ok(warnings.some(w => /no matching opener/i.test(w)));
});

test('parseVoiceMarkup: unclosed opener warns', () => {
    const { warnings } = parseVoiceMarkup('[v2]"dangling', { narratorSlot: 1 });
    assert.ok(warnings.some(w => /not explicitly closed/i.test(w)));
});

// ---------------------------------------------------------------------------
// stripping / display
// ---------------------------------------------------------------------------

test('stripVoiceMarkup: removes markers only', () => {
    assert.equal(stripVoiceMarkup('a [v2]"b"[/v2] c'), 'a "b" c');
});

test('stripExpressionTags: removes known tags, keeps prose "<"', () => {
    assert.equal(stripExpressionTags('"<gasp> hi"'), '" hi"');
    assert.equal(stripExpressionTags('if 3 < 5 and a<b then'), 'if 3 < 5 and a<b then',
        'bare comparisons are not tags');
});

test('cleanForDisplay: strips both and tidies whitespace', () => {
    assert.equal(cleanForDisplay('Kael. [v2]"<sigh> fine."[/v2]'), 'Kael. " fine."');
});

// ---------------------------------------------------------------------------
// extractSpeakableSegments
// ---------------------------------------------------------------------------

test('extractSpeakableSegments: quotes mode drops narrator prose', () => {
    const { segments } = parseVoiceMarkup('prose [v2]"hi"[/v2] more', { narratorSlot: 1 });
    const speak = extractSpeakableSegments(segments, { mode: 'quotes', narratorSlot: 1 });
    assert.deepEqual(speak, [{ slot: 2, text: '"hi"' }]);
});

test('extractSpeakableSegments: audiobook mode keeps everything speakable', () => {
    const { segments } = parseVoiceMarkup('prose [v2]"hi"[/v2]  ', { narratorSlot: 1 });
    const speak = extractSpeakableSegments(segments, { mode: 'audiobook', narratorSlot: 1 });
    assert.deepEqual(speak.map(s => s.slot), [1, 2]);
    assert.ok(!speak.some(s => !s.text.trim()), 'whitespace-only segments are dropped');
});

// ---------------------------------------------------------------------------
// splitVoiceSegment
// ---------------------------------------------------------------------------

test('splitVoiceSegment: short text is untouched', () => {
    assert.deepEqual(splitVoiceSegment({ slot: 1, text: 'short' }, 100), [{ slot: 1, text: 'short' }]);
});

test('splitVoiceSegment: long text splits on whitespace and keeps slot/order', () => {
    const text = ('word '.repeat(60)).trim(); // 299 chars
    const pieces = splitVoiceSegment({ slot: 4, text }, 100);
    assert.ok(pieces.length > 1);
    assert.ok(pieces.every(p => p.slot === 4));
    assert.ok(pieces.every(p => p.text.length <= 100));
    assert.equal(pieces.map(p => p.text).join(' ').replace(/\s+/g, ' '), text);
});

test('prepareVoiceSegments: flattens and splits', () => {
    const long = 'x'.repeat(250);
    const out = prepareVoiceSegments([{ slot: 1, text: long }], 100);
    assert.ok(out.length >= 3);
});

// ---------------------------------------------------------------------------
// payload + cache key + instructions
// ---------------------------------------------------------------------------

test('buildGeminiTtsPayload: prepends style instruction, defaults api', () => {
    const p = buildGeminiTtsPayload({ text: '"hi"', voice: 'Kore', model: 'm', instruction: 'elderly, weary' });
    assert.ok(p.text.startsWith('elderly, weary'));
    assert.ok(p.text.includes('"hi"'));
    assert.equal(p.voice, 'Kore');
    assert.equal(p.api, 'makersuite');
});

test('makeVoiceCacheKey: stable and sensitive to voice', () => {
    const a = makeVoiceCacheKey({ text: 't', slot: 1, voice: 'Kore', model: 'm' });
    const b = makeVoiceCacheKey({ text: 't', slot: 1, voice: 'Kore', model: 'm' });
    const c = makeVoiceCacheKey({ text: 't', slot: 1, voice: 'Puck', model: 'm' });
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test('buildInstructionBlock: lists enabled slots and marks the narrator', () => {
    const slots = [
        { id: 1, label: 'Narrator', voiceName: 'Charon', enabled: true },
        { id: 2, label: 'Kael', voiceName: 'Fenrir', stylePrompt: 'gruff', enabled: true },
        { id: 3, label: 'disabled', voiceName: 'Puck', enabled: false },
    ];
    const block = buildInstructionBlock(slots, { narratorSlot: 1 });
    assert.ok(block.includes('Slot 1: Narrator'));
    assert.ok(block.includes('[narrator]'));
    assert.ok(block.includes('Slot 2: Kael'));
    assert.ok(block.includes('gruff'));
    assert.ok(!block.includes('Slot 3'), 'disabled slot omitted');
    assert.ok(block.includes('[v2]'), 'includes a worked example');
});

// ---------------------------------------------------------------------------
// WAV assembly
// ---------------------------------------------------------------------------

/** Build a tiny valid PCM WAV with `samples` 16-bit frames of a constant value. */
function makeWav(samples, sampleRate = 24000, value = 1) {
    const dataSize = samples * 2;
    const header = buildWavHeader(dataSize, sampleRate, 1, 16);
    const out = new Uint8Array(header.length + dataSize);
    out.set(header, 0);
    const view = new DataView(out.buffer, header.length);
    for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true);
    return out;
}

test('parseWav + buildWavHeader: round-trip format fields', () => {
    const wav = makeWav(10, 24000);
    const { sampleRate, numChannels, bitsPerSample, data } = parseWav(wav);
    assert.equal(sampleRate, 24000);
    assert.equal(numChannels, 1);
    assert.equal(bitsPerSample, 16);
    assert.equal(data.length, 20);
});

test('concatWavBuffers: sums PCM length with no gap', () => {
    const a = makeWav(10);
    const b = makeWav(15);
    const out = concatWavBuffers([a, b], { gapMs: 0 });
    const { data } = parseWav(out);
    assert.equal(data.length, (10 + 15) * 2);
    // Header advertises the right data size.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    assert.equal(view.getUint32(40, true), (10 + 15) * 2);
});

test('concatWavBuffers: inserts frame-aligned silence between fragments', () => {
    const a = makeWav(10, 24000);
    const b = makeWav(10, 24000);
    const gapMs = 100; // 0.1s * 24000 = 2400 frames = 4800 bytes
    const out = concatWavBuffers([a, b], { gapMs });
    const { data } = parseWav(out);
    const gapBytes = Math.round((gapMs / 1000) * 24000) * 2;
    assert.equal(data.length, (10 + 10) * 2 + gapBytes);
});

test('concatWavBuffers: rejects mismatched formats', () => {
    assert.throws(() => concatWavBuffers([makeWav(10, 24000), makeWav(10, 16000)]));
});

test('concatWavBuffers: throws on empty input', () => {
    assert.throws(() => concatWavBuffers([]));
});
