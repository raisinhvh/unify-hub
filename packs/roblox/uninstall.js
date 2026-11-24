'use strict';
/**
 * Unify runs this when the Roblox pack is removed, before it deletes the pack folder (data/opencloud.json goes
 * with it). It removes the Unify Bridge plugin that install.js copied into Roblox Studio's Plugins folder.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_FILE = 'UnifyBridge.server.lua';

function pluginsFolder() {
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		return path.join(localAppData, 'Roblox', 'Plugins');
	}
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
	return undefined;
}

function main() {
	const plugins = pluginsFolder();
	const file = plugins && path.join(plugins, PLUGIN_FILE);
	if (!file || !fs.existsSync(file)) {
		console.log('The Studio plugin was not installed; nothing to remove.');
		return;
	}
	fs.rmSync(file, { force: true });
	console.log(`Removed ${PLUGIN_FILE} from ${plugins}. Restart Roblox Studio to unload it.`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
