import { z } from "zod";
import type { BoxProgram } from "./box-program.js";
import { box_program_identities, box_program_type_ids, normalize_box_program, project_box_program_nodes } from "./box-program.js";
import { validate_box_program_semantics } from "./box-program-semantics.js";

const normalized_name = z
	.string()
	.transform((value) => value.normalize("NFC").trim())
	.pipe(z.string().refine((value) => value.length > 0 && [...value].length <= 128, "Некорректное имя узла"));
const input_uuid = z.uuid().transform((value) => value.toLowerCase());

const scalar_node = z.strictObject({
	id: input_uuid,
	kind: z.literal("scalar"),
	value_type: z.enum(["string", "number", "boolean", "absence"]),
});

const record_field = z.strictObject({
	id: input_uuid,
	name: normalized_name,
	type_id: input_uuid,
	required: z.boolean(),
	record_target: z.strictObject({ entity_id: input_uuid }).optional(),
});

const record_node = z.strictObject({
	id: input_uuid,
	kind: z.literal("record"),
	fields: z.array(record_field),
});

const list_node = z.strictObject({
	id: input_uuid,
	kind: z.literal("list"),
	item_type_id: input_uuid,
});

const reference_node = z.strictObject({
	id: input_uuid,
	kind: z.literal("reference"),
	target_id: input_uuid,
});

const node = z.discriminatedUnion("kind", [scalar_node, record_node, list_node, reference_node]);
const document_v1 = z.strictObject({
	schema: z.literal("box.document.v1"),
	root_id: input_uuid.nullable(),
	nodes: z.array(node),
});

const input_program = z.unknown().transform((value, context): BoxProgram | typeof z.NEVER => {
	try {
		return normalize_box_program(value);
	} catch (error) {
		context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Некорректная программа Бокса" });
		return z.NEVER;
	}
});

const document_v2 = z.strictObject({
	schema: z.literal("box.document.v2"),
	root_id: input_uuid.nullable(),
	nodes: z.array(node),
	program: input_program,
});

const document = z.discriminatedUnion("schema", [document_v1, document_v2]);

const MAX_DOCUMENT_NODES = 256;
const MAX_RECORD_FIELDS = 128;

export type BoxDocumentNode = z.infer<typeof node>;
export type BoxDocument = z.infer<typeof document>;
export type BoxValue = string | number | boolean | null | readonly BoxValue[] | { readonly [key: string]: BoxValue };

const empty_document_nodes: BoxDocument["nodes"] = [];
Object.freeze(empty_document_nodes);

export const EMPTY_BOX_DOCUMENT: BoxDocument = Object.freeze({
	schema: "box.document.v1",
	root_id: null,
	nodes: empty_document_nodes,
});

const compare_code_units = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const by_id = <Value extends { id: string }>(left: Value, right: Value): number => compare_code_units(left.id, right.id);

const referenced_type_ids = (node: BoxDocumentNode): string[] => {
	if (node.kind === "record") return node.fields.map((field) => field.type_id);
	if (node.kind === "list") return [node.item_type_id];
	if (node.kind === "reference") return [node.target_id];
	return [];
};

