'use strict';
/**
 * Unify runs this after installing the Roblox pack. It copies the DSH Bridge plugin (DSHBridge.server.lua, shipped
 * next to this script) into Roblox Studio's local Plugins folder, replacing an older copy.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;
const PLUGIN_FILE = 'DSHBridge.server.lua';

function robloxFolder() {
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		return path.join(localAppData, 'Roblox');
	}
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Documents', 'Roblox');
	return undefined;
}

function main() {
	const source = path.join(packDir, PLUGIN_FILE);
	if (!fs.existsSync(source)) throw new Error(`${PLUGIN_FILE} is missing from the pack. Reinstall the pack from the Hub.`);
	const roblox = robloxFolder();
	if (!roblox) throw new Error('Roblox Studio only runs on Windows and macOS.');
	if (!fs.existsSync(roblox)) throw new Error(`Roblox Studio was not found (no ${roblox} folder). Install Studio, open it once, then run setup again.`);
	const plugins = path.join(roblox, 'Plugins');
	fs.mkdirSync(plugins, { recursive: true });
	fs.copyFileSync(source, path.join(plugins, PLUGIN_FILE));
	console.log(`Copied ${PLUGIN_FILE} to ${plugins}.`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
