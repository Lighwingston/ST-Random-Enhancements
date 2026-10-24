/** Story specialists prepare notes before the normal SillyTavern writer request. */
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders, sendTextareaMessage, isGenerating, stopGeneration, substituteParams } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { oai_settings, createGenerationParameters, getChatCompletionModel, promptManager, Message, ChatCompletion } from '../../../../openai.js';
import { countTokensOpenAIAsync } from '../../../../tokenizers.js';
import { AGENT_REQUEST, AGENT_POST_INSTRUCTIONS, MAX_AGENTS, makeSlot, normalizeSettings, buildAgentMessages, buildAgentRequest, compileNotes, addWriterNotes, runAgents, reorderSlots } from './story-agents-core.js';
import { presetPrompts, presetKey, cleanPresetMetadata, excludePresetPrompts, assertChatContext, installPresetTracking } from './story-agents-presets.js';
import { readAgentResponse } from './story-agents-stream.js';
import { fetchWriterWithRetries, apiResponseError } from './story-agents-writer.js';

const ROUTE = '/api/backends/chat-completions/generate';
const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
let previousFetch;
let pendingSelection = null;
let choosing = null;
let activeRun = null;
let lastRun = null;
let clockTimer = null;
let preparingSend = false;
let draggedSlot = null;

