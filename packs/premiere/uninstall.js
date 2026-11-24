'use strict';
/**
 * Unify runs this when the Premiere pack is removed, before it deletes the pack folder. It removes the Unify Bridge
 * CEP panel from the user's Adobe extensions folder and puts PlayerDebugMode back to what it was before the pack
 * was installed (install.js saved it in data/debug-mode-before.json). Without that record (packs installed before
 * it existed) PlayerDebugMode is left as it is, since other unsigned panels may need it.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;
const EXTENSION_ID = 'com.unify.premiere.bridge';

function extensionFolder() {
	if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions', EXTENSION_ID);
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', EXTENSION_ID);
	return undefined;
}

/** Removes the panel folder, but only when its manifest says it is ours. */
function removePanel() {
	const folder = extensionFolder();
	if (!folder || !fs.existsSync(folder)) return 'The Premiere panel was not installed.';
	const manifest = path.join(folder, 'CSXS', 'manifest.xml');
	let text = '';
	try { text = fs.readFileSync(manifest, 'utf8'); } catch { /* checked below */ }
	if (!text.includes(`ExtensionBundleId="${EXTENSION_ID}"`)) return `Left ${folder} in place: it is not the Unify Bridge panel.`;
	fs.rmSync(folder, { recursive: true, force: true });
	return `Removed the Unify Bridge panel from ${folder}.`;
}

function run(file, args) {
	const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(file)} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function restoreDebugMode() {
	let saved;
	try {
		saved = JSON.parse(fs.readFileSync(path.join(packDir, 'data', 'debug-mode-before.json'), 'utf8'));
	} catch {
		return 'PlayerDebugMode was left as it is (no record of its value before the pack).';
	}
	const version = /^\d+$/.test(String(saved.csxs)) ? String(saved.csxs) : '11';
	const value = typeof saved.value === 'string' ? saved.value : null;
	if (process.platform === 'win32') {
		const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
		const key = `HKCU\\Software\\Adobe\\CSXS.${version}`;
		if (value === null) {
			const query = spawnSync(reg, ['query', key, '/v', 'PlayerDebugMode'], { windowsHide: true });
			if (query.status === 0) run(reg, ['delete', key, '/v', 'PlayerDebugMode', '/f']);
		} else run(reg, ['add', key, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', value, '/f']);
	} else if (process.platform === 'darwin') {
		const domain = `com.adobe.CSXS.${version}`;
		if (value === null) spawnSync('/usr/bin/defaults', ['delete', domain, 'PlayerDebugMode']);
		else run('/usr/bin/defaults', ['write', domain, 'PlayerDebugMode', '-string', value]);
	}
	return value === null ? 'Turned PlayerDebugMode back off.' : `Put PlayerDebugMode back to ${value}.`;
}

try {
	console.log(`${removePanel()} ${restoreDebugMode()}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
