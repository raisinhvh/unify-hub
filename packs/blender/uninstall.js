'use strict';
/**
 * Unify runs this when the Blender pack is removed, before it deletes the pack folder. It removes the Unify Bridge
 * add-on (unify_bridge.py and its compiled cache) from every Blender version's user add-ons folder, where
 * blender_install_addon put it.
 *
 * Blender's saved preferences may still list the add-on as enabled; Blender skips a missing add-on at startup and
 * drops it from the list the next time preferences are saved, so nothing is left running.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADDON = 'unify_bridge';

/** Blender's per-user config root, holding one folder per version ("4.2", "3.6", ...). */
function configRoot() {
	if (process.platform === 'win32') {
		return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Blender Foundation', 'Blender');
	}
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Blender');
	return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'blender');
}

/** Every user add-ons folder: one per installed Blender version, plus BLENDER_USER_SCRIPTS when it is set. */
function addonFolders() {
	const folders = [];
	const root = configRoot();
	if (fs.existsSync(root)) {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory() && /^\d+\.\d+$/.test(entry.name)) folders.push(path.join(root, entry.name, 'scripts', 'addons'));
		}
	}
	if (process.env.BLENDER_USER_SCRIPTS) folders.push(path.join(process.env.BLENDER_USER_SCRIPTS, 'addons'));
	return folders;
}

/** Deletes unify_bridge.py and __pycache__/unify_bridge.*.pyc in one add-ons folder; returns whether the add-on was there. */
function removeFrom(folder) {
	const file = path.join(folder, `${ADDON}.py`);
	const found = fs.existsSync(file);
	fs.rmSync(file, { force: true });
	const cache = path.join(folder, '__pycache__');
	if (fs.existsSync(cache)) {
		for (const name of fs.readdirSync(cache)) {
			if (name.startsWith(`${ADDON}.`) && name.endsWith('.pyc')) fs.rmSync(path.join(cache, name), { force: true });
		}
	}
	return found;
}

function main() {
	const removed = addonFolders().filter(removeFrom);
	if (!removed.length) {
		console.log('The Unify Bridge add-on was not installed in any Blender; nothing to remove.');
		return;
	}
	console.log(`Removed the Unify Bridge add-on from ${removed.join(', ')}. Restart Blender to unload it.`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
