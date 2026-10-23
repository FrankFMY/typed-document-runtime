import { describe, expect, test } from "bun:test";
import {
	is_canonical_box_presentation,
	normalize_box_presentation,
	normalize_box_presentation_shape,
	record_action_input_names,
} from "./box-presentation.js";
import type { ProcessDocument } from "./process-document.js";
import type { PublishedDocument } from "./published-document.js";
import { normalize_process_document } from "./process-document.js";

const ROOT_ID = "10000000-0000-4000-8000-000000000001";
const STRING_ID = "10000000-0000-4000-8000-000000000002";
const NUMBER_ID = "10000000-0000-4000-8000-000000000003";
const BOOLEAN_ID = "10000000-0000-4000-8000-000000000004";
const RECORD_ID = "10000000-0000-4000-8000-000000000005";
const TITLE_FIELD_ID = "20000000-0000-4000-8000-000000000001";
const NUMBER_FIELD_ID = "20000000-0000-4000-8000-000000000002";
const BOOLEAN_FIELD_ID = "20000000-0000-4000-8000-000000000003";
const NESTED_FIELD_ID = "20000000-0000-4000-8000-000000000004";
const NESTED_TEXT_FIELD_ID = "20000000-0000-4000-8000-000000000005";
const SECOND_BOOLEAN_FIELD_ID = "20000000-0000-4000-8000-000000000006";
const TARGET_ENTITY_ID = "30000000-0000-4000-8000-000000000001";

const document: PublishedDocument = {
	schema: "box.document.v1",
	root_id: ROOT_ID,
	nodes: [
		{ id: STRING_ID, kind: "scalar", value_type: "string" },
		{ id: NUMBER_ID, kind: "scalar", value_type: "number" },
		{ id: BOOLEAN_ID, kind: "scalar", value_type: "boolean" },
		{
			id: RECORD_ID,
			kind: "record",
			fields: [
				{
					id: NESTED_TEXT_FIELD_ID,
					name: "text",
					type_id: STRING_ID,
					required: true,
				},
			],
		},
		{
			id: ROOT_ID,
			kind: "record",
			fields: [
				{
					id: TITLE_FIELD_ID,
					name: "title",
					type_id: STRING_ID,
					required: true,
				},
				{
					id: NUMBER_FIELD_ID,
					name: "priority",
					type_id: NUMBER_ID,
					required: true,
				},
				{
					id: BOOLEAN_FIELD_ID,
					name: "active",
					type_id: BOOLEAN_ID,
					required: true,
				},
				{ id: SECOND_BOOLEAN_FIELD_ID, name: "ready", type_id: BOOLEAN_ID, required: false },
				{
					id: NESTED_FIELD_ID,
					name: "details",
					type_id: RECORD_ID,
					required: true,
				},
			],
		},
	],
};

const canonical = {
	schema: "box.presentation.v1" as const,
	label: { ru: "Заявка", en: "Request" },
	description: { ru: "Описание {буквально}", en: "Description {literal}" },
	fields: [
		{ field_id: TITLE_FIELD_ID, label: { ru: "Заголовок", en: "Title" } },
		{
			field_id: NUMBER_FIELD_ID,
			label: { ru: "Приоритет", en: "Priority" },
			value_labels: [
				{ value: 0, label: { ru: "Нулевой", en: "Zero" } },
				{ value: 2, label: { ru: "Высокий", en: "High" } },
			],
		},
		{
			field_id: BOOLEAN_FIELD_ID,
			label: { ru: "Активна", en: "Active" },
			help: { ru: "Показывать в работе", en: "Show in work" },
			value_labels: [
				{ value: false, label: { ru: "Нет", en: "No" } },
				{ value: true, label: { ru: "Да", en: "Yes" } },
			],
		},
	],
	record_title_field_id: TITLE_FIELD_ID,
};
const conditioned_section = (id: string, field_id: string, source: string) => ({ id, label: { ru: "Раздел", en: "Section" }, field_ids: [field_id], visible_when: { field_id: source, operator: "equal", value: true } });

