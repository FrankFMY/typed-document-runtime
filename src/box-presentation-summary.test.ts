import { describe, expect, test } from "bun:test";
import { normalize_box_document } from "./box-document.js";
import { is_canonical_box_presentation, normalize_box_presentation, normalize_box_presentation_shape } from "./box-presentation.js";
import { normalize_process_document } from "./process-document.js";

const id = (index: number) => `b8100000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const root_fields = Array.from({ length: 7 }, (_, index) => ({
	id: id(10 + index),
	name: `f_${index}`,
	type_id: id(2),
	required: true,
}));
const document = normalize_box_document({
	schema: "box.document.v1",
	root_id: id(1),
	nodes: [
		{ id: id(1), kind: "record", fields: [...root_fields, { id: id(30), name: "nested", type_id: id(3), required: true }] },
		{ id: id(2), kind: "scalar", value_type: "string" },
		{ id: id(3), kind: "record", fields: [{ id: id(40), name: "child", type_id: id(2), required: true }] },
	],
});
const descriptor = (fields: string[]) => ({ schema: "box.presentation.v1" as const, fields: [], record_summary_field_ids: fields });
const form_layout_descriptor = (form_layouts: unknown) => ({ schema: "box.presentation.v1" as const, fields: [], form_layouts });

describe("source-owned ordered record summaries", () => {
	test("normalizes authored form sections for their exact record without changing authored order", () => {
		const input = {
			schema: "box.presentation.v1" as const,
			fields: [],
			form_layouts: [
				{
					record_type_id: id(1),
					sections: [
						{ id: id(101), label: { ru: "Основное", en: "General" }, field_ids: [id(12), id(10)] },
						{ id: id(102), label: { ru: "Дополнительно", en: "Additional" }, field_ids: [id(30)] },
					],
				},
			],
		};
		expect(normalize_box_presentation(input, document)).toEqual(input);
		expect(is_canonical_box_presentation(input, document)).toBe(true);
	});

	test("rejects empty, duplicate, dangling, and cross-record form layout references", () => {
		const section = { id: id(101), label: { ru: "Основное", en: "General" }, field_ids: [id(10)] };
		const layout = { record_type_id: id(1), sections: [section] };
		for (const invalid of [
			form_layout_descriptor([]),
			form_layout_descriptor([{ ...layout, sections: [] }]),
			form_layout_descriptor([{ ...layout, sections: [{ ...section, field_ids: [] }] }]),
			form_layout_descriptor([layout, { ...layout, sections: [{ ...section, id: id(102) }] }]),
			form_layout_descriptor([{ ...layout, sections: [section, { ...section, id: id(102) }] }]),
			form_layout_descriptor([layout, { record_type_id: id(3), sections: [{ ...section, field_ids: [id(40)] }] }]),
		]) {
			expect(() => normalize_box_presentation(invalid, document)).toThrow();
		}
		expect(() => normalize_box_presentation(form_layout_descriptor([{ ...layout, sections: [{ ...section, field_ids: [id(40)] }] }]), document)).toThrow(
			/belong to its record/iu,
		);
		expect(() =>
			normalize_box_presentation(
				form_layout_descriptor([{ record_type_id: id(999), sections: [{ ...section, field_ids: [id(10)] }] }]),
				document,
			),
		).toThrow(/record type/iu);
	});

	test("accepts explicit ordered root fields without changing the canonical document", () => {
		const before = JSON.stringify(document);
		const input = descriptor([id(12), id(10), id(30)]);
		expect(normalize_box_presentation(input, document)).toEqual(input);
		expect(is_canonical_box_presentation(input, document)).toBe(true);
		expect(JSON.stringify(document)).toBe(before);
	});

	test("distinguishes explicit no-summary from absent default behavior and a cleared descriptor", () => {
		const empty = descriptor([]);
		expect(normalize_box_presentation(empty, document)).toEqual(empty);
		const absent = normalize_box_presentation({ schema: "box.presentation.v1", fields: [], label: { ru: "Записи", en: "Records" } }, document);
		expect(Object.hasOwn(absent, "record_summary_field_ids")).toBe(false);
		expect(() => normalize_box_presentation({ schema: "box.presentation.v1", fields: [] }, document)).toThrow("must be cleared");
	});

	test("preserves an author's six-field order and rejects an oversized list", () => {
		const order = [id(15), id(12), id(10), id(14), id(11), id(13)];
		expect(normalize_box_presentation(descriptor(order), document)).toEqual(descriptor(order));
		expect(() => normalize_box_presentation(descriptor(root_fields.map((field) => field.id)), document)).toThrow();
	});

	test("rejects duplicate, malformed, missing and nested-only references instead of dropping them", () => {
		expect(() => normalize_box_presentation_shape(descriptor([id(10), id(10)]))).toThrow(/duplicate.*summary/iu);
		for (const invalid of [[id(10).toUpperCase()], ["not-a-field-id"]]) {
			expect(() => normalize_box_presentation_shape(descriptor(invalid))).toThrow();
		}
		for (const invalid of [[id(999)], [id(40)]]) {
			expect(() => normalize_box_presentation(descriptor(invalid), document)).toThrow(/root record field/iu);
		}
	});

	test("keeps summary metadata data-only, even for an explicit empty list", () => {
		const process = normalize_process_document({
			...document,
			schema: "process.document.v1",
			input_cell_ids: [],
			output_cell_ids: [],
			effects: [],
			program: { schema: "process.program.v1", body: [] },
		});
		const scalar = normalize_box_document({
			schema: "box.document.v1",
			root_id: id(2),
			nodes: [{ id: id(2), kind: "scalar", value_type: "string" }],
		});
		expect(() => normalize_box_presentation(descriptor([]), process)).toThrow(/data Box/iu);
		expect(() => normalize_box_presentation(descriptor([]), scalar)).toThrow(/root record/iu);
	});

	test("accepts canonical named working views by stable root field identity and rejects dangling fields or multiple defaults", () => {
		const views = {
			schema: "box.presentation.v1" as const,
			fields: [],
			record_views: [
				{
					id: id(100),
					name: { ru: "Срочные", en: "Urgent" },
					default: true as const,
					query: {
						include_archived: false,
						filters: [{ field_id: id(10), operator: "starts_with" as const, string_value: "A" }],
						sort: { field_id: id(11), direction: "desc" as const, missing_position: "last" as const },
					},
				},
			],
		};
		expect(normalize_box_presentation(views, document)).toEqual(views);
		expect(() =>
			normalize_box_presentation(
				{ ...views, record_views: [{ ...views.record_views[0]!, query: { ...views.record_views[0]!.query, filters: [{ field_id: id(999), operator: "is_missing" }] } }] },
				document,
			),
		).toThrow(/field/iu);
		expect(() =>
			normalize_box_presentation({ ...views, record_views: [...views.record_views, { ...views.record_views[0]!, id: id(101) }] }, document),
		).toThrow(/default/iu);
	});

	test("allows an explicitly selected title field without silently filtering it", () => {
		const input = { ...descriptor([id(10), id(11)]), record_title_field_id: id(10) };
		expect(normalize_box_presentation(input, document)).toEqual(input);
	});
});