function cfg() { return extension_settings.enhancements.storyAgents; }
function ensureDefaults() {
    extension_settings.enhancements ??= {};
    extension_settings.enhancements.storyAgents = normalizeSettings(cfg());
}
function context() { return globalThis.SillyTavern?.getContext?.(); }
function chatIdentity() { return context()?.getCurrentChatId?.() ?? null; }
function sameChat(selection) { return selection.chatId === chatIdentity() && selection.chat === context()?.chat; }
function errorMessage(error) { return error?.message || String(error); }
function abortError(message = 'Story agents cancelled') { return new DOMException(message, 'AbortError'); }

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, action) {
    const node = element('button', 'menu_button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}
function field(parent, label, value, onChange, { type = 'text', min, max, step, placeholder = '' } = {}) {
    const wrapper = element('label', 'enh_sa_field');
    wrapper.append(element('span', '', label));
    const input = element(type === 'textarea' ? 'textarea' : 'input', 'text_pole');
    if (type !== 'textarea') input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    if (step !== undefined) input.step = step;
    input.addEventListener(type === 'number' ? 'change' : 'input', () => onChange(type === 'number' ? Number(input.value) : input.value));
    wrapper.append(input);
    parent.append(wrapper);
    return input;
}
function checkbox(parent, label, checked, change) {
    const wrapper = element('label', 'checkbox_label');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => change(input.checked));
    wrapper.append(input, element('span', '', label));
    parent.append(wrapper);
    return input;
}

function save() {
    extension_settings.enhancements.storyAgents = normalizeSettings(cfg());
    saveSettingsDebounced();
}

function renderPresetExclusions() {
    const list = document.getElementById('enh_sa_preset_prompts');
    if (!list) return;
    const key = presetKey(oai_settings);
    document.getElementById('enh_sa_preset_name').textContent = `Preset: ${key}`;
    list.replaceChildren();
    const prompts = presetPrompts(promptManager);
    const ignored = cfg().ignoredPresetPrompts[key] ?? [];
    for (const prompt of prompts) {
        const row = element('div', 'enh_sa_choice');
        const position = prompt.injection_position === 1 ? `In chat, depth ${prompt.injection_depth ?? 4}, priority ${prompt.injection_order ?? 100}` : 'Preset order';
        checkbox(row, prompt.name || prompt.identifier, ignored.includes(prompt.identifier), checked => {
            const ids = new Set(cfg().ignoredPresetPrompts[key] ?? []);
            if (checked) ids.add(prompt.identifier); else ids.delete(prompt.identifier);
            cfg().ignoredPresetPrompts[key] = [...ids];
            save();
        });
        row.append(element('small', 'enh_sa_hint', `${prompt.role || 'system'} · ${position}${prompt.enabled ? '' : ' · disabled in preset'}`));
        list.append(row);
    }
    if (!prompts.length) list.append(element('p', 'enh_sa_hint', 'Select a chat and a Chat Completion preset to list its prompts.'));
}

function moveSlot(source, target, after = false) {
    cfg().slots = reorderSlots(cfg().slots, source, target, after);
    save();
    renderSlots();
}

function renderSlots() {
    const list = document.getElementById('enh_sa_slots');
    list.replaceChildren();
    cfg().slots.forEach((slot, index) => {
        const card = element('details', 'enh_sa_slot');
        card.dataset.slot = slot.id;
        const summary = element('summary', '', `${index + 1}. ${slot.name || 'Unnamed agent'}${slot.enabled ? '' : ' (disabled)'}`);
        summary.draggable = true;
        summary.title = 'Drag to change agent priority';
        summary.addEventListener('dragstart', event => {
            draggedSlot = slot.id;
            event.dataTransfer.setData('text/plain', slot.id);
            event.dataTransfer.effectAllowed = 'move';
        });
        summary.addEventListener('dragend', () => { draggedSlot = null; list.querySelectorAll('.enh_sa_drop').forEach(n => n.classList.remove('enh_sa_drop')); });
        card.addEventListener('dragover', event => {
            if (!draggedSlot || draggedSlot === slot.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            card.classList.add('enh_sa_drop');
        });
        card.addEventListener('dragleave', () => card.classList.remove('enh_sa_drop'));
        card.addEventListener('drop', event => {
            if (!draggedSlot) return;
            event.preventDefault();
            const after = event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
            moveSlot(draggedSlot, slot.id, after);
            draggedSlot = null;
        });
        card.append(summary);
        const priority = element('div', 'enh_sa_actions');
        const up = button('Move up', () => moveSlot(slot.id, cfg().slots[index - 1]?.id));
        const down = button('Move down', () => moveSlot(slot.id, cfg().slots[index + 1]?.id, true));
        up.disabled = index === 0;
        down.disabled = index === cfg().slots.length - 1;
        priority.append(up, down);
        card.append(priority);
        // Find by ID on each edit: normalization replaces the settings object.
        const update = (key, value) => {
            const current = cfg().slots.find(s => s.id === slot.id);
            if (current) current[key] = value;
            save();
            card.querySelector('summary').textContent = `${index + 1}. ${current?.name || 'Unnamed agent'}${current?.enabled ? '' : ' (disabled)'}`;
        };
        checkbox(card, 'Select this agent by default', slot.enabled, v => update('enabled', v));
        checkbox(card, 'Isolated agent (ignore earlier agents\' notes)', slot.isolated, v => update('isolated', v));
        card.append(element('p', 'enh_sa_hint', 'Isolation keeps preset, lore and chat context. This agent\'s finished notes still go to the writer and to later agents that allow shared notes.'));
        field(card, 'Name', slot.name, v => update('name', v));
        field(card, 'Activity shown while working', slot.activity, v => update('activity', v));
        field(card, 'Specialist prompt (SillyTavern macros supported)', slot.prompt, v => update('prompt', v), { type: 'textarea' });
        field(card, 'Model on the current API connection', slot.model, v => update('model', v), { placeholder: 'Blank = current chat model' });
        const row = element('div', 'enh_sa_grid');
        field(row, 'Output tokens', slot.maxTokens, v => update('maxTokens', v), { type: 'number', min: 100, max: 4000, step: 100 });
        field(row, 'Temperature', slot.temperature, v => update('temperature', v), { type: 'number', min: 0, max: 2, step: 0.1 });
        card.append(row, button('Remove agent', () => {
            cfg().slots = cfg().slots.filter(s => s.id !== slot.id);
            save();
            renderSlots();
        }));
        list.append(card);
    });
    document.getElementById('enh_sa_add').disabled = cfg().slots.length >= MAX_AGENTS;
}

function renderSettings(contentContainer) {
    const root = element('section', 'enh_sa_settings');
    root.append(element('hr'), element('h4', '', 'Multi-agent story writer'));
    checkbox(root, 'Enable story agents', cfg().enabled, value => {
        cfg().enabled = value;
        save();
        if (!value) { pendingSelection = null; cancelRun(); choosing?.cancel(); }
    });
    checkbox(root, 'Choose agents before each response', cfg().askEveryTime, value => { cfg().askEveryTime = value; save(); });
    checkbox(root, 'Stream agent responses', cfg().streamAgents, value => { cfg().streamAgents = value; save(); });
    root.append(element('p', 'enh_sa_hint', 'Agents run in slot order. Each sees completed notes from earlier agents while working only on its own task. Drag a slot heading to change priority, or use Move up / Move down. Streaming shows notes as they arrive.'));
    root.append(element('p', 'enh_sa_hint', 'Each selected agent makes one extra API request using the current connection. Blank models use the chat model. The final writer uses your normal chat settings.'));
    root.append(element('p', 'enh_sa_hint', 'Agents inherit the assembled preset and activated lorebook messages with their roles, order and depth placements, plus the current prompt post-processing.'));
    const row = element('div', 'enh_sa_grid');
    for (const [key, label, min, max] of [['timeoutSeconds', 'Timeout per attempt (seconds)', 15, 600], ['maxNoteChars', 'Max note characters per agent', 200, 8000], ['maxRetries', 'Retries per agent', 0, 5], ['retryDelaySeconds', 'Retry delay (seconds)', 1, 30]]) {
        field(row, label, cfg()[key], value => { cfg()[key] = value; save(); }, { type: 'number', min, max, step: 1 });
    }
    root.append(row);
    root.append(element('p', 'enh_sa_hint', 'Retries restart a failed request, up to the selected count, with increasing delay. They can add API charges. Skip cancels one agent; Cancel response stops the whole chain.'));
    const exclusions = element('details', 'enh_sa_slot');
    exclusions.append(element('summary', '', 'Preset prompts ignored by agents'));
    exclusions.append(element('p', 'enh_sa_hint', 'Check prompts to omit from every specialist request. Selections are saved separately for each preset. The final writer keeps the full preset. Lorebook, character and chat markers remain included.'));
    const presetName = element('b');
    presetName.id = 'enh_sa_preset_name';
    const presetList = element('div');
    presetList.id = 'enh_sa_preset_prompts';
    exclusions.append(presetName, presetList, button('Refresh preset prompts', renderPresetExclusions), button('Include all preset prompts', () => {
        cfg().ignoredPresetPrompts[presetKey(oai_settings)] = [];
        save();
        renderPresetExclusions();
    }));
    exclusions.addEventListener('toggle', () => { if (exclusions.open) renderPresetExclusions(); });
    root.append(exclusions);
    const post = element('details', 'enh_sa_slot');
    post.append(element('summary', '', 'Final post instructions for every agent'));
    post.append(element('p', 'enh_sa_hint', 'Appended after all preset messages and the specialist task. Controls agent notes; the final story writer has its own instructions below.'));
    const postRole = element('label', 'enh_sa_field');
    postRole.append(element('span', '', 'Agent post instruction role'));
    const roleSelect = element('select', 'text_pole');
    for (const role of ['system', 'user']) {
        const option = element('option', '', role === 'system' ? 'System' : 'User');
        option.value = role;
        roleSelect.append(option);
    }
    roleSelect.value = cfg().agentPostRole;
    roleSelect.addEventListener('change', () => { cfg().agentPostRole = roleSelect.value; save(); });
    postRole.append(roleSelect);
    post.append(postRole);
    const postInput = field(post, 'Final agent post instructions', cfg().agentPostInstructions,
        value => { cfg().agentPostInstructions = value; save(); }, { type: 'textarea' });
    post.append(element('p', 'enh_sa_hint', 'Supports SillyTavern macros plus {{agent_name}}, {{agent_max_tokens}} and {{agent_note_chars}}. A blank prompt disables the extra post instructions.'));
    post.append(button('Restore default agent post instructions', () => {
        cfg().agentPostInstructions = AGENT_POST_INSTRUCTIONS;
        postInput.value = AGENT_POST_INSTRUCTIONS;
        save();
    }));
    root.append(post);
    const writer = element('details', 'enh_sa_slot');
    writer.append(element('summary', '', 'Final writer instructions'));
    field(writer, 'How the writer should use the notes', cfg().writerPrompt, value => { cfg().writerPrompt = value; save(); }, { type: 'textarea' });
    field(writer, 'Retries for final writer request', cfg().writerMaxRetries, value => { cfg().writerMaxRetries = value; save(); }, { type: 'number', min: 0, max: 5, step: 1 });
    writer.append(element('p', 'enh_sa_hint', 'Automatically retries HTTP 402, temporary API failures and accepted requests that return no story yet. Keeps finished agent notes and uses the configured retry delay. Set to 0 to disable automatic retries. Failed writer requests always offer Retry writer or Cancel.'));
    root.append(writer);
    const list = element('div');
    list.id = 'enh_sa_slots';
    root.append(list);
    const actions = element('div', 'enh_sa_actions');
    const add = button('Add agent slot', () => {
        if (cfg().slots.length >= MAX_AGENTS) return;
        const slot = makeSlot(cfg().slots.length);
        slot.id = `agent-${crypto.randomUUID()}`;
        slot.enabled = true;
        cfg().slots.push(slot);
        save();
        renderSlots();
    });
    add.id = 'enh_sa_add';
    actions.append(add, button('Show latest agent notes', () => {
        if (lastRun) { document.getElementById('enh_sa_progress').hidden = false; renderProgress(lastRun); }
        else globalThis.toastr?.info('Send a message with story agents to see their notes here.');
    }));
    root.append(actions);
    contentContainer.append(root);
    renderSlots();
    renderPresetExclusions();
}

async function selectAgents() {
    if (choosing) return choosing.promise;
    const config = normalizeSettings(cfg());
    if (!config.askEveryTime) return config.slots.filter(s => s.enabled && s.prompt.trim());
    const dialog = element('dialog', 'enh_sa_picker');
    dialog.setAttribute('aria-label', 'Choose story agents');
    dialog.append(element('h3', '', 'Who should help write this response?'),
        element('p', 'enh_sa_hint', 'Selected agents prepare notes, then your usual model writes the story.'));
    const checks = [];
    for (const slot of config.slots) {
        const row = element('div', 'enh_sa_choice');
        const input = checkbox(row, slot.name || 'Unnamed agent', slot.enabled && !!slot.prompt.trim(), () => {});
        input.disabled = !slot.prompt.trim();
        row.append(element('small', 'enh_sa_hint', slot.prompt.trim() ? `${checks.length + 1}. ${slot.activity}` : 'Add a prompt in Enhancements settings to use this slot.'));
        checks.push({ input, slot });
        dialog.append(row);
    }
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    const close = value => {
        if (choosing?.dialog !== dialog) return;
        choosing = null;
        dialog.close();
        dialog.remove();
        finish(value);
    };
    const actions = element('div', 'enh_sa_actions');
    actions.append(button('Run selected agents', () => close(checks.filter(c => c.input.checked && !c.input.disabled).map(c => c.slot))),
        button('Send without agents', () => close([])), button('Cancel', () => close(null)));
    dialog.append(actions);
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(null); });
    choosing = { dialog, promise, cancel: () => close(null) };
    document.body.append(dialog);
    dialog.showModal();
    return promise;
}

