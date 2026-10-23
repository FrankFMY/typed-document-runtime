import { expect, test } from "bun:test";
import { normalize_box_document } from "./box-document.js";
import { create_box_type_comparer } from "./box-type-system.js";

const id = (value: number): string => `62000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const schema = (target_id: string) =>
	normalize_box_document({
		schema: "box.document.v1",
		root_id: id(1),
		nodes: [
			{
				id: id(1),
				kind: "record",
				fields: [
					{
						id: id(2),
						name: "customer_id",
						type_id: id(3),
						required: true,
						record_target: { entity_id: target_id },
					},
				],
			},
			{ id: id(3), kind: "scalar", value_type: "string" },
		],
	});

test("record relation target participates in canonical structural type comparison", () => {
	const comparer = create_box_type_comparer();
	const left = schema(id(10));
	const same = schema(id(10));
	const retargeted = schema(id(11));

	expect(comparer.same_type(left, left.root_id!, same, same.root_id!)).toBe(true);
	expect(comparer.same_type(left, left.root_id!, retargeted, retargeted.root_id!)).toBe(false);
});
