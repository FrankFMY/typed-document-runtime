import { normalize_box_document } from "@frankfmy/typed-document-runtime/box-document";
import { normalize_project_source_snapshot } from "@frankfmy/typed-document-runtime/project-source-snapshot";
import { execute_project_runtime } from "@frankfmy/typed-document-runtime/runtime";

const id = (n) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const document = normalize_box_document({
	schema: "box.document.v2",
	root_id: id(10),
	nodes: [
		{ id: id(11), kind: "scalar", value_type: "string" },
		{ id: id(10), kind: "record", fields: [{ id: id(12), name: "message", type_id: id(11), required: false }] },
	],
	program: {
		schema: "box.program.v1",
		body: [{ id: id(13), kind: "write", cell_id: id(12), value: { id: id(14), kind: "literal", type_id: id(11), value: "Hello, typed documents!" } }],
	},
});
const snapshot = normalize_project_source_snapshot({
	schema: "project.source.snapshot.v1",
	project_id: id(1),
	revision: "1",
	realms: [{ id: id(2), name: "Main", is_primary: true }],
	boxes: [{ id: id(3), realm_id: id(2), parent_id: null, name: "Greeting", document_version: "1", document }],
});
const result = execute_project_runtime({
	publication: { id: id(4), snapshot },
	entry_box_id: id(3),
	input: [],
	output_cell_ids: [id(12)],
	budget: { max_steps: 100, max_call_depth: 8, max_value_nodes: 100, max_string_units: 1000 },
});
if (result.status !== "success") throw new Error(JSON.stringify(result));
if (result.outputs[0]?.value !== "Hello, typed documents!") throw new Error("Unexpected output");
console.log(result.outputs[0].value);