async function chooseAndSend() {
    if (preparingSend || choosing || isGenerating() || activeRun) return;
    preparingSend = true;
    try {
        const chat = context()?.chat;
        const chatId = chatIdentity();
        const draft = document.getElementById('send_textarea')?.value;
        const slots = await selectAgents();
        if (slots === null || chat !== context()?.chat || chatId !== chatIdentity()) return;
        // Keep cancellation safe even if another UI/script changed the draft.
        if (draft !== document.getElementById('send_textarea')?.value || isGenerating()) return;
        pendingSelection = { chat, chatId, slots };
        try { await sendTextareaMessage(); }
        catch (error) { if (error?.name !== 'AbortError') globalThis.toastr?.error(errorMessage(error), 'Story agents'); }
        finally { pendingSelection = null; }
    } finally { preparingSend = false; }
}

function interceptSend(event) {
    if (!cfg().enabled || context()?.mainApi !== 'openai') return;
    let send = event.type === 'click' && event.target.closest?.('#send_but');
    if (event.type === 'keydown') {
        send = event.target.id === 'send_textarea' && event.key === 'Enter' && !event.isComposing
            && !event.shiftKey && !event.altKey && !event.metaKey && context()?.shouldSendOnEnter?.();
    }
    if (!send) return;
    // Leave slash commands to SillyTavern; their generated requests use the
    // fallback picker at the API boundary if they produce a story response.
    if (document.getElementById('send_textarea')?.value.trimStart().startsWith('/')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void chooseAndSend();
}

function mountProgress() {
    const panel = element('aside', 'enh_sa_progress');
    panel.id = 'enh_sa_progress';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Story agent progress');
    const header = element('div', 'enh_sa_actions');
    header.append(element('b', '', 'Story agents'), button('Minimize', () => panel.classList.toggle('enh_sa_minimized')),
        button('Close', () => { panel.hidden = true; }));
    const status = element('div');
    status.id = 'enh_sa_status';
    status.setAttribute('role', 'status');
    const rows = element('div', 'enh_sa_results');
    rows.id = 'enh_sa_results';
    const cancel = button('Cancel response', () => cancelRun());
    cancel.id = 'enh_sa_cancel';
    panel.append(header, status, rows, cancel);
    document.body.append(panel);
}

function renderProgress(run) {
    lastRun = run;
    const rows = document.getElementById('enh_sa_results');
    document.getElementById('enh_sa_status').textContent = run.message;
    document.getElementById('enh_sa_cancel').hidden = !['agents', 'writer', 'review'].includes(run.phase);
    for (const result of run.results) {
        let card = Array.from(rows.children).find(node => node.dataset.agent === result.slot.id);
        if (!card) {
            card = element('details', 'enh_sa_result');
            card.dataset.agent = result.slot.id;
            const heading = element('summary');
            const skip = button('Skip', event => {
                event.preventDefault();
                event.stopPropagation();
                if (!result.controller || !['queued', 'working', 'retrying'].includes(result.status)) return;
                result.controller.abort(abortError('Agent skipped'));
                result.status = 'skipped';
                result.notes = '';
                result.error = 'Skipped by you.';
                renderProgress(run);
            });
            heading.append(element('span', 'enh_sa_agent_status'), skip);
            const contextView = element('details', 'enh_sa_context');
            contextView.append(element('summary', '', 'View context'));
            card.contextText = element('pre', 'enh_sa_notes');
            contextView.append(card.contextText);
            card.append(heading, element('pre', 'enh_sa_notes'), contextView);
            rows.append(card);
        }
        const elapsed = result.started ? ` (${Math.floor(((result.finished || Date.now()) - result.started) / 1000)}s)` : '';
        const remaining = result.retryAt ? Math.max(0, Math.ceil((result.retryAt - Date.now()) / 1000)) : 0;
        const status = { queued: 'Queued', working: result.slot.activity || 'Preparing notes', retrying: `Retrying in ${remaining}s`, done: 'Finished', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }[result.status];
        card.querySelector('span').textContent = `${result.slot.name} — ${status}${result.attempt > 1 ? ` · attempt ${result.attempt}` : ''}${elapsed}`;
        card.querySelector('pre').textContent = result.error || result.notes || 'Waiting for finished notes…';
        card.contextText.textContent = result.context || 'Context will appear when this agent starts.';
        card.querySelector('button').hidden = !['queued', 'working', 'retrying'].includes(result.status) || run.phase !== 'agents';
        if (result.status === 'failed' && card.dataset.status !== 'failed') card.open = true;
        card.dataset.status = result.status;
    }
}

function cancelRun() {
    const run = activeRun;
    if (!run) return;
    run.controller.abort(abortError());
    run.decision?.(null);
    run.phase = 'cancelled';
    run.message = 'Response cancelled.';
    renderProgress(run);
    clearInterval(clockTimer);
    stopGeneration();
    if (run.responseReturned && activeRun === run) activeRun = null;
}

async function fitWriterContext(messages, notes, maxTokens, signal) {
    // Keep the preset's depth and position placements exact. Offer skipping
    // notes instead of silently shifting injected prompts by dropping turns.
    const budget = Number(oai_settings.openai_max_context) - Number(maxTokens || oai_settings.openai_max_tokens) - 256;
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('Set a valid context size in your chat completion settings.');
    const candidate = addWriterNotes(messages, notes);
    signal.throwIfAborted();
    const count = await countTokensOpenAIAsync(candidate, true);
    if (!Number.isFinite(count)) throw new Error('Could not count the final writer context.');
    if (count > budget) throw new Error('Agent notes exceed the available context. Reduce note length or increase the chat context size. Preset messages have been kept in place.');
    return candidate;
}

async function executeAgent(slot, request, config, signal, connectionSettings, onNotes, previousResults, agentBase, onContext = () => {}) {
    const settings = structuredClone(connectionSettings);
    settings.openai_max_tokens = slot.maxTokens;
    settings.temp_openai = slot.temperature;
    settings.stream_openai = config.streamAgents;
    settings.show_thoughts = false;
    settings.enable_web_search = false;
    settings.request_images = false;
    const model = slot.model.trim() || request.model || getChatCompletionModel(settings);
    const budget = Number(settings.openai_max_context) - slot.maxTokens - 256;
    let agentMessages;
    try {
        agentMessages = buildAgentMessages(agentBase, slot, substituteParams, config, previousResults);
        signal.throwIfAborted();
        const count = await countTokensOpenAIAsync(agentMessages, true);
        // Keep only prompt fields for inspection. Never store credentials,
        // headers, URLs or arbitrary custom request parameters in the view.
        onContext(`Model: ${model}\nInput tokens: ${count} / ${budget}\nBase context: ${agentBase.length} messages\nPreset post-processing: ${request.custom_prompt_post_processing || 'none'}\n\nThese are the exact messages supplied to the request before provider post-processing and transport conversion. Those steps may merge messages or convert unsupported roles.\n\n${agentMessages.map((m, i) => `Message ${i + 1} | ${m.role}${m.name ? ` | ${m.name}` : ''}\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}`).join('\n\n')}`);
        if (!Number.isFinite(count)) throw new Error('Could not count the agent context.');
        if (count > budget) throw new Error('Not enough context for this agent. Reduce output tokens or increase the chat context size. Preset messages have been kept in place.');
    } catch (error) { error.retryable = false; throw error; }
    let modelParameters = null;
    if (model !== request.model) {
        settings.function_calling = false;
        ({ generate_data: modelParameters } = await createGenerationParameters(settings, model, 'quiet', structuredClone(agentMessages)));
    }
    const generate_data = buildAgentRequest(request, agentMessages, slot, modelParameters, config.streamAgents);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
    const response = await previousFetch(ROUTE, {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(generate_data),
        signal: requestSignal,
        [AGENT_REQUEST]: true,
    });
    requestSignal.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw await apiResponseError(response, 'Agent');
    return readAgentResponse(response, requestSignal, onNotes, config.streamAgents);
}

