/**
 * Pure helpers for Enhanced TTS. No SillyTavern imports — safe to unit-test
 * by importing this file directly under `node --test`.
 *
 * Voice routing recognizes only wrapper markers of the form  [vN] ... [/vN].
 * An opener may carry a short per-line delivery cue:  [vN: whispering] ... [/vN].
 * Square brackets are used deliberately so they can never be confused with
 * Gemini's angle-bracket expression tags (<gasp>, <sigh>, <laugh>, ...). Those
 * expression tags are ordinary text here: they ride along inside a quote to the
 * TTS provider untouched, and are only removed from the *visible* chat message
 * by stripExpressionTags().
 */

// Matches an opening [vN] / [vN: cue] or closing [/vN] voice marker.
const VOICE_MARKER_RE = /\[(\/?)v(\d+)(?:\s*:\s*([^\]\n]{0,200}))?\]/gi;

// Gemini drifts on long style strings; a per-line cue is a few words at most.
const MAX_STYLE_CHARS = 100;

// Quoted dialogue left outside any voice marker: straight, curly, guillemet
// and low-high quotes. Used so quotes-only mode never drops unwrapped lines.
const UNMARKED_QUOTE_RE = /"[^"\n]+"|“[^”\n]+”|«[^»\n]+»|„[^“”\n]+[“”]/g;

// Matches short angle-bracket expression tags such as <gasp>, <sigh>,
// <heavy breath>, <short pause>, </laugh>. Deliberately narrow: the tag name
// must start with a letter and contain only letters, digits, spaces, hyphens
// and underscores, so ordinary prose like "3 < 5" or "a<b" is left alone.
const EXPRESSION_TAG_RE = /<\/?[a-z][a-z0-9 _-]{0,30}>/gi;

const DEFAULT_MAX_SLOTS = 10;

// HTML elements a chat message may contain. Angle-bracket tags that are not on
// this list (<gasp>, <short pause>, ...) are Gemini expression tags and stay.
const HTML_TAG_RE = /<\/?(?:a|abbr|b|big|blockquote|br|center|cite|code|del|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)\b[^>]*>/gi;

/**
 * Turn a chat message into a speakable transcript. Gemini reads its input
 * verbatim, so drop what is never read aloud (code, collapsed <details>,
 * comments, images) and formatting characters (markdown emphasis, HTML tags,
 * link syntax). Voice markers and expression tags are kept.
 * @param {string} input
 * @returns {string}
 */