export const normalize_box_document = (input: unknown): BoxDocument => {
	const parsed = document.parse(input);
	if (parsed.nodes.length > MAX_DOCUMENT_NODES) throw new Error("Box document has too many nodes");
	const identities = new Set<string>();
	const nodes = parsed.nodes.map((item) => {
		if (identities.has(item.id)) throw new Error("Box document contains duplicate identity");
		identities.add(item.id);
		if (item.kind !== "record") return item;
		if (item.fields.length > MAX_RECORD_FIELDS) throw new Error("Box document record has too many fields");

		const field_names = new Set<string>();
		const fields = item.fields.map((field) => {
			if (identities.has(field.id)) throw new Error("Box document contains duplicate identity");
			identities.add(field.id);
			if (field_names.has(field.name)) throw new Error("Box document record contains duplicate field name");
			field_names.add(field.name);
			return field;
		});
		fields.sort((left, right) => compare_code_units(left.name, right.name) || by_id(left, right));
		return { ...item, fields };
	});
	nodes.sort(by_id);

	const node_ids = new Set(nodes.map((item) => item.id));
	if (parsed.root_id === null ? nodes.length > 0 : !node_ids.has(parsed.root_id)) {
		throw new Error("Box document root is inconsistent");
	}
	for (const item of nodes) {
		if (item.kind === "record" && item.fields.some((field) => !node_ids.has(field.type_id))) {
			throw new Error("Box document record field type is missing");
		}
		if (item.kind === "list" && !node_ids.has(item.item_type_id)) throw new Error("Box document list item type is missing");
		if (item.kind === "reference" && !node_ids.has(item.target_id)) throw new Error("Box document reference target is missing");
	}

	const node_by_id = new Map(nodes.map((item) => [item.id, item]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error("Box document type graph contains a cycle");
		if (visited.has(id)) return;
		visiting.add(id);
		const item = node_by_id.get(id);
		if (!item) throw new Error("Box document type reference is missing");
		for (const target_id of referenced_type_ids(item)) visit(target_id);
		visiting.delete(id);
		visited.add(id);
	};
	if (parsed.root_id !== null) visit(parsed.root_id);
	if (parsed.schema === "box.document.v2") {
		for (const type_id of box_program_type_ids(parsed.program)) visit(type_id);
	}
	if (visited.size !== nodes.length) throw new Error("Box document contains unreachable declarations");
	for (const item of nodes) {
		if (item.kind !== "record") continue;
		for (const field of item.fields) {
			if (!field.record_target) continue;
			let target = node_by_id.get(field.type_id);
			while (target?.kind === "reference") target = node_by_id.get(target.target_id);
			if (target?.kind !== "scalar" || target.value_type !== "string") {
				throw new Error("Box document record target field must be a string");
			}
		}
	}

	if (parsed.schema === "box.document.v2") {
		const root = parsed.root_id === null ? undefined : node_by_id.get(parsed.root_id);
		if (!root || root.kind !== "record") {
			throw new Error("Executable Box document root must be a record");
		}
		for (const id of box_program_identities(parsed.program)) {
			if (identities.has(id)) throw new Error("Box document contains duplicate identity");
			identities.add(id);
		}
		validate_box_program_semantics(nodes, root, parsed.program);
		return { schema: parsed.schema, root_id: parsed.root_id, nodes, program: parsed.program };
	}
	return { schema: parsed.schema, root_id: parsed.root_id, nodes };
};

const json_values_equal = (left: unknown, right: unknown): boolean => {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (Object.hasOwn(left, index) !== Object.hasOwn(right, index)) return false;
			if (Object.hasOwn(left, index) && !json_values_equal(left[index], right[index])) return false;
		}
		return true;
	}
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	const left_keys = Object.keys(left);
	const right_record = right as Record<string, unknown>;
	if (left_keys.length !== Object.keys(right_record).length) return false;
	return left_keys.every((key) => Object.hasOwn(right_record, key) && json_values_equal((left as Record<string, unknown>)[key], right_record[key]));
};

export const box_documents_equal = (left: unknown, right: unknown): boolean => {
	try {
		return json_values_equal(normalize_box_document(left), normalize_box_document(right));
	} catch {
		return false;
	}
};

export const is_canonical_box_document = (input: unknown): input is BoxDocument => {
	try {
		return json_values_equal(input, normalize_box_document(input));
	} catch {
		return false;
	}
};

const is_record_value = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const normalize_box_value_at = (document_input: unknown, node_id: string, input: unknown): BoxValue => {
	const canonical = normalize_box_document(document_input);
	const node_by_id = new Map(canonical.nodes.map((item) => [item.id, item]));
	const normalize = (current_node_id: string, value: unknown): BoxValue => {
		const item = node_by_id.get(current_node_id);
		if (!item) throw new Error("Box document value type is missing");
		if (item.kind === "reference") return normalize(item.target_id, value);
		if (item.kind === "list") {
			if (!Array.isArray(value)) throw new Error("Box document value must be a list");
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new Error("Box document value must be a dense list");
			}
			return Object.freeze(value.map((entry) => normalize(item.item_type_id, entry)));
		}
		if (item.kind === "record") {
			if (!is_record_value(value)) throw new Error("Box document value must be a record");
			const field_names = new Set(item.fields.map((field) => field.name));
			if (Object.keys(value).some((key) => !field_names.has(key))) throw new Error("Box document value contains an unknown field");
			const entries: [string, BoxValue][] = [];
			for (const field of item.fields) {
				if (!Object.hasOwn(value, field.name)) {
					if (field.required) throw new Error("Box document value is missing a required field");
					continue;
				}
				entries.push([field.name, normalize(field.type_id, value[field.name])]);
			}
			return Object.freeze(Object.fromEntries(entries) as Record<string, BoxValue>);
		}
		if (item.value_type === "absence") {
			if (value !== null) throw new Error("Box document value must be absent");
			return null;
		}
		if (item.value_type === "number") {
			if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Box document value must be a finite number");
			return Object.is(value, -0) ? 0 : value;
		}
		if (item.value_type === "string") {
			if (typeof value !== "string") throw new Error("Box document value must be a string");
			return value;
		}
		if (typeof value !== "boolean") throw new Error("Box document value must be a boolean");
		return value;
	};
	return normalize(node_id, input);
};

