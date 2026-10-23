import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifact = resolve(root, process.argv[2] ?? `.artifacts/frankfmy-typed-document-runtime-${manifest.version}.tgz`);
assert.ok(existsSync(artifact), "Build and pack the library first");
const verification = join(root, ".verification");
mkdirSync(verification, { recursive: true });
const attempt = mkdtempSync(join(verification, "consumer-"));
const report = { status: "running", artifact, artifact_sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"), commands: [], consumers: [] };
let sequence = 0;

function disk_guard() {
	const disk = statfsSync(root);
	const free = disk.bavail * disk.bsize;
	console.log(JSON.stringify({ disk_free_bytes: free, at: new Date().toISOString() }));
	assert.ok(free >= 10 * 1024 ** 3, "Heavy allocation stopped: less than 10 GiB free");
}
function command(cwd, executable, args, expected = 0) {
	const started = Date.now();
	const result = spawnSync(executable, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const log = join(attempt, `${++sequence}-${executable.split(sep).at(-1)}.log`);
	const record = { cwd, executable, args, exit: result.status, signal: result.signal, seconds: (Date.now() - started) / 1000, log };
	writeFileSync(log, JSON.stringify(record) + "\nSTDOUT\n" + result.stdout + "\nSTDERR\n" + result.stderr);
	report.commands.push(record);
	console.log("CONSUMER_COMMAND " + JSON.stringify(record));
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.error) throw result.error;
	assert.equal(result.signal, null);
	if (expected === "failure") assert.notEqual(result.status, 0, "negative check unexpectedly succeeded");
	else assert.equal(result.status, expected, `Command failed; full output: ${log}`);
	return result.stdout + result.stderr;
}
function within(base, path) {
	const rel = relative(base, realpathSync(path));
	assert.ok(rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep), `Dependency escaped consumer: ${path}`);
}
async function browser_check(consumer, expected) {
	const modules = new Set();
	await build({
		root: consumer, configFile: false,
		build: { target: "es2023", outDir: "browser-dist", sourcemap: true },
		plugins: [{ name: "record-package-modules", moduleParsed(info) { modules.add(info.id); } }],
	});
	const installed = join(consumer, "node_modules", manifest.name);
	for (const entry of Object.values(manifest.exports)) assert.ok(modules.has(join(installed, entry.import)), `Browser omitted ${entry.import}`);
	let server, browser;
	const errors = [];
	try {
		server = await preview({ root: consumer, configFile: false, build: { outDir: "browser-dist" }, preview: { host: "127.0.0.1", port: 0, open: false } });
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
		page.on("requestfailed", (request) => errors.push(request.url() + ": " + request.failure()?.errorText));
		const address = server.httpServer.address();
		assert.ok(address && typeof address === "object");
		const response = await page.goto(`http://127.0.0.1:${address.port}/`);
		assert.equal(response?.status(), 200);
		await page.waitForFunction(() => document.body.dataset.status !== undefined, null, { timeout: 15000 });
		assert.equal(await page.getAttribute("body", "data-status"), "pass", await page.textContent("body"));
		const result = JSON.parse(await page.textContent("body"));
		assert.deepEqual(result, expected);
		assert.deepEqual(errors, []);
		await page.screenshot({ path: join(consumer, "browser.png") });
		const details = { ...result, browser: browser.version(), executable: chromium.executablePath(), bundled_subpaths: Object.keys(manifest.exports), errors };
		console.log("BROWSER_PASS " + JSON.stringify(details));
		return details;
	} finally {
		try { if (browser) await browser.close(); }
		finally {
			if (server) await new Promise((accept, reject) => server.httpServer.close((error) => error ? reject(error) : accept()));
			console.log("BROWSER_CLEANUP_COMPLETE " + consumer);
		}
	}
}

