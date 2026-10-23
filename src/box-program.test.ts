import { describe, expect, test } from "bun:test";
import { box_documents_equal, diff_box_documents, normalize_box_document, project_box_document_code } from "./box-document.js";

const STRING_ID = "00000000-0000-4000-8000-000000000001";
const ROOT_ID = "00000000-0000-4000-8000-000000000002";
const TITLE_ID = "00000000-0000-4000-8000-000000000003";

const executable_document = (value: string) => ({
	schema: "box.document.v2",
	root_id: ROOT_ID,
	nodes: [
		{ id: STRING_ID, kind: "scalar", value_type: "string" },
		{ id: ROOT_ID, kind: "record", fields: [{ id: TITLE_ID, name: "title", type_id: STRING_ID, required: false }] },
	],
	program: {
		schema: "box.program.v1",
		body: [
			{
				id: "00000000-0000-4000-8000-000000000010",
				kind: "write",
				cell_id: TITLE_ID,
				value: {
					id: "00000000-0000-4000-8000-000000000011",
					kind: "literal",
					type_id: STRING_ID,
					value,
				},
			},
		],
	},
});

describe("Box program document", () => {
	test("distinguishes sparse runtime literals from dense JSON values", () => {
		const sparse_value: null[] = [];
		sparse_value.length = 1;
		const sparse = executable_document("Product");
		const dense = executable_document("Product");
		(sparse.program.body[0]!.value as { value: unknown }).value = sparse_value;
		(dense.program.body[0]!.value as { value: unknown }).value = [null];

		expect(box_documents_equal(sparse, dense)).toBe(false);
	});

	test("rejects sparse runtime list literals before canonical publication", () => {
		const absence_id = "00000000-0000-4000-8000-000000000020";
		const list_id = "00000000-0000-4000-8000-000000000021";
		const list_cell_id = "00000000-0000-4000-8000-000000000022";
		const sparse_value: null[] = [];
		sparse_value.length = 1;

		expect(() =>
			normalize_box_document({
				schema: "box.document.v2",
				root_id: ROOT_ID,
				nodes: [
					{ id: absence_id, kind: "scalar", value_type: "absence" },
					{ id: list_id, kind: "list", item_type_id: absence_id },
					{ id: ROOT_ID, kind: "record", fields: [{ id: list_cell_id, name: "items", type_id: list_id, required: false }] },
				],
				program: {
					schema: "box.program.v1",
					body: [
						{
							id: "00000000-0000-4000-8000-000000000023",
							kind: "write",
							cell_id: list_cell_id,
							value: {
								id: "00000000-0000-4000-8000-000000000024",
								kind: "literal",
								type_id: list_id,
								value: sparse_value,
							},
						},
					],
				},
			}),
		).toThrow("dense");
	});

	test("rejects a dormant write to an unknown frame cell during document admission", () => {
		const boolean_id = "00000000-0000-4000-8000-000000000030";
		const condition_cell_id = "00000000-0000-4000-8000-000000000031";
		const missing_cell_id = "00000000-0000-4000-8000-000000000032";

		expect(() =>
			normalize_box_document({
				schema: "box.document.v2",
				root_id: ROOT_ID,
				nodes: [
					{ id: STRING_ID, kind: "scalar", value_type: "string" },
					{ id: boolean_id, kind: "scalar", value_type: "boolean" },
					{
						id: ROOT_ID,
						kind: "record",
						fields: [
							{ id: TITLE_ID, name: "title", type_id: STRING_ID, required: false },
							{ id: condition_cell_id, name: "condition", type_id: boolean_id, required: false },
						],
					},
				],
				program: {
					schema: "box.program.v1",
					body: [
						{
							id: "00000000-0000-4000-8000-000000000033",
							kind: "reject_if",
							condition: {
								id: "00000000-0000-4000-8000-000000000034",
								kind: "literal",
								type_id: boolean_id,
								value: true,
							},
							code: "stopped",
						},
						{
							id: "00000000-0000-4000-8000-000000000035",
							kind: "write",
							cell_id: missing_cell_id,
							value: {
								id: "00000000-0000-4000-8000-000000000036",
								kind: "literal",
								type_id: STRING_ID,
								value: "unreachable",
							},
						},
					],
				},
			}),
		).toThrow("unknown frame cell");
	});

	test("rejects a literal whose value does not match its declared type", () => {
		const invalid = executable_document("Product");
		(invalid.program.body[0]!.value as { value: unknown }).value = 42;

		expect(() => normalize_box_document(invalid)).toThrow("literal does not match its type");
	});

	test("rejects a binding expression outside its lexical list scope", () => {
		const invalid = executable_document("Product");
		invalid.program.body[0]!.value = {
			id: "00000000-0000-4000-8000-000000000040",
			kind: "binding",
			type_id: STRING_ID,
			binding_id: "00000000-0000-4000-8000-000000000041",
		} as never;

		expect(() => normalize_box_document(invalid)).toThrow("outside its lexical scope");
	});

	test("rejects an unknown record-expression field", () => {
		const invalid = executable_document("Product");
		invalid.program.body[0]!.value = {
			id: "00000000-0000-4000-8000-000000000042",
			kind: "record",
			type_id: ROOT_ID,
			fields: [
				{
					field_id: "00000000-0000-4000-8000-000000000043",
					value: {
						id: "00000000-0000-4000-8000-000000000044",
						kind: "literal",
						type_id: STRING_ID,
						value: "Product",
					},
				},
			],
		} as never;

		expect(() => normalize_box_document(invalid)).toThrow("unknown field");
	});

	test("normalizes one executable document without inventing source syntax", () => {
		expect(
			normalize_box_document({
				schema: "box.document.v2",
				root_id: ROOT_ID.toUpperCase(),
				nodes: [
					{
						id: ROOT_ID.toUpperCase(),
						kind: "record",
						fields: [{ id: TITLE_ID.toUpperCase(), name: " title ", type_id: STRING_ID.toUpperCase(), required: true }],
					},
					{ id: STRING_ID.toUpperCase(), kind: "scalar", value_type: "string" },
				],
				program: { schema: "box.program.v1", body: [] },
			}),
		).toEqual({
			schema: "box.document.v2",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{
					id: ROOT_ID,
					kind: "record",
					fields: [{ id: TITLE_ID, name: "title", type_id: STRING_ID, required: true }],
				},
			],
			program: { schema: "box.program.v1", body: [] },
		});
	});

	test("normalizes stable runtime node and cell identities", () => {
		const statement_id = "00000000-0000-4000-8000-000000000010";
		const expression_id = "00000000-0000-4000-8000-000000000011";
		const normalized = normalize_box_document({
			schema: "box.document.v2",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{
					id: ROOT_ID,
					kind: "record",
					fields: [{ id: TITLE_ID, name: "title", type_id: STRING_ID, required: false }],
				},
			],
			program: {
				schema: "box.program.v1",
				body: [
					{
						id: statement_id.toUpperCase(),
						kind: "write",
						cell_id: TITLE_ID.toUpperCase(),
						value: {
							id: expression_id.toUpperCase(),
							kind: "literal",
							type_id: STRING_ID.toUpperCase(),
							value: "Product",
						},
					},
				],
			},
		});

		expect(normalized.schema).toBe("box.document.v2");
		if (normalized.schema !== "box.document.v2") throw new Error("Expected executable document");
		expect(normalized.program).toEqual({
			schema: "box.program.v1",
			body: [
				{
					id: statement_id,
					kind: "write",
					cell_id: TITLE_ID,
					value: { id: expression_id, kind: "literal", type_id: STRING_ID, value: "Product" },
				},
			],
		});
	});

	test("rejects runtime identities that collide with the typed frame", () => {
		expect(() =>
			normalize_box_document({
				schema: "box.document.v2",
				root_id: ROOT_ID,
				nodes: [
					{ id: STRING_ID, kind: "scalar", value_type: "string" },
					{
						id: ROOT_ID,
						kind: "record",
						fields: [{ id: TITLE_ID, name: "title", type_id: STRING_ID, required: false }],
					},
				],
				program: {
					schema: "box.program.v1",
					body: [
						{
							id: TITLE_ID,
							kind: "write",
							cell_id: TITLE_ID,
							value: {
								id: "00000000-0000-4000-8000-000000000012",
								kind: "literal",
								type_id: STRING_ID,
								value: "Product",
							},
						},
					],
				},
			}),
		).toThrow("duplicate identity");
	});

	test("diffs executable runtime nodes by stable identity", () => {
		expect(diff_box_documents(executable_document("before"), executable_document("after"))).toEqual({
			root_changed: false,
			added_node_ids: [],
			removed_node_ids: [],
			changed_node_ids: [],
			program_changed: true,
			added_runtime_node_ids: [],
			removed_runtime_node_ids: [],
			changed_runtime_node_ids: ["00000000-0000-4000-8000-000000000011"],
		});
	});

	test("includes canonical runtime IR in the full-code projection", () => {
		const document = normalize_box_document(executable_document("Product"));
		if (document.schema !== "box.document.v2") throw new Error("expected executable document");
		expect(project_box_document_code(document).split("\n").at(-1)).toBe(`program ${JSON.stringify(document.program)}`);
	});

	test("bounds rejection expressions before runtime execution", () => {
		let condition: Record<string, unknown> = {
			id: "00000000-0000-4000-8000-000000001000",
			kind: "cell",
			type_id: STRING_ID,
			cell_id: TITLE_ID,
		};
		for (let index = 1; index <= 65; index += 1) {
			condition = {
				id: `00000000-0000-4000-8000-${(4096 + index).toString(16).padStart(12, "0")}`,
				kind: "binary",
				type_id: STRING_ID,
				operator: "equal",
				left: condition,
				right: {
					id: `00000000-0000-4000-8000-${(8192 + index).toString(16).padStart(12, "0")}`,
					kind: "literal",
					type_id: STRING_ID,
					value: "x",
				},
			};
		}
		expect(() =>
			normalize_box_document({
				...executable_document("Product"),
				program: {
					schema: "box.program.v1",
					body: [{ id: "00000000-0000-4000-8000-000000003000", kind: "reject_if", condition, code: "rejected" }],
				},
			}),
		).toThrow("too deeply nested");
	});

	test("requires an executable Box to expose a record frame", () => {
		expect(() =>
			normalize_box_document({
				schema: "box.document.v2",
				root_id: STRING_ID,
				nodes: [{ id: STRING_ID, kind: "scalar", value_type: "string" }],
				program: { schema: "box.program.v1", body: [] },
			}),
		).toThrow("Executable Box document root must be a record");
	});
});
