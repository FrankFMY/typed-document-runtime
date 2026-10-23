import { expect, test } from "bun:test";
import { EMPTY_BOX_DOCUMENT } from "./box-document.js";
import { compare_project_source } from "./project-source-comparison.js";
import { parse_project_source_comparison } from "./project-source-history.js";
import { normalize_project_source_snapshot } from "./project-source-snapshot.js";

const project_id = crypto.randomUUID();
const realm_id = crypto.randomUUID();
const box_id = crypto.randomUUID();
const parent_id = crypto.randomUUID();
const source = () =>
	normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1",
		project_id,
		revision: "2",
		realms: [{ id: realm_id, name: "Main", is_primary: true }],
		boxes: [box_id, parent_id].map((id) => ({
			id,
			realm_id,
			parent_id: null,
			name: id === box_id ? "Review" : "Workshop",
			document_version: "0",
			document: EMPTY_BOX_DOCUMENT,
		})),
	});

test("compares structure by stable identity, retaining renames, moves, additions and removals", () => {
	const before = source();
	const after = source();
	after.revision = "5";
	const changed = after.boxes.find((box) => box.id === box_id)!;
	changed.name = "Approve work";
	changed.parent_id = parent_id;
	expect(compare_project_source(before, after)).toEqual([
		{ category: "structure", object_kind: "box", object_id: box_id, property: "name", before: "Review", after: "Approve work" },
		{ category: "structure", object_kind: "box", object_id: box_id, property: "parent_id", before: null, after: parent_id },
	]);
	const removed = structuredClone(before);
	removed.boxes = removed.boxes.filter((box) => box.id !== box_id);
	expect(compare_project_source(before, removed)).toEqual([expect.objectContaining({ object_id: box_id, property: "presence", after: null })]);
	expect(compare_project_source(removed, before)).toEqual([expect.objectContaining({ object_id: box_id, property: "presence", before: null })]);
});

const string_id = crypto.randomUUID();
const root_id = crypto.randomUUID();
const field_id = crypto.randomUUID();
const second_field_id = crypto.randomUUID();
const first_step = crypto.randomUUID();
const second_step = crypto.randomUUID();
const literal_id = crypto.randomUUID();
const second_literal_id = crypto.randomUUID();
const with_program = () => {
	const snapshot = source();
	const box = snapshot.boxes.find((item) => item.id === box_id)!;
	box.document_version = "1";
	box.document = {
		schema: "process.document.v1",
		root_id,
		nodes: [
			{ id: string_id, kind: "scalar", value_type: "string" },
			{
				id: root_id,
				kind: "record",
				fields: [
					{ id: field_id, name: "note", type_id: string_id, required: false },
					{ id: second_field_id, name: "status", type_id: string_id, required: false },
				],
			},
		],
		input_cell_ids: [],
		output_cell_ids: [field_id],
		effects: [],
		program: {
			schema: "process.program.v1",
			body: [
				{ id: first_step, kind: "write", cell_id: field_id, value: { id: literal_id, kind: "literal", type_id: string_id, value: "old" } },
				{
					id: second_step,
					kind: "write",
					cell_id: second_field_id,
					value: { id: second_literal_id, kind: "literal", type_id: string_id, value: "ready" },
				},
			],
		},
	};
	return normalize_project_source_snapshot(snapshot);
};

test("document version counters retain custody without inventing semantic changes", () => {
	const before = with_program();
	const after = structuredClone(before);
	after.revision = "3";
	after.boxes.find((box) => box.id === box_id)!.document_version = "2";
	const input = {
		project_id,
		from: { revision: before.revision, operation_id: crypto.randomUUID() },
		to: { revision: after.revision, operation_id: crypto.randomUUID() },
	};
	expect(compare_project_source(before, after)).toEqual([]);
	expect(compare_project_source(after, before)).toEqual([]);
	const evidence = {
		project_id,
		head_revision: after.revision,
		status: "ready" as const,
		from: { ...input.from, snapshot: before },
		to: { ...input.to, snapshot: after },
		changes: [],
	};
	expect(parse_project_source_comparison(evidence, input)).toEqual(evidence);
	expect(
		parse_project_source_comparison(
			{
				...evidence,
				changes: [
					{ category: "document", object_kind: "document", object_id: box_id, box_id, property: "document_version", before: "1", after: "2" },
				],
			},
			input,
		),
	).toBeNull();
});

