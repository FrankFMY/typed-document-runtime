import { expect, test } from "bun:test";
import { normalize_box_document } from "./box-document.js";
import { normalize_application_data_query } from "./application-data-query.js";
import type { OperationSchema } from "./process-contract.js";

const id = (index: number): string => `58000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const schema = normalize_box_document({
	schema: "box.document.v1",
	root_id: id(1),
	nodes: [
		{
			id: id(1),
			kind: "record",
			fields: [
				{ id: id(2), name: "name", type_id: id(10), required: true },
				{ id: id(3), name: "amount", type_id: id(11), required: false },
				{ id: id(4), name: "approved", type_id: id(12), required: false },
			],
		},
		{ id: id(10), kind: "scalar", value_type: "string" },
		{ id: id(11), kind: "scalar", value_type: "number" },
		{ id: id(12), kind: "scalar", value_type: "boolean" },
	],
}) as OperationSchema;

test("normalizes not-equal typed filters for open work queues", () => {
	expect(normalize_application_data_query(schema, {
		filters: [{ field_id: id(2), operator: "not_equal", string_value: "approved" }],
	}).filters).toEqual([{ field_id: id(2), operator: "not_equal", string_value: "approved" }]);
});

test("normalizes multiple typed filters by stable field identity without losing empty, zero, or false values", () => {
	expect(
		normalize_application_data_query(schema, {
			limit: 20,
			include_archived: true,
			filters: [
				{ field_id: id(2), operator: "equal", string_value: "" },
				{ field_id: id(3), operator: "at_least", number_value: 0 },
				{ field_id: id(4), operator: "equal", boolean_value: false },
			],
		}),
	).toEqual({
		limit: 20,
		include_archived: true,
		filters: [
			{ field_id: id(2), operator: "equal", string_value: "" },
			{ field_id: id(3), operator: "at_least", number_value: 0 },
			{ field_id: id(4), operator: "equal", boolean_value: false },
		],
	});
});
