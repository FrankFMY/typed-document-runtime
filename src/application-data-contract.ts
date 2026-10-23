import { z } from "zod";
import type { BoxDocumentNode, BoxValue } from "./box-document.js";
import { normalize_box_document, normalize_box_value, normalize_box_value_at } from "./box-document.js";
import type { OperationSchema } from "./process-contract.js";

export interface ApplicationDataSchemaChange {
	kind: "added" | "removed" | "changed";
	field_id: string;
	name: string;
}

export interface ApplicationDataSchemaComparison {
	compatible: boolean;
	changes: ApplicationDataSchemaChange[];
}

export interface ApplicationDataFieldFill {
	field_id: string;
	value: BoxValue;
}

export const normalize_application_data_fill_plan = (
	before_input: unknown | null,
	after_input: unknown,
	plan: readonly ApplicationDataFieldFill[],
): ApplicationDataFieldFill[] => {
	const after = normalize_application_data_schema(after_input);
	const before = before_input === null ? null : normalize_application_data_schema(before_input);
	const root = after.nodes.find((node) => node.id === after.root_id);
	const previous = before?.nodes.find((node) => node.id === before.root_id);
	if (root?.kind !== "record" || (previous && previous.kind !== "record")) throw new Error("Application data fill root is invalid");
	const prior = new Set(previous?.kind === "record" ? previous.fields.map((field) => field.id) : root.fields.map((field) => field.id));
	const required = root.fields.filter((field) => !prior.has(field.id) && field.required);
	if (!Array.isArray(plan) || plan.length !== required.length)
		throw new Error("Application data fill plan must cover exactly the new required fields");
	const fields = new Map(required.map((field) => [field.id, field]));
	const seen = new Set<string>();
	const normalized = plan.map((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			Object.keys(entry).length !== 2 ||
			!Object.hasOwn(entry, "field_id") ||
			!Object.hasOwn(entry, "value")
		) {
			throw new Error("Application data fill entry is invalid");
		}
		const field = fields.get(entry.field_id);
		if (!field || seen.has(entry.field_id)) throw new Error("Application data fill field is not a new required field");
		seen.add(entry.field_id);
		return { field_id: field.id, value: normalize_box_value_at(after, field.type_id, entry.value) };
	});
	return normalized.sort((left, right) => left.field_id.localeCompare(right.field_id));
};

export const fill_application_data_record = (schema_input: unknown, data: unknown, fill_plan: readonly ApplicationDataFieldFill[]): BoxValue => {
	const schema = normalize_application_data_schema(schema_input);
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Application data record is not a record");
	const root = schema.nodes.find((node) => node.id === schema.root_id);
	if (root?.kind !== "record") throw new Error("Application data root is invalid");
	const by_id = new Map(root.fields.map((field) => [field.id, field]));
	const value = { ...(data as Record<string, unknown>) };
	for (const fill of fill_plan) {
		const field = by_id.get(fill.field_id);
		if (!field || Object.hasOwn(value, field.name)) throw new Error("Application data fill would replace existing content");
		value[field.name] = fill.value;
	}
	return normalize_box_value(schema, value);
};

export const APPLICATION_DATA_OPERATIONS = Object.freeze(["create", "read", "update", "archive", "restore", "list", "query", "aggregate"] as const);
export type ApplicationDataOperation = (typeof APPLICATION_DATA_OPERATIONS)[number];

export interface ApplicationDataOperationContract {
	capability: string;
	operation: ApplicationDataOperation;
	request: OperationSchema;
	result: OperationSchema;
}

const MAX_APPLICATION_DATA_REVISION = 9_223_372_036_854_775_807n;
const CANONICAL_POSITIVE_REVISION = /^[1-9]\d*$/u;
export const APPLICATION_DATA_OPERATION_COUNT = APPLICATION_DATA_OPERATIONS.length;
const APPLICATION_DATA_OPERATION_SET = new Set<ApplicationDataOperation>(APPLICATION_DATA_OPERATIONS);

export const application_data_capability = (entity_id: string, document_version: string, operation: ApplicationDataOperation): string => {
	if (!z.uuid().safeParse(entity_id).success || entity_id !== entity_id.toLowerCase())
		throw new Error("Application data entity identity must be a canonical UUID");
	if (!CANONICAL_POSITIVE_REVISION.test(document_version) || BigInt(document_version) > MAX_APPLICATION_DATA_REVISION) {
		throw new Error("Application data document version must be a canonical positive revision");
	}
	if (!APPLICATION_DATA_OPERATION_SET.has(operation)) throw new Error("Application data operation is invalid");
	return `data.e${entity_id.replaceAll("-", "")}.r${document_version}.${operation}.v1`;
};