async function reviewFailure(run, message, allowNotes = true) {
    run.phase = 'review';
    run.message = message;
    renderProgress(run);
    const actions = element('div', 'enh_sa_actions');
    document.getElementById('enh_sa_progress').hidden = false;
    document.getElementById('enh_sa_progress').classList.remove('enh_sa_minimized');
    return new Promise(resolve => {
        const decide = value => { actions.remove(); run.decision = null; resolve(value); };
        run.decision = decide;
        actions.append(button('Write with finished notes', () => decide('notes')),
            button('Write without agents', () => decide('skip')), button('Cancel', () => { decide(null); cancelRun(); }));
        if (!allowNotes || !run.results.some(r => r.status === 'done')) actions.firstChild.disabled = true;
        document.getElementById('enh_sa_progress').append(actions);
        if (run.controller.signal.aborted) decide(null);
    });
}

async function reviewWriterFailure(run, error) {
    run.phase = 'review';
    run.message = `${errorMessage(error)} Finished agent notes are kept. Retry the writer or cancel the response.`;
    renderProgress(run);
    const panel = document.getElementById('enh_sa_progress');
    panel.hidden = false;
    panel.classList.remove('enh_sa_minimized');
    const actions = element('div', 'enh_sa_actions');
    actions.id = 'enh_sa_writer_recovery';
    return new Promise(resolve => {
        let settled = false;
        const decide = value => {
            if (settled) return;
            settled = true;
            actions.remove();
            run.decision = null;
            resolve(value);
        };
        run.decision = decide;
        actions.append(button('Retry writer', () => decide('retry')),
            button('Cancel', () => { decide(null); cancelRun(); }));
        panel.append(actions);
        if (run.signal.aborted) decide(null);
    });
}

