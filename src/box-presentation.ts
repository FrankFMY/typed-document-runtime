import { z } from "zod";
import type { ApplicationDataQueryFilter, ApplicationDataQuerySort } from "./application-data-query.js";
import { application_data_query_fields, normalize_application_data_query } from "./application-data-query.js";
import type { PublishedDocument } from "./published-document.js";
import { normalize_published_document } from "./published-document.js";
import { normalize_box_value_at } from "./box-document.js";
import { process_document_box_schema } from "./process-document.js";
import { compare_scalar } from "./scalar-comparison.js";
import type { ScalarComparisonOperator } from "./scalar-comparison.js";

export { compare_scalar } from "./scalar-comparison.js";

const MAX_LABEL_CODE_POINTS = 128;
const MAX_DESCRIPTION_CODE_POINTS = 1024;
const MAX_FIELDS = 128;
const MAX_VALUE_LABELS = 64;
const MAX_SUMMARY_FIELDS = 6;
const MAX_RECORD_VIEWS = 16;
const MAX_FORM_LAYOUTS = 128;
const MAX_FORM_SECTIONS = 32;
const MAX_FORM_SECTION_FIELDS = 128;
const MAX_PRESENTATION_BYTES = 64 * 1024;

export interface BilingualText {
	ru: string;
	en: string;
}

export type BoxPresentationScalarValue = string | number | boolean | null;
export interface BoxPresentationCondition { field_id: string; operator: ScalarComparisonOperator; value: string | number | boolean }
export const box_presentation_condition_matches = (condition: BoxPresentationCondition | undefined, value: unknown): boolean =>
	condition === undefined || compare_scalar(condition.operator, value, condition.value);

export interface BoxPresentationValueLabel {
	value: BoxPresentationScalarValue;
	label: BilingualText;
}

export interface BoxPresentationField {
	field_id: string;
	label: BilingualText;
	help?: BilingualText;
	value_labels?: BoxPresentationValueLabel[];
	input_format?: "datetime_utc";
	visible_when?: BoxPresentationCondition;
	initial_value?: BoxPresentationScalarValue;
}
export type BoxPresentationQueryFilter = ApplicationDataQueryFilter & { readonly relative_value?: "current_actor" | "now" };

export interface BoxPresentationRecordAction {
	entity_id: string;
	input_field_path: string[];
	revision_input_field_path?: string[];
}

export interface BoxPresentationRecordView {
	id: string;
	name: BilingualText;
	query: {
		include_archived: boolean;
		filters: BoxPresentationQueryFilter[];
		sort?: ApplicationDataQuerySort;
	};
	default?: true;
}

export interface BoxPresentationFormSection {
	id: string;
	label: BilingualText;
	field_ids: string[];
	visible_when?: BoxPresentationCondition;
}
export interface BoxPresentationRejectionFeedback {
	code: string;
	field_id: string;
	message: BilingualText;
}

export interface BoxPresentationFormLayout {
	record_type_id: string;
	sections: BoxPresentationFormSection[];
}

export interface BoxPresentation {
	schema: "box.presentation.v1";
	label?: BilingualText;
	description?: BilingualText;
	fields: BoxPresentationField[];
	record_title_field_id?: string;
	record_summary_field_ids?: string[];
	record_action?: BoxPresentationRecordAction;
	record_views?: BoxPresentationRecordView[];
	form_layouts?: BoxPresentationFormLayout[];
	rejection_feedback?: BoxPresentationRejectionFeedback[];
}

const normalized_text = (maximum: number): z.ZodType<string> =>
	z
		.string()
		.transform((value) => value.normalize("NFC").trim())
		.pipe(z.string().refine((value) => value.length > 0 && [...value].length <= maximum, "Некорректный текст презентации"));

