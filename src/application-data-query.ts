import type { BoxDocumentNode } from "./box-document.js";
import { normalize_application_data_schema } from "./application-data-contract.js";
import type { OperationSchema } from "./process-contract.js";

export const APPLICATION_DATA_QUERY_MAX_FILTERS = 8;
export const APPLICATION_DATA_QUERY_MAX_TEXT_UNITS = 256;
export const APPLICATION_DATA_QUERY_MAX_CURSOR_UNITS = 4_096;

export type ApplicationDataScalarType = "string" | "number" | "boolean" | "absence";
export type ApplicationDataQueryOperator =
	| "equal"
	| "not_equal"
	| "contains"
	| "starts_with"
	| "less_than"
	| "at_most"
	| "greater_than"
	| "at_least"
	| "is_missing"
	| "is_present";

export interface ApplicationDataQueryFilter {
	readonly field_id: string;
	readonly operator: ApplicationDataQueryOperator;
	readonly string_value?: string;
	readonly number_value?: number;
	readonly boolean_value?: boolean;
	readonly absence_value?: null;
}

export interface ApplicationDataQuerySort {
	readonly field_id: string;
	readonly direction: "asc" | "desc";
	readonly missing_position: "first" | "last";
}

export interface ApplicationDataQuery {
	readonly cursor?: string;
	readonly limit: number;
	readonly include_archived: boolean;
	readonly filters: readonly ApplicationDataQueryFilter[];
	readonly sort?: ApplicationDataQuerySort;
}

export interface ApplicationDataQueryField {
	readonly id: string;
	readonly name: string;
	readonly type: ApplicationDataScalarType;
	required: boolean;
}

