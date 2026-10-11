/**
 * Pure helpers for Enhanced TTS. No SillyTavern imports — safe to unit-test
 * by importing this file directly under `node --test`.
 *
 * Voice routing recognizes only wrapper markers of the form  [vN] ... [/vN].
 * Square brackets are used deliberately so they can never be confused with
 * Gemini's angle-bracket expression tags (<gasp>, <sigh>, <laugh>, ...). Those
 * expression tags are ordinary text here: they ride along inside a quote to the
 * TTS provider untouched, and are only removed from the *visible* chat message
 * by stripExpressionTags().
 */

// Matches an opening [vN] or closing [/vN] voice marker.
const VOICE_MARKER_RE = /\[(\/?)v(\d+)\]/gi;

// Matches short angle-bracket expression tags such as <gasp>, <sigh>,
// <heavy breath>, <short pause>, </laugh>. Deliberately narrow: the tag name
// must start with a letter and contain only letters, digits, spaces, hyphens
// and underscores, so ordinary prose like "3 < 5" or "a<b" is left alone.
const EXPRESSION_TAG_RE = /<\/?[a-z][a-z0-9 _-]{0,30}>/gi;

const DEFAULT_MAX_SLOTS = 10;

/**
 * Parse voice markers while assigning unmarked text to the narrator slot.
 * The parser is a scanner, not an HTML parser: arbitrary expression tags must
 * survive unchanged in the text handed to a provider.
 *
 * @param {string} input
 * @param {{narratorSlot?: number, maxSlots?: number}} [options]
 * @returns {{segments: Array<{slot: number, text: string}>, warnings: string[]}}
 */
export function parseVoiceMarkup(input, options = {}) {
    const maxSlots = Number.isInteger(options.maxSlots) ? options.maxSlots : DEFAULT_MAX_SLOTS;
    const narratorSlot = normalizeSlot(options.narratorSlot ?? 1, maxSlots) ?? 1;
    const source = String(input ?? '');
    const segments = [];
    const warnings = [];
    let activeSlot = narratorSlot;
    let cursor = 0;
    let openSlot = null;

    const pushText = (text, slot) => {
        if (!text) return;
        segments.push({ slot, text });
    };

    for (const match of source.matchAll(VOICE_MARKER_RE)) {
        pushText(source.slice(cursor, match.index), activeSlot);
        const marker = match[0];
        const isClosing = match[1] === '/';
        const parsedSlot = Number(match[2]);
        cursor = match.index + marker.length;

        if (!Number.isInteger(parsedSlot) || parsedSlot < 1 || parsedSlot > maxSlots) {
            warnings.push(`Ignored invalid voice slot ${parsedSlot}.`);
            continue;
        }

        if (!isClosing) {
            if (openSlot !== null) {
                warnings.push(`Voice slot ${openSlot} was closed implicitly by slot ${parsedSlot}.`);
            }
            openSlot = parsedSlot;
            activeSlot = parsedSlot;
        } else if (openSlot === null) {
            warnings.push(`Closing marker for slot ${parsedSlot} had no matching opener.`);
            activeSlot = narratorSlot;
        } else if (openSlot !== parsedSlot) {
            warnings.push(`Voice slot ${openSlot} was closed by slot ${parsedSlot}.`);
            openSlot = null;
            activeSlot = narratorSlot;
        } else {
            openSlot = null;
            activeSlot = narratorSlot;
        }
    }

    pushText(source.slice(cursor), activeSlot);

    if (openSlot !== null) {
        warnings.push(`Voice slot ${openSlot} was not explicitly closed.`);
    }

    return {
        segments: mergeVoiceSegments(segments),
        warnings,
    };
}

/**
 * Remove only Enhanced TTS voice markers. Expression tags are preserved.
 * @param {string} input
 * @returns {string}
 */
export function stripVoiceMarkup(input) {
    return String(input ?? '').replace(VOICE_MARKER_RE, '');
}

/**
 * Remove angle-bracket expression tags for DISPLAY only. Never call this on the
 * text sent to TTS — Gemini uses these tags to shape delivery.
 * @param {string} input
 * @returns {string}
 */
export function stripExpressionTags(input) {
    return String(input ?? '').replace(EXPRESSION_TAG_RE, '');
}

/**
 * Clean a message for display: drop voice markers and expression tags, then
 * tidy up the whitespace they leave behind.
 * @param {string} input
 * @returns {string}
 */
export function cleanForDisplay(input) {
    return stripExpressionTags(stripVoiceMarkup(input))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +\n/g, '\n');
}

/**
 * Merge adjacent text using the same slot without trimming meaningful text.
 * @param {Array<{slot:number,text:string}>} segments
 * @returns {Array<{slot:number,text:string}>}
 */
export function mergeVoiceSegments(segments) {
    const merged = [];
    for (const segment of segments || []) {
        if (!segment || !String(segment.text ?? '')) continue;
        const previous = merged.at(-1);
        if (previous && previous.slot === segment.slot) {
            previous.text += segment.text;
        } else {
            merged.push({ slot: segment.slot, text: String(segment.text) });
        }
    }
    return merged;
}

