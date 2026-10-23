import { describe, expect, test } from "bun:test";
import { EMPTY_BOX_DOCUMENT } from "./box-document.js";
import type { BoxPresentation } from "./box-presentation.js";
import type { ProcessDocument } from "./process-document.js";
import {
	is_canonical_project_source_snapshot,
	normalize_project_source_snapshot,
	serialize_project_source_snapshot,
} from "./project-source-snapshot.js";
import { execute_project_runtime } from "./runtime.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const PRIMARY_REALM_ID = "00000000-0000-4000-8000-000000000002";
const SECONDARY_REALM_ID = "00000000-0000-4000-8000-000000000003";
const ROOT_BOX_ID = "00000000-0000-4000-8000-000000000010";
const CHILD_BOX_ID = "00000000-0000-4000-8000-000000000011";
const indexed_id = (index: number): string => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const expected = {
	schema: "project.source.snapshot.v1" as const,
	project_id: PROJECT_ID,
	revision: "7",
	realms: [
		{ id: PRIMARY_REALM_ID, name: "Main", is_primary: true },
		{ id: SECONDARY_REALM_ID, name: "Café", is_primary: false },
	],
	boxes: [
		{
			id: ROOT_BOX_ID,
			realm_id: PRIMARY_REALM_ID,
			parent_id: null,
			name: "Catalog",
			document_version: "0",
			document: EMPTY_BOX_DOCUMENT,
		},
		{
			id: CHILD_BOX_ID,
			realm_id: PRIMARY_REALM_ID,
			parent_id: ROOT_BOX_ID,
			name: "Product",
			document_version: "0",
			document: EMPTY_BOX_DOCUMENT,
		},
	],
};

const ABSENCE_ID = indexed_id(100);
const ABSENCE_LIST_ID = indexed_id(101);
const EXECUTABLE_ROOT_ID = indexed_id(102);
const ITEMS_CELL_ID = indexed_id(103);

const executable_list_snapshot = (value: unknown) => ({
	schema: "project.source.snapshot.v1",
	project_id: PROJECT_ID,
	revision: "1",
	realms: [{ id: PRIMARY_REALM_ID, name: "Main", is_primary: true }],
	boxes: [
		{
			id: ROOT_BOX_ID,
			realm_id: PRIMARY_REALM_ID,
			parent_id: null,
			name: "Executable",
			document_version: "1",
			document: {
				schema: "box.document.v2",
				root_id: EXECUTABLE_ROOT_ID,
				nodes: [
					{ id: ABSENCE_ID, kind: "scalar", value_type: "absence" },
					{ id: ABSENCE_LIST_ID, kind: "list", item_type_id: ABSENCE_ID },
					{
						id: EXECUTABLE_ROOT_ID,
						kind: "record",
						fields: [
							{
								id: ITEMS_CELL_ID,
								name: "items",
								type_id: ABSENCE_LIST_ID,
								required: false,
							},
						],
					},
				],
				program: {
					schema: "box.program.v1",
					body: [
						{
							id: indexed_id(104),
							kind: "write",
							cell_id: ITEMS_CELL_ID,
							value: {
								id: indexed_id(105),
								kind: "literal",
								type_id: ABSENCE_LIST_ID,
								value,
							},
						},
					],
				},
			},
		},
	],
});

