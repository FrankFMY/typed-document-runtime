import { describe, expect, test } from "bun:test";
import type { RuntimePublication } from "./runtime.js";
import { execute_project_runtime } from "./runtime.js";

const id = (index: number): string => `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const PROJECT_ID = id(1);
const PUBLICATION_ID = id(2);
const REALM_ID = id(3);
const BOX_ID = id(4);
const NUMBER_TYPE_ID = id(10);
const BOOLEAN_TYPE_ID = id(11);
const STRING_TYPE_ID = id(12);
const NUMBER_LIST_TYPE_ID = id(13);
const SUMMARY_TYPE_ID = id(14);
const ROOT_ID = id(15);

const ALL_POSITIVE_ID = id(20);
const COUNT_ID = id(21);
const MAPPED_ID = id(22);
const MULTIPLIER_ID = id(23);
const NUMBERS_ID = id(24);
const STATUS_ID = id(25);
const SUMMARY_ID = id(26);
const TOTAL_ID = id(27);
const TOTAL_COPY_ID = id(28);
const SUMMARY_ALL_POSITIVE_ID = id(30);
const SUMMARY_COUNT_ID = id(31);
const SUMMARY_TOTAL_ID = id(32);

const literal = (node_id: number, type_id: string, value: string | number | boolean | null) => ({
	id: id(node_id),
	kind: "literal" as const,
	type_id,
	value,
});
const cell = (node_id: number, type_id: string, cell_id: string) => ({ id: id(node_id), kind: "cell" as const, type_id, cell_id });
const binding = (node_id: number, type_id: string, binding_id: string) => ({
	id: id(node_id),
	kind: "binding" as const,
	type_id,
	binding_id,
});

const ITEM_BINDING_ID = id(200);
const FOLD_ITEM_BINDING_ID = id(201);
const ACCUMULATOR_BINDING_ID = id(202);
const EVERY_ITEM_BINDING_ID = id(203);

const publication: RuntimePublication = {
	id: PUBLICATION_ID,
	snapshot: {
		schema: "project.source.snapshot.v1",
		project_id: PROJECT_ID,
		revision: "7",
		realms: [{ id: REALM_ID, name: "Main", is_primary: true }],
		boxes: [
			{
				id: BOX_ID,
				realm_id: REALM_ID,
				parent_id: null,
				name: "Totals",
				document_version: "6",
				document: {
					schema: "box.document.v2",
					root_id: ROOT_ID,
					nodes: [
						{ id: NUMBER_TYPE_ID, kind: "scalar", value_type: "number" },
						{ id: BOOLEAN_TYPE_ID, kind: "scalar", value_type: "boolean" },
						{ id: STRING_TYPE_ID, kind: "scalar", value_type: "string" },
						{ id: NUMBER_LIST_TYPE_ID, kind: "list", item_type_id: NUMBER_TYPE_ID },
						{
							id: SUMMARY_TYPE_ID,
							kind: "record",
							fields: [
								{ id: SUMMARY_ALL_POSITIVE_ID, name: "all_positive", type_id: BOOLEAN_TYPE_ID, required: true },
								{ id: SUMMARY_COUNT_ID, name: "count", type_id: NUMBER_TYPE_ID, required: true },
								{ id: SUMMARY_TOTAL_ID, name: "total", type_id: NUMBER_TYPE_ID, required: true },
							],
						},
						{
							id: ROOT_ID,
							kind: "record",
							fields: [
								{ id: ALL_POSITIVE_ID, name: "all_positive", type_id: BOOLEAN_TYPE_ID, required: false },
								{ id: COUNT_ID, name: "count", type_id: NUMBER_TYPE_ID, required: false },
								{ id: MAPPED_ID, name: "mapped", type_id: NUMBER_LIST_TYPE_ID, required: false },
								{ id: MULTIPLIER_ID, name: "multiplier", type_id: NUMBER_TYPE_ID, required: true },
								{ id: NUMBERS_ID, name: "numbers", type_id: NUMBER_LIST_TYPE_ID, required: true },
								{ id: STATUS_ID, name: "status", type_id: STRING_TYPE_ID, required: false },
								{ id: SUMMARY_ID, name: "summary", type_id: SUMMARY_TYPE_ID, required: false },
								{ id: TOTAL_ID, name: "total", type_id: NUMBER_TYPE_ID, required: false },
								{ id: TOTAL_COPY_ID, name: "total_copy", type_id: NUMBER_TYPE_ID, required: false },
							],
						},
					],
					program: {
						schema: "box.program.v1",
						body: [
							{
								id: id(300),
								kind: "write",
								cell_id: MAPPED_ID,
								value: {
									id: id(301),
									kind: "list.map",
									type_id: NUMBER_LIST_TYPE_ID,
									list: cell(302, NUMBER_LIST_TYPE_ID, NUMBERS_ID),
									item_binding_id: ITEM_BINDING_ID,
									value: {
										id: id(303),
										kind: "binary",
										type_id: NUMBER_TYPE_ID,
										operator: "multiply",
										left: binding(304, NUMBER_TYPE_ID, ITEM_BINDING_ID),
										right: cell(305, NUMBER_TYPE_ID, MULTIPLIER_ID),
									},
								},
							},
							{
								id: id(310),
								kind: "write",
								cell_id: TOTAL_ID,
								value: {
									id: id(311),
									kind: "list.fold",
									type_id: NUMBER_TYPE_ID,
									list: cell(312, NUMBER_LIST_TYPE_ID, MAPPED_ID),
									initial: literal(313, NUMBER_TYPE_ID, 0),
									item_binding_id: FOLD_ITEM_BINDING_ID,
									accumulator_binding_id: ACCUMULATOR_BINDING_ID,
									value: {
										id: id(314),
										kind: "binary",
										type_id: NUMBER_TYPE_ID,
										operator: "add",
										left: binding(315, NUMBER_TYPE_ID, ACCUMULATOR_BINDING_ID),
										right: binding(316, NUMBER_TYPE_ID, FOLD_ITEM_BINDING_ID),
									},
								},
							},
							{
								id: id(320),
								kind: "write",
								cell_id: ALL_POSITIVE_ID,
								value: {
									id: id(321),
									kind: "list.every",
									type_id: BOOLEAN_TYPE_ID,
									list: cell(322, NUMBER_LIST_TYPE_ID, MAPPED_ID),
									item_binding_id: EVERY_ITEM_BINDING_ID,
									predicate: {
										id: id(323),
										kind: "binary",
										type_id: BOOLEAN_TYPE_ID,
										operator: "greater_than",
										left: binding(324, NUMBER_TYPE_ID, EVERY_ITEM_BINDING_ID),
										right: literal(325, NUMBER_TYPE_ID, 0),
									},
								},
							},
							{
								id: id(330),
								kind: "write",
								cell_id: COUNT_ID,
								value: {
									id: id(331),
									kind: "list.length",
									type_id: NUMBER_TYPE_ID,
									list: cell(332, NUMBER_LIST_TYPE_ID, MAPPED_ID),
								},
							},
							{
								id: id(340),
								kind: "write",
								cell_id: SUMMARY_ID,
								value: {
									id: id(341),
									kind: "record",
									type_id: SUMMARY_TYPE_ID,
									fields: [
										{ field_id: SUMMARY_ALL_POSITIVE_ID, value: cell(342, BOOLEAN_TYPE_ID, ALL_POSITIVE_ID) },
										{ field_id: SUMMARY_COUNT_ID, value: cell(343, NUMBER_TYPE_ID, COUNT_ID) },
										{ field_id: SUMMARY_TOTAL_ID, value: cell(344, NUMBER_TYPE_ID, TOTAL_ID) },
									],
								},
							},
							{
								id: id(350),
								kind: "write",
								cell_id: TOTAL_COPY_ID,
								value: {
									id: id(351),
									kind: "field",
									type_id: NUMBER_TYPE_ID,
									record: cell(352, SUMMARY_TYPE_ID, SUMMARY_ID),
									field_id: SUMMARY_TOTAL_ID,
								},
							},
							{
								id: id(360),
								kind: "write",
								cell_id: STATUS_ID,
								value: {
									id: id(361),
									kind: "select",
									type_id: STRING_TYPE_ID,
									condition: cell(362, BOOLEAN_TYPE_ID, ALL_POSITIVE_ID),
									when_true: literal(363, STRING_TYPE_ID, "ok"),
									when_false: literal(364, STRING_TYPE_ID, "invalid"),
								},
							},
						],
					},
				},
			},
		],
	},
};

describe("runtime expressions", () => {
	test("evaluates deterministic typed records and immutable List operations", () => {
		const result = execute_project_runtime({
			publication,
			entry_box_id: BOX_ID,
			input: [
				{ cell_id: NUMBERS_ID, value: [1, 2, 3] },
				{ cell_id: MULTIPLIER_ID, value: 2 },
			],
			output_cell_ids: [TOTAL_COPY_ID, SUMMARY_ID, STATUS_ID, MAPPED_ID],
			budget: { max_steps: 1_000, max_call_depth: 8, max_value_nodes: 1_000, max_string_units: 10_000 },
		});

		expect(result.status).toBe("success");
		if (result.status !== "success") throw new Error(result.status === "fault" ? result.fault.code : result.rejection.code);
		expect(result.outputs).toEqual([
			{ cell_id: MAPPED_ID, value: [2, 4, 6] },
			{ cell_id: STATUS_ID, value: "ok" },
			{ cell_id: SUMMARY_ID, value: { all_positive: true, count: 3, total: 12 } },
			{ cell_id: TOTAL_COPY_ID, value: 12 },
		]);
		expect(Object.isFrozen(result.outputs[0]?.value)).toBe(true);
		expect(Object.isFrozen(result.outputs[2]?.value)).toBe(true);
		expect(
			execute_project_runtime({
				publication,
				entry_box_id: BOX_ID,
				input: [
					{ cell_id: NUMBERS_ID, value: [1, 2, 3] },
					{ cell_id: MULTIPLIER_ID, value: 2 },
				],
				output_cell_ids: [TOTAL_COPY_ID, SUMMARY_ID, STATUS_ID, MAPPED_ID],
				budget: { max_steps: 1_000, max_call_depth: 8, max_value_nodes: 1_000, max_string_units: 10_000 },
			}),
		).toEqual(result);
	});

	test("records actual repeated expression values as detached immutable Box values", () => {
		const input_numbers = [1, 2, 3];
		const base_request = {
			publication,
			entry_box_id: BOX_ID,
			input: [
				{ cell_id: NUMBERS_ID, value: input_numbers },
				{ cell_id: MULTIPLIER_ID, value: 2 },
			],
			output_cell_ids: [TOTAL_COPY_ID, SUMMARY_ID, STATUS_ID, MAPPED_ID],
			budget: { max_steps: 1_000, max_call_depth: 8, max_value_nodes: 1_000, max_string_units: 10_000 },
		};
		const baseline = execute_project_runtime(base_request);
		const inspected = execute_project_runtime({ ...base_request, inspection: "values" });
		expect({ ...inspected, inspection: undefined }).toEqual({ ...baseline, inspection: undefined });
		expect(inspected.inspection?.values).toBe("recorded");
		const accumulator_reads = inspected.inspection?.events.filter((event) => event.expression_id === id(315));
		expect(accumulator_reads?.map((event) => event.value)).toEqual([
			{ status: "available", value: 0 },
			{ status: "available", value: 2 },
			{ status: "available", value: 6 },
		]);
		const input_event = inspected.inspection?.events.find((event) => event.kind === "cell.input" && event.cell_id === NUMBERS_ID);
		expect(input_event?.value).toEqual({ status: "available", value: [1, 2, 3] });
		if (input_event?.value?.status !== "available" || !Array.isArray(input_event.value.value)) throw new Error("List input inspection missing");
		expect(Object.isFrozen(input_event.value.value)).toBe(true);
		input_numbers[0] = 99;
		expect(input_event.value.value).toEqual([1, 2, 3]);
	});
});
