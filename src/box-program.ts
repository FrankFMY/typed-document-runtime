import { z } from "zod";

const MAX_PROGRAM_STATEMENTS = 512;
const MAX_PROGRAM_NODES = 4096;
const MAX_EXPRESSION_DEPTH = 64;
const MAX_LITERAL_NODES = 16_384;
const MAX_LITERAL_DEPTH = 64;
const MAX_LITERAL_COLLECTION_ITEMS = 4096;
const MAX_RECORD_EXPRESSION_FIELDS = 128;

const compare_code_units = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const input_uuid = z.uuid().transform((value) => value.toLowerCase());

export type RuntimeLiteralValue = string | number | boolean | null | readonly RuntimeLiteralValue[] | { readonly [key: string]: RuntimeLiteralValue };

const normalize_literal_value = (input: unknown): RuntimeLiteralValue => {
	let nodes = 0;
	const ancestors = new WeakSet<object>();
	const visit = (value: unknown, depth: number): RuntimeLiteralValue => {
		nodes += 1;
		if (nodes > MAX_LITERAL_NODES) throw new Error("Runtime literal has too many values");
		if (depth > MAX_LITERAL_DEPTH) throw new Error("Runtime literal is too deeply nested");
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new Error("Runtime number must be finite");
			return Object.is(value, -0) ? 0 : value;
		}
		if (typeof value !== "object") throw new Error("Runtime literal must be a JSON value");
		if (ancestors.has(value)) throw new Error("Runtime literal must not be cyclic");
		ancestors.add(value);
		try {
			if (Array.isArray(value)) {
				if (value.length > MAX_LITERAL_COLLECTION_ITEMS) throw new Error("Runtime literal list is too large");
				for (let index = 0; index < value.length; index += 1) {
					if (!Object.hasOwn(value, index)) throw new Error("Runtime literal list must be dense");
				}
				return value.map((entry) => visit(entry, depth + 1));
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) throw new Error("Runtime literal record must be plain");
			const keys = Object.keys(value);
			if (keys.length > MAX_LITERAL_COLLECTION_ITEMS) throw new Error("Runtime literal record is too large");
			const entries = keys.toSorted(compare_code_units).map((key) => [key, visit((value as Record<string, unknown>)[key], depth + 1)] as const);
			return Object.fromEntries(entries) as { readonly [key: string]: RuntimeLiteralValue };
		} finally {
			ancestors.delete(value);
		}
	};
	return visit(input, 0);
};

const literal_value = z.unknown().transform((value, context): RuntimeLiteralValue | typeof z.NEVER => {
	try {
		return normalize_literal_value(value);
	} catch (error) {
		context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Некорректный литерал" });
		return z.NEVER;
	}
});

interface ExpressionBase {
	id: string;
	type_id: string;
}

export type BoxProgramExpression =
	| (ExpressionBase & { kind: "literal"; value: RuntimeLiteralValue })
	| (ExpressionBase & { kind: "cell"; cell_id: string })
	| (ExpressionBase & { kind: "binding"; binding_id: string })
	| (ExpressionBase & {
			kind: "binary";
			operator:
				| "add"
				| "subtract"
				| "multiply"
				| "divide"
				| "concat"
				| "equal"
				| "not_equal"
				| "less_than"
				| "less_or_equal"
				| "greater_than"
				| "greater_or_equal"
				| "and"
				| "or";
			left: BoxProgramExpression;
			right: BoxProgramExpression;
	  })
	| (ExpressionBase & {
			kind: "select";
			condition: BoxProgramExpression;
			when_true: BoxProgramExpression;
			when_false: BoxProgramExpression;
	  })
	| (ExpressionBase & { kind: "record"; fields: { field_id: string; value: BoxProgramExpression }[] })
	| (ExpressionBase & { kind: "field"; record: BoxProgramExpression; field_id: string })
	| (ExpressionBase & { kind: "list.length"; list: BoxProgramExpression })
	| (ExpressionBase & { kind: "list.map"; list: BoxProgramExpression; item_binding_id: string; value: BoxProgramExpression })
	| (ExpressionBase & {
			kind: "list.fold";
			list: BoxProgramExpression;
			initial: BoxProgramExpression;
			item_binding_id: string;
			accumulator_binding_id: string;
			value: BoxProgramExpression;
	  })
	| (ExpressionBase & { kind: "list.every"; list: BoxProgramExpression; item_binding_id: string; predicate: BoxProgramExpression });

