/** Track preset fragments during ST assembly, before it groups injections. */
export const PRESET_META = '__enhancementsPreset';
const SOURCE = Symbol('preset fragments');
const PROTECTED = new Set(['chatHistory', 'dialogueExamples', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription']);
function fingerprint(content) {
    const text = JSON.stringify(content) ?? 'undefined';
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${hash >>> 0}`;
}

export function presetPrompts(manager) {
    const definitions = manager?.serviceSettings?.prompts ?? [];
    const order = manager?.getPromptOrderForCharacter(manager.activeCharacter) ?? [];
    return order.map(entry => ({ ...definitions.find(p => p.identifier === entry.identifier), enabled: entry.enabled }))
        .filter(p => p.identifier && !p.marker && !PROTECTED.has(p.identifier));
}

export function presetKey(settings) { return String(settings.preset_settings_openai || 'Current preset'); }

export function cleanPresetMetadata(messages) {
    return structuredClone(messages).map(message => { delete message[PRESET_META]; return message; });
}

export function excludePresetPrompts(messages, ignored) {
    if (!ignored.length) return cleanPresetMetadata(messages);
    if (!messages.every(m => m[PRESET_META]?.version === 1)) {
        throw new Error('Preset prompt identities are unavailable for this request. Send a new chat response, or clear the agent preset exclusions.');
    }
    const excluded = new Set(ignored);
    return messages.flatMap(message => {
        const copy = structuredClone(message);
        delete copy[PRESET_META];
        const ranges = message[PRESET_META].ranges.filter(r => excluded.has(r.id));
        if (!ranges.length) return [copy];
        if (message[PRESET_META].fingerprint !== fingerprint(copy.content)) throw new Error('Another extension changed a selected preset message after assembly. Clear agent preset exclusions for this request.');
        if (typeof copy.content !== 'string') throw new Error('Cannot exclude a preset prompt from a media message.');
        let end = 0;
        let content = '';
        for (const range of ranges.sort((a, b) => a.start - b.start)) {
            content += copy.content.slice(end, range.start);
            end = Math.max(end, range.end);
        }
        content += copy.content.slice(end);
        // Join separators can remain after a removed fragment. Preserve all
        // remaining text verbatim; discard only a wholly empty message.
        if (!content.trim() && !copy.tool_calls) return [];
        copy.content = content;
        return [copy];
    });
}

export function installPresetTracking({ getManager, Message, ChatCompletion, enabled }) {
    const nonce = crypto.randomUUID();
    const prefix = `\uE000enh-sa-${nonce}:`;
    const suffix = '\uE001';
    const tracked = new Map();
    let next = 0;
    function unwrap(value) {
        if (typeof value !== 'string') return { content: value, ranges: [] };
        let content = '';
        let cursor = 0;
        const ranges = [];
        while (true) {
            const start = value.indexOf(prefix, cursor);
            if (start < 0) break;
            const stop = value.indexOf(suffix, start);
            if (stop < 0) break;
            const token = value.slice(start + prefix.length, stop);
            const record = tracked.get(token);
            if (!record) break;
            const closing = `${prefix}/${token}${suffix}`;
            const closingAt = value.indexOf(closing, stop + suffix.length);
            if (closingAt < 0) break;
            content += value.slice(cursor, start);
            const fragment = value.slice(stop + suffix.length, closingAt);
            ranges.push({ id: record, start: content.length, end: content.length + fragment.length });
            content += fragment;
            cursor = closingAt + closing.length;
        }
        content += value.slice(cursor);
        return { content, ranges };
    }
    let hookedManager;
    function hookManager() {
        const manager = getManager();
        if (!manager || manager === hookedManager) return;
        hookedManager = manager;
        const prepare = manager.preparePrompt;
        manager.preparePrompt = function (prompt, original = null) {
            const candidate = enabled() && presetPrompts(this).some(p => p.identifier === prompt.identifier);
            if (candidate) {
                // A character override may contain {{original}}. Strip the
                // earlier wrapper, then attribute the final override as a unit.
                prompt = { ...prompt, content: unwrap(prompt.content).content };
                original = unwrap(original).content;
            }
            const prepared = prepare.call(this, prompt, original);
            if (candidate && typeof prepared.content === 'string' && prepared.content.trim()) {
                const token = String(next++);
                tracked.set(token, prepared.identifier);
                if (tracked.size > 10000) tracked.delete(tracked.keys().next().value);
                // Wrap only non-whitespace characters so ST's .trim() behaves
                // exactly as it did before instrumentation.
                prepared.content = prepared.content.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_m, left, text, right) =>
                    `${left}${prefix}${token}${suffix}${text}${prefix}/${token}${suffix}${right}`);
            }
            return prepared;
        };
    }
    const create = Message.createAsync;
    Message.createAsync = async function (role, content, ...args) {
        const parsed = unwrap(content);
        // Tokens are always counted from the original, untagged content.
        const message = await create.call(this, role, parsed.content, ...args);
        message[SOURCE] = parsed.ranges;
        return message;
    };
    const squash = ChatCompletion.prototype.squashSystemMessages;
    ChatCompletion.prototype.squashSystemMessages = async function (...args) {
        const exclude = new Set(['newMainChat', 'newChat', 'groupNudge']);
        const flattened = this.messages.flatten();
        const combined = [];
        const squashable = m => !exclude.has(m.identifier) && m.role === 'system' && !m.name;
        for (const m of flattened) {
            if (m.role === 'system' && !m.content) continue;
            const last = combined.at(-1);
            if (last && squashable(last.message) && squashable(m)) {
                const offset = last.length + 1;
                last.ranges.push(...(m[SOURCE] ?? []).map(r => ({ ...r, start: r.start + offset, end: r.end + offset })));
                last.length += 1 + m.content.length;
            } else combined.push({ message: m, length: m.content?.length || 0, ranges: [...(m[SOURCE] ?? [])] });
        }
        await squash.apply(this, args);
        for (const item of combined) item.message[SOURCE] = item.ranges;
    };
    const getChat = ChatCompletion.prototype.getChat;
    ChatCompletion.prototype.getChat = function (...args) {
        const chat = getChat.apply(this, args);
        if (!enabled()) return chat;
        const flat = this.messages.flatten().filter(m => m.content || m.tool_calls);
        if (flat.length !== chat.length) return chat;
        chat.forEach((m, i) => { m[PRESET_META] = { version: 1, fingerprint: fingerprint(m.content), ranges: flat[i][SOURCE] ?? [] }; });
        return chat;
    };
    hookManager();
    // Called on preset/chat changes too; handles a manager initialized later.
    return hookManager;
}
