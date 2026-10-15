/**
 * Unit tests for features/enhanced-tts-core.js
 *
 *   node --test "tests/*.test.mjs"
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
    mergeVoiceSegments,
    extractSpeakableSegments,
    hasSpeakableContent,
    prepareSpeechText,
    splitVoiceSegment,
    packTurns,
    buildGeminiTtsPayload,
    buildGeminiTurnsPayload,
    supportsStructuredTurns,
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

test('parseVoiceMarkup: a cue on the opener becomes that line\'s style', () => {
    const { segments, warnings } = parseVoiceMarkup(
        'She froze. [v2:  whispering   urgently ]"Get down."[/v2] Then [v2]"Now."[/v2]',
        { narratorSlot: 1 });
    assert.deepEqual(warnings, []);
    assert.deepEqual(segments, [
        { slot: 1, text: 'She froze. ' },
        { slot: 2, text: '"Get down."', style: 'whispering urgently' },
        { slot: 1, text: ' Then ' },
        { slot: 2, text: '"Now."' },
    ]);
});

test('parseVoiceMarkup: an over-long cue is clipped, not spoken', () => {
    const { segments } = parseVoiceMarkup(`[v2: ${'very '.repeat(40)}]"hi"[/v2]`, { narratorSlot: 1 });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, '"hi"');
    assert.ok(segments[0].style.length <= 100);
});

test('mergeVoiceSegments: keeps lines with different styles apart', () => {
    assert.deepEqual(mergeVoiceSegments([
        { slot: 2, text: 'a', style: 'calm' },
        { slot: 2, text: 'b', style: 'calm' },
        { slot: 2, text: 'c', style: 'angry' },
    ]), [
        { slot: 2, text: 'ab', style: 'calm' },
        { slot: 2, text: 'c', style: 'angry' },
    ]);
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

test('cleanForDisplay: strips markers that carry a cue', () => {
    assert.equal(cleanForDisplay('[v2: furious, shouting]"Out!"[/v2]'), '"Out!"');
});

test('prepareSpeechText: drops formatting and unspoken blocks, keeps markers and tags', () => {
    const raw = [
        '*Kael leans back.* [v2: dry]"Oh, **really**?"[/v2] <sigh>',
        '<details><summary>Stats</summary>HP: 10</details>',
        '```js\nconsole.log(1)\n```',
        '<span style="color:red">The __door__ creaks.</span> ~~no~~ [a link](https://x.y) ![img](a.png)',
        '# Chapter two',
        'snake_case stays',
    ].join('\n');
    assert.equal(prepareSpeechText(raw), [
        'Kael leans back. [v2: dry]"Oh, really?"[/v2] <sigh>',
        '',
        'The door creaks. no a link',
        'Chapter two',
        'snake_case stays',
    ].join('\n'));
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

test('extractSpeakableSegments: audiobook mode keeps narration between quotes, in order', () => {
    const { segments } = parseVoiceMarkup(
        'Kael folded his arms. [v2: cold]"Leave."[/v2] Mira laughed. [v3]"Make me."[/v3]',
        { narratorSlot: 1 });
    assert.deepEqual(extractSpeakableSegments(segments, { mode: 'audiobook', narratorSlot: 1 }), [
        { slot: 1, text: 'Kael folded his arms.' },
        { slot: 2, text: '"Leave."', style: 'cold' },
        { slot: 1, text: 'Mira laughed.' },
        { slot: 3, text: '"Make me."' },
    ]);
});

test('extractSpeakableSegments: quotes mode voices unwrapped quotes instead of dropping them', () => {
    const { segments } = parseVoiceMarkup(
        'He turned. «Где ты был?» [v2]"Out."[/v2] She sighed. “Fine.” Nothing else.',
        { narratorSlot: 1 });
    assert.deepEqual(extractSpeakableSegments(segments, { mode: 'quotes', narratorSlot: 1 }), [
        { slot: 1, text: '«Где ты был?»' },
        { slot: 2, text: '"Out."' },
        { slot: 1, text: '“Fine.”' },
    ]);
});

test('hasSpeakableContent: punctuation and emphasis leftovers are not speech', () => {
    assert.equal(hasSpeakableContent(' ." — '), false);
    assert.equal(hasSpeakableContent('<sigh>'), true);
    assert.equal(hasSpeakableContent('Да.'), true);
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

test('splitVoiceSegment: prefers a sentence end and keeps the other fields', () => {
    const first = 'The rain kept falling on the old tin roof of the cabin all night long. ';
    const text = first + 'word '.repeat(30).trim();
    const pieces = splitVoiceSegment({ slot: 2, text, style: 'tired', voice: 'Kore' }, 100);
    assert.equal(pieces[0].text, first.trim(), 'first cut lands after the full stop');
    assert.ok(pieces.every(p => p.slot === 2 && p.style === 'tired' && p.voice === 'Kore'));
    assert.ok(pieces.every(p => p.text.length <= 100));
});

test('splitVoiceSegment: never cuts inside an expression tag', () => {
    // The last space before the 100-char limit sits inside <short pause>.
    const text = `${'abcd '.repeat(18)}<short pause> and then the rest of the line goes on`;
    const pieces = splitVoiceSegment({ slot: 2, text }, 100);
    assert.equal(pieces.length, 2);
    assert.ok(pieces[1].text.startsWith('<short pause>'), pieces[1].text);
    assert.equal(pieces.map(p => p.text).join(' '), text);
});

// ---------------------------------------------------------------------------
// packTurns — request planning
// ---------------------------------------------------------------------------

const turn = (voice, text, style = '') => ({ voice, text, style });

test('packTurns: narrator plus one character is a single request in reading order', () => {
    const turns = [
        turn('Charon', 'Kael folded his arms.'),
        turn('Fenrir', '"You shouldn\'t be here."', 'cold'),
        turn('Charon', 'Mira laughed.'),
        turn('Fenrir', '"I mean it."'),
    ];
    assert.deepEqual(packTurns(turns, { maxSpeakers: 2, maxChars: 1800 }), [turns]);
});

test('packTurns: a third voice starts a new request without reordering', () => {
    const turns = [
        turn('Charon', 'n1'), turn('Fenrir', 'a1'), turn('Charon', 'n2'),
        turn('Kore', 'b1'), turn('Charon', 'n3'), turn('Fenrir', 'a2'),
    ];
    const requests = packTurns(turns, { maxSpeakers: 2, maxChars: 1800 });
    assert.deepEqual(requests.map(r => r.map(t => t.text)), [['n1', 'a1', 'n2'], ['b1', 'n3'], ['a2']]);
    assert.deepEqual(requests.flat(), turns, 'every turn kept, in order');
    assert.ok(requests.every(r => new Set(r.map(t => t.voice)).size <= 2));
});

test('packTurns: the character budget closes a request', () => {
    const turns = [turn('Charon', 'a'.repeat(80)), turn('Fenrir', 'b'.repeat(30)), turn('Charon', 'c'.repeat(10))];
    const requests = packTurns(turns, { maxSpeakers: 2, maxChars: 100 });
    assert.deepEqual(requests.map(r => r.length), [1, 2]);
});

test('packTurns: the single-voice route groups only same voice and same style', () => {
    const turns = [
        turn('Charon', 'n1'), turn('Charon', 'n2'), turn('Charon', 'n3', 'tense'),
        turn('Fenrir', 'a1'), turn('Charon', 'n4'),
    ];
    const requests = packTurns(turns, { maxSpeakers: 1, maxChars: 1800, perTurnStyle: false });
    assert.deepEqual(requests.map(r => r.map(t => t.text)), [['n1', 'n2'], ['n3'], ['a1'], ['n4']]);
});

test('packTurns: does not mutate its input', () => {
    const turns = [turn('Charon', 'n1'), turn('Fenrir', 'a1')];
    const before = structuredClone(turns);
    packTurns(turns, { maxSpeakers: 2 });
    assert.deepEqual(turns, before);
});

// ---------------------------------------------------------------------------
// payload + cache key + instructions
// ---------------------------------------------------------------------------

test('buildGeminiTtsPayload: keeps text verbatim, routes style separately', () => {
    const p = buildGeminiTtsPayload({ text: '"hi" <gasp>', voice: 'Kore', model: 'm', instruction: 'elderly, weary' });
    // The transcript must stay EXACT — style must never leak into spoken text.
    assert.equal(p.text, '"hi" <gasp>');
    assert.ok(!p.text.includes('elderly'), 'style must not appear in spoken text');
    assert.equal(p.style, 'elderly, weary');
    assert.equal(p.voice, 'Kore');
    assert.equal(p.api, 'makersuite');
});

test('buildGeminiTtsPayload: empty style yields empty string (server omits it)', () => {
    const p = buildGeminiTtsPayload({ text: 'read me', voice: 'Kore', model: 'm' });
    assert.equal(p.text, 'read me');
    assert.equal(p.style, '');
});

test('makeVoiceCacheKey: stable and sensitive to voice', () => {
    const a = makeVoiceCacheKey({ text: 't', slot: 1, voice: 'Kore', model: 'm' });
    const b = makeVoiceCacheKey({ text: 't', slot: 1, voice: 'Kore', model: 'm' });
    const c = makeVoiceCacheKey({ text: 't', slot: 1, voice: 'Puck', model: 'm' });
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test('makeVoiceCacheKey: sensitive to per-turn style', () => {
    const turns = [turn('Charon', 'n'), turn('Kore', 'q', 'calm')];
    const angry = [turn('Charon', 'n'), turn('Kore', 'q', 'angry')];
    assert.notEqual(
        makeVoiceCacheKey(buildGeminiTurnsPayload(turns, { model: 'm' })),
        makeVoiceCacheKey(buildGeminiTurnsPayload(angry, { model: 'm' })));
});

test('buildGeminiTurnsPayload: two voices use multi-speaker with a style per turn', () => {
    const p = buildGeminiTurnsPayload([
        turn('Charon', 'Kael folded his arms.'),
        turn('Fenrir', '"You shouldn\'t be here." <sigh>', 'cold, clipped'),
    ], { model: 'gemini-3.8-flash-tts' });
    assert.equal(p.voice, '');
    assert.deepEqual(p.speakers, [{ speaker: 'Charon', voice: 'Charon' }, { speaker: 'Fenrir', voice: 'Fenrir' }]);
    assert.deepEqual(p.turns, [
        { text: 'Kael folded his arms.', style: '', speaker: 'Charon' },
        { text: '"You shouldn\'t be here." <sigh>', style: 'cold, clipped', speaker: 'Fenrir' },
    ]);
    assert.equal(p.model, 'gemini-3.8-flash-tts');
    assert.equal(p.api, 'makersuite');
});

test('buildGeminiTurnsPayload: one voice keeps per-turn styles without speakers', () => {
    const p = buildGeminiTurnsPayload([turn('Kore', 'a', 'calm'), turn('Kore', 'b', 'angry')], { model: 'm' });
    assert.equal(p.voice, 'Kore');
    assert.deepEqual(p.speakers, []);
    assert.deepEqual(p.turns, [{ text: 'a', style: 'calm' }, { text: 'b', style: 'angry' }]);
});

test('buildGeminiTurnsPayload: refuses more than two voices', () => {
    assert.throws(() => buildGeminiTurnsPayload([turn('A', 'a'), turn('B', 'b'), turn('C', 'c')], { model: 'm' }));
});

test('supportsStructuredTurns: 3.8+ take speech_metadata, older previews do not', () => {
    assert.equal(supportsStructuredTurns('gemini-3.8-flash-tts'), true);
    assert.equal(supportsStructuredTurns('gemini-3.8-flash-lite-tts'), true);
    assert.equal(supportsStructuredTurns('gemini-3.10-flash-tts'), true);
    assert.equal(supportsStructuredTurns('gemini-3.1-flash-tts-preview'), false);
    assert.equal(supportsStructuredTurns('gemini-2.5-pro-preview-tts'), false);
    assert.equal(supportsStructuredTurns('models/gemini-2.5-flash-preview-tts'), false);
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
    assert.ok(block.includes('[v2: whispering urgently]'), 'documents the per-line cue');
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