test("explains field and expression edits and preserves explicit instruction order", () => {
	const before = with_program();
	const after = structuredClone(before);
	after.revision = "3";
	const box = after.boxes.find((item) => item.id === box_id)!;
	box.document_version = "2";
	const document = box.document;
	if (document.schema !== "process.document.v1") throw new Error("Expected Process");
	const root = document.nodes.find((node) => node.id === root_id)!;
	if (root.kind !== "record") throw new Error("Expected record");
	root.fields.find((field) => field.id === field_id)!.name = "review_note";
	const write = document.program.body[0]!;
	if (write.kind !== "write" || write.value.kind !== "literal") throw new Error("Expected literal write");
	write.value.value = "reviewed";
	document.program.body.reverse();
	const changes = compare_project_source(before, normalize_project_source_snapshot(after));
	expect(changes).toContainEqual(
		expect.objectContaining({
			category: "document",
			object_kind: "field",
			box_id,
			object_id: field_id,
			property: "name",
			before: "note",
			after: "review_note",
		}),
	);
	expect(changes).toContainEqual(
		expect.objectContaining({ object_kind: "expression", object_id: literal_id, property: "value", before: "old", after: "reviewed" }),
	);
	expect(changes).toContainEqual(
		expect.objectContaining({
			object_kind: "document",
			property: "program_order",
			before: [first_step, second_step],
			after: [second_step, first_step],
		}),
	);
	expect(changes.some((change) => change.property === "presence")).toBe(false);
});

test("separates descriptive changes and preserves the authored summary order", () => {
	const before = with_program();
	const box = before.boxes.find((item) => item.id === box_id)!;
	box.document = { schema: "box.document.v1", root_id: box.document.root_id, nodes: box.document.nodes };
	box.presentation = {
		schema: "box.presentation.v1",
		fields: [{ field_id, label: { ru: "Заметка", en: "Note" } }],
		record_summary_field_ids: [field_id, second_field_id],
		form_layouts: [
			{
				record_type_id: box.document.root_id!,
				sections: [{ id: crypto.randomUUID(), label: { ru: "Проверка", en: "Review" }, field_ids: [field_id, second_field_id] }],
			},
		],
	};
	const after = structuredClone(before);
	const changed = after.boxes.find((item) => item.id === box_id)!;
	changed.presentation!.fields[0]!.label.en = "Review note";
	changed.presentation!.record_summary_field_ids!.reverse();
	changed.presentation!.form_layouts![0]!.sections[0]!.field_ids.reverse();
	const changes = compare_project_source(normalize_project_source_snapshot(before), normalize_project_source_snapshot(after));
	expect(changes).toHaveLength(3);
	expect(changes).toContainEqual({
		category: "presentation",
		object_kind: "box",
		object_id: box_id,
		box_id,
		property: "record_summary_field_ids",
		before: [field_id, second_field_id],
		after: [second_field_id, field_id],
	});
	expect(changes).toContainEqual({
		category: "presentation",
		object_kind: "box",
		object_id: box_id,
		box_id,
		property: "form_layouts",
		before: box.presentation.form_layouts,
		after: changed.presentation!.form_layouts,
	});
	expect(changes).toContainEqual(
		expect.objectContaining({
			category: "presentation",
			object_kind: "field",
			object_id: field_id,
			property: "label",
			before: { ru: "Заметка", en: "Note" },
			after: { ru: "Заметка", en: "Review note" },
		}),
	);
});

test("records optional contextual revision binding changes in source presentation history", () => {
	const record_id = crypto.randomUUID();
	const expected_revision = crypto.randomUUID();
	const entity_id = parent_id;
	const entity_root_id = crypto.randomUUID();
	const before = with_program();
	const box = before.boxes.find((item) => item.id === box_id)!;
	const entity = before.boxes.find((item) => item.id === entity_id)!;
	entity.document_version = "1";
	entity.document = {
		schema: "box.document.v1",
		root_id: entity_root_id,
		nodes: [{ id: entity_root_id, kind: "record", fields: [] }],
	};
	if (box.document.schema !== "process.document.v1") throw new Error("Expected Process");
	const root = box.document.nodes.find((node) => node.id === root_id);
	if (root?.kind !== "record") throw new Error("Expected root record");
	root.fields = [
		{ id: record_id, name: "record_id", type_id: string_id, required: true },
		{ id: expected_revision, name: "expected_revision", type_id: string_id, required: true },
	];
	box.document.input_cell_ids = [record_id, expected_revision];
	box.document.output_cell_ids = [];
	box.document.program.body = [];
	box.presentation = {
		schema: "box.presentation.v1",
		fields: [],
		record_action: { entity_id, input_field_path: [record_id] },
	};
	const canonical_before = normalize_project_source_snapshot(before);
	const after = structuredClone(canonical_before);
	after.revision = "3";
	after.boxes.find((item) => item.id === box_id)!.presentation!.record_action!.revision_input_field_path = [expected_revision];
	const canonical_after = normalize_project_source_snapshot(after);
	expect(compare_project_source(canonical_before, canonical_after)).toContainEqual({
		category: "presentation",
		object_kind: "box",
		object_id: box_id,
		box_id,
		property: "record_action",
		before: { entity_id, input_field_path: [record_id] },
		after: { entity_id, input_field_path: [record_id], revision_input_field_path: [expected_revision] },
	});
});