/**
 * Select the segments that should actually be synthesized.
 *  - 'quotes'   : only segments routed to a non-narrator slot (wrapped dialogue)
 *  - 'audiobook': every segment with speakable text, narrator prose included
 * Segments whose text is only whitespace are dropped either way.
 *
 * @param {Array<{slot:number,text:string}>} segments
 * @param {{mode?: 'quotes'|'audiobook', narratorSlot?: number}} [options]
 * @returns {Array<{slot:number,text:string}>}
 */
export function extractSpeakableSegments(segments, options = {}) {
    const mode = options.mode === 'audiobook' ? 'audiobook' : 'quotes';
    const narratorSlot = Number(options.narratorSlot ?? 1);
    const result = [];
    for (const segment of segments || []) {
        if (!segment) continue;
        const text = String(segment.text ?? '');
        if (!text.trim()) continue;
        if (mode === 'quotes' && segment.slot === narratorSlot) continue;
        result.push({ slot: segment.slot, text });
    }
    return result;
}

/**
 * Split a segment at whitespace boundaries while keeping its order.
 * @param {{slot:number,text:string}} segment
 * @param {number} [maxChars]
 * @returns {Array<{slot:number,text:string}>}
 */
export function splitVoiceSegment(segment, maxChars = 1800) {
    const limit = Math.max(100, Number(maxChars) || 1800);
    const text = String(segment?.text ?? '');
    if (text.length <= limit) return text ? [{ slot: segment.slot, text }] : [];

    const pieces = [];
    let remaining = text;
    while (remaining.length > limit) {
        let cut = remaining.lastIndexOf(' ', limit);
        if (cut < Math.floor(limit * 0.5)) cut = remaining.lastIndexOf('\n', limit);
        if (cut < Math.floor(limit * 0.5)) cut = limit;
        pieces.push({ slot: segment.slot, text: remaining.slice(0, cut) });
        remaining = remaining.slice(cut).replace(/^\s+/, '');
    }
    if (remaining) pieces.push({ slot: segment.slot, text: remaining });
    return pieces;
}

/**
 * Expand and split parsed segments for the synthesis queue.
 * @param {Array<{slot:number,text:string}>} segments
 * @param {number} [maxChars]
 */
export function prepareVoiceSegments(segments, maxChars = 1800) {
    return (segments || []).flatMap(segment => splitVoiceSegment(segment, maxChars));
}

/**
 * Build the request payload understood by SillyTavern's native Gemini route.
 * A per-slot style instruction is prepended as a natural-language cue; the
 * fragment text (expression tags included) follows verbatim.
 *
 * @param {{text:string, voice:string, model:string, api?:string, instruction?:string}} input
 */
export function buildGeminiTtsPayload(input) {
    const instruction = String(input?.instruction ?? '').trim();
    const text = String(input?.text ?? '');
    const promptedText = instruction
        ? `${instruction}\n\nSpeak the following text exactly, preserving expression markers:\n${text}`
        : text;

    return {
        text: promptedText,
        voice: String(input?.voice ?? ''),
        model: String(input?.model ?? ''),
        api: input?.api || 'makersuite',
    };
}

/**
 * Deterministic cache key for a single synthesized fragment.
 */
export function makeVoiceCacheKey({ text, slot, voice, model, instruction, gapMs }) {
    return JSON.stringify({
        version: 2,
        text: String(text ?? ''),
        slot: Number(slot),
        voice: String(voice ?? ''),
        model: String(model ?? ''),
        instruction: String(instruction ?? ''),
        gapMs: Number(gapMs) || 0,
    });
}

/**
 * Build the AI-facing instruction block describing the slot roster and the
 * wrapper-marker rules. Used both for auto-injection and the copy button.
 *
 * @param {Array<{id:number,label:string,voiceName:string,stylePrompt?:string,enabled?:boolean}>} slots
 * @param {{narratorSlot?: number, narrationMode?: 'quotes'|'audiobook'}} [options]
 * @returns {string}
 */
