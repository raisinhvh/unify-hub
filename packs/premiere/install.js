'use strict';
/**
 * Unify runs this after installing the Premiere pack. It installs the bundled DSH Bridge CEP panel into the
 * user's Adobe extensions folder and turns on PlayerDebugMode so the unsigned panel can load, using the pack's
 * own premiere_install_panel tool.
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
