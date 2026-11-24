'use strict';
/**
 * Unify runs this when the Figma pack is removed, before it deletes the pack folder (the plugin files in data/
 * go with it). Figma has no API for development plugins, so the imported DSH Bridge entry has to be removed in
 * Figma itself; this only says how.
 */
console.log('Also remove DSH Bridge in Figma: Plugins > Development > Manage plugins in development, then Remove.');
