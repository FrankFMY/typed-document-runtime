import { expect, test } from "bun:test";
import { package_digest, package_json, package_operation_digest } from "../src/application-package.js";
import { execute_process_runtime as process_entry } from "../src/process-runtime.js";
import { execute_process_runtime as runtime_entry } from "../src/runtime.js";

test("public Process entry delegates to the exact same evaluator", () => {
	expect(process_entry).toBe(runtime_entry);
});

test("publication digests keep JSON insertion order while operation digests sort keys", async () => {
	const forward = { a: 1, b: 2 };
	const reverse = { b: 2, a: 1 };
	expect(package_json(forward)).toBe('{"a":1,"b":2}');
	expect(package_json(reverse)).toBe('{"b":2,"a":1}');
	expect(await package_digest(forward)).toBe("sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
	expect(await package_digest(reverse)).not.toBe(await package_digest(forward));
	expect(await package_operation_digest(reverse)).toBe(await package_operation_digest(forward));
});

test("package data guards reject accessors without executing them", () => {
	let calls = 0;
	const value = Object.defineProperty({}, "value", { enumerable: true, get: () => ++calls });
	expect(() => package_json(value)).toThrow("package_data_only");
	expect(calls).toBe(0);
});