export const normalize_application_data_schema = (input: unknown): OperationSchema => {
	const schema = normalize_box_document(input);
	if (schema.schema !== "box.document.v1" || schema.nodes.find((node) => node.id === schema.root_id)?.kind !== "record") {
		throw new Error("Persistent data requires a schema-only record Box");
	}
	return schema;
};

const deterministic_uuid = (seed: string): string => {
	const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((initial, index) => {
		let hash = initial;
		const input = `${index}\0${seed}`;
		for (let offset = 0; offset < input.length; offset += 1) hash = Math.imul(hash ^ input.codePointAt(offset)!, 0x01000193);
		return (hash >>> 0).toString(16).padStart(8, "0");
	});
	const hex = words.join("").split("");
	hex[12] = "5";
	hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
};

const application_data_id_allocator = (schema: OperationSchema, witness: string): ((role: string) => string) => {
	const used = new Set(schema.nodes.flatMap((node) => [node.id, ...(node.kind === "record" ? node.fields.map((field) => field.id) : [])]));
	return (role) => {
		for (let attempt = 0; attempt <= used.size; attempt += 1) {
			const id = deterministic_uuid(`${witness}\0${role}\0${attempt}`);
			if (used.has(id)) continue;
			used.add(id);
			return id;
		}
		throw new Error("Application data contract identity space is exhausted");
	};
};

