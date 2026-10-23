import { describe, expect, test } from "bun:test";
import type { RuntimePublication } from "./runtime.js";
import { execute_project_runtime } from "./runtime.js";

const id = (index: number): string => `30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const BOOL = id(1);
const NUMBER = id(2);
const STRING = id(3);
const ROOT = id(4);
const CONDITION = id(10);
const OUTPUT = id(11);
const REASON = id(12);
const REALM = id(20);
const BOX = id(21);

const publication: RuntimePublication = {
	id: id(30),
	snapshot: {
		schema: "project.source.snapshot.v1",
		project_id: id(31),
		revision: "1",
		realms: [{ id: REALM, name: "Primary", is_primary: true }],
		boxes: [
			{
				id: BOX,
				realm_id: REALM,
				parent_id: null,
				name: "Rejecting Box",
				document_version: "1",
				document: {
					schema: "box.document.v2",
					root_id: ROOT,
					nodes: [
						{ id: BOOL, kind: "scalar", value_type: "boolean" },
						{ id: NUMBER, kind: "scalar", value_type: "number" },
						{ id: STRING, kind: "scalar", value_type: "string" },
						{
							id: ROOT,
							kind: "record",
							fields: [
								{ id: REASON, name: "reason", type_id: STRING, required: false },
								{ id: CONDITION, name: "should_reject", type_id: BOOL, required: true },
								{ id: OUTPUT, name: "value", type_id: NUMBER, required: false },
							],
						},
					],
					program: {
						schema: "box.program.v1",
						body: [
							{
								id: id(100),
								kind: "write",
								cell_id: OUTPUT,
								value: { id: id(101), kind: "literal", type_id: NUMBER, value: 7 },
							},
							{
								id: id(102),
								kind: "reject_if",
								condition: { id: id(103), kind: "cell", type_id: BOOL, cell_id: CONDITION },
								code: "out_of_stock",
								details: { id: id(104), kind: "literal", type_id: STRING, value: "stock changed" },
							},
						],
					},
				},
			},
		],
	},
};

describe("Runtime outcomes", () => {
	test("returns an expected rejection without partial outputs", () => {
		const outcome = execute_project_runtime({
			publication,
			entry_box_id: BOX,
			input: [{ cell_id: CONDITION, value: true }],
			output_cell_ids: [OUTPUT],
			budget: { max_steps: 100, max_call_depth: 4, max_value_nodes: 100, max_string_units: 10_000 },
		});

		expect(outcome).toMatchObject({
			status: "rejected",
			publication_id: publication.id,
			project_id: publication.snapshot.project_id,
			source_revision: "1",
			rejection: { code: "out_of_stock", details: "stock changed" },
		});
		expect("outputs" in outcome).toBe(false);
		expect(outcome.trace.at(-1)).toMatchObject({ kind: "box.exit", box_id: BOX, outcome: "rejected" });
	});
});