export function prepareSpeechText(input) {
    return String(input ?? '')
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(details|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(HTML_TAG_RE, ' ')
        .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
        .replace(/\[(?!\/?v\d)([^\]\n]+)\]\([^)\n]*\)/gi, '$1')
        .replace(/`([^`\n]*)`/g, '$1')
        .replace(/\*+|~~/g, '')
        .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
        .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?)/gm, '')
        .replace(/^[ \t]*(?:-[ \t]*){3,}$/gm, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Parse voice markers while assigning unmarked text to the narrator slot.
 * The parser is a scanner, not an HTML parser: arbitrary expression tags must
 * survive unchanged in the text handed to a provider. A cue on an opener
 * ([v2: angry]) becomes that segment's `style`.
 *
 * @param {string} input
 * @param {{narratorSlot?: number, maxSlots?: number}} [options]
 * @returns {{segments: Array<{slot: number, text: string, style?: string}>, warnings: string[]}}
 */
export function parseVoiceMarkup(input, options = {}) {
    const maxSlots = Number.isInteger(options.maxSlots) ? options.maxSlots : DEFAULT_MAX_SLOTS;
    const narratorSlot = normalizeSlot(options.narratorSlot ?? 1, maxSlots) ?? 1;
    const source = String(input ?? '');
    const segments = [];
    const warnings = [];
    let activeSlot = narratorSlot;
    let activeStyle = '';
    let cursor = 0;
    let openSlot = null;

    const pushText = (text, slot, style) => {
        if (!text) return;
        segments.push(style ? { slot, text, style } : { slot, text });
    };

    for (const match of source.matchAll(VOICE_MARKER_RE)) {
        pushText(source.slice(cursor, match.index), activeSlot, activeStyle);
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
            activeStyle = normalizeStyle(match[3]);
        } else if (openSlot === null) {
            warnings.push(`Closing marker for slot ${parsedSlot} had no matching opener.`);
            activeSlot = narratorSlot;
            activeStyle = '';
        } else if (openSlot !== parsedSlot) {
            warnings.push(`Voice slot ${openSlot} was closed by slot ${parsedSlot}.`);
            openSlot = null;
            activeSlot = narratorSlot;
            activeStyle = '';
        } else {
            openSlot = null;
            activeSlot = narratorSlot;
            activeStyle = '';
        }
    }

    pushText(source.slice(cursor), activeSlot, activeStyle);

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
 * Merge adjacent text using the same slot and style without trimming
 * meaningful text.
 * @param {Array<{slot:number,text:string,style?:string}>} segments
 * @returns {Array<{slot:number,text:string,style?:string}>}
 */
export function mergeVoiceSegments(segments) {
    const merged = [];
    for (const segment of segments || []) {
        if (!segment || !String(segment.text ?? '')) continue;
        const style = segment.style || '';
        const previous = merged.at(-1);
        if (previous && previous.slot === segment.slot && (previous.style || '') === style) {
            previous.text += segment.text;
        } else {
            merged.push(withStyle({ slot: segment.slot, text: String(segment.text) }, style));
        }
    }
    return merged;
}

/**
 * Select the segments that should actually be synthesized, in reading order.
 *  - 'quotes'   : dialogue only — wrapped lines, plus quoted text the model
 *                 forgot to wrap (voiced by the narrator slot), so no line is lost
 *  - 'audiobook': every segment with speakable text, narrator prose included
 * Text is trimmed; segments without a letter or digit are dropped either way.
 *
 * @param {Array<{slot:number,text:string,style?:string}>} segments
 * @param {{mode?: 'quotes'|'audiobook', narratorSlot?: number}} [options]
 * @returns {Array<{slot:number,text:string,style?:string}>}
 */
export function extractSpeakableSegments(segments, options = {}) {
    const mode = options.mode === 'audiobook' ? 'audiobook' : 'quotes';
    const narratorSlot = Number(options.narratorSlot ?? 1);
    const result = [];
    const keep = (slot, text, style) => {
        const trimmed = text.trim();
        if (hasSpeakableContent(trimmed)) result.push(withStyle({ slot, text: trimmed }, style));
    };
    for (const segment of segments || []) {
        if (!segment) continue;
        const text = String(segment.text ?? '');
        if (mode === 'quotes' && segment.slot === narratorSlot) {
            for (const quote of text.match(UNMARKED_QUOTE_RE) || []) keep(narratorSlot, quote, segment.style);
            continue;
        }
        keep(segment.slot, text, segment.style);
    }
    return result;
}

/**
 * True when the text has something to pronounce (a letter or digit), as
 * opposed to stray punctuation or emphasis markers left between quotes.
 * @param {string} text
 */
export function hasSpeakableContent(text) {
    return /[\p{L}\p{N}]/u.test(String(text ?? ''));
}

/**
 * Split an over-long segment while keeping its order and other fields.
 * Splits prefer a sentence or line end, then whitespace, so the voice does not
 * break off mid-word.
 * @param {{slot:number,text:string}} segment
 * @param {number} [maxChars]
 * @returns {Array<{slot:number,text:string}>}
 */
export function splitVoiceSegment(segment, maxChars = 1800) {
    const limit = Math.max(100, Number(maxChars) || 1800);
    const text = String(segment?.text ?? '');
    if (text.length <= limit) return text ? [{ ...segment, text }] : [];

    const pieces = [];
    let remaining = text;
    while (remaining.length > limit) {
        const cut = findSplitPoint(remaining, limit);
        const piece = remaining.slice(0, cut).trim();
        if (piece) pieces.push({ ...segment, text: piece });
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.trim()) pieces.push({ ...segment, text: remaining });
    return pieces;
}

/**
 * Pack ordered turns into as few TTS requests as possible without reordering
 * anything. A request is closed when the next turn would add a voice beyond
 * `maxSpeakers` (Gemini's multi-speaker mode takes two) or push it past
 * `maxChars`. With `perTurnStyle: false` (a route that takes one style per
 * request) a style change closes the request too.
 *
 * Greedy packing gives the fewest requests: every run of turns inside a valid
 * request is itself valid, so extending each request as far as possible is
 * never worse than closing it early.
 *
 * @template {{voice:string,text:string,style?:string}} T
 * @param {T[]} turns
 * @param {{maxSpeakers?: number, maxChars?: number, perTurnStyle?: boolean}} [options]
 * @returns {T[][]}
 */
export function packTurns(turns, options = {}) {
    const maxSpeakers = Math.max(1, Math.floor(Number(options.maxSpeakers)) || 1);
    const maxChars = Math.max(100, Number(options.maxChars) || 1800);
    const perTurnStyle = options.perTurnStyle !== false;
    const requests = [];
    let current = null;
    let voices = new Set();
    let chars = 0;

    for (const turn of turns || []) {
        if (!turn?.text) continue;
        const fits = current !== null
            && (voices.has(turn.voice) || voices.size < maxSpeakers)
            && chars + turn.text.length <= maxChars
            && (perTurnStyle || (current[0].style || '') === (turn.style || ''));
        if (!fits) {
            current = [];
            requests.push(current);
            voices = new Set();
            chars = 0;
        }
        current.push(turn);
        voices.add(turn.voice);
        chars += turn.text.length;
    }
    return requests;
}

/**
 * Build the request payload understood by SillyTavern's native Gemini route.
 *
 * Gemini 3.8 TTS treats `text` as a STRICT verbatim transcript — anything in it
 * is spoken. Per-turn delivery direction (emotion, pace, tone) must therefore
 * travel in `speech_metadata.style`, NOT inside the text, or the model reads the
 * instruction aloud. We keep the transcript verbatim (inline angle-bracket
 * expression tags like <gasp> are legitimate and stay) and surface the per-slot
 * style separately as `style`, which the server maps to `speech_metadata.style`.
 *
 * @param {{text:string, voice:string, model:string, api?:string, instruction?:string}} input
 */
export function buildGeminiTtsPayload(input) {
    const style = String(input?.instruction ?? '').trim();
    const text = String(input?.text ?? '');

    return {
        text,                                   // verbatim transcript, read exactly
        voice: String(input?.voice ?? ''),
        model: String(input?.model ?? ''),
        api: input?.api || 'makersuite',
        style,                                  // -> speech_metadata.style (empty = omitted)
    };
}

/**
 * Build a request for the extended native route: ordered `turns` (one Gemini
 * part each, with its own speech_metadata.style) and, when two voices are
 * involved, a `speakers` list for Gemini's multi-speaker mode. This keeps
 * narration and the quotes inside it in one request, in reading order.
 *
 * @param {Array<{voice:string,text:string,style?:string}>} turns  at most two distinct voices
 * @param {{model:string, api?:string}} options
 */
export function buildGeminiTurnsPayload(turns, options = {}) {
    const list = (turns || []).filter(turn => turn?.text);
    const voices = [...new Set(list.map(turn => String(turn.voice ?? '')))];
    if (voices.length > 2) throw new Error('A Gemini TTS request supports at most two voices');
    const multi = voices.length === 2;
    const names = speakerNames(voices);

    return {
        model: String(options.model ?? ''),
        api: options.api || 'makersuite',
        voice: multi ? '' : (voices[0] ?? ''),
        speakers: multi ? voices.map((voice, i) => ({ speaker: names[i], voice })) : [],
        turns: list.map(turn => {
            const part = { text: String(turn.text), style: String(turn.style ?? '').trim() };
            if (multi) part.speaker = names[voices.indexOf(String(turn.voice ?? ''))];
            return part;
        }),
    };
}

/**
 * Gemini 3.8+ TTS models take per-turn speech_metadata (style, speaker). The
 * older previews take plain text only and get one voice per request.
 * @param {string} model
 */
export function supportsStructuredTurns(model) {
    const name = String(model ?? '').trim().replace(/^models\//i, '');
    return !/^gemini-(?:1\.|2\.|3\.[0-7](?!\d))/i.test(name);
}

/**
 * Deterministic cache key for one synthesized request payload.
 */
export function makeVoiceCacheKey(payload) {
    return JSON.stringify({
        version: 3,
        model: String(payload?.model ?? ''),
        voice: String(payload?.voice ?? ''),
        text: String(payload?.text ?? ''),
        style: String(payload?.style ?? ''),
        speakers: payload?.speakers ?? [],
        turns: payload?.turns ?? [],
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
        'Wrap every spoken line of dialogue in a voice-slot marker so it is read aloud in',
        'that speaker\'s voice. Use square-bracket wrappers exactly like this:',
        '',
        '    [v2]"You shouldn\'t be here."[/v2]',
        '',
        'When the delivery matters, add a short cue after a colon in the opening marker:',
        '',
        '    [v2: whispering urgently]"Get down. <short pause> Now."[/v2]',
        '',
        'Rules:',
        '  - Open with [vN] or [vN: cue] and close with [/vN], where N is the speaker\'s slot number.',
        '  - Wrap every quoted line, even short ones; keep the quotation marks inside the wrapper.',
        '  - Leave narration/prose outside any marker; it belongs to the narrator slot.',
        '  - A cue is 1-4 English words about delivery only: emotion, pace, volume or tone',
        '    (e.g. "furious, shouting", "barely audible", "teasing", "out of breath").',
        '    Never put age, gender, accent or names in a cue; the voice already carries them.',
        '  - For moments inside a line use angle-bracket tags: <gasp>, <sigh>, <laugh>, <chuckle>,',
        '    <breath>, <cough>, <sob>, <short pause>, <long pause>. Never square brackets for these.',
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

function normalizeStyle(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STYLE_CHARS);
}

function withStyle(segment, style) {
    return style ? { ...segment, style } : segment;
}

// Prefer the end of a sentence or line in the back half of the window, then
// any whitespace, so a split never lands mid-word unless it must. A space
// inside an expression tag (<short pause>) is not a split point.
function findSplitPoint(text, limit) {
    const floor = Math.floor(limit * 0.5);
    const head = text.slice(0, limit + 1);
    let sentenceEnd = -1;
    for (const match of head.matchAll(/[.!?…]+["'”»’)]*(?=\s)|\n/g)) {
        const cut = match[0] === '\n' ? match.index : match.index + match[0].length;
        if (cut <= limit) sentenceEnd = cut;
    }
    if (sentenceEnd >= floor) return sentenceEnd;

    let space = head.lastIndexOf(' ', limit);
    const tagStart = space > 0 ? text.lastIndexOf('<', space) : -1;
    const tag = tagStart === -1 ? null : /^<\/?[a-z][a-z0-9 _-]{0,30}>/i.exec(text.slice(tagStart));
    if (tag && tagStart + tag[0].length > space) space = text.lastIndexOf(' ', tagStart - 1);
    return space >= floor ? space : limit;
}

// Speaker labels only need to be unique within one request; the voice name is
// readable in logs and already alphanumeric for Gemini's prebuilt voices.
function speakerNames(voices) {
    const names = voices.map((voice, i) => voice.replace(/[^A-Za-z0-9]/g, '') || `Speaker${i + 1}`);
    if (names.length === 2 && names[0] === names[1]) names[1] += '2';
    return names;
}