const bilingual_label = z.strictObject({
	ru: normalized_text(MAX_LABEL_CODE_POINTS),
	en: normalized_text(MAX_LABEL_CODE_POINTS),
});
const bilingual_description = z.strictObject({
	ru: normalized_text(MAX_DESCRIPTION_CODE_POINTS),
	en: normalized_text(MAX_DESCRIPTION_CODE_POINTS),
});
const canonical_uuid = z.uuid().refine((value) => value === value.toLowerCase(), "Некорректный UUID презентации");
const scalar_value = z.union([
	z.string(),
	z
		.number()
		.finite()
		.transform((value) => (Object.is(value, -0) ? 0 : value)),
	z.boolean(),
	z.null(),
]);
const value_label = z.strictObject({
	value: scalar_value,
	label: bilingual_label,
});
const form_condition = z.strictObject({
	field_id: canonical_uuid,
	operator: z.enum(["equal", "not_equal", "less_than", "less_or_equal", "greater_than", "greater_or_equal"]),
	value: z.union([z.string(), z.number().finite().transform((value) => Object.is(value, -0) ? 0 : value), z.boolean()]),
});
const presentation_field = z.strictObject({
	field_id: canonical_uuid,
	label: bilingual_label,
	help: bilingual_description.optional(),
	value_labels: z.array(value_label).min(1).max(MAX_VALUE_LABELS).optional(),
	input_format: z.literal("datetime_utc").optional(),
	visible_when: form_condition.optional(),
	initial_value: scalar_value.optional(),
});
const query_filter = z.strictObject({
	field_id: canonical_uuid,
	operator: z.enum(["equal", "not_equal", "contains", "starts_with", "less_than", "at_most", "greater_than", "at_least", "is_missing", "is_present"]),
	string_value: z.string().optional(),
	number_value: z.number().finite().optional(),
	boolean_value: z.boolean().optional(),
	absence_value: z.null().optional(),
	relative_value: z.enum(["current_actor", "now"]).optional(),
});
const query_sort = z.strictObject({
	field_id: canonical_uuid,
	direction: z.enum(["asc", "desc"]),
	missing_position: z.enum(["first", "last"]),
});
const record_view = z.strictObject({
	id: canonical_uuid,
	name: bilingual_label,
	query: z.strictObject({
		include_archived: z.boolean(),
		filters: z.array(query_filter).max(8),
		sort: query_sort.optional(),
	}),
	default: z.literal(true).optional(),
});
const form_section = z.strictObject({
	id: canonical_uuid,
	label: bilingual_label,
	field_ids: z.array(canonical_uuid).min(1).max(MAX_FORM_SECTION_FIELDS),
	visible_when: form_condition.optional(),
});
const rejection_feedback = z.strictObject({
	code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/u),
	field_id: canonical_uuid,
	message: bilingual_description,
});
const form_layout = z.strictObject({
	record_type_id: canonical_uuid,
	sections: z.array(form_section).min(1).max(MAX_FORM_SECTIONS),
});
const presentation = z.strictObject({
	schema: z.literal("box.presentation.v1"),
	label: bilingual_label.optional(),
	description: bilingual_description.optional(),
	fields: z.array(presentation_field).max(MAX_FIELDS),
	record_title_field_id: canonical_uuid.optional(),
	record_summary_field_ids: z.array(canonical_uuid).max(MAX_SUMMARY_FIELDS).optional(),
	record_action: z
		.strictObject({
			entity_id: canonical_uuid,
			input_field_path: z.array(canonical_uuid).min(1).max(32),
			revision_input_field_path: z.array(canonical_uuid).min(1).max(32).optional(),
		})
		.optional(),
	record_views: z.array(record_view).max(MAX_RECORD_VIEWS).optional(),
	form_layouts: z.array(form_layout).min(1).max(MAX_FORM_LAYOUTS).optional(),
	rejection_feedback: z.array(rejection_feedback).min(1).max(128).optional(),
});

const compare_code_units = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const scalar_key = (value: BoxPresentationScalarValue): string => {
	if (value === null) return "0:null";
	if (typeof value === "boolean") return `1:${value ? "1" : "0"}`;
	if (typeof value === "number") return `2:${JSON.stringify(value)}`;
	return `3:${value}`;
};