export type BoxProgramInit =
	| { id: string; kind: "value"; callee_cell_id: string; value: BoxProgramExpression }
	| { id: string; kind: "copy" | "share"; callee_cell_id: string; caller_cell_id: string };

export type BoxProgramStatement =
	| { id: string; kind: "write"; cell_id: string; value: BoxProgramExpression }
	| { id: string; kind: "call"; box_id: string; init: BoxProgramInit[] }
	| { id: string; kind: "reject_if"; condition: BoxProgramExpression; code: string; details?: BoxProgramExpression };

const expression: z.ZodType<BoxProgramExpression> = z.lazy(() => {
	const base = { id: input_uuid, type_id: input_uuid };
	const record_fields = z
		.array(z.strictObject({ field_id: input_uuid, value: expression }))
		.max(MAX_RECORD_EXPRESSION_FIELDS)
		.superRefine((fields, context) => {
			const seen = new Set<string>();
			for (const field of fields) {
				if (seen.has(field.field_id)) context.addIssue({ code: "custom", message: "Runtime record expression contains a duplicate field" });
				seen.add(field.field_id);
			}
		})
		.transform((fields) => fields.toSorted((left, right) => compare_code_units(left.field_id, right.field_id)));
	return z.discriminatedUnion("kind", [
		z.strictObject({ ...base, kind: z.literal("literal"), value: literal_value }),
		z.strictObject({ ...base, kind: z.literal("cell"), cell_id: input_uuid }),
		z.strictObject({ ...base, kind: z.literal("binding"), binding_id: input_uuid }),
		z.strictObject({
			...base,
			kind: z.literal("binary"),
			operator: z.enum([
				"add",
				"subtract",
				"multiply",
				"divide",
				"concat",
				"equal",
				"not_equal",
				"less_than",
				"less_or_equal",
				"greater_than",
				"greater_or_equal",
				"and",
				"or",
			]),
			left: expression,
			right: expression,
		}),
		z.strictObject({
			...base,
			kind: z.literal("select"),
			condition: expression,
			when_true: expression,
			when_false: expression,
		}),
		z.strictObject({ ...base, kind: z.literal("record"), fields: record_fields }),
		z.strictObject({ ...base, kind: z.literal("field"), record: expression, field_id: input_uuid }),
		z.strictObject({ ...base, kind: z.literal("list.length"), list: expression }),
		z.strictObject({ ...base, kind: z.literal("list.map"), list: expression, item_binding_id: input_uuid, value: expression }),
		z.strictObject({
			...base,
			kind: z.literal("list.fold"),
			list: expression,
			initial: expression,
			item_binding_id: input_uuid,
			accumulator_binding_id: input_uuid,
			value: expression,
		}),
		z.strictObject({ ...base, kind: z.literal("list.every"), list: expression, item_binding_id: input_uuid, predicate: expression }),
	]);
}) as z.ZodType<BoxProgramExpression>;

const write_statement = z.strictObject({
	id: input_uuid,
	kind: z.literal("write"),
	cell_id: input_uuid,
	value: expression,
});

const call_init = z.discriminatedUnion("kind", [
	z.strictObject({ id: input_uuid, kind: z.literal("value"), callee_cell_id: input_uuid, value: expression }),
	z.strictObject({ id: input_uuid, kind: z.literal("copy"), callee_cell_id: input_uuid, caller_cell_id: input_uuid }),
	z.strictObject({ id: input_uuid, kind: z.literal("share"), callee_cell_id: input_uuid, caller_cell_id: input_uuid }),
]);

const call_statement = z.strictObject({
	id: input_uuid,
	kind: z.literal("call"),
	box_id: input_uuid,
	init: z
		.array(call_init)
		.max(128)
		.superRefine((entries, context) => {
			const cells = new Set<string>();
			for (const entry of entries) {
				if (cells.has(entry.callee_cell_id)) context.addIssue({ code: "custom", message: "Box call initializes a cell more than once" });
				cells.add(entry.callee_cell_id);
			}
		}),
});

