/**
 * SillyTavern Enhancements Extension — Base Script
 *
 * Lightweight orchestrator that:
 *  1. Mounts the shared settings drawer shell
 *  2. Ensures the shared extension_settings bucket exists
 *  3. Loads every feature module from ./features/
 *
 * To add a new feature:
 *  - Create a file in ./features/  (e.g. features/my-feature.js)
 *  - Export an  init(contentContainer)  function from it
 *  - Import and register it in the FEATURES array below
 */

import { extension_settings } from '../../../extensions.js';
import { init as avatarVisionInit } from './features/avatar-vision.js';

const SETTINGS_KEY = 'enhancements';

// ---------------------------------------------------------------------------
// Register features here — each entry is { name, init }
// ---------------------------------------------------------------------------

const FEATURES = [
    { name: 'AvatarVision', init: avatarVisionInit },
    // { name: 'NextFeature', init: nextFeatureInit },
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

    // Init every registered feature
    for (const feature of FEATURES) {
        try {
            feature.init(contentContainer);
        } catch (err) {
            console.error(`[Enhancements] Failed to init feature "${feature.name}":`, err);
        }
    }

    console.log(`[Enhancements] Extension loaded (${FEATURES.length} feature(s))`);
});
