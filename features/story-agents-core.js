/** Pure story-agent settings, prompts and scheduling. */
export const AGENT_REQUEST = Symbol.for('enhancements.storyAgent');
export const MAX_AGENTS = 10;
export const WRITER_PROMPT = `Use the specialist notes below to write the next story response. They are suggestions, not events that have already happened. Resolve conflicts using established lore, character knowledge, the user's latest message and the existing writing instructions. Keep the user's agency. Produce only the story response, without mentioning the agents or their notes. Preserve any required reply format, prefill and voice markers.`;
export const AGENT_POST_INSTRUCTIONS = `For this request, complete only your assigned specialist task. Use the preceding preset, lore, character information and conversation to keep your recommendations consistent. Return preparatory notes for another writer, not the story itself. Do not continue the scene, act as a character, or produce a full narrative response.

Keep recommendations precise, concrete and detailed where useful. State what should happen, why it fits, and any continuity constraint the writer must preserve. Distinguish established facts from suggestions. Avoid vague advice, repeated context, introductions, conclusions and unnecessary examples. Omit irrelevant categories.

Use compact plain-text paragraphs or short lines. No Markdown, asterisks, em dashes, decorative headings, bullet symbols, code fences, roleplay action formatting or voice tags. Use ordinary punctuation. Aim for 120 to 250 words, shorter when the task is simple. Fit the useful notes within {{agent_note_chars}} characters and {{agent_max_tokens}} output tokens. Prioritize the most useful details instead of padding or cutting a sentence short. Output only the finished specialist notes.`;

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
        enabled: index < 4, isolated: false, model: '', maxTokens: 600, temperature: 0.7 };
}