const FILTER_KEYS = ["field_id", "operator", "string_value", "number_value", "boolean_value", "absence_value"] as const;
const QUERY_KEYS = ["cursor", "limit", "include_archived", "filters", "sort"] as const;
const SORT_KEYS = ["field_id", "direction", "missing_position"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATORS = new Set<ApplicationDataQueryOperator>([
	"equal",
	"not_equal",
	"contains",
	"starts_with",
	"less_than",
	"at_most",
	"greater_than",
	"at_least",
	"is_missing",
	"is_present",
]);

const plain_record = (value: unknown, allowed: readonly string[], label: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new TypeError(`${label} must be a plain record`);
	}
	const record = value as Record<string, unknown>;
	for (const key of Reflect.ownKeys(record)) {
		if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(`${label} shape is invalid`);
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${label} must contain enumerable data properties`);
	}
	return record;
};

const resolve_scalar_type = (nodes: ReadonlyMap<string, BoxDocumentNode>, type_id: string): ApplicationDataScalarType | undefined => {
	let node = nodes.get(type_id);
	const seen = new Set<string>();
	while (node?.kind === "reference") {
		if (seen.has(node.id)) return undefined;
		seen.add(node.id);
		node = nodes.get(node.target_id);
	}
	return node?.kind === "scalar" ? node.value_type : undefined;
};

export const application_data_query_fields = (schema_input: unknown): readonly ApplicationDataQueryField[] => {
	const schema = normalize_application_data_schema(schema_input);
	const root = schema.nodes.find((node) => node.id === schema.root_id);
	if (root?.kind !== "record") throw new Error("Application data query requires a root record");
	const nodes = new Map(schema.nodes.map((node) => [node.id, node]));
	return Object.freeze(
		root.fields.flatMap((field) => {
			const type = resolve_scalar_type(nodes, field.type_id);
			return type ? [Object.freeze({ id: field.id, name: field.name, type, required: field.required })] : [];
		}),
	);
};

const normalize_filter = (
	value: unknown,
	fields: ReadonlyMap<string, ApplicationDataQueryField>,
): ApplicationDataQueryFilter => {
	const filter = plain_record(value, FILTER_KEYS, "Application data query filter");
	if (typeof filter.field_id !== "string" || !UUID.test(filter.field_id)) throw new Error("Application data query filter field identity is invalid");
	const field = fields.get(filter.field_id);
	if (!field) throw new Error("Application data query filter field is not a root scalar field");
	if (typeof filter.operator !== "string" || !OPERATORS.has(filter.operator as ApplicationDataQueryOperator)) {
		throw new Error("Application data query filter operator is invalid");
	}
	const operator = filter.operator as ApplicationDataQueryOperator;
	const value_keys = (["string_value", "number_value", "boolean_value", "absence_value"] as const).filter((key) => Object.hasOwn(filter, key));
	if (operator === "is_missing" || operator === "is_present") {
		if (value_keys.length > 0) throw new Error("Application data presence filter cannot contain a value");
		return Object.freeze({ field_id: field.id, operator });
	}
	const expected_key = `${field.type}_value` as (typeof value_keys)[number];
	if (value_keys.length !== 1 || value_keys[0] !== expected_key) throw new Error("Application data query filter value type is invalid");
	if ((operator === "contains" || operator === "starts_with") && field.type !== "string") {
		throw new Error("Application data text operator requires a string field");
	}
	if (operator === "not_equal" && field.type === "absence") throw new Error("Application data absence field cannot use not-equal");
	if (["less_than", "at_most", "greater_than", "at_least"].includes(operator) && field.type !== "number") {
		throw new Error("Application data comparison operator requires a number field");
	}
	if (operator === "equal" || operator === "not_equal" || field.type === "string" || field.type === "number") {
		const raw = filter[expected_key];
		if (field.type === "string" && (typeof raw !== "string" || raw.length > APPLICATION_DATA_QUERY_MAX_TEXT_UNITS)) {
			throw new Error("Application data query text value is invalid");
		}
		if (field.type === "number" && (typeof raw !== "number" || !Number.isFinite(raw))) {
			throw new Error("Application data query number value is invalid");
		}
		if (field.type === "boolean" && typeof raw !== "boolean") throw new Error("Application data query boolean value is invalid");
		if (field.type === "absence" && raw !== null) throw new Error("Application data query absence value is invalid");
		return Object.freeze({
			field_id: field.id,
			operator,
			...(field.type === "string" ? { string_value: raw as string } : {}),
			...(field.type === "number" ? { number_value: Object.is(raw, -0) ? 0 : (raw as number) } : {}),
			...(field.type === "boolean" ? { boolean_value: raw as boolean } : {}),
			...(field.type === "absence" ? { absence_value: null } : {}),
		});
	}
	throw new Error("Application data query filter operator is invalid for its field");
};

export const normalize_application_data_query = (schema_input: OperationSchema, input: unknown): ApplicationDataQuery => {
	const query = plain_record(input, QUERY_KEYS, "Application data query");
	const limit = query.limit === undefined ? 25 : query.limit;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Application data query limit is invalid");
	}
	const include_archived = query.include_archived === undefined ? false : query.include_archived;
	if (typeof include_archived !== "boolean") throw new Error("Application data query archive filter is invalid");
	let cursor: string | undefined;
	if (query.cursor !== undefined) {
		if (typeof query.cursor !== "string" || query.cursor.length === 0 || query.cursor.length > APPLICATION_DATA_QUERY_MAX_CURSOR_UNITS) {
			throw new Error("Application data query cursor is invalid");
		}
		cursor = query.cursor;
	}
	if (query.filters !== undefined && (!Array.isArray(query.filters) || Object.getPrototypeOf(query.filters) !== Array.prototype)) {
		throw new Error("Application data query filters are invalid");
	}
	const raw_filters = (query.filters ?? []) as unknown[];
	if (raw_filters.length > APPLICATION_DATA_QUERY_MAX_FILTERS) throw new Error("Application data query has too many filters");
	const fields = new Map(application_data_query_fields(schema_input).map((field) => [field.id, field]));
	const filters = Object.freeze(raw_filters.map((filter) => normalize_filter(filter, fields)));
	if (new Set(filters.map((filter) => JSON.stringify(filter))).size !== filters.length) {
		throw new Error("Application data query contains a duplicate filter");
	}
	let sort: ApplicationDataQuerySort | undefined;
	if (query.sort !== undefined) {
		const raw_sort = plain_record(query.sort, SORT_KEYS, "Application data query sort");
		if (typeof raw_sort.field_id !== "string" || !UUID.test(raw_sort.field_id) || !fields.has(raw_sort.field_id)) {
			throw new Error("Application data query sort field is not a root scalar field");
		}
		if (raw_sort.direction !== "asc" && raw_sort.direction !== "desc") throw new Error("Application data query sort direction is invalid");
		if (raw_sort.missing_position !== "first" && raw_sort.missing_position !== "last") {
			throw new Error("Application data query missing-value position is invalid");
		}
		sort = Object.freeze({
			field_id: raw_sort.field_id,
			direction: raw_sort.direction,
			missing_position: raw_sort.missing_position,
		});
	}
	return Object.freeze({
		...(cursor ? { cursor } : {}),
		limit,
		include_archived,
		filters,
		...(sort ? { sort } : {}),
	});
};