async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (init?.[AGENT_REQUEST] || !url.includes(ROUTE) || typeof init?.body !== 'string') return previousFetch(input, init);
    let body;
    try { body = JSON.parse(init.body); } catch { return previousFetch(input, init); }
    const sourceMessages = body.messages;
    if (Array.isArray(body.messages)) {
        body.messages = cleanPresetMetadata(body.messages);
        init = { ...init, body: JSON.stringify(body) };
    }
    if (!cfg()?.enabled) return previousFetch(input, init);
    if (!SUPPORTED_TYPES.has(body.type) || !Array.isArray(body.messages) || body.json_schema) return previousFetch(input, init);
    if (activeRun) throw new Error('A story response is already in progress.');
    let selection = pendingSelection;
    pendingSelection = null;
    if (selection && !sameChat(selection)) throw abortError('Chat changed before generation.');
    if (!selection) {
        selection = { chat: context()?.chat, chatId: chatIdentity(), slots: null };
        selection.slots = await selectAgents();
        if (!sameChat(selection)) throw abortError('Chat changed before generation.');
    }
    init.signal?.throwIfAborted();
    if (selection.slots === null) throw abortError();
    if (!selection.slots.length) return previousFetch(input, init);
    const config = normalizeSettings(cfg());
    const connectionSettings = structuredClone(oai_settings);
    const run = { phase: 'agents', message: 'Preparing specialist notes…', results: [], controller: new AbortController() };
    activeRun = run;
    const signal = init.signal ? AbortSignal.any([init.signal, run.controller.signal]) : run.controller.signal;
    run.signal = signal;
    signal.addEventListener('abort', () => run.decision?.(null), { once: true });
    document.getElementById('enh_sa_results').replaceChildren();
    document.getElementById('enh_sa_progress').hidden = false;
    renderProgress(run);
    clearInterval(clockTimer);
    clockTimer = setInterval(() => renderProgress(run), 1000);
    try {
        let agentBase;
        let baseError;
        try {
            assertChatContext(sourceMessages, selection.chat);
            agentBase = excludePresetPrompts(sourceMessages, config.ignoredPresetPrompts[presetKey(connectionSettings)] ?? []);
        }
        catch (error) { error.retryable = false; baseError = error; }
        run.results = await runAgents(selection.slots, {
            signal, maxRetries: config.maxRetries, retryDelayMs: config.retryDelaySeconds * 1000,
            execute: (slot, onNotes, previous, agentSignal) => {
                if (baseError) throw baseError;
                return executeAgent(slot, body, config, agentSignal, connectionSettings, onNotes, previous, agentBase, value => {
                    const result = run.results.find(r => r.slot.id === slot.id);
                    if (result) result.context = value;
                    renderProgress(run);
                });
            },
            onUpdate: (result, results) => {
                if (result?.status === 'working') result.started ??= Date.now();
                else if (result && ['done', 'failed', 'skipped', 'cancelled'].includes(result.status)) result.finished ??= Date.now();
                run.results = results;
                renderProgress(run);
            },
        });
        signal.throwIfAborted();
        let decision = 'notes';
        if (run.results.some(r => r.status === 'failed')) decision = await reviewFailure(run, 'Some agents failed. Choose how to continue.');
        signal.throwIfAborted();
        if (decision === null) throw abortError();
        let notes = decision === 'notes' ? compileNotes(run.results, config) : '';
        if (notes) {
            try { body.messages = await fitWriterContext(body.messages, notes, body.max_tokens ?? body.max_completion_tokens, signal); }
            catch (error) {
                signal.throwIfAborted();
                const choice = await reviewFailure(run, errorMessage(error), false);
                signal.throwIfAborted();
                if (choice !== 'skip') throw abortError();
                notes = '';
            }
        }
        run.phase = 'writer';
        run.message = notes && decision === 'notes' ? 'Notes finished. Writing the story response…' : 'Writing the story response without agent notes…';
        renderProgress(run);
        const writerMessage = run.message;
        let response;
        while (!response) {
            run.phase = 'writer';
            try {
                response = await fetchWriterWithRetries(previousFetch, input, { ...init, body: JSON.stringify(body) }, {
                    signal, maxRetries: config.writerMaxRetries, retryDelayMs: config.retryDelaySeconds * 1000, generationType: body.type,
                    onAttempt: attempt => {
                        run.message = attempt === 1 ? writerMessage : `Writing the story response, attempt ${attempt} of ${config.writerMaxRetries + 1}…`;
                        renderProgress(run);
                    },
                    onRetry: (error, attempt, delay) => {
                        run.message = `${errorMessage(error)} Retrying writer in ${Math.ceil(delay / 1000)}s (attempt ${attempt} of ${config.writerMaxRetries + 1}).`;
                        renderProgress(run);
                    },
                });
            } catch (error) {
                signal.throwIfAborted();
                if (error?.name === 'AbortError') throw error;
                const choice = await reviewWriterFailure(run, error);
                signal.throwIfAborted();
                if (choice !== 'retry') throw abortError();
            }
        }
        signal.throwIfAborted();
        run.responseReturned = true;
        return response;
    } catch (error) {
        run.phase = signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
        run.message = run.phase === 'cancelled' ? 'Response cancelled.' : errorMessage(error);
        renderProgress(run);
        if (activeRun === run) activeRun = null;
        clearInterval(clockTimer);
        throw error;
    }
}

