import { extractNotes, textContent } from './story-agents-core.js';

/** Consume the SSE formats returned by ST and the custom endpoint adapters. */
export async function readAgentResponse(response, signal, onNotes = () => {}, stream = true) {
    const type = response.headers.get('content-type') || '';
    if (!stream || /application\/json/i.test(type)) return extractNotes(await response.json());
    if (!response.body) throw new Error('The agent returned no response body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    let complete = false;
    let terminal = false;
    let published = '';
    const publish = () => {
        const notes = extractNotes({ text: raw });
        if (notes !== published) { published = notes; onNotes(notes); }
    };
    function event(block) {
        const lines = block.split('\n');
        const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data.trim() === '[DONE]') { complete = true; terminal = true; return; }
        let value;
        try { value = JSON.parse(data); } catch { throw new Error('The agent returned a malformed streaming event.'); }
        if (value.error || value.type === 'error') throw new Error(value.error?.message || value.message || 'Agent streaming API error');
        const choice = value.choices?.find(c => !c.index) ?? value.choices?.[0];
        if (choice) {
            raw += textContent(choice.delta?.content ?? choice.text);
            if (choice.finish_reason) complete = true;
            if (choice.message?.content) raw = textContent(choice.message.content);
        } else if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta') raw += value.delta.text || '';
        else if (value.type === 'response.output_text.delta') raw += value.delta || '';
        else if (value.candidates?.[0]) {
            raw += textContent(value.candidates[0].content?.parts);
            if (value.candidates[0].finishReason) complete = true;
        } else if (value.type === 'content-delta') raw += value.delta?.message?.content?.text || '';
        else if (value.event_type === 'text-generation') raw += value.text || '';
        if (['message_stop', 'response.completed', 'message-end'].includes(value.type) || value.event_type === 'stream-end') { complete = true; terminal = true; }
        if (value.type === 'response.failed' || value.type === 'response.incomplete') throw new Error('Agent stream did not complete.');
        if (raw.length > 512000) throw new Error('Agent streaming output exceeded the supported note size.');
    }
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            // Normalize CRLF only after both bytes have arrived.
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                event(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
            }
            publish();
            if (terminal) { await reader.cancel(); break; }
            if (done) break;
            if (buffer.length > 1024000) throw new Error('Agent returned an oversized streaming event.');
        }
        if (buffer.trim()) event(buffer);
        publish();
        if (!complete) throw new Error('Agent stream ended before completion. Partial notes will not be passed to the writer.');
        return published;
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}
