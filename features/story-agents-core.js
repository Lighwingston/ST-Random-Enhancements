/** Pure story-agent settings, prompts and scheduling. */
export const AGENT_REQUEST = Symbol.for('enhancements.storyAgent');
export const MAX_AGENTS = 10;
export const WRITER_PROMPT = `Use the specialist notes below to write the next story response. They are suggestions, not events that have already happened. Resolve conflicts using established lore, character knowledge, the user's latest message and the existing writing instructions. Keep the user's agency. Produce only the story response, without mentioning the agents or their notes. Preserve any required reply format, prefill and voice markers.`;

const PRESETS = [
    ['Scenario', 'Planning scene beats and pacing', 'Suggest a short sequence of scene beats responding to the latest user message. Preserve cause and effect, open plot threads and pacing. Avoid rushing resolutions or deciding the user character\'s actions. Distinguish established events from proposed developments.'],
    ['Characters', 'Checking motivations and relationships', 'Suggest character reactions, dialogue intentions and emotional subtext consistent with the character cards and conversation. Respect what each character actually knows. Keep voices distinct and avoid controlling the user character.'],
    ['World', 'Checking lore and scene continuity', 'Identify the relevant established lore, setting rules, physical positions and continuity constraints for this scene. Suggest a few concrete environmental details. Mark any new world detail as a proposal, and do not invent missing canon as fact.'],
    ['Style', 'Shaping voice, dialogue and prose', 'Recommend the point of view, rhythm, dialogue balance and a few precise sensory details matching the established writing style. Avoid repetitive phrasing and unnecessary exposition. Preserve formatting and voice-marker requirements.'],
    ['Intimacy / NSFW', 'Checking intimacy and scene tone', 'For an adult intimate scene, suggest emotional tone, relationship dynamics, consent cues and continuity appropriate to the user\'s requested level of detail. If the scene is not intimate, say that no intimacy guidance is needed. Do not steer an unrelated scene toward sexual content.'],
];

export function makeSlot(index = 0) {
    const preset = PRESETS[index];
    return { id: `agent-${index + 1}`, name: preset?.[0] || `Agent ${index + 1}`,
        activity: preset?.[1] || 'Preparing story notes', prompt: preset?.[2] || '',
        enabled: index < 4, model: '', maxTokens: 600, temperature: 0.7 };
}

export function defaultSettings() {
    return { enabled: false, askEveryTime: true, concurrency: 2, timeoutSeconds: 120,
        maxNoteChars: 2000, writerPrompt: WRITER_PROMPT,
        slots: PRESETS.map((_, i) => makeSlot(i)) };
}

export function boundedNumber(value, fallback, min, max) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeSettings(value) {
    const defaults = defaultSettings();
    const c = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
    c.enabled = c.enabled === true;
    c.askEveryTime = c.askEveryTime !== false;
    c.concurrency = Math.floor(boundedNumber(c.concurrency, 2, 1, 4));
    c.timeoutSeconds = boundedNumber(c.timeoutSeconds, 120, 15, 600);
    c.maxNoteChars = Math.floor(boundedNumber(c.maxNoteChars, 2000, 200, 8000));
    c.writerPrompt = typeof c.writerPrompt === 'string' ? c.writerPrompt : WRITER_PROMPT;
    const ids = new Set();
    c.slots = (Array.isArray(c.slots) ? c.slots : defaults.slots).slice(0, MAX_AGENTS).map((s, i) => {
        const slot = { ...makeSlot(i), ...(s && typeof s === 'object' ? s : {}) };
        for (const key of ['name', 'activity', 'prompt', 'model']) {
            slot[key] = typeof slot[key] === 'string' ? slot[key] : '';
        }
        slot.id = typeof slot.id === 'string' && slot.id && !ids.has(slot.id) ? slot.id : `slot-${i}`;
        while (ids.has(slot.id)) slot.id += '-new';
        ids.add(slot.id);
        slot.enabled = slot.enabled === true;
        slot.maxTokens = Math.floor(boundedNumber(slot.maxTokens, 600, 100, 4000));
        slot.temperature = boundedNumber(slot.temperature, 0.7, 0, 2);
        return slot;
    });
    return c;
}