describe("Box presentation v1", () => {
	test("admits one typed scalar condition for choices, thresholds, and false while rejecting malformed or mismatched operators", () => {
		const condition = { field_id: TITLE_FIELD_ID, operator: "equal" as const, value: "replacement" };
		const source = { ...canonical, fields: [{ ...canonical.fields[1], visible_when: condition }], form_layouts: [{ record_type_id: ROOT_ID, sections: [{ id: TARGET_ENTITY_ID, label: { ru: "Детали", en: "Details" }, field_ids: [BOOLEAN_FIELD_ID], visible_when: { field_id: NUMBER_FIELD_ID, operator: "greater_or_equal", value: 10 } }] }] };
		expect(normalize_box_presentation(source, document).fields[0]?.visible_when).toEqual(condition);
		for (const visible_when of [
			{ field_id: BOOLEAN_FIELD_ID, operator: "equal", value: false },
			{ field_id: NUMBER_FIELD_ID, operator: "less_than", value: 0 },
			{ field_id: TITLE_FIELD_ID, operator: "not_equal", value: "old" },
		]) expect(normalize_box_presentation({ ...canonical, fields: [{ ...canonical.fields[visible_when.field_id === NUMBER_FIELD_ID ? 0 : 1], visible_when }] }, document).fields[0]?.visible_when?.field_id).toBe(visible_when.field_id);
		for (const visible_when of [
			{ field_id: TITLE_FIELD_ID, operator: "at_least", value: "wrong" },
			{ field_id: NUMBER_FIELD_ID, operator: "less_than", value: "10" },
			{ field_id: BOOLEAN_FIELD_ID, operator: "equal", value: "false" },
			{ field_id: NUMBER_FIELD_ID, operator: "equal", value: Number.POSITIVE_INFINITY },
		]) expect(() => normalize_box_presentation({ ...canonical, fields: [{ ...canonical.fields[0], visible_when }] }, document)).toThrow();
		expect(() => normalize_box_presentation_shape({ ...canonical, fields: [{ ...canonical.fields[0], visible_when_field_id: BOOLEAN_FIELD_ID }] })).toThrow();
	});
	test("rejects transitive field and section visibility cycles together", () => {
		const layout = { record_type_id: ROOT_ID, sections: [conditioned_section(TARGET_ENTITY_ID, BOOLEAN_FIELD_ID, SECOND_BOOLEAN_FIELD_ID), conditioned_section("30000000-0000-4000-8000-000000000002", SECOND_BOOLEAN_FIELD_ID, BOOLEAN_FIELD_ID)] };
		expect(() => normalize_box_presentation({ ...canonical, form_layouts: [layout] }, document)).toThrow("cycle");
		const mixed = { ...layout, sections: [conditioned_section(TARGET_ENTITY_ID, BOOLEAN_FIELD_ID, SECOND_BOOLEAN_FIELD_ID)] };
		expect(() => normalize_box_presentation({ ...canonical, fields: [{ field_id: SECOND_BOOLEAN_FIELD_ID, label: { ru: "Готово", en: "Ready" }, visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }], form_layouts: [mixed] }, document)).toThrow("cycle");
	});
	test("feedback binds an authored rejection code only to the Process public input closure", () => {
		const process = normalize_process_document({
			...document, schema: "process.document.v1", input_cell_ids: [NESTED_FIELD_ID], output_cell_ids: [TITLE_FIELD_ID], effects: [],
			program: { schema: "process.program.v1", body: [{ id: TARGET_ENTITY_ID, kind: "reject_if", code: "needs_reason", condition: { id: "30000000-0000-4000-8000-000000000002", kind: "literal", type_id: BOOLEAN_ID, value: true } }] },
		});
		const entry = { code: "needs_reason", field_id: NESTED_TEXT_FIELD_ID, message: { ru: "Объясните", en: "Give a reason" } };
		expect(normalize_box_presentation({ schema: "box.presentation.v1", fields: [], rejection_feedback: [entry] }, process).rejection_feedback).toEqual([entry]);
		for (const change of [{ code: "absent" }, { field_id: TITLE_FIELD_ID }])
			expect(() => normalize_box_presentation({ schema: "box.presentation.v1", fields: [], rejection_feedback: [{ ...entry, ...change }] }, process)).toThrow();
	});
	test("keeps existing private Process grouping source valid while conditional references remain public", () => {
		const process = normalize_process_document({
			...document, schema: "process.document.v1", input_cell_ids: [TITLE_FIELD_ID], output_cell_ids: [], effects: [],
			program: { schema: "process.program.v1", body: [] },
		});
		const layout = { record_type_id: ROOT_ID, sections: [{ id: TARGET_ENTITY_ID, label: { ru: "Внутреннее", en: "Internal" }, field_ids: [BOOLEAN_FIELD_ID] }] };
		expect(normalize_box_presentation({ schema: "box.presentation.v1", fields: [], form_layouts: [layout] }, process).form_layouts).toEqual([layout]);
	});
	test("does not admit a Process form whose condition reads a private cell", () => {
		const process = normalize_process_document({
			...document, schema: "process.document.v1", input_cell_ids: [TITLE_FIELD_ID], output_cell_ids: [], effects: [],
			program: { schema: "process.program.v1", body: [] },
		});
		expect(() => normalize_box_presentation({ schema: "box.presentation.v1", fields: [{ field_id: TITLE_FIELD_ID, label: { ru: "Имя", en: "Name" }, visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }] }, process)).toThrow("public Process input");
	});
	test("admits typed direct form conditions and distinct false/zero/empty initial values", () => {
		const source = {
			...canonical,
			fields: [
				{ ...canonical.fields[0], visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true }, initial_value: "" },
				{ ...canonical.fields[1], initial_value: 0 },
				{ ...canonical.fields[2], initial_value: false },
			],
			form_layouts: [{ record_type_id: ROOT_ID, sections: [{ id: TARGET_ENTITY_ID, label: { ru: "Детали", en: "Details" }, field_ids: [TITLE_FIELD_ID], visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }] }],
		};
		const normalized = normalize_box_presentation(source, document);
		expect(normalized.fields[0]?.initial_value).toBe("");
		expect(normalized.fields[1]?.initial_value).toBe(0);
		expect(normalized.fields[2]?.initial_value).toBe(false);
		expect(normalized.form_layouts?.[0]?.sections[0]?.visible_when?.field_id).toBe(BOOLEAN_FIELD_ID);
	});
	test("rejects a section that hides its own boolean switch", () => {
		expect(() => normalize_box_presentation({ ...canonical, form_layouts: [{ record_type_id: ROOT_ID, sections: [{ id: TARGET_ENTITY_ID, label: { ru: "Раздел", en: "Section" }, field_ids: [BOOLEAN_FIELD_ID, TITLE_FIELD_ID], visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }] }] }, document)).toThrow("Form section cannot hide its own condition field");
	});
	test("rejects non-boolean, self, and cyclic form dependencies without mutating source", () => {
		const base = [{ ...canonical.fields[0], visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }];
		for (const fields of [
			[{ ...base[0], visible_when: { field_id: NUMBER_FIELD_ID, operator: "equal", value: "1" } }],
			[{ ...canonical.fields[2], visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }],
			[{ ...canonical.fields[2], visible_when: { field_id: TITLE_FIELD_ID, operator: "equal", value: "x" } }, { ...canonical.fields[0], visible_when: { field_id: BOOLEAN_FIELD_ID, operator: "equal", value: true } }],
			[{ ...canonical.fields[1], initial_value: "0" }],
		]) expect(() => normalize_box_presentation({ ...canonical, fields }, document)).toThrow();
	});
	test("retains source-authored current-actor and clock filters on a numeric deadline", () => {
		const source = {
			...canonical,
			fields: [canonical.fields[0], { ...canonical.fields[1], input_format: "datetime_utc" }, ...canonical.fields.slice(2)],
			record_views: [{
				id: TARGET_ENTITY_ID, name: { ru: "Моя работа", en: "My work" },
				query: { include_archived: false, filters: [
					{ field_id: TITLE_FIELD_ID, operator: "equal", relative_value: "current_actor" },
					{ field_id: NUMBER_FIELD_ID, operator: "less_than", relative_value: "now" },
				], sort: { field_id: NUMBER_FIELD_ID, direction: "asc", missing_position: "last" } },
			}],
		};
		// A relative filter belongs to immutable source, not the literal data-query wire contract.
		const normalized = normalize_box_presentation(source, document);
		expect(JSON.stringify(normalized.record_views?.[0]?.query.filters)).toBe(JSON.stringify(source.record_views[0]!.query.filters));
		expect(normalized.fields.find((field) => field.field_id === NUMBER_FIELD_ID)?.input_format).toBe("datetime_utc");
	});
	test("rejects incompatible relative view conditions and nonnumeric datetime presentation", () => {
		const view = (filter: unknown) => ({ ...canonical, record_views: [{ id: TARGET_ENTITY_ID, name: { ru: "Очередь", en: "Queue" }, query: { include_archived: false, filters: [filter] } }] });
		for (const filter of [
			{ field_id: TITLE_FIELD_ID, operator: "equal", relative_value: "now" },
			{ field_id: NUMBER_FIELD_ID, operator: "less_than", relative_value: "current_actor" },
			{ field_id: TITLE_FIELD_ID, operator: "contains", relative_value: "current_actor" },
			{ field_id: TITLE_FIELD_ID, operator: "equal", relative_value: "current_actor", string_value: "someone" },
		]) expect(() => normalize_box_presentation(view(filter), document)).toThrow();
		expect(() => normalize_box_presentation({ ...canonical, fields: [{ ...canonical.fields[0], input_format: "datetime_utc" }] }, document)).toThrow();
	});
	test("normalizes one strict bilingual presentation deterministically", () => {
		const normalized = normalize_box_presentation(
			{
				...canonical,
				label: { ru: "  Заявка  ", en: " Request " },
				description: {
					ru: " Описание {буквально} ",
					en: " Description {literal} ",
				},
				fields: [
					canonical.fields[2],
					canonical.fields[0],
					{
						...canonical.fields[1],
						value_labels: [canonical.fields[1]!.value_labels![1], { ...canonical.fields[1]!.value_labels![0], value: -0 }],
					},
				],
				record_title_field_id: TITLE_FIELD_ID,
			},
			document,
		);

		expect(normalized).toEqual(canonical);
		expect(is_canonical_box_presentation(canonical, document)).toBe(true);
		expect(is_canonical_box_presentation({ ...canonical, fields: [...canonical.fields].reverse() }, document)).toBe(false);
	});

	test("rejects uppercase identifiers, incomplete locale pairs, unknown keys, and empty equivalents", () => {
		const uppercase_id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
		for (const invalid of [
			{ ...canonical, record_title_field_id: uppercase_id },
			{
				...canonical,
				fields: [{ ...canonical.fields[0], field_id: uppercase_id }, ...canonical.fields.slice(1)],
			},
			{ ...canonical, label: { ru: "Только русский" } },
			{ ...canonical, label: { ru: "", en: "Empty" } },
			{ ...canonical, extra: true },
			{ schema: "box.presentation.v1", fields: [] },
		]) {
			expect(() => normalize_box_presentation(invalid, document)).toThrow();
		}
		expect(() =>
			normalize_box_presentation(
				{
					...canonical,
					description: { ru: "😀".repeat(1025), en: "Description" },
				},
				document,
			),
		).toThrow();
	});

	test("binds field and value-label identities to the exact document", () => {
		const missing_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		const invalid = [
			{
				...canonical,
				fields: [canonical.fields[0], { ...canonical.fields[0] }],
			},
			{
				...canonical,
				fields: [{ field_id: missing_id, label: { ru: "Нет", en: "Missing" } }],
			},
			{
				...canonical,
				fields: [
					{
						field_id: NESTED_FIELD_ID,
						label: { ru: "Детали", en: "Details" },
						value_labels: [{ value: "x", label: { ru: "X", en: "X" } }],
					},
				],
			},
			{
				...canonical,
				fields: [
					{
						field_id: BOOLEAN_FIELD_ID,
						label: { ru: "Активна", en: "Active" },
						value_labels: [{ value: "yes", label: { ru: "Да", en: "Yes" } }],
					},
				],
			},
			{
				...canonical,
				fields: [
					{
						field_id: NUMBER_FIELD_ID,
						label: { ru: "Число", en: "Number" },
						value_labels: [
							{ value: 1, label: { ru: "Один", en: "One" } },
							{ value: 1, label: { ru: "Ещё один", en: "Another one" } },
						],
					},
				],
			},
		];
		for (const value of invalid) expect(() => normalize_box_presentation(value, document)).toThrow();
	});

	test("restricts a record title to a root string or number field of a data Box", () => {
		for (const record_title_field_id of [BOOLEAN_FIELD_ID, NESTED_FIELD_ID, NESTED_TEXT_FIELD_ID]) {
			expect(() => normalize_box_presentation({ ...canonical, record_title_field_id }, document)).toThrow(
				"Box presentation record title must reference a root string or number field",
			);
		}
		const executable: PublishedDocument = {
			...document,
			schema: "box.document.v2",
			program: { schema: "box.program.v1", body: [] },
		};
		expect(() => normalize_box_presentation(canonical, executable)).toThrow("Box presentation record title requires a data Box");
	});

	test("rejects a stored-record relationship as a record title", () => {
		const relation_document = structuredClone(document);
		const root = relation_document.nodes.find((node) => node.id === ROOT_ID);
		const title = root?.kind === "record" ? root.fields.find((field) => field.id === TITLE_FIELD_ID) : undefined;
		if (!title) throw new Error("title field fixture missing");
		title.record_target = { entity_id: TARGET_ENTITY_ID };
		expect(() => normalize_box_presentation(canonical, relation_document)).toThrow(
			"Box presentation record title cannot reference a stored-record relationship",
		);
	});

	test("accepts distinct contextual record ID and revision bindings to required string input paths", () => {
		const revision_field_id = "20000000-0000-4000-8000-000000000006";
		const process: ProcessDocument = {
			schema: "process.document.v1",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{
					id: RECORD_ID,
					kind: "record",
					fields: [
						{ id: NESTED_TEXT_FIELD_ID, name: "work_order_id", type_id: STRING_ID, required: true },
						{ id: revision_field_id, name: "expected_revision", type_id: STRING_ID, required: true },
					],
				},
				{
					id: ROOT_ID,
					kind: "record",
					fields: [{ id: NESTED_FIELD_ID, name: "input", type_id: RECORD_ID, required: true }],
				},
			],
			input_cell_ids: [NESTED_FIELD_ID],
			output_cell_ids: [],
			effects: [],
			program: { schema: "process.program.v1", body: [] },
		};
		const contextual = {
			schema: "box.presentation.v1" as const,
			label: { ru: "Завершить работу", en: "Complete work" },
			fields: [],
			record_action: {
				entity_id: "30000000-0000-4000-8000-000000000001",
				input_field_path: [NESTED_FIELD_ID, NESTED_TEXT_FIELD_ID],
				revision_input_field_path: [NESTED_FIELD_ID, revision_field_id],
			},
		};

		expect(normalize_box_presentation(contextual, process)).toEqual(contextual);
		expect(() =>
			normalize_box_presentation(
				{
					...contextual,
					record_action: {
						...contextual.record_action,
						revision_input_field_path: contextual.record_action.input_field_path,
					},
				},
				process,
			),
		).toThrow("Box presentation record action ID and revision paths must be distinct");
		const wrong_revision_type = structuredClone(process);
		wrong_revision_type.nodes.push({ id: NUMBER_ID, kind: "scalar", value_type: "number" });
		const nested = wrong_revision_type.nodes.find((node) => node.id === RECORD_ID);
		if (nested?.kind !== "record") throw new Error("Expected nested record fixture");
		nested.fields.find((field) => field.id === revision_field_id)!.type_id = NUMBER_ID;
		expect(() => normalize_box_presentation(contextual, wrong_revision_type)).toThrow(
			"Box presentation record action revision path must follow required Process inputs to a string field",
		);
	});

	test("resolves contextual path names in Process and public schema-only Box documents", () => {
		const process: ProcessDocument = {
			schema: "process.document.v1",
			root_id: ROOT_ID,
			nodes: [
				{ id: STRING_ID, kind: "scalar", value_type: "string" },
				{ id: RECORD_ID, kind: "record", fields: [{ id: NESTED_TEXT_FIELD_ID, name: "work_order_id", type_id: STRING_ID, required: true }] },
				{ id: ROOT_ID, kind: "record", fields: [{ id: NESTED_FIELD_ID, name: "input", type_id: RECORD_ID, required: true }] },
			],
			input_cell_ids: [NESTED_FIELD_ID],
			output_cell_ids: [],
			effects: [],
			program: { schema: "process.program.v1", body: [] },
		};
		expect(record_action_input_names(process, [NESTED_FIELD_ID, NESTED_TEXT_FIELD_ID])).toEqual(["input", "work_order_id"]);
		expect(
			record_action_input_names({ schema: "box.document.v1", root_id: process.root_id, nodes: process.nodes }, [
				NESTED_FIELD_ID,
				NESTED_TEXT_FIELD_ID,
			]),
		).toEqual(["input", "work_order_id"]);
		expect(record_action_input_names(process, [NESTED_TEXT_FIELD_ID])).toBeUndefined();
	});

	test("bounds canonical shape collections and UTF-8 serialized bytes", () => {
		const field = canonical.fields[0]!;
		expect(() =>
			normalize_box_presentation_shape({
				...canonical,
				fields: Array.from({ length: 129 }, () => field),
			}),
		).toThrow();
		const huge_fields = Array.from({ length: 128 }, (_, index) => ({
			field_id: `30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
			label: { ru: "😀".repeat(128), en: "😀".repeat(128) },
			help: { ru: "😀".repeat(1024), en: "😀".repeat(1024) },
		}));
		expect(() =>
			normalize_box_presentation_shape({
				schema: "box.presentation.v1",
				fields: huge_fields,
			}),
		).toThrow("Box presentation exceeds 64 KiB");
		expect(() =>
			normalize_box_presentation_shape({
				...canonical,
				fields: [
					{
						...field,
						value_labels: Array.from({ length: 65 }, (_, value) => ({
							value,
							label: { ru: `${value}`, en: `${value}` },
						})),
					},
				],
			}),
		).toThrow();
	});
});