describe("published Project source snapshot", () => {
	test("binds record targets to same-Realm schema-only record entities", () => {
		const string_id = indexed_id(200);
		const target_root = indexed_id(201);
		const target_field = indexed_id(202);
		const source_root = indexed_id(203);
		const relation_field = indexed_id(204);
		const target_id = indexed_id(205);
		const source_id = indexed_id(206);
		const nested_record = indexed_id(207);
		const nested_relation_field = indexed_id(208);
		const nested_container_field = indexed_id(209);
		const snapshot = {
			schema: "project.source.snapshot.v1" as const,
			project_id: PROJECT_ID,
			revision: "1",
			realms: [
				{ id: PRIMARY_REALM_ID, name: "Main", is_primary: true },
				{ id: SECONDARY_REALM_ID, name: "Other", is_primary: false },
			],
			boxes: [
				{
					id: target_id,
					realm_id: PRIMARY_REALM_ID,
					parent_id: null,
					name: "Customers",
					document_version: "1",
					document: {
						schema: "box.document.v1" as const,
						root_id: target_root,
						nodes: [
							{ id: string_id, kind: "scalar" as const, value_type: "string" as const },
							{ id: target_root, kind: "record" as const, fields: [{ id: target_field, name: "name", type_id: string_id, required: true }] },
						],
					},
				},
				{
					id: source_id,
					realm_id: PRIMARY_REALM_ID,
					parent_id: null,
					name: "Orders",
					document_version: "1",
					document: {
						schema: "box.document.v1" as const,
						root_id: source_root,
						nodes: [
							{ id: string_id, kind: "scalar" as const, value_type: "string" as const },
							{
								id: source_root,
								kind: "record" as const,
								fields: [
									{
										id: relation_field,
										name: "customer_id",
										type_id: string_id,
										required: true,
										record_target: { entity_id: target_id },
									},
								],
							},
						],
					},
				},
			],
		};

		expect(normalize_project_source_snapshot(snapshot).boxes[1]?.document).toEqual(snapshot.boxes[1]?.document);
		const cross_realm = structuredClone(snapshot);
		cross_realm.boxes[0]!.realm_id = SECONDARY_REALM_ID;
		expect(() => normalize_project_source_snapshot(cross_realm)).toThrow("record target must be a same Realm data Box");

		const nested = structuredClone(snapshot);
		const source_document = nested.boxes[1]!.document;
		const source_root_node = source_document.nodes.find((node) => node.id === source_root);
		if (source_root_node?.kind !== "record") throw new Error("source root fixture missing");
		source_root_node.fields.push({ id: nested_container_field, name: "details", type_id: nested_record, required: true });
		source_document.nodes.push({
			id: nested_record,
			kind: "record",
			fields: [
				{
					id: nested_relation_field,
					name: "nested_customer_id",
					type_id: string_id,
					required: true,
					record_target: { entity_id: target_id },
				},
			],
		});
		expect(() => normalize_project_source_snapshot(nested)).toThrow("data Box record target must belong to the root record");
	});

	test("rejects contextual record action targets outside the same Realm or data-record source", () => {
		const string_id = indexed_id(210);
		const entity_root = indexed_id(211);
		const entity_field = indexed_id(212);
		const process_root = indexed_id(213);
		const input_cell = indexed_id(214);
		const input_type = indexed_id(215);
		const record_id_field = indexed_id(216);
		const entity_id = indexed_id(217);
		const process_id = indexed_id(218);
		const source = {
			schema: "project.source.snapshot.v1" as const,
			project_id: PROJECT_ID,
			revision: "1",
			realms: [
				{ id: PRIMARY_REALM_ID, name: "Main", is_primary: true },
				{ id: SECONDARY_REALM_ID, name: "Other", is_primary: false },
			],
			boxes: [
				{
					id: entity_id,
					realm_id: PRIMARY_REALM_ID,
					parent_id: null,
					name: "WorkOrder",
					document_version: "1",
					document: {
						schema: "box.document.v1" as const,
						root_id: entity_root,
						nodes: [
							{ id: string_id, kind: "scalar" as const, value_type: "string" as const },
							{ id: entity_root, kind: "record" as const, fields: [{ id: entity_field, name: "number", type_id: string_id, required: true }] },
						],
					},
				},
				{
					id: process_id,
					realm_id: PRIMARY_REALM_ID,
					parent_id: null,
					name: "Complete",
					document_version: "1",
					document: {
						schema: "process.document.v1" as const,
						root_id: process_root,
						nodes: [
							{ id: string_id, kind: "scalar" as const, value_type: "string" as const },
							{
								id: input_type,
								kind: "record" as const,
								fields: [{ id: record_id_field, name: "work_order_id", type_id: string_id, required: true }],
							},
							{ id: process_root, kind: "record" as const, fields: [{ id: input_cell, name: "input", type_id: input_type, required: true }] },
						],
						input_cell_ids: [input_cell],
						output_cell_ids: [],
						effects: [],
						program: { schema: "process.program.v1" as const, body: [] },
					},
					presentation: {
						schema: "box.presentation.v1" as const,
						fields: [],
						record_action: { entity_id, input_field_path: [input_cell, record_id_field] },
					},
				},
			],
		};
		expect(normalize_project_source_snapshot(source).boxes.find((box) => box.id === process_id)?.presentation?.record_action?.entity_id).toBe(
			entity_id,
		);
		const cross_realm = structuredClone(source);
		cross_realm.boxes[0]!.realm_id = SECONDARY_REALM_ID;
		expect(() => normalize_project_source_snapshot(cross_realm)).toThrow("same Realm data Box");
	});

	test("normalizes semantic source into one locale-independent byte representation", () => {
		const first = normalize_project_source_snapshot({
			schema: "project.source.snapshot.v1",
			project_id: PROJECT_ID.toUpperCase(),
			revision: "7",
			realms: [
				{
					id: SECONDARY_REALM_ID.toUpperCase(),
					name: " Cafe\u0301 ",
					is_primary: false,
				},
				{ id: PRIMARY_REALM_ID, name: " Main ", is_primary: true },
			],
			boxes: [
				{
					...expected.boxes[1],
					id: CHILD_BOX_ID.toUpperCase(),
					parent_id: ROOT_BOX_ID.toUpperCase(),
				},
				expected.boxes[0],
			],
		});
		const second = normalize_project_source_snapshot(expected);

		expect(first).toEqual(expected);
		expect(first).toEqual(second);
		expect(serialize_project_source_snapshot(first)).toBe(JSON.stringify(expected));
		expect(serialize_project_source_snapshot(second)).toBe(JSON.stringify(expected));
	});

	test("preserves historical absence and carries configured presentation without changing snapshot schema", () => {
		const field_id = indexed_id(108);
		const type_id = indexed_id(109);
		const root_id = indexed_id(110);
		const data_document = {
			schema: "box.document.v1" as const,
			root_id,
			nodes: [
				{ id: type_id, kind: "scalar" as const, value_type: "string" as const },
				{
					id: root_id,
					kind: "record" as const,
					fields: [{ id: field_id, name: "name", type_id, required: true }],
				},
			],
		};
		const presentation: BoxPresentation = {
			schema: "box.presentation.v1",
			label: { ru: "Справочник", en: "Directory" },
			fields: [{ field_id, label: { ru: "Название", en: "Name" } }],
			record_title_field_id: field_id,
		};
		const old_snapshot = normalize_project_source_snapshot(expected);
		const with_presentation = normalize_project_source_snapshot({
			...expected,
			boxes: [
				{
					...expected.boxes[0],
					document_version: "1",
					document: data_document,
					presentation,
				},
			],
		});

		expect(Object.hasOwn(old_snapshot.boxes[0]!, "presentation")).toBe(false);
		expect(serialize_project_source_snapshot(old_snapshot)).toBe(JSON.stringify(expected));
		expect(with_presentation.boxes[0]).toEqual({
			...expected.boxes[0],
			document_version: "1",
			document: data_document,
			presentation,
		});
		expect(is_canonical_project_source_snapshot(with_presentation)).toBe(true);
	});

	test("rejects sparse executable literals before snapshot JSON custody", () => {
		const sparse_value: null[] = [];
		sparse_value.length = 1;
		const sparse_snapshot = executable_list_snapshot(sparse_value);

		expect(is_canonical_project_source_snapshot(sparse_snapshot)).toBe(false);
		expect(() => normalize_project_source_snapshot(sparse_snapshot)).toThrow();
	});

	test("executes a dense absence List identically after snapshot JSON custody", () => {
		const snapshot = normalize_project_source_snapshot(executable_list_snapshot([null]));
		const round_tripped = normalize_project_source_snapshot(JSON.parse(serialize_project_source_snapshot(snapshot)));
		const request = {
			publication: { id: indexed_id(106), snapshot },
			entry_box_id: ROOT_BOX_ID,
			input: [],
			output_cell_ids: [ITEMS_CELL_ID],
			budget: {
				max_steps: 10,
				max_call_depth: 2,
				max_value_nodes: 20,
				max_string_units: 100,
			},
		};

		expect(is_canonical_project_source_snapshot(round_tripped)).toBe(true);
		expect(
			execute_project_runtime({
				...request,
				publication: { ...request.publication, snapshot: round_tripped },
			}),
		).toEqual(execute_project_runtime(request));
	});

	test("keeps canonical Process documents in snapshot v1 while the Box runtime refuses them", () => {
		const process_document: ProcessDocument = {
			schema: "process.document.v1",
			root_id: EXECUTABLE_ROOT_ID,
			nodes: [
				{ id: ABSENCE_ID, kind: "scalar", value_type: "absence" },
				{
					id: EXECUTABLE_ROOT_ID,
					kind: "record",
					fields: [
						{
							id: ITEMS_CELL_ID,
							name: "result",
							type_id: ABSENCE_ID,
							required: false,
						},
					],
				},
			],
			input_cell_ids: [],
			output_cell_ids: [ITEMS_CELL_ID],
			effects: [],
			program: { schema: "process.program.v1", body: [] },
		};
		const snapshot = normalize_project_source_snapshot({
			schema: "project.source.snapshot.v1",
			project_id: PROJECT_ID,
			revision: "1",
			realms: [{ id: PRIMARY_REALM_ID, name: "Main", is_primary: true }],
			boxes: [
				{
					id: ROOT_BOX_ID,
					realm_id: PRIMARY_REALM_ID,
					parent_id: null,
					name: "Process",
					document_version: "1",
					document: process_document,
				},
			],
		});
		const round_tripped = normalize_project_source_snapshot(JSON.parse(serialize_project_source_snapshot(snapshot)));

		expect(round_tripped).toEqual(snapshot);
		expect(is_canonical_project_source_snapshot(round_tripped)).toBe(true);
		expect(
			execute_project_runtime({
				publication: { id: indexed_id(107), snapshot: round_tripped },
				entry_box_id: ROOT_BOX_ID,
				input: [],
				output_cell_ids: [],
				budget: {
					max_steps: 10,
					max_call_depth: 2,
					max_value_nodes: 20,
					max_string_units: 100,
				},
			}),
		).toMatchObject({
			status: "fault",
			fault: { code: "entry_box_not_executable" },
		});
	});

	test("rejects source revision zero", () => {
		expect(() => normalize_project_source_snapshot({ ...expected, revision: "0" })).toThrow("Published source revision must be positive");
	});

	test("rejects duplicate Realm identity", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				realms: [...expected.realms, expected.realms[0]],
			}),
		).toThrow("Published source contains duplicate Realm identity");
	});

	test("rejects duplicate normalized Realm names", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				realms: [...expected.realms, { ...expected.realms[1], id: indexed_id(99), name: "Cafe\u0301" }],
			}),
		).toThrow("Published source contains duplicate Realm name");
	});

	test("requires exactly one primary Realm", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				realms: expected.realms.map((realm) => ({
					...realm,
					is_primary: false,
				})),
			}),
		).toThrow("Published source must contain exactly one primary Realm");
	});

	test("rejects a Box whose Realm is missing", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [
					{
						...expected.boxes[0],
						realm_id: "00000000-0000-4000-8000-000000000099",
					},
				],
			}),
		).toThrow("Published source Box Realm is missing");
	});

	test("rejects duplicate Box identity", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [...expected.boxes, expected.boxes[0]],
			}),
		).toThrow("Published source contains duplicate Box identity");
	});

	test("rejects duplicate normalized sibling Box names", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [...expected.boxes, { ...expected.boxes[1], id: indexed_id(98), name: " Product " }],
			}),
		).toThrow("Published source contains duplicate sibling Box name");
	});

	test("rejects a future Box document version", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [{ ...expected.boxes[0], document_version: "8" }],
			}),
		).toThrow("Published source Box document version is from the future");
	});

	test("rejects a missing Box parent", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [
					expected.boxes[0],
					{
						...expected.boxes[1],
						parent_id: "00000000-0000-4000-8000-000000000099",
					},
				],
			}),
		).toThrow("Published source Box parent is missing");
	});

	test("rejects a cross-Realm Box parent", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [expected.boxes[0], { ...expected.boxes[1], realm_id: SECONDARY_REALM_ID }],
			}),
		).toThrow("Published source Box parent belongs to another Realm");
	});

	test("rejects a cyclic Box hierarchy", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				boxes: [
					{ ...expected.boxes[0], parent_id: CHILD_BOX_ID },
					{ ...expected.boxes[1], parent_id: ROOT_BOX_ID },
				],
			}),
		).toThrow("Published source Box hierarchy contains a cycle");
	});

	test("distinguishes canonical stored wire from normalizable input", () => {
		expect(is_canonical_project_source_snapshot(expected)).toBe(true);
		expect(
			is_canonical_project_source_snapshot({
				...expected,
				project_id: PROJECT_ID.toUpperCase(),
				realms: [...expected.realms].reverse(),
			}),
		).toBe(false);
	});

	test("bounds the number of published Realms", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				realms: Array.from({ length: 257 }, (_, index) => ({
					id: indexed_id(1000 + index),
					name: `Realm ${index}`,
					is_primary: index === 0,
				})),
				boxes: [],
			}),
		).toThrow("Published source has too many Realms");
	});

	test("bounds the number of published Boxes", () => {
		expect(() =>
			normalize_project_source_snapshot({
				...expected,
				realms: [expected.realms[0]],
				boxes: Array.from({ length: 4097 }, (_, index) => ({
					...expected.boxes[0],
					id: indexed_id(10_000 + index),
				})),
			}),
		).toThrow("Published source has too many Boxes");
	});

	test("bounds canonical snapshot bytes before hashing or persistence", () => {
		const root_id = indexed_id(100_000);
		const document = {
			schema: "box.document.v1",
			root_id,
			nodes: [
				...Array.from({ length: 128 }, (_, index) => ({
					id: indexed_id(100_001 + index),
					kind: "scalar",
					value_type: "string",
				})),
				{
					id: root_id,
					kind: "record",
					fields: Array.from({ length: 128 }, (_, index) => ({
						id: indexed_id(200_001 + index),
						name: `${"x".repeat(115)}${index.toString().padStart(3, "0")}`,
						type_id: indexed_id(100_001 + index),
						required: true,
					})),
				},
			],
		};
		let failure: unknown;
		try {
			serialize_project_source_snapshot({
				...expected,
				realms: [expected.realms[0]],
				boxes: Array.from({ length: 300 }, (_, index) => ({
					...expected.boxes[0],
					id: indexed_id(300_000 + index),
					name: `Box ${index}`,
					document_version: "1",
					document,
				})),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("Published source snapshot exceeds 8 MiB");
	});
});

test("source revision inspection admits genesis and pending presentation repair without weakening publications", async () => {
	const { normalize_project_source_revision_snapshot } = await import("./project-source-snapshot.js");
	const project_id = crypto.randomUUID();
	const realm_id = crypto.randomUUID();
	const source = {
		schema: "project.source.snapshot.v1" as const,
		project_id,
		revision: "0",
		realms: [{ id: realm_id, name: "Main", is_primary: true }],
		boxes: [],
	};
	expect(normalize_project_source_revision_snapshot(source)).toEqual(source);
	expect(() => normalize_project_source_snapshot(source)).toThrow();
	const draft = {
		...source,
		revision: "1",
		boxes: [
			{
				id: crypto.randomUUID(),
				realm_id,
				parent_id: null,
				name: "Review",
				document_version: "0",
				document: { schema: "box.document.v1" as const, root_id: null, nodes: [] },
				presentation: { schema: "box.presentation.v1" as const, fields: [{ field_id: crypto.randomUUID(), label: { ru: "Поле", en: "Field" } }] },
			},
		],
	};
	expect(normalize_project_source_revision_snapshot(draft)).toEqual(draft);
	expect(() => normalize_project_source_snapshot(draft)).toThrow();
});
