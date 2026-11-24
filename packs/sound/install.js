'use strict';
/**
 * Unify runs this after installing the Sound pack (and after it installed Python and ffmpeg). It builds the pack's
 * own Python environment (the "core" tier: numpy, scipy, soundfile, pedalboard, pyloudnorm, matplotlib) in
 * <pack>/data/venv, exactly as sound_setup {"tier":"core"} would, and creates <pack>/data/config.json with empty
 * keys so the user knows where a Freesound or Hugging Face key goes. Running it again is safe.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;
const dataDir = path.join(packDir, 'data');
const venvDir = path.join(dataDir, 'venv');
const venvPython = process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
// Keep in step with CORE_PACKAGES / PIP_FLAGS in the pack.
const CORE_PACKAGES = ['numpy<2', 'scipy', 'soundfile', 'pedalboard', 'pyloudnorm', 'matplotlib'];
const PIP_FLAGS = ['--disable-pip-version-check', '--progress-bar', 'off'];
const CONFIG_KEYS = ['freesoundToken', 'hfToken', 'robloxApiKey', 'outputDir'];

function run(file, args, label) {
	console.log(label);
	const result = spawnSync(file, args, {
		cwd: dataDir,
		encoding: 'utf8',
		windowsHide: true,
		env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_NO_INPUT: '1' },
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
	if (result.status !== 0) {
		const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
		throw new Error(`${label} failed (exit ${result.status}):\n${tail}`);
	}
	return result.stdout || '';
}

/** Python 3.10 to 3.12; a Python winget just installed is not on PATH yet, so its install folders come first. */
function findPython() {
	const candidates = [];
	if (process.env.DSH_SOUND_PYTHON) candidates.push([process.env.DSH_SOUND_PYTHON]);
	if (process.platform === 'win32') {
		for (const version of ['312', '311', '310']) {
			for (const base of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'), process.env.ProgramFiles]) {
				if (base) candidates.push([path.join(base, `Python${version}`, 'python.exe')]);
			}
		}
		for (const version of ['3.12', '3.11', '3.10']) candidates.push(['py', `-${version}`]);
	} else {
		for (const version of ['3.12', '3.11', '3.10']) {
			for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) candidates.push([path.join(prefix, `python${version}`)]);
		}
	}
	candidates.push(['python'], ['python3']);
	for (const [file, ...args] of candidates) {
		if (path.isAbsolute(file) && !fs.existsSync(file)) continue;
		const probe = spawnSync(file, [...args, '-c', "import sys;print('%d.%d'%sys.version_info[:2])"], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
		const version = (probe.stdout || '').trim();
		if (probe.status === 0 && /^3\.1[0-2]$/.test(version)) return { file, args, version };
	}
	return undefined;
}

function importsWork() {
	const probe = spawnSync(venvPython, ['-c', 'import numpy, scipy, soundfile, pedalboard, pyloudnorm, matplotlib'], { cwd: dataDir, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
	return probe.status === 0;
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** config.json with every key present (empty when unset), so a key can be pasted straight into it. */
function writeConfigTemplate() {
	const file = path.join(dataDir, 'config.json');
	const stored = readJson(file);
	const config = {};
	for (const key of CONFIG_KEYS) config[key] = typeof stored[key] === 'string' ? stored[key] : '';
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
	return file;
}

function main() {
	fs.mkdirSync(dataDir, { recursive: true });
	const configFile = writeConfigTemplate();
	const tiersFile = path.join(dataDir, 'tiers.json');
	const tiers = readJson(tiersFile);
	if (!fs.existsSync(venvPython)) {
		const python = findPython();
		if (!python) throw new Error('Python 3.10-3.12 was not found. Install Python 3.12 from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then choose Run setup again.');
		run(python.file, [...python.args, '-m', 'venv', venvDir], `Creating the sound environment with Python ${python.version}...`);
	}
	run(venvPython, ['-m', 'pip', 'install', ...PIP_FLAGS, '--upgrade', 'pip'], 'Updating pip...');
	run(venvPython, ['-m', 'pip', 'install', ...PIP_FLAGS, ...CORE_PACKAGES], 'Installing the sound libraries (a few minutes the first time)...');
	// An install that was cut off part-way can leave a library pip thinks is installed but that will not import.
	if (!importsWork()) {
		run(venvPython, ['-m', 'pip', 'install', ...PIP_FLAGS, '--force-reinstall', '--no-cache-dir', ...CORE_PACKAGES], 'Repairing the sound libraries...');
		if (!importsWork()) throw new Error('The sound libraries installed but will not load. Uninstall the Sound pack and install it again.');
	}
	tiers.core = { installed: new Date().toISOString() };
	fs.writeFileSync(tiersFile, JSON.stringify(tiers, null, 2), 'utf8');
	console.log(`Keys go in ${configFile}.`);
	console.log('The sound tools are ready.');
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
