'use strict';
/**
 * Unify runs this after installing the Imaging pack (and after it installed ImageMagick and oxipng). It downloads
 * the two tools that have no package-manager install on Windows into <pack>/data/bin, where the pack looks first:
 *   - pngquant (Windows only; macOS gets it from Homebrew)  -> data/bin/pngquant/pngquant.exe
 *   - Real-ESRGAN ncnn-vulkan (Windows, macOS, Linux)       -> data/bin/realesrgan/realesrgan-ncnn-vulkan[.exe]
 * Tools already there are skipped, so running it again is quick and safe.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;
const binDir = path.join(packDir, 'data', 'bin');
const exe = name => (process.platform === 'win32' ? `${name}.exe` : name);

const REALESRGAN_BASE = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424';
const REALESRGAN_ZIP = { win32: `${REALESRGAN_BASE}-windows.zip`, darwin: `${REALESRGAN_BASE}-macos.zip`, linux: `${REALESRGAN_BASE}-ubuntu.zip` };

const TOOLS = [
	{ folder: 'pngquant', program: exe('pngquant'), url: process.platform === 'win32' ? 'https://pngquant.org/pngquant-windows.zip' : undefined, label: 'pngquant' },
	{ folder: 'realesrgan', program: exe('realesrgan-ncnn-vulkan'), url: REALESRGAN_ZIP[process.platform], label: 'Real-ESRGAN', size: ' (about 45 MB)' },
];

async function download(url, file) {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
	fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** Windows 10+ and macOS ship bsdtar, which reads zip files; Linux uses unzip or Python's zipfile. */
function unzip(zip, destination) {
	const attempts = process.platform === 'linux'
		? [['unzip', ['-q', '-o', zip, '-d', destination]], ['python3', ['-m', 'zipfile', '-e', zip, destination]]]
		: [[process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', zip, '-C', destination]]];
	for (const [file, args] of attempts) {
		const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
		if (!result.error && result.status === 0) return;
	}
	throw new Error(`Could not unzip ${zip}. On Linux, install unzip (sudo apt install unzip) and run setup again.`);
}

/** The folder inside `root` that holds `program` (zips put it at the top or one folder down). */
function findProgramDir(root, program) {
	const queue = [root];
	while (queue.length) {
		const dir = queue.shift();
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		if (entries.some(entry => entry.isFile() && entry.name === program)) return dir;
		for (const entry of entries) if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
	}
	return undefined;
}

async function install(tool) {
	const target = path.join(binDir, tool.folder);
	if (fs.existsSync(path.join(target, tool.program))) {
		console.log(`${tool.label} is already installed.`);
		return;
	}
	console.log(`Downloading ${tool.label}${tool.size || ''}...`);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), `unify-imaging-${tool.folder}-`));
	try {
		const zip = path.join(work, 'download.zip');
		await download(tool.url, zip);
		const extracted = path.join(work, 'files');
		fs.mkdirSync(extracted);
		unzip(zip, extracted);
		const found = findProgramDir(extracted, tool.program);
		if (!found) throw new Error(`${tool.program} was not in the ${tool.label} download.`);
		fs.rmSync(target, { recursive: true, force: true });
		fs.cpSync(found, target, { recursive: true });
		if (process.platform !== 'win32') fs.chmodSync(path.join(target, tool.program), 0o755);
		console.log(`Installed ${tool.label} in ${target}.`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

async function main() {
	fs.mkdirSync(binDir, { recursive: true });
	const failures = [];
	for (const tool of TOOLS) {
		if (!tool.url) continue;
		try {
			await install(tool);
		} catch (error) {
			failures.push(`${tool.label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length) throw new Error(`${failures.join('\n')}\nCheck your internet connection and choose Run setup again.`);
	console.log('The image tools are ready.');
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