export const application_data_operation_contracts = (
	entity_id: string,
	document_version: string,
	schema_input: unknown,
): ApplicationDataOperationContract[] => {
	const schema = normalize_application_data_schema(schema_input);
	const allocate = application_data_id_allocator(schema, `${entity_id}\0${document_version}`);
	type RecordField = Extract<BoxDocumentNode, { kind: "record" }>["fields"][number];
	const generated_schema = (root: BoxDocumentNode, wrappers: BoxDocumentNode[], include_data: boolean): OperationSchema =>
		normalize_box_document({
			schema: "box.document.v1",
			root_id: root.id,
			nodes: [...(include_data ? schema.nodes : []), ...wrappers, root],
		}) as OperationSchema;
	const scalar = (role: string, value_type: "string" | "number" | "boolean" | "absence"): BoxDocumentNode => ({
		id: allocate(role),
		kind: "scalar",
		value_type,
	});
	const field = (role: string, name: string, type_id: string, required: boolean): RecordField => ({
		id: allocate(role),
		name,
		type_id,
		required,
	});
	const request = (
		operation: ApplicationDataOperation,
		definitions: { name: string; type: "string" | "number" | "boolean" | "data"; required: boolean }[],
	): OperationSchema => {
		const scalars = new Map<string, BoxDocumentNode>();
		const fields = definitions.map((definition) => {
			if (definition.type === "data") return field(`${operation}.request.${definition.name}`, definition.name, schema.root_id!, definition.required);
			let type = scalars.get(definition.type);
			if (!type) {
				type = scalar(`${operation}.request.${definition.type}`, definition.type);
				scalars.set(definition.type, type);
			}
			return field(`${operation}.request.${definition.name}`, definition.name, type.id, definition.required);
		});
		const root: BoxDocumentNode = { id: allocate(`${operation}.request`), kind: "record", fields };
		return generated_schema(
			root,
			[...scalars.values()],
			definitions.some((definition) => definition.type === "data"),
		);
	};
	const record_shape = (operation: ApplicationDataOperation): { record: BoxDocumentNode; wrappers: BoxDocumentNode[] } => {
		const string_type = scalar(`${operation}.result.string`, "string");
		const boolean_type = scalar(`${operation}.result.boolean`, "boolean");
		const record: BoxDocumentNode = {
			id: allocate(`${operation}.result.record`),
			kind: "record",
			fields: [
				field(`${operation}.result.record.id`, "id", string_type.id, true),
				field(`${operation}.result.record.revision`, "revision", string_type.id, true),
				field(`${operation}.result.record.archived`, "archived", boolean_type.id, true),
				field(`${operation}.result.record.data`, "data", schema.root_id!, true),
			],
		};
		return { record, wrappers: [string_type, boolean_type, record] };
	};
	const ordinary_result = (operation: ApplicationDataOperation): OperationSchema => {
		const shape = record_shape(operation);
		const string_type = shape.wrappers[0]!;
		const root: BoxDocumentNode = {
			id: allocate(`${operation}.result`),
			kind: "record",
			fields: [
				field(`${operation}.result.status`, "status", string_type.id, true),
				field(`${operation}.result.record_field`, "record", shape.record.id, false),
			],
		};
		return generated_schema(root, shape.wrappers, true);
	};
	const list_result = (): OperationSchema => {
		const operation = "list" as const;
		const shape = record_shape(operation);
		const string_type = shape.wrappers[0]!;
		const items: BoxDocumentNode = { id: allocate("list.result.items"), kind: "list", item_type_id: shape.record.id };
		const root: BoxDocumentNode = {
			id: allocate("list.result"),
			kind: "record",
			fields: [field("list.result.items_field", "items", items.id, true), field("list.result.next_after_id", "next_after_id", string_type.id, false)],
		};
		return generated_schema(root, [...shape.wrappers, items], true);
	};
	const query_request = (): OperationSchema => {
		const string_type = scalar("query.request.string", "string");
		const number_type = scalar("query.request.number", "number");
		const boolean_type = scalar("query.request.boolean", "boolean");
		const absence_type = scalar("query.request.absence", "absence");
		const filter: BoxDocumentNode = {
			id: allocate("query.request.filter"),
			kind: "record",
			fields: [
				field("query.request.filter.field_id", "field_id", string_type.id, true),
				field("query.request.filter.operator", "operator", string_type.id, true),
				field("query.request.filter.string_value", "string_value", string_type.id, false),
				field("query.request.filter.number_value", "number_value", number_type.id, false),
				field("query.request.filter.boolean_value", "boolean_value", boolean_type.id, false),
				field("query.request.filter.absence_value", "absence_value", absence_type.id, false),
			],
		};
		const filters: BoxDocumentNode = { id: allocate("query.request.filters"), kind: "list", item_type_id: filter.id };
		const sort: BoxDocumentNode = {
			id: allocate("query.request.sort"),
			kind: "record",
			fields: [
				field("query.request.sort.field_id", "field_id", string_type.id, true),
				field("query.request.sort.direction", "direction", string_type.id, true),
				field("query.request.sort.missing_position", "missing_position", string_type.id, true),
			],
		};
		const root: BoxDocumentNode = {
			id: allocate("query.request"),
			kind: "record",
			fields: [
				field("query.request.cursor", "cursor", string_type.id, false),
				field("query.request.limit", "limit", number_type.id, false),
				field("query.request.include_archived", "include_archived", boolean_type.id, false),
				field("query.request.filters_field", "filters", filters.id, false),
				field("query.request.sort_field", "sort", sort.id, false),
			],
		};
		return generated_schema(root, [string_type, number_type, boolean_type, absence_type, filter, filters, sort], false);
	};
	const query_result = (): OperationSchema => {
		const operation = "query" as const;
		const shape = record_shape(operation);
		const string_type = shape.wrappers[0]!;
		const items: BoxDocumentNode = { id: allocate("query.result.items"), kind: "list", item_type_id: shape.record.id };
		const root: BoxDocumentNode = {
			id: allocate("query.result"),
			kind: "record",
			fields: [field("query.result.items_field", "items", items.id, true), field("query.result.next_cursor", "next_cursor", string_type.id, false)],
		};
		return generated_schema(root, [...shape.wrappers, items], true);
	};
	const aggregate_request = (): OperationSchema => {
		const string_type = scalar("aggregate.request.string", "string");
		const number_type = scalar("aggregate.request.number", "number");
		const boolean_type = scalar("aggregate.request.boolean", "boolean");
		const absence_type = scalar("aggregate.request.absence", "absence");
		const filter: BoxDocumentNode = {
			id: allocate("aggregate.request.filter"),
			kind: "record",
			fields: [
				field("aggregate.request.filter.field_id", "field_id", string_type.id, true),
				field("aggregate.request.filter.operator", "operator", string_type.id, true),
				field("aggregate.request.filter.string_value", "string_value", string_type.id, false),
				field("aggregate.request.filter.number_value", "number_value", number_type.id, false),
				field("aggregate.request.filter.boolean_value", "boolean_value", boolean_type.id, false),
				field("aggregate.request.filter.absence_value", "absence_value", absence_type.id, false),
			],
		};
		const filters: BoxDocumentNode = { id: allocate("aggregate.request.filters"), kind: "list", item_type_id: filter.id };
		const root: BoxDocumentNode = {
			id: allocate("aggregate.request"),
			kind: "record",
			fields: [
				field("aggregate.request.filters_field", "filters", filters.id, false),
				field("aggregate.request.include_archived", "include_archived", boolean_type.id, false),
				field("aggregate.request.value_field_id", "value_field_id", string_type.id, true),
				field("aggregate.request.multiplier_field_id", "multiplier_field_id", string_type.id, false),
				field("aggregate.request.scale", "scale", number_type.id, true),
			],
		};
		return generated_schema(root, [string_type, number_type, boolean_type, absence_type, filter, filters], false);
	};
	const aggregate_result = (): OperationSchema => {
		const string_type = scalar("aggregate.result.string", "string");
		const number_type = scalar("aggregate.result.number", "number");
		const root: BoxDocumentNode = {
			id: allocate("aggregate.result"),
			kind: "record",
			fields: [field("aggregate.result.count", "count", number_type.id, true), field("aggregate.result.total", "total", string_type.id, true)],
		};
		return generated_schema(root, [string_type, number_type], false);
	};
	const contracts: { operation: ApplicationDataOperation; request: OperationSchema; result: OperationSchema }[] = [
		{
			operation: "create",
			request: request("create", [{ name: "data", type: "data", required: true }]),
			result: ordinary_result("create"),
		},
		{
			operation: "read",
			request: request("read", [{ name: "id", type: "string", required: true }]),
			result: ordinary_result("read"),
		},
		{
			operation: "update",
			request: request("update", [
				{ name: "id", type: "string", required: true },
				{ name: "revision", type: "string", required: true },
				{ name: "data", type: "data", required: true },
			]),
			result: ordinary_result("update"),
		},
		{
			operation: "archive",
			request: request("archive", [
				{ name: "id", type: "string", required: true },
				{ name: "revision", type: "string", required: true },
			]),
			result: ordinary_result("archive"),
		},
		{
			operation: "restore",
			request: request("restore", [
				{ name: "id", type: "string", required: true },
				{ name: "revision", type: "string", required: true },
			]),
			result: ordinary_result("restore"),
		},
		{
			operation: "list",
			request: request("list", [
				{ name: "after_id", type: "string", required: false },
				{ name: "limit", type: "number", required: false },
				{ name: "include_archived", type: "boolean", required: false },
				{ name: "search_field", type: "string", required: false },
				{ name: "search", type: "string", required: false },
			]),
			result: list_result(),
		},
		{
			operation: "query",
			request: query_request(),
			result: query_result(),
		},
		{
			operation: "aggregate",
			request: aggregate_request(),
			result: aggregate_result(),
		},
	];
	return contracts.map((contract) => ({
		capability: application_data_capability(entity_id, document_version, contract.operation),
		operation: contract.operation,
		request: contract.request,
		result: contract.result,
	}));
};