function injectStyles() {
    const style = element('style');
    style.textContent = `
        .enh_sa_field { display:flex; flex-direction:column; gap:4px; margin:8px 0; }
        .enh_sa_field textarea { min-height:110px; resize:vertical; }
        .enh_sa_hint { font-size:.85em; opacity:.75; }
        .enh_sa_grid { display:flex; flex-wrap:wrap; gap:12px; }
        .enh_sa_grid > label { flex:1; min-width:120px; }
        .enh_sa_actions { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin:8px 0; }
        .enh_sa_actions b { margin-right:auto; }
        .enh_sa_actions button { margin:0; }
        .enh_sa_slot, .enh_sa_result { border:1px solid var(--SmartThemeBorderColor,#777); border-radius:8px; padding:10px; margin:8px 0; }
        .enh_sa_slot summary, .enh_sa_result summary { cursor:pointer; overflow-wrap:anywhere; }
        .enh_sa_slot summary[draggable] { cursor:grab; }
        .enh_sa_slot.enh_sa_drop { outline:2px solid var(--SmartThemeBodyColor,#eee); }
        .enh_sa_picker { box-sizing:border-box; width:min(540px,94vw); max-height:85vh; overflow:auto; padding:20px; border-radius:12px; background:var(--SmartThemeBlurTintColor,#242424); color:var(--SmartThemeBodyColor,#eee); border:1px solid var(--SmartThemeBorderColor,#777); }
        .enh_sa_picker::backdrop { background:rgba(0,0,0,.55); }
        .enh_sa_choice { display:flex; flex-direction:column; gap:3px; padding:8px 0; }
        .enh_sa_progress { box-sizing:border-box; position:fixed; bottom:90px; right:16px; width:min(430px,calc(100vw - 32px)); max-height:calc(100dvh - 110px); overflow:auto; padding:12px; border:1px solid var(--SmartThemeBorderColor,#777); border-radius:12px; background:var(--SmartThemeBlurTintColor,#242424); backdrop-filter:blur(20px); color:var(--SmartThemeBodyColor,#eee); z-index:10000; box-shadow:0 8px 30px #0006; }
        .enh_sa_progress[hidden] { display:none; }
        .enh_sa_results { max-height:45vh; overflow:auto; }
        .enh_sa_notes { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:.85em; margin-bottom:0; }
        .enh_sa_minimized .enh_sa_results { display:none; }
        .enh_sa_result[data-status="done"] { border-color:#739879; }
        .enh_sa_result[data-status="failed"] { border-color:#c07869; }
        .enh_sa_result summary { display:flex; align-items:center; gap:8px; }
        .enh_sa_agent_status { flex:1 1 0; min-width:0; }
        #enh_sa_progress button { width:auto; min-width:max-content; white-space:nowrap; word-break:normal; overflow-wrap:normal; flex-shrink:0; }
        #enh_sa_progress .enh_sa_result summary button { flex:0 0 auto; width:auto; min-width:3.5em; height:auto; white-space:nowrap; word-break:normal; overflow-wrap:normal; font-size:.8em; margin:0; padding:4px 8px; }
    `;
    document.head.append(style);
}