try {
	const quickstart = readFileSync(join(root, "examples/quickstart.mjs"), "utf8").trim();
	const readme = readFileSync(join(root, "README.md"), "utf8");
	const snippet = readme.match(/<!-- quickstart:start -->\s*```js\n([\s\S]*?)\n```\s*<!-- quickstart:end -->/);
	assert.equal(snippet?.[1], quickstart, "README quickstart must match the executable example exactly");
	for (const installer of ["npm", "bun"]) {
		disk_guard();
		const consumer = join(attempt, installer);
		mkdirSync(consumer);
		writeFileSync(join(consumer, "package.json"), JSON.stringify({
			name: `typed-document-consumer-${installer}`, version: "0.0.0", private: true, type: "module",
			dependencies: { [manifest.name]: `file:${artifact}` },
			devDependencies: { typescript: manifest.devDependencies.typescript, "@types/node": "24.10.1" },
		}, null, 2));
		for (const name of ["scenario.ts", "run.ts", "protocol.ts", "types.ts", "browser.ts"]) copyFileSync(join(root, "tests/consumer", name), join(consumer, name));
		writeFileSync(join(consumer, "quickstart.mjs"), snippet[1] + "\n");
		writeFileSync(join(consumer, "index.html"), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Runtime consumer</title><link rel="icon" href="data:,"></head><body><script type="module" src="/browser.ts"></script></body></html>\n');
		const options = { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2023", "DOM"], types: ["node"], strict: true, skipLibCheck: false, noEmitOnError: true, verbatimModuleSyntax: true, outDir: "emitted" };
		writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: options, files: ["run.ts", "scenario.ts", "protocol.ts", "types.ts"] }));
		writeFileSync(join(consumer, "tsconfig.browser.json"), JSON.stringify({ compilerOptions: { ...options, module: "ESNext", moduleResolution: "Bundler", types: [], noEmit: true }, files: ["browser.ts", "types.ts"] }));
		if (installer === "npm") command(consumer, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(verification, "npm-cache")]);
		else command(consumer, "bun", ["install", "--ignore-scripts"]);
		const installed = join(consumer, "node_modules", manifest.name);
		within(consumer, installed);
		within(consumer, join(consumer, "node_modules/zod"));
		assert.equal(readFileSync(join(installed, "package.json"), "utf8"), readFileSync(join(root, "package.json"), "utf8"));
		assert.match(manifest.dependencies.zod, /^\d+\.\d+\.\d+$/);
		assert.equal(JSON.parse(readFileSync(join(consumer, "node_modules/zod/package.json"), "utf8")).version, manifest.dependencies.zod);
		for (const entry of Object.values(manifest.exports)) {
			for (const path of Object.values(entry)) assert.equal(readFileSync(join(installed, path), "utf8"), readFileSync(join(root, path), "utf8"));
		}
		const compiler = join(consumer, "node_modules/.bin/tsc");
		command(consumer, compiler, ["--project", "tsconfig.json"]);
		command(consumer, compiler, ["--project", "tsconfig.browser.json"]);
		const type_source = readFileSync(join(consumer, "types.ts"), "utf8");
		const expected_errors = (type_source.match(/@ts-expect-error/g) ?? []).length;
		assert.ok(expected_errors >= 10);
		writeFileSync(join(consumer, "negative.ts"), type_source.replace(/^.*@ts-expect-error.*$/gm, ""));
		writeFileSync(join(consumer, "tsconfig.negative.json"), JSON.stringify({ compilerOptions: { ...options, noEmit: true }, files: ["negative.ts"] }));
		const negative_output = command(consumer, compiler, ["--project", "tsconfig.negative.json"], "failure");
		const diagnostics = negative_output.split("\n").filter((line) => /error TS\d+/.test(line));
		assert.equal(diagnostics.length, expected_errors, "negative consumer must reject each invalid API use");
		assert.ok(diagnostics.every((line) => line.startsWith("negative.ts(")), "unexpected dependency or compiler diagnostic");
		let expected;
		for (const runtime of ["node", "bun"]) {
			const output = command(consumer, runtime, ["emitted/run.js"]);
			const result = JSON.parse(output.trim());
			assert.equal(result.status, "pass");
			assert.ok(result.assertions >= 60);
			if (expected) assert.deepEqual(result, expected); else expected = result;
			command(consumer, runtime, ["emitted/protocol.js"]);
			assert.equal(command(consumer, runtime, ["quickstart.mjs"]).trim(), "Hello, typed documents!");
		}
		const browser = await browser_check(consumer, expected);
		report.consumers.push({ installer, path: consumer, runtime: expected, negative_type_errors: diagnostics, browser, cleanup_complete: true });
	}
	report.status = "pass";
	console.log("PACKAGE_CONSUMERS_PASS " + JSON.stringify({ consumers: report.consumers.length, commands: report.commands.length, report: join(attempt, "report.json") }));
} catch (error) {
	report.status = "fail";
	report.error = String(error);
	throw error;
} finally {
	writeFileSync(join(attempt, "report.json"), JSON.stringify(report, null, 2) + "\n");
	console.log("CONSUMER_REPORT " + join(attempt, "report.json"));
}