test("browser comparison parser rederives all changes from exact canonical revision witnesses", () => {
	const before = with_program();
	const after = structuredClone(before);
	after.revision = "3";
	after.boxes.find((box) => box.id === box_id)!.name = "Approval";
	after.boxes.find((box) => box.id === parent_id)!.name = "Main workshop";
	after.boxes.find((box) => box.id === box_id)!.document_version = "2";
	const input = {
		project_id,
		from: { revision: before.revision, operation_id: crypto.randomUUID() },
		to: { revision: after.revision, operation_id: crypto.randomUUID() },
	};
	const result = {
		project_id,
		head_revision: "3",
		status: "ready" as const,
		from: { ...input.from, snapshot: before },
		to: { ...input.to, snapshot: after },
		changes: compare_project_source(before, after),
	};
	expect(parse_project_source_comparison(result, input)).toEqual(result);
	for (const invalid of [
		{ ...result, changes: [] },
		{ ...result, changes: undefined },
		{ ...result, changes: result.changes.toReversed() },
		{ ...result, changes: [...result.changes, result.changes[0]] },
		{ ...result, from: result.to, to: result.from },
		{ ...result, to: { ...result.to, operation_id: crypto.randomUUID() } },
		{ ...result, head_revision: "2" },
		{ ...result, from: { ...result.from, snapshot: { ...before, project_id: crypto.randomUUID() } } },
		{ ...result, to: { ...result.to, snapshot: { ...after, revision: "4" } } },
		{ ...result, to: { ...result.to, snapshot: { ...after, ignored: true } } },
		{ ...result, to: { ...result.to, snapshot: { ...after, boxes: [...after.boxes, after.boxes[0]] } } },
		{ ...result, unexpected: true },
	])
		expect(parse_project_source_comparison(invalid, input)).toBeNull();
	const parsed = parse_project_source_comparison(result, input)!;
	result.to.snapshot.boxes[0]!.name = "Mutated later";
	expect(parsed.status === "ready" && parsed.to.snapshot.boxes[0]!.name).not.toBe("Mutated later");
});

test("compares stable schema types, required fields, projections and effect declarations", () => {
	const before = with_program();
	const document = before.boxes.find((box) => box.id === box_id)!.document;
	if (document.schema !== "process.document.v1") throw new Error("Expected Process");
	const effect_id = crypto.randomUUID();
	document.effects.push({
		id: effect_id,
		capability: "example.read.v1",
		request_cell_id: field_id,
		result_cell_id: second_field_id,
		request_type_id: string_id,
		result_type_id: string_id,
	});
	document.program.body.push({ id: crypto.randomUUID(), kind: "effect", effect_id });
	const after = structuredClone(before);
	const changed = after.boxes.find((box) => box.id === box_id)!.document;
	if (changed.schema !== "process.document.v1") throw new Error("Expected Process");
	const scalar = changed.nodes.find((node) => node.id === string_id)!;
	if (scalar.kind !== "scalar") throw new Error("Expected scalar");
	scalar.value_type = "number";
	const root = changed.nodes.find((node) => node.id === root_id)!;
	if (root.kind !== "record") throw new Error("Expected record");
	root.fields.find((field) => field.id === field_id)!.required = true;
	changed.input_cell_ids = [field_id];
	changed.output_cell_ids = [second_field_id];
	changed.effects[0]!.capability = "example.read.v2";
	for (const [index, step] of changed.program.body.entries()) {
		if (step.kind === "effect") continue;
		if (step.kind !== "write" || step.value.kind !== "literal") throw new Error("Expected literal write");
		step.value.value = index;
	}
	const changes = compare_project_source(normalize_project_source_snapshot(before), normalize_project_source_snapshot(after));
	expect(changes).toContainEqual(
		expect.objectContaining({ object_kind: "type", object_id: string_id, property: "value_type", before: "string", after: "number" }),
	);
	expect(changes).toContainEqual(
		expect.objectContaining({ object_kind: "field", object_id: field_id, property: "required", before: false, after: true }),
	);
	expect(changes).toContainEqual(expect.objectContaining({ object_kind: "document", property: "input_cell_ids", before: [], after: [field_id] }));
	expect(changes).toContainEqual(
		expect.objectContaining({ object_kind: "document", property: "output_cell_ids", before: [field_id], after: [second_field_id] }),
	);
	expect(changes).toContainEqual(
		expect.objectContaining({
			object_kind: "effect",
			object_id: effect_id,
			property: "capability",
			before: "example.read.v1",
			after: "example.read.v2",
		}),
	);
	expect(changes.some((change) => change.property === "presence")).toBe(false);
});

test("one revision witness cannot describe two models or two revision numbers", () => {
	const snapshot = source();
	const other = structuredClone(snapshot);
	other.boxes[0]!.name = "Changed";
	const witness = { revision: snapshot.revision, operation_id: crypto.randomUUID() };
	const input = { project_id, from: witness, to: witness };
	const result = {
		project_id,
		status: "ready" as const,
		head_revision: "3",
		from: { ...witness, snapshot },
		to: { ...witness, snapshot: other },
		changes: compare_project_source(snapshot, other),
	};
	expect(parse_project_source_comparison(result, input)).toBeNull();
	const reused = { ...input, to: { ...witness, revision: "3" } };
	other.revision = "3";
	expect(parse_project_source_comparison({ ...result, to: { ...reused.to, snapshot: other } }, reused)).toBeNull();
	expect(parse_project_source_comparison({ ...result, to: result.from, changes: [] }, input)?.status).toBe("ready");
});