export function init(contentContainer) {
    ensureDefaults();
    const hookManager = installPresetTracking({ getManager: () => promptManager, Message, ChatCompletion, enabled: () => cfg()?.enabled === true });
    injectStyles();
    renderSettings(contentContainer);
    mountProgress();
    previousFetch = window.fetch;
    window.fetch = interceptedFetch;
    document.addEventListener('click', interceptSend, true);
    document.addEventListener('keydown', interceptSend, true);
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        choosing?.cancel();
        pendingSelection = null;
        const run = activeRun;
        if (!run) return;
        run.controller.abort(abortError());
        run.decision?.(null);
        run.phase = 'cancelled';
        run.message = 'Response cancelled.';
        clearInterval(clockTimer);
        renderProgress(run);
        if (run.responseReturned && activeRun === run) activeRun = null;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        const run = activeRun;
        if (!run || run.phase !== 'writer') return;
        run.phase = run.signal.aborted ? 'cancelled' : 'done';
        run.message = run.signal.aborted ? 'Response cancelled.' : 'Story response finished. Expand an agent to read its notes.';
        renderProgress(run);
        clearInterval(clockTimer);
        activeRun = null;
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        hookManager();
        renderPresetExclusions();
        pendingSelection = null;
        choosing?.cancel();
        cancelRun();
        document.getElementById('enh_sa_progress').hidden = true;
    });
    if (event_types.OAI_PRESET_CHANGED_AFTER) eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => { hookManager(); renderPresetExclusions(); });
    if (event_types.GENERATE_BEFORE_COMBINE_PROMPTS) eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, hookManager);
}
