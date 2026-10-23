import { describe, expect, test } from "bun:test";
import { normalize_box_document, normalize_box_value_at, project_box_document_schema } from "./box-document.js";
import { create_box_type_comparer } from "./box-type-system.js";
import { normalize_process_document, process_document_box_schema } from "./process-document.js";
import { execute_process_runtime, execute_project_runtime } from "./runtime.js";

const id = (index: number): string => `85000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const PROJECT_ID = id(1);
const PUBLICATION_ID = id(2);
const REALM_ID = id(3);
const BOX_ID = id(4);
const NUMBER_TYPE_ID = id(10);
const BOOLEAN_TYPE_ID = id(11);
const ROOT_ID = id(12);
const RESULT_CELL_ID = id(13);

const executable_box = () => ({
	schema: "box.document.v2" as const,
	root_id: ROOT_ID,
	nodes: [
		{ id: NUMBER_TYPE_ID, kind: "scalar" as const, value_type: "number" as const },
		{ id: BOOLEAN_TYPE_ID, kind: "scalar" as const, value_type: "boolean" as const },
		{
			id: ROOT_ID,
			kind: "record" as const,
			fields: [{ id: RESULT_CELL_ID, name: "result", type_id: NUMBER_TYPE_ID, required: false }],
		},
	],
	program: {
		schema: "box.program.v1" as const,
		body: [
			{
				id: id(20),
				kind: "write" as const,
				cell_id: RESULT_CELL_ID,
				value: {
					id: id(21),
					kind: "select" as const,
					type_id: NUMBER_TYPE_ID,
					condition: { id: id(22), kind: "literal" as const, type_id: BOOLEAN_TYPE_ID, value: true },
					when_true: { id: id(23), kind: "literal" as const, type_id: NUMBER_TYPE_ID, value: 7 },
					when_false: { id: id(24), kind: "literal" as const, type_id: NUMBER_TYPE_ID, value: 3 },
				},
			},
		],
	},
});

describe("executable type reachability", () => {
	test("executes a numeric Box select whose boolean condition type is absent from root fields", () => {
		const document = normalize_box_document(executable_box());
		const result = execute_project_runtime({
			publication: {
				id: PUBLICATION_ID,
				snapshot: {
					schema: "project.source.snapshot.v1",
					project_id: PROJECT_ID,
					revision: "1",
					realms: [{ id: REALM_ID, name: "Main", is_primary: true }],
					boxes: [
						{
							id: BOX_ID,
							realm_id: REALM_ID,
							parent_id: null,
							name: "Select",
							document_version: "1",
							document,
						},
					],
				},
			},
			entry_box_id: BOX_ID,
			input: [],
			output_cell_ids: [RESULT_CELL_ID],
			budget: { max_steps: 20, max_call_depth: 2, max_value_nodes: 20, max_string_units: 100 },
		});

		expect(result).toMatchObject({ status: "success", outputs: [{ cell_id: RESULT_CELL_ID, value: 7 }] });
	});

	test("executes a numeric Process select whose boolean condition type is absent from root fields", () => {
		const box = executable_box();
		const document = normalize_process_document({
			schema: "process.document.v1",
			root_id: box.root_id,
			nodes: box.nodes,
			input_cell_ids: [],
			output_cell_ids: [RESULT_CELL_ID],
			effects: [],
			program: { schema: "process.program.v1", body: box.program.body },
		});
		const projection = process_document_box_schema(document);
		const box_document = normalize_box_document(box);

		expect(projection.schema).toBe("box.document.v2");
		expect(normalize_box_value_at(projection, BOOLEAN_TYPE_ID, true)).toBe(true);
		expect(project_box_document_schema(projection).declarations).toContainEqual({
			id: BOOLEAN_TYPE_ID,
			type: "boolean",
		});
		expect(create_box_type_comparer().same_type(projection, BOOLEAN_TYPE_ID, box_document, BOOLEAN_TYPE_ID)).toBe(true);

		const result = execute_process_runtime({
			publication: {
				id: PUBLICATION_ID,
				snapshot: {
					schema: "project.source.snapshot.v1",
					project_id: PROJECT_ID,
					revision: "1",
					realms: [{ id: REALM_ID, name: "Main", is_primary: true }],
					boxes: [
						{
							id: BOX_ID,
							realm_id: REALM_ID,
							parent_id: null,
							name: "Select Process",
							document_version: "1",
							document,
						},
					],
				},
			},
			process_id: BOX_ID,
			invocation_id: id(30),
			input: [],
			effect_receipts: [],
			budget: { max_steps: 20, max_call_depth: 2, max_value_nodes: 20, max_string_units: 100, max_effects: 1 },
		});

		expect(result).toMatchObject({ status: "success", outputs: [{ cell_id: RESULT_CELL_ID, value: 7 }] });
	});

	test("retains declarations reached from call values and rejection condition or details expressions", () => {
		const string_type_id = id(40);
		const absence_type_id = id(41);
		const document = normalize_box_document({
			schema: "box.document.v2",
			root_id: ROOT_ID,
			nodes: [
				{ id: NUMBER_TYPE_ID, kind: "scalar", value_type: "number" },
				{ id: BOOLEAN_TYPE_ID, kind: "scalar", value_type: "boolean" },
				{ id: string_type_id, kind: "scalar", value_type: "string" },
				{ id: absence_type_id, kind: "scalar", value_type: "absence" },
				{
					id: ROOT_ID,
					kind: "record",
					fields: [{ id: RESULT_CELL_ID, name: "result", type_id: NUMBER_TYPE_ID, required: false }],
				},
			],
			program: {
				schema: "box.program.v1",
				body: [
					{
						id: id(42),
						kind: "call",
						box_id: id(43),
						init: [
							{
								id: id(44),
								kind: "value",
								callee_cell_id: id(45),
								value: { id: id(46), kind: "literal", type_id: string_type_id, value: "value" },
							},
						],
					},
					{
						id: id(47),
						kind: "reject_if",
						condition: { id: id(48), kind: "literal", type_id: BOOLEAN_TYPE_ID, value: false },
						code: "not_rejected",
						details: { id: id(49), kind: "literal", type_id: absence_type_id, value: null },
					},
				],
			},
		});

		expect(document.nodes.map((node) => node.id)).toEqual([NUMBER_TYPE_ID, BOOLEAN_TYPE_ID, ROOT_ID, string_type_id, absence_type_id]);
	});

	test("keeps schema-only Box v1 reachability strict", () => {
		const box = executable_box();
		expect(() =>
			normalize_box_document({
				schema: "box.document.v1",
				root_id: box.root_id,
				nodes: box.nodes,
			}),
		).toThrow("Box document contains unreachable declarations");
	});

	test("rejects a genuinely orphaned executable declaration", () => {
		const box = executable_box();
		box.program.body[0]!.value.condition.type_id = NUMBER_TYPE_ID;

		expect(() => normalize_box_document(box)).toThrow("Box document contains unreachable declarations");
	});

	test("rejects a missing executable expression type", () => {
		const box = executable_box();
		box.program.body[0]!.value.condition.type_id = id(60);

		expect(() => normalize_box_document(box)).toThrow("Box document type reference is missing");
	});

	test("rejects a type cycle reached only from an executable expression", () => {
		const first_reference_id = id(61);
		const second_reference_id = id(62);
		const box = executable_box();
		const nodes: unknown[] = [...box.nodes];
		nodes.splice(
			1,
			1,
			{ id: first_reference_id, kind: "reference", target_id: second_reference_id },
			{ id: second_reference_id, kind: "reference", target_id: first_reference_id },
		);
		box.program.body[0]!.value.condition.type_id = first_reference_id;

		expect(() => normalize_box_document({ ...box, nodes })).toThrow("Box document type graph contains a cycle");
	});
});