const json_values_equal = (left: unknown, right: unknown): boolean => {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (!Object.hasOwn(left, index) || !Object.hasOwn(right, index) || !json_values_equal(left[index], right[index])) return false;
		}
		return true;
	}
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	const left_record = left as Record<string, unknown>;
	const right_record = right as Record<string, unknown>;
	const left_keys = Object.keys(left_record);
	if (left_keys.length !== Object.keys(right_record).length) return false;
	return left_keys.every((key) => Object.hasOwn(right_record, key) && json_values_equal(left_record[key], right_record[key]));
};

export const normalize_box_presentation_shape = (input: unknown): BoxPresentation => {
	const parsed = presentation.parse(input);
	if (
		!parsed.label &&
		!parsed.description &&
		parsed.fields.length === 0 &&
		!parsed.record_title_field_id &&
		parsed.record_summary_field_ids === undefined &&
		!parsed.record_action &&
		parsed.record_views === undefined &&
		parsed.form_layouts === undefined &&
		parsed.rejection_feedback === undefined
	) {
		throw new Error("Empty Box presentation must be cleared");
	}

	if (parsed.record_summary_field_ids && new Set(parsed.record_summary_field_ids).size !== parsed.record_summary_field_ids.length) {
		throw new Error("Box presentation contains duplicate record summary field reference");
	}
	if (parsed.record_views) {
		if (new Set(parsed.record_views.map((view) => view.id)).size !== parsed.record_views.length) {
			throw new Error("Box presentation contains duplicate record view identity");
		}
		if (parsed.record_views.filter((view) => view.default).length > 1) throw new Error("Box presentation contains multiple default record views");
	}
	if (parsed.form_layouts) {
		if (new Set(parsed.form_layouts.map((layout) => layout.record_type_id)).size !== parsed.form_layouts.length) {
			throw new Error("Box presentation contains duplicate form layout record reference");
		}
		const section_ids = new Set<string>();
		for (const layout of parsed.form_layouts) {
			const assigned_fields = new Set<string>();
			for (const section of layout.sections) {
				if (section_ids.has(section.id)) throw new Error("Box presentation contains duplicate form section identity");
				section_ids.add(section.id);
				for (const field_id of section.field_ids) {
					if (assigned_fields.has(field_id)) throw new Error("Box presentation assigns a form field more than once");
					assigned_fields.add(field_id);
				}
			}
		}
	}
	if (parsed.rejection_feedback && new Set(parsed.rejection_feedback.map((entry) => `${entry.code}:${entry.field_id}`)).size !== parsed.rejection_feedback.length) {
		throw new Error("Box presentation contains duplicate rejection feedback");
	}

	const seen_fields = new Set<string>();
	const fields = parsed.fields.map((field) => {
		if (seen_fields.has(field.field_id)) throw new Error("Box presentation contains duplicate field reference");
		seen_fields.add(field.field_id);
		let value_labels: BoxPresentationValueLabel[] | undefined;
		if (field.value_labels) {
			const seen_values = new Set<string>();
			value_labels = field.value_labels.map((entry) => {
				const key = scalar_key(entry.value);
				if (seen_values.has(key)) throw new Error("Box presentation contains duplicate scalar value label");
				seen_values.add(key);
				return entry;
			});
			value_labels.sort((left, right) => compare_code_units(scalar_key(left.value), scalar_key(right.value)));
		}
		return {
			field_id: field.field_id,
			label: field.label,
			...(field.help ? { help: field.help } : {}),
			...(value_labels ? { value_labels } : {}),
			...(field.input_format ? { input_format: field.input_format } : {}),
			...(field.visible_when ? { visible_when: field.visible_when } : {}),
			...(Object.hasOwn(field, "initial_value") ? { initial_value: field.initial_value } : {}),
		};
	});
	fields.sort((left, right) => compare_code_units(left.field_id, right.field_id));
	const normalized: BoxPresentation = {
		schema: parsed.schema,
		...(parsed.label ? { label: parsed.label } : {}),
		...(parsed.description ? { description: parsed.description } : {}),
		fields,
		...(parsed.record_title_field_id ? { record_title_field_id: parsed.record_title_field_id } : {}),
		...(parsed.record_summary_field_ids === undefined ? {} : { record_summary_field_ids: parsed.record_summary_field_ids }),
		...(parsed.record_action ? { record_action: parsed.record_action } : {}),
		...(parsed.record_views ? { record_views: parsed.record_views } : {}),
		...(parsed.form_layouts
			? { form_layouts: [...parsed.form_layouts].sort((left, right) => compare_code_units(left.record_type_id, right.record_type_id)) }
			: {}),
		...(parsed.rejection_feedback ? { rejection_feedback: [...parsed.rejection_feedback].sort((a, b) => compare_code_units(`${a.code}:${a.field_id}`, `${b.code}:${b.field_id}`)) } : {}),
	};
	if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_PRESENTATION_BYTES) {
		throw new Error("Box presentation exceeds 64 KiB");
	}
	return normalized;
};