const projectable_box_value = (value: unknown, active = new WeakSet<object>()): BoxValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Application data value must be JSON-wire compatible");
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value !== "object" || active.has(value)) throw new TypeError("Application data value must be JSON-wire compatible");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("Application data value must use ordinary arrays");
			const length_descriptor = Object.getOwnPropertyDescriptor(value, "length");
			if (!length_descriptor || !("value" in length_descriptor) || typeof length_descriptor.value !== "number") {
				throw new TypeError("Application data value has an invalid array length");
			}
			const length = length_descriptor.value;
			for (const key of Reflect.ownKeys(value)) {
				if (key === "length") continue;
				if (typeof key !== "string") throw new TypeError("Application data value cannot contain symbol keys");
				const index = Number(key);
				if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
					throw new TypeError("Application data value must use dense arrays");
				}
			}
			const entries: BoxValue[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new TypeError("Application data value must use enumerable data properties");
				}
				entries.push(projectable_box_value(descriptor.value, active));
			}
			return Object.freeze(entries);
		}
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Application data value must use plain records");
		const entries: [string, BoxValue][] = [];
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") throw new TypeError("Application data value cannot contain symbol keys");
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new TypeError("Application data value must use enumerable data properties");
			}
			entries.push([key, projectable_box_value(descriptor.value, active)]);
		}
		return Object.freeze(Object.fromEntries(entries) as Record<string, BoxValue>);
	} finally {
		active.delete(value);
	}
};