export function buildInstructionBlock(slots, options = {}) {
    const narratorSlot = Number(options.narratorSlot ?? 1);
    const active = (slots || []).filter(s => s && s.enabled !== false && (s.label || s.voiceName));

    const roster = active.length
        ? active.map(s => {
            const bits = [`Slot ${s.id}: ${s.label || '(unnamed)'}`];
            if (s.voiceName) bits.push(`voice "${s.voiceName}"`);
            if (s.stylePrompt) bits.push(`style: ${s.stylePrompt}`);
            return `  - ${bits.join(' — ')}${s.id === narratorSlot ? '  [narrator]' : ''}`;
        }).join('\n')
        : '  (no voice slots configured yet)';

    return [
        '[Voice narration markup]',
        'When you write dialogue, wrap each spoken line in a voice-slot marker so it can be',
        'narrated with the right voice. Use square-bracket wrappers exactly like this:',
        '',
        '    [v2]"You shouldn\'t be here."[/v2]',
        '',
        'Rules:',
        '  - Open with [vN] and close with [/vN], where N is the slot number for the speaker.',
        '  - Wrap only the spoken words (keep the quotation marks inside the wrapper).',
        '  - Leave narration/prose outside any marker; it belongs to the narrator slot.',
        '  - You may use expression tags inside a quote for delivery, e.g. <gasp>, <sigh>,',
        '    <laugh>, <breath>, <short pause>. Write them in angle brackets, never square ones.',
        '  - Do not nest voice markers. Close one speaker before opening the next.',
        '',
        'Voice slots:',
        roster,
        '',
        `Narrator slot: ${narratorSlot}.`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// WAV assembly
// ---------------------------------------------------------------------------

/**
 * Parse a 16-bit PCM WAV (RIFF) buffer into its format + raw PCM data.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{sampleRate:number, numChannels:number, bitsPerSample:number, data:Uint8Array}}
 */
export function parseWav(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length < 12 || readTag(bytes, 0) !== 'RIFF' || readTag(bytes, 8) !== 'WAVE') {
        throw new Error('Not a RIFF/WAVE buffer');
    }

    let sampleRate = 24000;
    let numChannels = 1;
    let bitsPerSample = 16;
    let data = null;

    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const chunkId = readTag(bytes, offset);
        const chunkSize = view.getUint32(offset + 4, true);
        const body = offset + 8;

        if (chunkId === 'fmt ') {
            numChannels = view.getUint16(body + 2, true);
            sampleRate = view.getUint32(body + 4, true);
            bitsPerSample = view.getUint16(body + 14, true);
        } else if (chunkId === 'data') {
            const end = Math.min(body + chunkSize, bytes.length);
            data = bytes.subarray(body, end);
        }

        // Chunks are word-aligned (padded to an even length).
        offset = body + chunkSize + (chunkSize % 2);
    }

    if (!data) throw new Error('WAV has no data chunk');
    return { sampleRate, numChannels, bitsPerSample, data };
}

/**
 * Build a 44-byte PCM WAV header. Mirrors the server's createWavHeader
 * (src/endpoints/google.js) exactly so playback behaves identically.
 * @returns {Uint8Array}
 */
export function buildWavHeader(dataSize, sampleRate, numChannels = 1, bitsPerSample = 16) {
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    writeTag(header, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeTag(header, 8, 'WAVE');
    writeTag(header, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, (sampleRate * numChannels * bitsPerSample) / 8, true);
    view.setUint16(32, (numChannels * bitsPerSample) / 8, true);
    view.setUint16(34, bitsPerSample, true);
    writeTag(header, 36, 'data');
    view.setUint32(40, dataSize, true);
    return header;
}

/**
 * Concatenate several PCM WAV buffers into a single WAV, inserting `gapMs` of
 * silence between fragments. All inputs must share the same format (they do —
 * every Gemini fragment is 24 kHz mono 16-bit).
 *
 * @param {Array<ArrayBuffer|Uint8Array>} buffers
 * @param {{gapMs?: number}} [options]
 * @returns {Uint8Array} a complete WAV file
 */
export function concatWavBuffers(buffers, options = {}) {
    const list = (buffers || []).filter(Boolean);
    if (list.length === 0) throw new Error('No audio buffers to concatenate');

    const parsed = list.map(parseWav);
    const { sampleRate, numChannels, bitsPerSample } = parsed[0];
    for (const p of parsed) {
        if (p.sampleRate !== sampleRate || p.numChannels !== numChannels || p.bitsPerSample !== bitsPerSample) {
            throw new Error('Cannot concatenate WAVs with differing formats');
        }
    }

    const gapMs = Math.max(0, Number(options.gapMs) || 0);
    const bytesPerFrame = (numChannels * bitsPerSample) / 8;
    let gapBytes = Math.round((gapMs / 1000) * sampleRate) * bytesPerFrame;
    // Silence must be frame-aligned; it is already a multiple of bytesPerFrame.

    const totalData = parsed.reduce((sum, p) => sum + p.data.length, 0)
        + gapBytes * (parsed.length - 1);

    const header = buildWavHeader(totalData, sampleRate, numChannels, bitsPerSample);
    const out = new Uint8Array(header.length + totalData);
    out.set(header, 0);

    let pos = header.length;
    parsed.forEach((p, index) => {
        out.set(p.data, pos);
        pos += p.data.length;
        if (gapBytes > 0 && index < parsed.length - 1) {
            // Leave the gap as zeros (silence) — already zero-initialized.
            pos += gapBytes;
        }
    });

    return out;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function readTag(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function writeTag(bytes, offset, tag) {
    for (let i = 0; i < tag.length; i++) bytes[offset + i] = tag.charCodeAt(i);
}

function normalizeSlot(value, maxSlots) {
    const slot = Number(value);
    return Number.isInteger(slot) && slot >= 1 && slot <= maxSlots ? slot : null;
}
