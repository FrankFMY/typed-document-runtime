import { describe, expect, test } from "bun:test";
import {
	box_documents_equal,
	diff_box_documents,
	EMPTY_BOX_DOCUMENT,
	is_canonical_box_document,
	normalize_box_document,
	normalize_box_value,
	project_box_document_code,
	project_box_document_schema,
} from "./box-document.js";

const STRING_ID = "00000000-0000-4000-8000-000000000001";
const NUMBER_ID = "00000000-0000-4000-8000-000000000002";
const ROOT_ID = "00000000-0000-4000-8000-000000000003";
const ZETA_FIELD_ID = "00000000-0000-4000-8000-000000000004";
const ALPHA_FIELD_ID = "00000000-0000-4000-8000-000000000005";
const indexed_id = (index: number): string => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

describe("Box document", () => {
	test("exposes one immutable canonical empty document", () => {
		expect(EMPTY_BOX_DOCUMENT).toEqual({ schema: "box.document.v1", root_id: null, nodes: [] });
		expect(Object.isFrozen(EMPTY_BOX_DOCUMENT)).toBe(true);
		expect(Object.isFrozen(EMPTY_BOX_DOCUMENT.nodes)).toBe(true);
	});

	test("normalizes equivalent node and record-field ordering", () => {
		const first = normalize_box_document({
			schema: "box.document.v1",
			root_id: ROOT_ID.toUpperCase(),
			nodes: [
				{
					id: ROOT_ID.toUpperCase(),
					kind: "record",
					fields: [
						{ id: ZETA_FIELD_ID.toUpperCase(), name: " zeta ", type_id: NUMBER_ID.toUpperCase(), required: false },
						{ id: ALPHA_FIELD_ID, name: "alpha", type_id: STRING_ID, required: true },
					],
				},
				{ id: NUMBER_ID.toUpperCase(), kind: "scalar", value_type: "number" },
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
			],
		});
		const second = normalize_box_document({
			schema: "box.document.v1",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{ id: NUMBER_ID, kind: "scalar", value_type: "number" },
				{
					id: ROOT_ID,
					kind: "record",
					fields: [
						{ id: ALPHA_FIELD_ID, name: "alpha", type_id: STRING_ID, required: true },
						{ id: ZETA_FIELD_ID, name: "zeta", type_id: NUMBER_ID, required: false },
					],
				},
			],
		});

		expect(first).toEqual(second);
		expect(first).toEqual({
			schema: "box.document.v1",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{ id: NUMBER_ID, kind: "scalar", value_type: "number" },
				{
					id: ROOT_ID,
					kind: "record",
					fields: [
						{ id: ALPHA_FIELD_ID, name: "alpha", type_id: STRING_ID, required: true },
						{ id: ZETA_FIELD_ID, name: "zeta", type_id: NUMBER_ID, required: false },
					],
				},
			],
		});
	});

	test("compares semantic documents and detects their canonical wire form without Node APIs", () => {
		const letter_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const raw = {
			schema: "box.document.v1",
			root_id: letter_id.toUpperCase(),
			nodes: [{ id: letter_id.toUpperCase(), kind: "scalar", value_type: "string" }],
		};
		const canonical = normalize_box_document(raw);

		expect(box_documents_equal(raw, canonical)).toBe(true);
		expect(is_canonical_box_document(raw)).toBe(false);
		expect(is_canonical_box_document(canonical)).toBe(true);
		expect(
			box_documents_equal(canonical, {
				...canonical,
				nodes: [{ id: letter_id, kind: "scalar", value_type: "number" }],
			}),
		).toBe(false);
	});

	test("preserves an identity-bound record target on a string record field", () => {
		const target_id = "10000000-0000-4000-8000-000000000001";
		const document = normalize_box_document({
			schema: "box.document.v1",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{
					id: ROOT_ID,
					kind: "record",
					fields: [
						{
							id: ALPHA_FIELD_ID,
							name: "customer_id",
							type_id: STRING_ID,
							required: true,
							record_target: { entity_id: target_id.toUpperCase() },
						},
					],
				},
			],
		});
		const root = document.nodes.find((node) => node.id === document.root_id);
		const field = root?.kind === "record" ? (root.fields[0] as unknown as Record<string, unknown>) : undefined;

		expect(field?.record_target).toEqual({ entity_id: target_id });
		expect(is_canonical_box_document(document)).toBe(true);
	});

	test("rejects a record target on a non-string field", () => {
		expect(() =>
			normalize_box_document({
				schema: "box.document.v1",
				root_id: ROOT_ID,
				nodes: [
					{ id: NUMBER_ID, kind: "scalar", value_type: "number" },
					{
						id: ROOT_ID,
						kind: "record",
						fields: [
							{
								id: ALPHA_FIELD_ID,
								name: "customer_id",
								type_id: NUMBER_ID,
								required: true,
								record_target: { entity_id: "10000000-0000-4000-8000-000000000001" },
							},
						],
					},
				],
			}),
		).toThrow("Box document record target field must be a string");
	});

	test("normalizes homogeneous lists and explicit references", () => {
		const string_id = "00000000-0000-4000-8000-000000000010";
		const list_id = "00000000-0000-4000-8000-000000000011";
		const reference_id = "00000000-0000-4000-8000-000000000012";
		const root_id = "00000000-0000-4000-8000-000000000013";
		const list_field_id = "00000000-0000-4000-8000-000000000014";
		const reference_field_id = "00000000-0000-4000-8000-000000000015";
		const normalized = normalize_box_document({
			schema: "box.document.v1",
			root_id,
			nodes: [
				{
					id: root_id,
					kind: "record",
					fields: [
						{ id: reference_field_id, name: "selected", type_id: reference_id, required: false },
						{ id: list_field_id, name: "items", type_id: list_id, required: true },
					],
				},
				{ id: reference_id, kind: "reference", target_id: string_id },
				{ id: list_id, kind: "list", item_type_id: string_id },
				{ id: string_id, kind: "scalar", value_type: "string" },
			],
		});

		expect(normalized.nodes).toEqual([
			{ id: string_id, kind: "scalar", value_type: "string" },
			{ id: list_id, kind: "list", item_type_id: string_id },
			{ id: reference_id, kind: "reference", target_id: string_id },
			{
				id: root_id,
				kind: "record",
				fields: [
					{ id: list_field_id, name: "items", type_id: list_id, required: true },
					{ id: reference_field_id, name: "selected", type_id: reference_id, required: false },
				],
			},
		]);
	});

	test("rejects a cyclic type graph", () => {
		const first_id = "00000000-0000-4000-8000-000000000020";
		const second_id = "00000000-0000-4000-8000-000000000021";
		expect(() =>
			normalize_box_document({
				schema: "box.document.v1",
				root_id: first_id,
				nodes: [
					{ id: first_id, kind: "reference", target_id: second_id },
					{ id: second_id, kind: "reference", target_id: first_id },
				],
			}),
		).toThrow("Box document type graph contains a cycle");
	});

	test("rejects declarations unreachable from the document root", () => {
		const root_id = "00000000-0000-4000-8000-000000000030";
		const hidden_id = "00000000-0000-4000-8000-000000000031";
		expect(() =>
			normalize_box_document({
				schema: "box.document.v1",
				root_id,
				nodes: [
					{ id: root_id, kind: "scalar", value_type: "string" },
					{ id: hidden_id, kind: "scalar", value_type: "boolean" },
				],
			}),
		).toThrow("Box document contains unreachable declarations");
	});

	test("normalizes a typed record value through list, reference, and absence declarations", () => {
		const string_id = "00000000-0000-4000-8000-000000000040";
		const number_id = "00000000-0000-4000-8000-000000000041";
		const absence_id = "00000000-0000-4000-8000-000000000042";
		const list_id = "00000000-0000-4000-8000-000000000043";
		const reference_id = "00000000-0000-4000-8000-000000000044";
		const root_id = "00000000-0000-4000-8000-000000000045";
		const title_field_id = "00000000-0000-4000-8000-000000000046";
		const prices_field_id = "00000000-0000-4000-8000-000000000047";
		const selected_field_id = "00000000-0000-4000-8000-000000000048";
		const missing_field_id = "00000000-0000-4000-8000-000000000049";
		const document = normalize_box_document({
			schema: "box.document.v1",
			root_id,
			nodes: [
				{ id: string_id, kind: "scalar", value_type: "string" },
				{ id: number_id, kind: "scalar", value_type: "number" },
				{ id: absence_id, kind: "scalar", value_type: "absence" },
				{ id: list_id, kind: "list", item_type_id: number_id },
				{ id: reference_id, kind: "reference", target_id: string_id },
				{
					id: root_id,
					kind: "record",
					fields: [
						{ id: title_field_id, name: "title", type_id: string_id, required: true },
						{ id: prices_field_id, name: "prices", type_id: list_id, required: true },
						{ id: selected_field_id, name: "selected", type_id: reference_id, required: false },
						{ id: missing_field_id, name: "missing", type_id: absence_id, required: true },
					],
				},
			],
		});

		expect(normalize_box_value(document, { title: "Product", prices: [1, -0], missing: null })).toEqual({
			missing: null,
			prices: [1, 0],
			title: "Product",
		});
	});

	test("rejects sparse values for immutable List cells", () => {
		const number_id = "00000000-0000-4000-8000-000000000040";
		const list_id = "00000000-0000-4000-8000-000000000041";
		const sparse: number[] = [];
		sparse.length = 1;
		expect(() =>
			normalize_box_value(
				{
					schema: "box.document.v1",
					root_id: list_id,
					nodes: [
						{ id: number_id, kind: "scalar", value_type: "number" },
						{ id: list_id, kind: "list", item_type_id: number_id },
					],
				},
				sparse,
			),
		).toThrow("dense");
	});

	test("derives deterministic code and schema projections", () => {
		const scalar_id = "00000000-0000-4000-8000-000000000050";
		const root_id = "00000000-0000-4000-8000-000000000051";
		const field_id = "00000000-0000-4000-8000-000000000052";
		const document = normalize_box_document({
			schema: "box.document.v1",
			root_id,
			nodes: [
				{ id: root_id, kind: "record", fields: [{ id: field_id, name: "title", type_id: scalar_id, required: true }] },
				{ id: scalar_id, kind: "scalar", value_type: "string" },
			],
		});

		expect(project_box_document_code(document)).toBe(
			[
				"box.document.v1",
				`root ${root_id}`,
				`type ${scalar_id} = string`,
				`type ${root_id} = record {`,
				`  ${field_id} "title" required: ${scalar_id}`,
				"}",
			].join("\n"),
		);
		expect(project_box_document_schema(document)).toEqual({
			schema: "box.schema.v1",
			root_id,
			declarations: [
				{ id: scalar_id, type: "string" },
				{
					id: root_id,
					type: "record",
					fields: [{ id: field_id, name: "title", type_id: scalar_id, required: true }],
				},
			],
		});
	});

	test("diffs canonical documents by stable node identity", () => {
		const unchanged_id = "00000000-0000-4000-8000-000000000060";
		const removed_id = "00000000-0000-4000-8000-000000000061";
		const added_id = "00000000-0000-4000-8000-000000000062";
		const root_id = "00000000-0000-4000-8000-000000000063";
		const stable_field_id = "00000000-0000-4000-8000-000000000064";
		const old_field_id = "00000000-0000-4000-8000-000000000065";
		const new_field_id = "00000000-0000-4000-8000-000000000066";
		const before = {
			schema: "box.document.v1",
			root_id,
			nodes: [
				{ id: unchanged_id, kind: "scalar", value_type: "string" },
				{ id: removed_id, kind: "scalar", value_type: "number" },
				{
					id: root_id,
					kind: "record",
					fields: [
						{ id: stable_field_id, name: "name", type_id: unchanged_id, required: true },
						{ id: old_field_id, name: "old", type_id: removed_id, required: false },
					],
				},
			],
		};
		const after = {
			schema: "box.document.v1",
			root_id,
			nodes: [
				{
					id: root_id,
					kind: "record",
					fields: [
						{ id: new_field_id, name: "active", type_id: added_id, required: true },
						{ id: stable_field_id, name: "name", type_id: unchanged_id, required: true },
					],
				},
				{ id: added_id, kind: "scalar", value_type: "boolean" },
				{ id: unchanged_id, kind: "scalar", value_type: "string" },
			],
		};

		expect(diff_box_documents(before, after)).toEqual({
			root_changed: false,
			added_node_ids: [added_id],
			removed_node_ids: [removed_id],
			changed_node_ids: [root_id],
			program_changed: false,
			added_runtime_node_ids: [],
			removed_runtime_node_ids: [],
			changed_runtime_node_ids: [],
		});
	});

	test("bounds record declarations for deterministic processing", () => {
		const scalar_id = indexed_id(1000);
		const root_id = indexed_id(1001);
		const fields = Array.from({ length: 129 }, (_, index) => ({
			id: indexed_id(2000 + index),
			name: `field_${index.toString().padStart(3, "0")}`,
			type_id: scalar_id,
			required: true,
		}));
		expect(() =>
			normalize_box_document({
				schema: "box.document.v1",
				root_id,
				nodes: [
					{ id: scalar_id, kind: "scalar", value_type: "string" },
					{ id: root_id, kind: "record", fields },
				],
			}),
		).toThrow("Box document record has too many fields");
	});
});