export const project_application_data_value = (schema_input: unknown, value: unknown): BoxValue => {
	const schema = normalize_application_data_schema(schema_input);
	const current = projectable_box_value(value);
	const nodes = new Map(schema.nodes.map((node) => [node.id, node]));
	const project = (type_id: string, entry: BoxValue): BoxValue => {
		const node = nodes.get(type_id);
		if (!node) throw new Error("Application data projection type is missing");
		if (node.kind === "reference") return project(node.target_id, entry);
		if (node.kind === "list") {
			if (!Array.isArray(entry)) throw new TypeError("Application data projection expected a list");
			return Object.freeze(entry.map((item) => project(node.item_type_id, item)));
		}
		if (node.kind === "record") {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw new TypeError("Application data projection expected a record");
			}
			const record = entry as Record<string, BoxValue>;
			return Object.freeze(
				Object.fromEntries(
					node.fields.filter((field) => Object.hasOwn(record, field.name)).map((field) => [field.name, project(field.type_id, record[field.name]!)]),
				) as Record<string, BoxValue>,
			);
		}
		return entry;
	};
	return normalize_box_value(schema, project(schema.root_id!, current));
};

export const compare_application_data_schema = (
	before_input: unknown,
	after_input: unknown,
	fill_plan: readonly ApplicationDataFieldFill[] = [],
): ApplicationDataSchemaComparison => {
	const before = normalize_application_data_schema(before_input);
	const after = normalize_application_data_schema(after_input);
	const before_root = before.nodes.find((node) => node.id === before.root_id);
	const after_root = after.nodes.find((node) => node.id === after.root_id);
	if (before_root?.kind !== "record" || after_root?.kind !== "record") throw new Error("Persistent data root is missing");
	const before_fields = new Map(before_root.fields.map((field) => [field.id, field]));
	const after_fields = new Map(after_root.fields.map((field) => [field.id, field]));
	const before_nodes = new Map(before.nodes.map((node) => [node.id, node]));
	const after_nodes = new Map(after.nodes.map((node) => [node.id, node]));
	const exact_closures = new Map<string, boolean>();
	const closure_is_exact = (before_id: string, after_id: string): boolean => {
		if (before_id !== after_id) return false;
		const cached = exact_closures.get(before_id);
		if (cached !== undefined) return cached;
		const previous = before_nodes.get(before_id);
		const current = after_nodes.get(after_id);
		if (!previous || !current || JSON.stringify(previous) !== JSON.stringify(current)) return false;
		exact_closures.set(before_id, true);
		let exact = true;
		if (previous.kind === "record" && current.kind === "record") {
			exact = previous.fields.every((field, index) => closure_is_exact(field.type_id, current.fields[index]!.type_id));
		} else if (previous.kind === "list" && current.kind === "list") {
			exact = closure_is_exact(previous.item_type_id, current.item_type_id);
		} else if (previous.kind === "reference" && current.kind === "reference") {
			exact = closure_is_exact(previous.target_id, current.target_id);
		}
		exact_closures.set(before_id, exact);
		return exact;
	};
	const additions = after_root.fields.filter((field) => !before_fields.has(field.id));
	const removals = before_root.fields.filter((field) => !after_fields.has(field.id));
	const changed = after_root.fields.filter((field) => {
		const previous = before_fields.get(field.id);
		return (
			previous !== undefined &&
			(before.root_id !== after.root_id ||
				previous.name !== field.name ||
				previous.required !== field.required ||
				previous.record_target?.entity_id !== field.record_target?.entity_id ||
				!closure_is_exact(previous.type_id, field.type_id))
		);
	});
	return {
		compatible:
			before.root_id === after.root_id &&
			removals.length === 0 &&
			changed.length === 0 &&
			(() => {
				try {
					normalize_application_data_fill_plan(before, after, fill_plan);
					return true;
				} catch {
					return false;
				}
			})(),
		changes: [
			...removals.map((field): ApplicationDataSchemaChange => ({ kind: "removed", field_id: field.id, name: field.name })),
			...changed.map((field): ApplicationDataSchemaChange => ({ kind: "changed", field_id: field.id, name: field.name })),
			...additions.map((field): ApplicationDataSchemaChange => ({ kind: "added", field_id: field.id, name: field.name })),
		],
	};
};