export const is_canonical_box_presentation_shape = (input: unknown): input is BoxPresentation => {
	try {
		return json_values_equal(input, normalize_box_presentation_shape(input));
	} catch {
		return false;
	}
};

export const record_action_input_names = (document: PublishedDocument, path: readonly string[]): readonly string[] | undefined => {
	if (path.length === 0 || path.length > 32 || document.root_id === null) return undefined;
	const nodes = new Map(document.nodes.map((node) => [node.id, node]));
	const resolve = (type_id: string): (typeof document.nodes)[number] | undefined => {
		const seen = new Set<string>();
		let node = nodes.get(type_id);
		while (node?.kind === "reference") {
			if (seen.has(node.id)) return undefined;
			seen.add(node.id);
			node = nodes.get(node.target_id);
		}
		return node;
	};
	let node = resolve(document.root_id);
	const names: string[] = [];
	for (const [index, field_id] of path.entries()) {
		if (node?.kind !== "record") return undefined;
		const field = node.fields.find((candidate) => candidate.id === field_id);
		if (!field || !field.required) return undefined;
		if (index === 0 && document.schema === "process.document.v1" && !document.input_cell_ids.includes(field.id)) return undefined;
		names.push(field.name);
		node = resolve(field.type_id);
	}
	if (node?.kind !== "scalar" || node.value_type !== "string") return undefined;
	return Object.freeze(names);
};