const reject_statement = z.strictObject({
	id: input_uuid,
	kind: z.literal("reject_if"),
	condition: expression,
	code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
	details: expression.optional(),
});

const statement = z.discriminatedUnion("kind", [write_statement, call_statement, reject_statement]);

const program = z.strictObject({
	schema: z.literal("box.program.v1"),
	body: z.array(statement).max(MAX_PROGRAM_STATEMENTS),
});

export interface BoxProgram {
	schema: "box.program.v1";
	body: BoxProgramStatement[];
}

const expression_children = (value: BoxProgramExpression): BoxProgramExpression[] => {
	if (value.kind === "binary") return [value.left, value.right];
	if (value.kind === "select") return [value.condition, value.when_true, value.when_false];
	if (value.kind === "record") return value.fields.map((field) => field.value);
	if (value.kind === "field") return [value.record];
	if (value.kind === "list.length") return [value.list];
	if (value.kind === "list.map") return [value.list, value.value];
	if (value.kind === "list.fold") return [value.list, value.initial, value.value];
	if (value.kind === "list.every") return [value.list, value.predicate];
	return [];
};

export interface BoxProgramNodeProjection {
	id: string;
	value: Record<string, unknown>;
}

const project_expression = (value: BoxProgramExpression): Record<string, unknown> => {
	if (value.kind === "literal") return { id: value.id, kind: value.kind, type_id: value.type_id, value: value.value };
	if (value.kind === "cell") return { id: value.id, kind: value.kind, type_id: value.type_id, cell_id: value.cell_id };
	if (value.kind === "binding") return { id: value.id, kind: value.kind, type_id: value.type_id, binding_id: value.binding_id };
	if (value.kind === "binary") {
		return { id: value.id, kind: value.kind, type_id: value.type_id, operator: value.operator, left_id: value.left.id, right_id: value.right.id };
	}
	if (value.kind === "select") {
		return {
			id: value.id,
			kind: value.kind,
			type_id: value.type_id,
			condition_id: value.condition.id,
			when_true_id: value.when_true.id,
			when_false_id: value.when_false.id,
		};
	}
	if (value.kind === "record") {
		return {
			id: value.id,
			kind: value.kind,
			type_id: value.type_id,
			fields: value.fields.map((field) => ({ field_id: field.field_id, value_id: field.value.id })),
		};
	}
	if (value.kind === "field") return { id: value.id, kind: value.kind, type_id: value.type_id, record_id: value.record.id, field_id: value.field_id };
	if (value.kind === "list.length") return { id: value.id, kind: value.kind, type_id: value.type_id, list_id: value.list.id };
	if (value.kind === "list.map") {
		return {
			id: value.id,
			kind: value.kind,
			type_id: value.type_id,
			list_id: value.list.id,
			item_binding_id: value.item_binding_id,
			value_id: value.value.id,
		};
	}
	if (value.kind === "list.fold") {
		return {
			id: value.id,
			kind: value.kind,
			type_id: value.type_id,
			list_id: value.list.id,
			initial_id: value.initial.id,
			item_binding_id: value.item_binding_id,
			accumulator_binding_id: value.accumulator_binding_id,
			value_id: value.value.id,
		};
	}
	return {
		id: value.id,
		kind: value.kind,
		type_id: value.type_id,
		list_id: value.list.id,
		item_binding_id: value.item_binding_id,
		predicate_id: value.predicate.id,
	};
};

