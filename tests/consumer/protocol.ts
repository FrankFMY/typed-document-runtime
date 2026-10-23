import assert from "node:assert/strict";
import type { BoxDocument } from "@frankfmy/typed-document-runtime/box-document";
import type { ProcessDocument } from "@frankfmy/typed-document-runtime/process-document";
import { execute_process_runtime } from "@frankfmy/typed-document-runtime/process-runtime";
import { normalize_project_source_snapshot } from "@frankfmy/typed-document-runtime/project-source-snapshot";
import type { ProcessExecutionRequest } from "@frankfmy/typed-document-runtime/runtime";
import { execute_project_runtime } from "@frankfmy/typed-document-runtime/runtime";

const id = (index: number): string => `90000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const [project, realm, box, process_id, publication_id, invocation, root, text, input, output, effect, statement] = Array.from(
	{ length: 12 },
	(_, i) => id(i + 1),
);

const box_document = {
	schema: "box.document.v2",
	root_id: root,
	nodes: [
		{ id: text, kind: "scalar", value_type: "string" },
		{ id: root, kind: "record", fields: [{ id: output, name: "title", type_id: text, required: false }] },
	],
	program: {
		schema: "box.program.v1",
		body: [{ id: statement, kind: "write", cell_id: output, value: { id: id(20), kind: "literal", type_id: text, value: "Independent execution" } }],
	},
} satisfies BoxDocument;
const process_document = {
	schema: "process.document.v1",
	root_id: root,
	nodes: [
		{ id: text, kind: "scalar", value_type: "string" },
		{
			id: root,
			kind: "record",
			fields: [
				{ id: input, name: "input", type_id: text, required: true },
				{ id: output, name: "output", type_id: text, required: false },
			],
		},
	],
	input_cell_ids: [input],
	output_cell_ids: [output],
	effects: [
		{ id: effect, capability: "host.example.echo.v1", request_cell_id: input, request_type_id: text, result_cell_id: output, result_type_id: text },
	],
	program: { schema: "process.program.v1", body: [{ id: statement, kind: "effect", effect_id: effect }] },
} satisfies ProcessDocument;
const publication = {
	id: publication_id,
	snapshot: normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1",
		project_id: project,
		revision: "1",
		realms: [{ id: realm, name: "Main", is_primary: true }],
		boxes: [
			{ id: box, realm_id: realm, parent_id: null, name: "Title", document_version: "1", document: box_document },
			{ id: process_id, realm_id: realm, parent_id: null, name: "Echo", document_version: "1", document: process_document },
		],
	}),
};
const budget = { max_steps: 100, max_call_depth: 8, max_value_nodes: 100, max_string_units: 10_000, max_effects: 4 };
const box_request = { publication, entry_box_id: box, input: [], output_cell_ids: [output], budget };
const result = execute_project_runtime(box_request);
assert.equal(result.status, "success");
assert.deepEqual(result.status === "success" && result.outputs, [{ cell_id: output, value: "Independent execution" }]);
assert.deepEqual(execute_project_runtime(box_request), result);
assert.equal(execute_project_runtime({ ...box_request, budget: { ...budget, max_steps: 1 } }).status, "fault");

const request = {
	publication,
	process_id,
	invocation_id: invocation,
	input: [{ cell_id: input, value: "request" }],
	effect_receipts: [],
	budget,
} satisfies ProcessExecutionRequest;
const intent = execute_process_runtime(request);
assert.equal(intent.status, "effect");
assert.equal(intent.status === "effect" && intent.effect.capability, "host.example.echo.v1");
assert.equal(intent.status === "effect" && intent.effect.request, "request");
const receipt = { statement_id: statement, effect_id: effect, capability: "host.example.echo.v1", request: "request", result: "host result" };
const resumed = execute_process_runtime({ ...request, effect_receipts: [receipt] });
assert.equal(resumed.status, "success");
assert.deepEqual(resumed.status === "success" && resumed.outputs, [{ cell_id: output, value: "host result" }]);
assert.equal(execute_process_runtime({ ...request, input: [{ cell_id: input, value: 42 }] }).status, "fault");
assert.equal(execute_process_runtime({ ...request, effect_receipts: [{ ...receipt, capability: "host.other.v1" }] }).status, "fault");
await Promise.all(
	["@frankfmy/typed-document-runtime", "@frankfmy/typed-document-runtime/types", "@frankfmy/typed-document-runtime/src/runtime.ts"].map((specifier) =>
		assert.rejects(import(specifier), `undeclared entrypoint must fail: ${specifier}`),
	),
);
console.log("PROTOCOL_CONSUMER_PASS: deterministic execution, budget, typed effect/replay and invalid input/receipt/exports");
