/**
 * Loads a browser-only feature module under Node for testing.
 *
 * The feature files import SillyTavern internals ('../../../../extensions.js')
 * and touch `window` / `jQuery` at module scope, neither of which exists here.
 * We rewrite the imports to point at local stubs, write the result to a temp
 * file, and import that. Nothing in the extension itself is modified.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} featureFile file name inside ../features/
 * @param {object} settings initial contents of extension_settings.enhancements
 * @param {object} hooks { fetch, toastr }
 */
export async function loadFeature(featureFile, settings = {}, hooks = {}) {
    const state = {
        settings,
        calls: [],
        warnings: [],
        upstream: async () => new Response('{}'),
        /** Fire what SillyTavern's GENERATION_STARTED would deliver. */
        emitGenerationStarted: (type) => {
            for (const fn of listeners.generation_started) fn(type);
        },
    };
    const listeners = { generation_started: [] };

    globalThis.window = globalThis;
    globalThis.window.fetch = async (input, init) => {
        if (init?.body) {
            try { state.calls.push(JSON.parse(init.body)); } catch { state.calls.push(init.body); }
        }
        return state.upstream(input, init);
    };
    globalThis.toastr = { warning: (m) => state.warnings.push(String(m)), info: () => {}, error: () => {} };
    globalThis.__TEST_SETTINGS = { enhancements: settings };
    globalThis.__TEST_EVENTS = {
        on: (event, fn) => { (listeners[event] ??= []).push(fn); },
    };

    const src = readFileSync(join(HERE, '..', 'features', featureFile), 'utf8')
        .replace(/^import \{ extension_settings \}.*$/m, 'const extension_settings = globalThis.__TEST_SETTINGS;')
        .replace(/^import \{ saveSettingsDebounced \}.*$/m, 'const saveSettingsDebounced = () => {};')
        .replace(/^import \{ eventSource, event_types \}.*$/m,
            'const eventSource = globalThis.__TEST_EVENTS;'
            + ' const event_types = { GENERATION_STARTED: \'generation_started\' };')
        + '\nexport const __internals = { prepareRequest, prepareStructuredPrefill, interceptedFetch,'
        + ' createUnwrapStreamTransform, ensureDefaults, needsBuffering, responseShape, isWrapperScaffold,'
        + ' isFenceOnly, tryUnwrapStructuredOutput, validateOutput, stripHidePrefill, buildPrefillStripper,'
        + ' buildEnforcementValidator, isTruncated, extractContentFromJson };\n';

    const dir = mkdtempSync(join(tmpdir(), 'st-ext-test-'));
    const file = join(dir, featureFile.replace(/\.js$/, '.mjs'));
    writeFileSync(file, src);
    const mod = await import(pathToFileURL(file).href);
    return { sp: mod.__internals, state, ...hooks };
}

