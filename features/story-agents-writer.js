export const WRITER_GENERATION_TYPE = Symbol.for('enhancements.storyWriterGenerationType');

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

function responseError(status, message, retryAfter) {
    const error = new Error(`Writer API request failed (${status}): ${message}`);
    error.retryable = status >= 200 && status < 300 || [402, 408, 425, 429].includes(status) || status >= 500;
    error.retryAfter = retryAfter;
    return error;
}

async function providerError(response) {
    if (!response.body) return response.statusText || 'The provider did not return a successful response.';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
        while (text.length < 4096) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
        text = (text + decoder.decode()).slice(0, 4096).trim();
    } catch { /* Keep the HTTP status if the error body cannot be read. */ }
    finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    try {
        const data = JSON.parse(text);
        const message = data.error?.message || data.error?.detail || data.message || data.detail || data.error;
        if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
    } catch { /* Plain-text errors are common for proxy rejections. */ }
    if (text && !text.startsWith('<')) return text.slice(0, 500);
    // Gateways often return HTML rather than the provider's JSON error.
    // Keep a short title/heading so an unavailable Kaggle tunnel can be
    // distinguished from a provider rejection without showing an HTML page.
    if (text.startsWith('<')) {
        const heading = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
            || text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
        if (heading) return heading.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    return response.statusText || 'The provider did not return a successful response.';
}

function delayFromHeader(response) {
    const header = response.headers.get('retry-after');
    if (!header) return 0;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 60000)) : 0;
}

/** Share bounded error-body parsing and Retry-After handling with specialists. */
export async function apiResponseError(response, label = 'Writer') {
    const error = responseError(response.status, await providerError(response), delayFromHeader(response));
    error.message = error.message.replace(/^Writer API/, `${label} API`);
    error.status = response.status;
    return error;
}

async function validateResponse(response) {
    const status = response.status;
    const retryAfter = delayFromHeader(response);
    // Some wrappers report a stale .ok flag. HTTP status is authoritative.
    if (status < 200 || status >= 300) {
        throw await apiResponseError(response);
    }
    const type = response.headers.get('content-type') || '';
    if (/text\/event-stream/i.test(type)) {
        if (!response.body) throw responseError(status, 'The provider returned no stream.', retryAfter);
        return response; // Hand off live streaming without buffering the story.
    }
    if (status === 204 || !response.body) throw responseError(status, 'The provider returned no story response.', retryAfter);
    // Inspect JSON once and reconstruct it. No tee is left waiting or buffering.
    if (/application\/json/i.test(type) || status === 202) {
        let text;
        try { text = await response.text(); }
        catch (error) { throw error; }
        let data;
        try { data = JSON.parse(text); }
        catch { throw responseError(status, status === 202 ? 'The request was accepted, but no story response was returned yet.' : 'The provider returned invalid JSON.', retryAfter); }
        if (data?.error) throw responseError(status, typeof data.error === 'string' ? data.error : data.error.message || data.message || 'The provider returned an error.', retryAfter);
        const output = data?.choices?.some(c => c.message || typeof c.text === 'string')
            || Array.isArray(data?.content) && data.content.length > 0
            || data?.candidates?.length > 0 || data?.output?.length > 0
            || typeof data?.text === 'string' || data?.message?.content !== undefined;
        if (!output) throw responseError(status, status === 202 ? 'The request was accepted, but no story response was returned yet.' : 'The provider returned no story response.', retryAfter);
        return new Response(text, { status, statusText: response.statusText, headers: response.headers });
    }
    return response;
}

/** Retry only the writer, retaining completed notes and the exact request. */
export async function fetchWriterWithRetries(fetch, input, init, { maxRetries, retryDelayMs, generationType, signal, onAttempt = () => {}, onRetry = () => {} }) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        signal.throwIfAborted();
        onAttempt(attempt + 1);
        try {
            const response = await fetch(input, { ...init, signal, [WRITER_GENERATION_TYPE]: generationType });
            signal.throwIfAborted();
            const checked = await validateResponse(response);
            signal.throwIfAborted();
            return checked;
        } catch (error) {
            signal.throwIfAborted();
            if (attempt >= maxRetries || error?.retryable === false || error?.name === 'AbortError') throw error;
            const delay = Math.max(error.retryAfter || 0, Math.min(retryDelayMs * 2 ** attempt, 60000));
            onRetry(error, attempt + 2, delay);
            await wait(delay, signal);
        }
    }
}
