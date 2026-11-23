'use strict';
/**
 * Unify runs this after installing the Figma pack. It writes the bundled DSH Bridge development plugin into the
 * pack's data folder, using the pack's own figma_install_plugin tool. Importing the plugin into Figma is a manual
 * step: Figma has no API for adding development plugins, so setup.json walks the user through it.
 */
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;

async function runPackTool(name, args) {
	const loaded = require(path.join(packDir, 'pack.js'));
	const pack = loaded.default || loaded;
	const tool = (pack.tools || []).find(candidate => candidate.name === name);
	if (!tool) throw new Error(`This version of the pack has no ${name} tool.`);
	const context = {
		log: message => console.log(message),
		status() {},
		dataDir: path.join(packDir, 'data'),
	};
	return tool.run.call(tool, args, context);
}

async function main() {
	await runPackTool('install_plugin', {});
	console.log(`Wrote the DSH Bridge plugin to ${path.join(packDir, 'data', 'plugin')}.`);
}

main().then(
	() => process.exit(0),
	error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
