/**
 * SillyTavern Enhancements Extension — Base Script
 *
 * Lightweight orchestrator that:
 *  1. Mounts the shared settings drawer shell
 *  2. Ensures the shared extension_settings bucket exists
 *  3. Dynamically loads every feature module from ./features/
 *
 * To add a new feature:
 *  - Create a file in ./features/  (e.g. features/my-feature.js)
 *  - Export an  init(contentContainer)  function from it
 *  - Add an entry to the FEATURES array below
 */

import { extension_settings } from '../../../extensions.js';

const SETTINGS_KEY = 'enhancements';

// ---------------------------------------------------------------------------
// Register features here — path is relative to this file
// ---------------------------------------------------------------------------

const FEATURES = [
    { name: 'AvatarVision', path: './features/avatar-vision.js' },
    // { name: 'NextFeature', path: './features/next-feature.js' },
];

// ---------------------------------------------------------------------------
// Settings drawer shell (features append their own controls inside)
// ---------------------------------------------------------------------------

const drawerHtml = `
<div id="enhancements_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <div class="flex-container alignitemscenter margin0">
                <b>Enhancements</b>
            </div>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="enhancements_drawer_content">
        </div>
    </div>
</div>`;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

jQuery(async () => {
    // Ensure shared settings bucket
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = {};
    }

    // Mount the drawer shell
    const container = $('<div id="enhancements_container" class="extension_container"></div>');
    container.append(drawerHtml);
    $('#extensions_settings2').append(container);

    const contentContainer = $('#enhancements_drawer_content');

    // Dynamically load and init every registered feature
    let loaded = 0;
    for (const feature of FEATURES) {
        try {
            const module = await import(feature.path);
            module.init(contentContainer);
            loaded++;
            console.log(`[Enhancements] Feature "${feature.name}" loaded`);
        } catch (err) {
            console.error(`[Enhancements] Failed to load feature "${feature.name}" from ${feature.path}:`, err);
        }
    }

    console.log(`[Enhancements] Extension loaded (${loaded}/${FEATURES.length} features)`);
});
