'use strict';
/**
 * Unify runs this after installing the Premiere pack. It installs the bundled Unify Bridge CEP panel into the
 * user's Adobe extensions folder and turns on PlayerDebugMode so the unsigned panel can load, using the pack's
 * own premiere_install_panel tool.
 *
 * Before the first install it saves the PlayerDebugMode value that was there before (data/debug-mode-before.json),
 * so uninstall.js can put it back instead of turning off a setting other unsigned panels may rely on.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;
const dataDir = path.join(packDir, 'data');
// The CEP runtime install_panel enables by default (Premiere 2023); keep in step with the pack.
const CSXS_VERSION = '11';

async function runPackTool(name, args) {
	const loaded = require(path.join(packDir, 'pack.js'));
	const pack = loaded.default || loaded;
	const tool = (pack.tools || []).find(candidate => candidate.name === name);
	if (!tool) throw new Error(`This version of the pack has no ${name} tool.`);
	const context = {
		log: message => console.log(message),
		status() {},
		dataDir,
	};
	return tool.run.call(tool, args, context);
}

/** The current PlayerDebugMode value, or null when it is not set. */
function readDebugMode() {
	if (process.platform === 'win32') {
		const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
		const result = spawnSync(reg, ['query', `HKCU\\Software\\Adobe\\CSXS.${CSXS_VERSION}`, '/v', 'PlayerDebugMode'], { encoding: 'utf8', windowsHide: true });
		if (result.status !== 0) return null;
		const match = /PlayerDebugMode\s+REG_\w+\s+(.*)/.exec(result.stdout || '');
		return match ? match[1].trim() : null;
	}
	if (process.platform === 'darwin') {
		const result = spawnSync('/usr/bin/defaults', ['read', `com.adobe.CSXS.${CSXS_VERSION}`, 'PlayerDebugMode'], { encoding: 'utf8' });
		return result.status === 0 ? (result.stdout || '').trim() : null;
	}
	return null;
}

/** Saved once: a rerun or reinstall (which keeps data/) must not record the value this pack set itself. */
function saveDebugModeBefore() {
	const file = path.join(dataDir, 'debug-mode-before.json');
	if (fs.existsSync(file)) return;
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ csxs: CSXS_VERSION, value: readDebugMode() }, null, 2)}\n`, 'utf8');
}

async function main() {
	saveDebugModeBefore();
	const result = await runPackTool('install_panel', {});
	console.log(String(result).split('. ')[0] + '.');
}

main().then(
	() => process.exit(0),
	error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
