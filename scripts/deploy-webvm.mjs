import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

const DEFAULT_WORKER_NAME = 'iris-webvm';
const DEFAULT_DOMAIN = 'webvm.iris.to';
const DEFAULT_COMPATIBILITY_DATE = '2026-03-19';
const DEFAULT_WRANGLER_VERSION = '4';

function takeFlagValue(args, flag) {
	const value = args.shift();
	if (!value) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function parseArgs(argv) {
	const options = {
		workerName: process.env.CF_WORKER_NAME_WEBVM || DEFAULT_WORKER_NAME,
		domain: process.env.CF_WORKER_DOMAIN_WEBVM || DEFAULT_DOMAIN,
		route: process.env.CF_WORKER_ROUTE_WEBVM || '',
		compatibilityDate: process.env.CF_WORKER_COMPATIBILITY_DATE || DEFAULT_COMPATIBILITY_DATE,
		wranglerVersion: process.env.WRANGLER_VERSION || DEFAULT_WRANGLER_VERSION,
		dryRun: false,
	};

	const args = [...argv];
	while (args.length > 0) {
		const arg = args.shift();
		if (arg === '--name') {
			options.workerName = takeFlagValue(args, arg);
			continue;
		}
		if (arg === '--route') {
			options.route = takeFlagValue(args, arg);
			continue;
		}
		if (arg === '--domain') {
			options.domain = takeFlagValue(args, arg);
			continue;
		}
		if (arg === '--compatibility-date') {
			options.compatibilityDate = takeFlagValue(args, arg);
			continue;
		}
		if (arg === '--wrangler-version') {
			options.wranglerVersion = takeFlagValue(args, arg);
			continue;
		}
		if (arg === '--dry-run') {
			options.dryRun = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function configFor(options) {
	return {
		name: options.workerName,
		compatibility_date: options.compatibilityDate,
		main: 'scripts/webvm-worker.mjs',
		assets: {
			directory: 'build',
			binding: 'ASSETS',
			run_worker_first: true,
		},
	};
}

function run(command, args, cwd) {
	console.log(`$ ${[command, ...args].join(' ')}`);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
		});
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (signal) {
				reject(new Error(`command interrupted by ${signal}`));
				return;
			}
			resolve(code ?? 1);
		});
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const config = configFor(options);
	const configPath = path.join(appDir, `.wrangler-webvm-${process.pid}-${Date.now()}.json`);
	const deployCommand = [
		`wrangler@${options.wranglerVersion}`,
		'deploy',
		'--config',
		configPath,
		'--keep-vars',
	];
	if (options.route) {
		deployCommand.push('--route', options.route);
	}
	if (options.domain) {
		deployCommand.push('--domain', options.domain);
	}

	if (options.dryRun) {
		console.log('Install frozen dependencies: npm ci');
		console.log('Gate WebVM release: npm run test:release');
		console.log(`Deploy WebVM Worker: npx ${deployCommand.join(' ')}`);
		console.log(JSON.stringify(config, null, 2));
		return;
	}

	try {
		const installStatus = await run('npm', ['ci'], appDir);
		if (installStatus !== 0) {
			process.exitCode = installStatus;
			return;
		}

		const gateStatus = await run('npm', ['run', 'test:release'], appDir);
		if (gateStatus !== 0) {
			process.exitCode = gateStatus;
			return;
		}

		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
		const deployStatus = await run('npx', deployCommand, appDir);
		if (deployStatus !== 0) {
			process.exitCode = deployStatus;
		}
	} finally {
		await rm(configPath, { force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