export const project_box_program_nodes = (value: BoxProgram): BoxProgramNodeProjection[] => {
	const nodes: BoxProgramNodeProjection[] = [];
	const add_expression = (expression: BoxProgramExpression): void => {
		nodes.push({ id: expression.id, value: project_expression(expression) });
		for (const child of expression_children(expression)) add_expression(child);
	};
	for (const statement of value.body) {
		if (statement.kind === "write") {
			nodes.push({ id: statement.id, value: { id: statement.id, kind: statement.kind, cell_id: statement.cell_id, value_id: statement.value.id } });
			add_expression(statement.value);
			continue;
		}
		if (statement.kind === "reject_if") {
			nodes.push({
				id: statement.id,
				value: {
					id: statement.id,
					kind: statement.kind,
					condition_id: statement.condition.id,
					code: statement.code,
					details_id: statement.details?.id ?? null,
				},
			});
			add_expression(statement.condition);
			if (statement.details) add_expression(statement.details);
			continue;
		}
		nodes.push({
			id: statement.id,
			value: { id: statement.id, kind: statement.kind, box_id: statement.box_id, init_ids: statement.init.map((entry) => entry.id) },
		});
		for (const entry of statement.init) {
			nodes.push({
				id: entry.id,
				value:
					entry.kind === "value"
						? { id: entry.id, kind: entry.kind, callee_cell_id: entry.callee_cell_id, value_id: entry.value.id }
						: { id: entry.id, kind: entry.kind, callee_cell_id: entry.callee_cell_id, caller_cell_id: entry.caller_cell_id },
			});
			if (entry.kind === "value") add_expression(entry.value);
		}
	}
	return nodes.toSorted((left, right) => compare_code_units(left.id, right.id));
};

export const box_program_identities = (value: BoxProgram): string[] => {
	const identities: string[] = [];
	for (const statement of value.body) {
		identities.push(statement.id);
		const pending: BoxProgramExpression[] = [];
		if (statement.kind === "write") pending.push(statement.value);
		if (statement.kind === "call") {
			for (const entry of statement.init) {
				identities.push(entry.id);
				if (entry.kind === "value") pending.push(entry.value);
			}
		}
		if (statement.kind === "reject_if") {
			pending.push(statement.condition);
			if (statement.details) pending.push(statement.details);
		}
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) break;
			identities.push(current.id);
			if (current.kind === "list.map" || current.kind === "list.every") identities.push(current.item_binding_id);
			if (current.kind === "list.fold") identities.push(current.item_binding_id, current.accumulator_binding_id);
			pending.push(...expression_children(current));
		}
	}
	return identities;
};

export const box_program_type_ids = (value: BoxProgram): string[] => {
	const type_ids: string[] = [];
	const add_expression = (current: BoxProgramExpression): void => {
		type_ids.push(current.type_id);
		for (const child of expression_children(current)) add_expression(child);
	};
	for (const statement of value.body) {
		if (statement.kind === "write") add_expression(statement.value);
		if (statement.kind === "call") {
			for (const entry of statement.init) {
				if (entry.kind === "value") add_expression(entry.value);
			}
		}
		if (statement.kind === "reject_if") {
			add_expression(statement.condition);
			if (statement.details) add_expression(statement.details);
		}
	}
	return type_ids;
};

export const normalize_box_program = (input: unknown): BoxProgram => {
	const parsed = program.parse(input) as BoxProgram;
	let node_count = parsed.body.length;
	const identities = new Set<string>();
	const add_identity = (id: string): void => {
		if (identities.has(id)) throw new Error("Box program contains duplicate identity");
		identities.add(id);
	};
	for (const statement of parsed.body) {
		add_identity(statement.id);
		const pending: { expression: BoxProgramExpression; depth: number }[] = [];
		if (statement.kind === "write") pending.push({ expression: statement.value, depth: 1 });
		if (statement.kind === "call") {
			for (const entry of statement.init) {
				node_count += 1;
				if (node_count > MAX_PROGRAM_NODES) throw new Error("Box program has too many nodes");
				add_identity(entry.id);
				if (entry.kind === "value") pending.push({ expression: entry.value, depth: 1 });
			}
		}
		if (statement.kind === "reject_if") {
			pending.push({ expression: statement.condition, depth: 1 });
			if (statement.details) pending.push({ expression: statement.details, depth: 1 });
		}
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) break;
			node_count += 1;
			if (node_count > MAX_PROGRAM_NODES) throw new Error("Box program has too many nodes");
			if (current.depth > MAX_EXPRESSION_DEPTH) throw new Error("Box program expression is too deeply nested");
			add_identity(current.expression.id);
			if (current.expression.kind === "list.map" || current.expression.kind === "list.every") {
				add_identity(current.expression.item_binding_id);
			}
			if (current.expression.kind === "list.fold") {
				add_identity(current.expression.item_binding_id);
				add_identity(current.expression.accumulator_binding_id);
			}
			for (const child of expression_children(current.expression)) pending.push({ expression: child, depth: current.depth + 1 });
		}
	}
	return parsed;
};
