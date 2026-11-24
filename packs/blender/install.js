'use strict';
/**
 * Unify runs this after installing the Blender pack. It installs and enables the Unify Bridge add-on with a
 * headless Blender run, using the pack's own blender_install_addon tool. That tool runs as a background job, so
 * this script polls blender_job_status until the job finishes.
 *
 * When no Blender is found the add-on file is still saved, and setup.json shows how to install it by hand.
 */
const path = require('node:path');

const packDir = process.env.UNIFY_PACK_DIR || __dirname;
const JOB_PATTERN = /as job (\S+?)\./;
const MAX_POLLS = 4;

function loadPack() {
	const loaded = require(path.join(packDir, 'pack.js'));
	return loaded.default || loaded;
}

async function runPackTool(pack, name, args) {
	const tool = (pack.tools || []).find(candidate => candidate.name === name);
	if (!tool) throw new Error(`This version of the pack has no ${name} tool.`);
	const context = {
		log: message => console.log(message),
		status() {},
		dataDir: path.join(packDir, 'data'),
	};
	return String(await tool.run.call(tool, args, context));
}

async function main() {
	const pack = loadPack();
	let result = await runPackTool(pack, 'install_addon', {});
	for (let poll = 0; poll < MAX_POLLS; poll++) {
		const job = JOB_PATTERN.exec(result);
		if (!job) break;
		result = await runPackTool(pack, 'job_status', { jobId: job[1], waitSeconds: 40 });
	}
	console.log(result);
	if (/no Blender executable was found|still running|failed/i.test(result)) process.exitCode = 1;
}

main().then(
	() => process.exit(process.exitCode || 0),
	error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