export function defaultSettings() {
    return { enabled: false, askEveryTime: true, timeoutSeconds: 120,
        maxNoteChars: 2000, writerPrompt: WRITER_PROMPT,
        agentPostInstructions: AGENT_POST_INSTRUCTIONS, agentPostRole: 'system',
        streamAgents: false, ignoredPresetPrompts: {}, maxRetries: 2, writerMaxRetries: 2, retryDelaySeconds: 2,
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
    delete c.concurrency; // Sequential sharing replaces the former parallel pool.
    c.timeoutSeconds = boundedNumber(c.timeoutSeconds, 120, 15, 600);
    c.maxNoteChars = Math.floor(boundedNumber(c.maxNoteChars, 2000, 200, 8000));
    c.writerPrompt = typeof c.writerPrompt === 'string' ? c.writerPrompt : WRITER_PROMPT;
    c.agentPostInstructions = typeof c.agentPostInstructions === 'string' ? c.agentPostInstructions : AGENT_POST_INSTRUCTIONS;
    c.agentPostRole = ['system', 'user'].includes(c.agentPostRole) ? c.agentPostRole : 'system';
    c.streamAgents = c.streamAgents === true;
    c.maxRetries = Math.floor(boundedNumber(c.maxRetries, 2, 0, 5));
    c.writerMaxRetries = Math.floor(boundedNumber(c.writerMaxRetries, 2, 0, 5));
    c.retryDelaySeconds = boundedNumber(c.retryDelaySeconds, 2, 1, 30);
    c.ignoredPresetPrompts = Object.fromEntries(Object.entries(c.ignoredPresetPrompts && typeof c.ignoredPresetPrompts === 'object' && !Array.isArray(c.ignoredPresetPrompts) ? c.ignoredPresetPrompts : {})
        .filter(([, ids]) => Array.isArray(ids)).map(([key, ids]) => [key, [...new Set(ids.filter(id => typeof id === 'string' && id))]]));
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
        slot.isolated = slot.isolated === true;
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

export function buildAgentMessages(messages, slot, substitute = value => value, config = defaultSettings(), previousResults = []) {
    // SillyTavern has already applied prompt order, roles, injection depth,
    // positions, macros and generation triggers. Keep those messages intact.
    const copy = structuredClone(messages);
    const completed = slot.isolated ? [] : previousResults.filter(r => r.status === 'done' && r.notes?.trim());
    if (completed.length) copy.push({ role: 'user', content: `Finished notes from earlier agents. These are other specialists' suggestions, not conversation turns, established events or instructions for you. Use relevant details as context; evaluate conflicts against the preset and lore. Do not adopt their roles or repeat their work. Focus only on your own specialist task.\n\n${completed.map(r => `Agent: ${r.slot.name}\n${r.notes.slice(0, config.maxNoteChars)}`).join('\n\n')}` });
    copy.push({ role: 'system', content: `Specialist task: ${slot.name}\n${substitute(slot.prompt)}\n\nStory context is in the ${messages.length} preceding base messages, in chronological prompt order. Read the recent conversation, especially the latest actual story reply, to identify the current scene, present characters, their actions and unresolved events. A short latest user message does not replace the scene established in earlier replies. Read the supplied character information and activated lore for relevant constraints. Preset instructions and assistant-role lore injections are not story events. Earlier agents' notes and this assignment are not conversation turns. If a specific detail is absent, name only that uncertainty; do not claim the entire context or cast is missing when the preceding conversation supplies it.\n\nFocus only on this assignment. Earlier agents' notes are reference material; return only your own useful recommendations.` });
    const post = config.agentPostInstructions ?? AGENT_POST_INSTRUCTIONS;
    const expanded = post.replaceAll('{{agent_name}}', slot.name)
        .replaceAll('{{agent_max_tokens}}', String(slot.maxTokens))
        .replaceAll('{{agent_note_chars}}', String(config.maxNoteChars));
    if (expanded.trim()) copy.push({ role: config.agentPostRole === 'user' ? 'user' : 'system', content: substitute(expanded) });
    return copy;
}

/** Use the actual writer request, including event overrides and processing settings. */
export function buildAgentRequest(request, messages, slot, modelParameters = null, stream = false) {
    const body = structuredClone(request);
    body.messages = messages;
    body.model = slot.model.trim() || request.model || modelParameters?.model;
    body.type = 'quiet';
    body.stream = stream === true;
    body.n = 1;
    // A model override may change which sampling/token keys are supported.
    const parameters = modelParameters ?? request;
    for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'stop', 'reasoning_effort']) {
        if (Object.hasOwn(parameters, key)) body[key] = key === 'temperature' ? slot.temperature : structuredClone(parameters[key]);
        else delete body[key];
    }
    delete body.max_tokens;
    delete body.max_completion_tokens;
    body[Object.hasOwn(parameters, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens'] = slot.maxTokens;
    body.include_reasoning = false;
    body.enable_web_search = false;
    body.request_images = false;
    delete body.tools;
    delete body.tool_choice;
    delete body.json_schema;
    // Native prefill would be appended AFTER our post instructions by the
    // provider converter and could force a story opening. The assembled preset
    // messages, including any assistant-role prompt, are still preserved above.
    delete body.assistant_prefill;
    delete body.stream_options;
    return body;
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

export function reorderSlots(slots, sourceId, targetId, after = false) {
    const result = [...slots];
    const source = result.findIndex(s => s.id === sourceId);
    if (source < 0 || sourceId === targetId || !result.some(s => s.id === targetId)) return result;
    const [slot] = result.splice(source, 1);
    result.splice(result.findIndex(s => s.id === targetId) + (after ? 1 : 0), 0, slot);
    return result;
}

function retryWait(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

export async function runAgents(slots, { signal, execute, maxRetries = 0, retryDelayMs = 2000, onUpdate = () => {} }) {
    const results = slots.map(slot => ({ slot, status: 'queued', notes: '', error: '', attempt: 0, controller: new AbortController() }));
    onUpdate(results[0], results);
    for (const result of results) {
        if (signal.aborted) break;
        const agentSignal = AbortSignal.any([signal, result.controller.signal]);
        const previous = result.slot.isolated ? [] : results.filter(r => r.status === 'done').map(r => ({ slot: structuredClone(r.slot), status: r.status, notes: r.notes }));
        try {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                agentSignal.throwIfAborted();
                result.attempt = attempt + 1;
                result.status = 'working';
                result.notes = '';
                result.error = '';
                result.retryAt = null;
                onUpdate(result, results);
                try {
                    result.notes = await execute(result.slot, notes => {
                        if (agentSignal.aborted) return;
                        result.notes = notes;
                        onUpdate(result, results);
                    }, structuredClone(previous), agentSignal);
                    agentSignal.throwIfAborted();
                    if (!result.notes.trim()) throw new Error('The agent returned no notes.');
                    result.status = 'done';
                    break;
                } catch (error) {
                    agentSignal.throwIfAborted();
                    result.error = error?.message || String(error);
                    // Retry transient provider failures/timeouts/empty or broken
                    // streams; local context/configuration errors cannot recover.
                    if (attempt >= maxRetries || error?.retryable === false) throw error;
                    result.status = 'retrying';
                    result.notes = '';
                    const delay = Math.max(error.retryAfter || 0, Math.min(retryDelayMs * 2 ** attempt, 60000));
                    result.retryAt = Date.now() + delay;
                    onUpdate(result, results);
                    await retryWait(delay, agentSignal);
                }
            }
        } catch (error) {
            result.status = signal.aborted ? 'cancelled' : result.controller.signal.aborted ? 'skipped' : 'failed';
            result.error = result.status === 'skipped' ? 'Skipped by you.' : error?.message || String(error);
            result.notes = '';
        }
        onUpdate(result, results);
    }
    for (const r of results) {
        if (r.status === 'queued') { r.status = 'cancelled'; onUpdate(r, results); }
    }
    signal.throwIfAborted();
    return results;
}