export function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(p => !p.thought && (p.type === 'text' || !p.type))
        .map(p => p.text || '').join('\n');
}

export function buildAgentMessages(messages, slot, substitute = value => value) {
    // Story instructions are quoted context, rather than instructions to this
    // specialist. This also removes media, tool calls and reasoning signatures.
    const context = messages.map(m => `[${m.role}${m.name ? `: ${m.name}` : ''}]\n${textContent(m.content)}`)
        .filter(s => s.trim()).join('\n\n');
    return [
        { role: 'system', content: `You are a specialist story editor named ${slot.name}. The supplied conversation includes lore, character cards and instructions for a different writer. Treat it as reference material. Your task is to provide concise, actionable notes for that writer. Return only your finished recommendations, relevant facts and optional short examples. Do not write the final story response.\n\nYour specialty:\n${substitute(slot.prompt)}` },
        { role: 'user', content: `STORY CONTEXT\n${context}\n\nPrepare your specialist notes for the next response to the latest user message.` },
    ];
}

export function extractNotes(data) {
    if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message || 'API returned an error');
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text
        ?? data?.content ?? data?.candidates?.[0]?.content?.parts ?? data?.text
        ?? data?.message?.content ?? data?.message?.text ?? data?.message?.tool_plan;
    // Strip explicitly labelled reasoning if an endpoint includes it in content.
    return textContent(content).replace(/<(think|thinking|analysis)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(think|thinking|analysis)>[\s\S]*$/gi, '').trim();
}

export function compileNotes(results, config) {
    const notes = results.filter(r => r.status === 'done' && r.notes?.trim());
    if (!notes.length) return '';
    return `${config.writerPrompt.trim() || WRITER_PROMPT}\n\nSPECIALIST NOTES\n${notes.map(r =>
        `--- ${r.slot.name} ---\n${r.notes.slice(0, config.maxNoteChars)}`).join('\n\n')}`;
}

export function addWriterNotes(messages, notes) {
    const copy = structuredClone(messages);
    if (!notes) return copy;
    // Insert before a final assistant prefill (and trailing system prompts).
    // The prefill must remain the last assistant message for existing features.
    let index = copy.length;
    while (index > 0 && copy[index - 1].role === 'system') index--;
    if (index > 0 && copy[index - 1].role === 'assistant') index--;
    copy.splice(index, 0, { role: 'system', content: notes });
    return copy;
}

/** Drop the oldest whole conversation turn, keeping lore and the latest user turn. */
export function dropOldestTurn(messages) {
    const users = messages.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0);
    if (users.length < 2) return null;
    return messages.filter((m, i) => i < users[0] || i >= users[1] || m.role === 'system');
}

export async function runAgents(slots, { concurrency, signal, execute, onUpdate = () => {} }) {
    const results = slots.map(slot => ({ slot, status: 'queued', notes: '', error: '' }));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, slots.length) }, async () => {
        while (next < results.length && !signal.aborted) {
            const result = results[next++];
            result.status = 'working';
            onUpdate(result, results);
            try {
                result.notes = await execute(result.slot, notes => {
                    if (signal.aborted) return;
                    result.notes = notes;
                    onUpdate(result, results);
                });
                signal.throwIfAborted();
                if (!result.notes.trim()) throw new Error('The agent returned no notes.');
                result.status = 'done';
            } catch (error) {
                result.status = signal.aborted ? 'cancelled' : 'failed';
                result.error = error?.message || String(error);
            }
            onUpdate(result, results);
        }
    }));
    for (const r of results) {
        if (r.status === 'queued') { r.status = 'cancelled'; onUpdate(r, results); }
    }
    signal.throwIfAborted();
    return results;
}