export const normalize_box_value = (document_input: unknown, input: unknown): BoxValue => {
	const canonical = normalize_box_document(document_input);
	if (canonical.root_id === null) {
		if (input !== null) throw new Error("Empty Box document accepts only absence");
		return null;
	}
	return normalize_box_value_at(canonical, canonical.root_id, input);
};

export const project_box_document_code = (document_input: unknown): string => {
	const canonical = normalize_box_document(document_input);
	const lines = [canonical.schema, canonical.root_id === null ? "root absence" : `root ${canonical.root_id}`];
	for (const item of canonical.nodes) {
		if (item.kind === "scalar") {
			lines.push(`type ${item.id} = ${item.value_type}`);
			continue;
		}
		if (item.kind === "list") {
			lines.push(`type ${item.id} = List<${item.item_type_id}>`);
			continue;
		}
		if (item.kind === "reference") {
			lines.push(`type ${item.id} = Reference<${item.target_id}>`);
			continue;
		}
		lines.push(`type ${item.id} = record {`);
		for (const field of item.fields) {
			lines.push(`  ${field.id} ${JSON.stringify(field.name)} ${field.required ? "required" : "optional"}: ${field.type_id}`);
		}
		lines.push("}");
	}
	if (canonical.schema === "box.document.v2") lines.push(`program ${JSON.stringify(canonical.program)}`);
	return lines.join("\n");
};

export type BoxDocumentSchemaDeclaration =
	| { id: string; type: "string" | "number" | "boolean" | "absence" }
	| { id: string; type: "list"; item_type_id: string }
	| { id: string; type: "reference"; target_id: string }
	| { id: string; type: "record"; fields: Extract<BoxDocumentNode, { kind: "record" }>["fields"] };

export interface BoxDocumentSchemaProjection {
	schema: "box.schema.v1";
	root_id: string | null;
	declarations: BoxDocumentSchemaDeclaration[];
}

export const project_box_document_schema = (document_input: unknown): BoxDocumentSchemaProjection => {
	const canonical = normalize_box_document(document_input);
	return {
		schema: "box.schema.v1" as const,
		root_id: canonical.root_id,
		declarations: canonical.nodes.map((item) => {
			if (item.kind === "scalar") return { id: item.id, type: item.value_type };
			if (item.kind === "list") return { id: item.id, type: "list" as const, item_type_id: item.item_type_id };
			if (item.kind === "reference") return { id: item.id, type: "reference" as const, target_id: item.target_id };
			return {
				id: item.id,
				type: "record" as const,
				fields: item.fields.map(({ id, name, type_id, required }) => ({ id, name, type_id, required })),
			};
		}),
	};
};

export interface BoxDocumentDiff {
	root_changed: boolean;
	added_node_ids: string[];
	removed_node_ids: string[];
	changed_node_ids: string[];
	program_changed: boolean;
	added_runtime_node_ids: string[];
	removed_runtime_node_ids: string[];
	changed_runtime_node_ids: string[];
}

export const diff_box_documents = (before_input: unknown, after_input: unknown): BoxDocumentDiff => {
	const before = normalize_box_document(before_input);
	const after = normalize_box_document(after_input);
	const before_by_id = new Map(before.nodes.map((item) => [item.id, item]));
	const after_by_id = new Map(after.nodes.map((item) => [item.id, item]));
	const before_program = before.schema === "box.document.v2" ? before.program : null;
	const after_program = after.schema === "box.document.v2" ? after.program : null;
	const before_runtime_nodes = before_program ? project_box_program_nodes(before_program) : [];
	const after_runtime_nodes = after_program ? project_box_program_nodes(after_program) : [];
	const before_runtime_by_id = new Map(before_runtime_nodes.map((item) => [item.id, item.value]));
	const after_runtime_by_id = new Map(after_runtime_nodes.map((item) => [item.id, item.value]));
	return {
		root_changed: before.root_id !== after.root_id,
		added_node_ids: after.nodes.filter((item) => !before_by_id.has(item.id)).map((item) => item.id),
		removed_node_ids: before.nodes.filter((item) => !after_by_id.has(item.id)).map((item) => item.id),
		changed_node_ids: after.nodes
			.filter((item) => {
				const previous = before_by_id.get(item.id);
				return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item);
			})
			.map((item) => item.id),
		program_changed: !json_values_equal(before_program, after_program),
		added_runtime_node_ids: after_runtime_nodes.filter((item) => !before_runtime_by_id.has(item.id)).map((item) => item.id),
		removed_runtime_node_ids: before_runtime_nodes.filter((item) => !after_runtime_by_id.has(item.id)).map((item) => item.id),
		changed_runtime_node_ids: after_runtime_nodes
			.filter((item) => {
				const previous = before_runtime_by_id.get(item.id);
				return previous !== undefined && !json_values_equal(previous, item.value);
			})
			.map((item) => item.id),
	};
};