export const normalize_box_presentation = (input: unknown, document_input: PublishedDocument): BoxPresentation => {
	const parsed = normalize_box_presentation_shape(input);
	const document = normalize_published_document(document_input);

	const field_by_id = new Map(
		document.nodes.flatMap((node) => (node.kind === "record" ? node.fields.map((field) => [field.id, field] as const) : [])),
	);
	const node_by_id = new Map(document.nodes.map((node) => [node.id, node]));
	const public_input_fields = new Set<string>();
	if (document.schema === "process.document.v1") {
		const visited = new Set<string>();
		const visit = (type_id: string): void => {
			if (visited.has(type_id)) return;
			visited.add(type_id);
			const node = node_by_id.get(type_id);
			if (node?.kind === "reference") visit(node.target_id);
			else if (node?.kind === "list") visit(node.item_type_id);
			else if (node?.kind === "record") {
				for (const field of node.fields) { public_input_fields.add(field.id); visit(field.type_id); }
			}
		};
		const root = node_by_id.get(document.root_id);
		if (root?.kind === "record") {
			for (const field of root.fields) if (document.input_cell_ids.includes(field.id)) { public_input_fields.add(field.id); visit(field.type_id); }
		}
	}
	const scalar_type = (type_id: string): "string" | "number" | "boolean" | "absence" | null => {
		let node = node_by_id.get(type_id);
		while (node?.kind === "reference") node = node_by_id.get(node.target_id);
		return node?.kind === "scalar" ? node.value_type : null;
	};
	for (const field of parsed.fields) {
		const document_field = field_by_id.get(field.field_id);
		if (!document_field) throw new Error("Box presentation field is missing from its document");
		if (field.input_format && scalar_type(document_field.type_id) !== "number") throw new Error("Datetime presentation requires a number field");
		if (Object.hasOwn(field, "initial_value")) {
			if (scalar_type(document_field.type_id) === null) throw new Error("Initial value requires a scalar field");
			normalize_box_value_at(document.schema === "process.document.v1" ? process_document_box_schema(document) : document, document_field.type_id, field.initial_value);
		}
		if (!field.value_labels) continue;
		const expected_type = scalar_type(document_field.type_id);
		if (!expected_type) throw new Error("Box presentation value labels require a scalar field");
		for (const entry of field.value_labels) {
			const actual_type = entry.value === null ? "absence" : typeof entry.value;
			if (actual_type !== expected_type) throw new Error("Box presentation scalar value label has the wrong type");
		}
	}

	const owner_by_field = new Map(document.nodes.flatMap((node) => node.kind === "record" ? node.fields.map((field) => [field.id, node] as const) : []));
	const validate_condition = (owner_id: string, condition: BoxPresentationCondition, target_id?: string): void => {
		const owner = node_by_id.get(owner_id);
		const source = owner?.kind === "record" ? owner.fields.find((field) => field.id === condition.field_id) : undefined;
		const type = source ? scalar_type(source.type_id) : null;
		if (!source || !type || type === "absence" || target_id === condition.field_id || typeof condition.value !== type ||
			(!["equal", "not_equal"].includes(condition.operator) && type !== "number")) {
			throw new Error("Form condition requires a matching scalar field and operator of the same record");
		}
		if (document.schema === "process.document.v1" && (!public_input_fields.has(condition.field_id) || (target_id !== undefined && !public_input_fields.has(target_id)))) {
			throw new Error("Form condition must reference a public Process input field");
		}
	};
	for (const field of parsed.fields) if (field.visible_when) {
		const owner = owner_by_field.get(field.field_id);
		if (!owner) throw new Error("Form condition target is missing");
		validate_condition(owner.id, field.visible_when, field.field_id);
	}

	if (parsed.record_summary_field_ids !== undefined) {
		if (document.schema !== "box.document.v1") throw new Error("Box presentation record summary requires a data Box");
		const root = document.nodes.find((node) => node.id === document.root_id);
		if (root?.kind !== "record") throw new Error("Box presentation record summary requires a root record");
		const root_field_ids = new Set(root.fields.map((field) => field.id));
		if (parsed.record_summary_field_ids.some((field_id) => !root_field_ids.has(field_id))) {
			throw new Error("Box presentation record summary must reference a root record field");
		}
	}

	if (parsed.record_title_field_id) {
		if (document.schema !== "box.document.v1") throw new Error("Box presentation record title requires a data Box");
		const root = document.nodes.find((node) => node.id === document.root_id);
		if (root?.kind !== "record") throw new Error("Box presentation record title requires a root record");
		const title_field = root.fields.find((field) => field.id === parsed.record_title_field_id);
		if (!title_field || !(["string", "number"] as const).includes(scalar_type(title_field.type_id) as "string" | "number")) {
			throw new Error("Box presentation record title must reference a root string or number field");
		}
		if (title_field.record_target) throw new Error("Box presentation record title cannot reference a stored-record relationship");
	}

	if (parsed.record_action) {
		if (document.schema !== "process.document.v1") throw new Error("Box presentation record action requires a Process");
		if (!record_action_input_names(document, parsed.record_action.input_field_path)) {
			throw new Error("Box presentation record action path must follow required Process inputs to a string field");
		}
		if (parsed.record_action.revision_input_field_path) {
			if (!record_action_input_names(document, parsed.record_action.revision_input_field_path)) {
				throw new Error("Box presentation record action revision path must follow required Process inputs to a string field");
			}
			if (
				parsed.record_action.input_field_path.length === parsed.record_action.revision_input_field_path.length &&
				parsed.record_action.input_field_path.every((field_id, index) => field_id === parsed.record_action!.revision_input_field_path![index])
			) {
				throw new Error("Box presentation record action ID and revision paths must be distinct");
			}
		}
	}

	if (parsed.record_views !== undefined) {
		if (document.schema !== "box.document.v1") throw new Error("Box presentation record views require a data Box");
		for (const view of parsed.record_views) {
			const query_fields = new Map(application_data_query_fields(document).map((field) => [field.id, field]));
			const literal_filters = view.query.filters.map((filter) => {
				if (!filter.relative_value) return filter;
				if (["string_value", "number_value", "boolean_value", "absence_value"].some((key) => Object.hasOwn(filter, key))) {
					throw new Error("Relative view filter cannot contain a literal value");
				}
				const type = query_fields.get(filter.field_id)?.type;
				if (filter.relative_value === "current_actor" && type === "string" && filter.operator === "equal") {
					return { field_id: filter.field_id, operator: "equal", string_value: "actor" };
				}
				if (filter.relative_value === "now" && type === "number" && ["less_than", "at_most", "greater_than", "at_least"].includes(filter.operator)) {
					return { field_id: filter.field_id, operator: filter.operator, number_value: 0 };
				}
				throw new Error("Relative view filter is incompatible with its field or operator");
			});
			const query = normalize_application_data_query(document, { ...view.query, filters: literal_filters, limit: 25 });
			view.query = {
				include_archived: query.include_archived,
				filters: view.query.filters.map((filter, index) => filter.relative_value ? { field_id: filter.field_id, operator: filter.operator, relative_value: filter.relative_value } : query.filters[index]!),
				...(query.sort ? { sort: query.sort } : {}),
			};
		}
	}

	if (parsed.form_layouts !== undefined) {
		for (const layout of parsed.form_layouts) {
			const record = node_by_id.get(layout.record_type_id);
			if (record?.kind !== "record") throw new Error("Box presentation form layout must reference a record type");
			const owned_field_ids = new Set(record.fields.map((field) => field.id));
			for (const section of layout.sections) {
				if (section.visible_when) {
					validate_condition(record.id, section.visible_when);
					if (section.field_ids.includes(section.visible_when.field_id)) throw new Error("Form section cannot hide its own condition field");
				}
				if (section.field_ids.some((field_id) => !owned_field_ids.has(field_id))) {
					throw new Error("Box presentation form section field must belong to its record type");
				}
			}
		}
	}

	// Combined field/section dependencies must be acyclic: a switch must remain reachable.
	const dependencies = new Map<string, Set<string>>();
	for (const field of parsed.fields) if (field.visible_when) dependencies.set(field.field_id, new Set([field.visible_when.field_id]));
	for (const layout of parsed.form_layouts ?? []) for (const section of layout.sections) if (section.visible_when) {
		for (const id of section.field_ids) {
			const edges = dependencies.get(id) ?? new Set<string>();
			edges.add(section.visible_when.field_id);
			dependencies.set(id, edges);
		}
	}
	const done = new Set<string>();
	const active = new Set<string>();
	const visit_dependency = (id: string): void => {
		if (active.has(id)) throw new Error("Form condition dependency cycle");
		if (done.has(id)) return;
		active.add(id);
		for (const source of dependencies.get(id) ?? []) visit_dependency(source);
		active.delete(id);
		done.add(id);
	};
	for (const id of dependencies.keys()) visit_dependency(id);

	if (parsed.rejection_feedback) {
		if (document.schema !== "process.document.v1") throw new Error("Rejection feedback requires a Process");
		const codes = new Set(document.program.body.flatMap((statement) => statement.kind === "reject_if" ? [statement.code] : []));
		for (const entry of parsed.rejection_feedback) if (!codes.has(entry.code) || !public_input_fields.has(entry.field_id)) {
			throw new Error("Rejection feedback must bind an authored code to a public Process input field");
		}
	}

	return parsed;
};

export const is_canonical_box_presentation = (input: unknown, document: PublishedDocument): input is BoxPresentation => {
	try {
		return json_values_equal(input, normalize_box_presentation(input, document));
	} catch {
		return false;
	}
};
