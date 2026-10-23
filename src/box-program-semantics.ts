import type { BoxDocumentNode } from "./box-document.js";
import type { BoxProgram, BoxProgramExpression } from "./box-program.js";
import { create_box_type_comparer } from "./box-type-system.js";

type RecordNode = Extract<BoxDocumentNode, { kind: "record" }>;

export const validate_box_program_semantics = (nodes: BoxDocumentNode[], root: RecordNode, program: BoxProgram): void => {
	const frame_cell_types = new Map(root.fields.map((field) => [field.id, field.type_id]));
	const type_document = { nodes };
	const type_comparer = create_box_type_comparer();
	const resolved_type = (type_id: string): ReturnType<typeof type_comparer.resolved_type> => type_comparer.resolved_type(type_document, type_id);
	const same_type = (left_type_id: string, right_type_id: string): boolean =>
		type_comparer.same_type(type_document, left_type_id, type_document, right_type_id);
	const scalar_type = (type_id: string, expected: "string" | "number" | "boolean" | "absence"): boolean =>
		type_comparer.scalar_type(type_document, type_id, expected);

	const validate_literal = (type_id: string, value: unknown): void => {
		const item = resolved_type(type_id);
		if (item.kind === "scalar") {
			const valid =
				(item.value_type === "absence" && value === null) ||
				(item.value_type === "string" && typeof value === "string") ||
				(item.value_type === "boolean" && typeof value === "boolean") ||
				(item.value_type === "number" && typeof value === "number" && Number.isFinite(value));
			if (!valid) throw new Error("Box program literal does not match its type");
			return;
		}
		if (item.kind === "list") {
			if (!Array.isArray(value)) throw new Error("Box program literal does not match its list type");
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new Error("Box program literal list must be dense");
				validate_literal(item.item_type_id, value[index]);
			}
			return;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("Box program literal does not match its record type");
		}
		const record = value as Record<string, unknown>;
		const fields_by_name = new Map(item.fields.map((field) => [field.name, field]));
		for (const key of Object.keys(record)) {
			const field = fields_by_name.get(key);
			if (!field) throw new Error("Box program record literal contains an unknown field");
			validate_literal(field.type_id, record[key]);
		}
		if (item.fields.some((field) => field.required && !Object.hasOwn(record, field.name))) {
			throw new Error("Box program record literal is missing a required field");
		}
	};

	const validate_expression = (expression: BoxProgramExpression, bindings: ReadonlyMap<string, string>): void => {
		resolved_type(expression.type_id);
		if (expression.kind === "literal") {
			validate_literal(expression.type_id, expression.value);
			return;
		}
		if (expression.kind === "cell") {
			const cell_type = frame_cell_types.get(expression.cell_id);
			if (!cell_type) throw new Error("Box program reads an unknown frame cell");
			if (!same_type(cell_type, expression.type_id)) throw new Error("Box program cell expression type is inconsistent");
			return;
		}
		if (expression.kind === "binding") {
			const binding_type = bindings.get(expression.binding_id);
			if (!binding_type) throw new Error("Box program binding is outside its lexical scope");
			if (!same_type(binding_type, expression.type_id)) throw new Error("Box program binding expression type is inconsistent");
			return;
		}
		if (expression.kind === "select") {
			validate_expression(expression.condition, bindings);
			validate_expression(expression.when_true, bindings);
			validate_expression(expression.when_false, bindings);
			if (!scalar_type(expression.condition.type_id, "boolean")) throw new Error("Box program select condition is not boolean");
			if (!same_type(expression.type_id, expression.when_true.type_id) || !same_type(expression.type_id, expression.when_false.type_id)) {
				throw new Error("Box program select branches are inconsistent");
			}
			return;
		}
		if (expression.kind === "binary") {
			validate_expression(expression.left, bindings);
			validate_expression(expression.right, bindings);
			if (expression.operator === "and" || expression.operator === "or") {
				if (
					!scalar_type(expression.type_id, "boolean") ||
					!scalar_type(expression.left.type_id, "boolean") ||
					!scalar_type(expression.right.type_id, "boolean")
				) {
					throw new Error("Box program boolean expression types are inconsistent");
				}
				return;
			}
			if (expression.operator === "equal" || expression.operator === "not_equal") {
				if (!scalar_type(expression.type_id, "boolean") || !same_type(expression.left.type_id, expression.right.type_id)) {
					throw new Error("Box program equality expression types are inconsistent");
				}
				return;
			}
			if (expression.operator === "concat") {
				if (
					!scalar_type(expression.type_id, "string") ||
					!scalar_type(expression.left.type_id, "string") ||
					!scalar_type(expression.right.type_id, "string")
				) {
					throw new Error("Box program concat expression types are inconsistent");
				}
				return;
			}
			if (["less_than", "less_or_equal", "greater_than", "greater_or_equal"].includes(expression.operator)) {
				const comparable =
					(scalar_type(expression.left.type_id, "number") && scalar_type(expression.right.type_id, "number")) ||
					(scalar_type(expression.left.type_id, "string") && scalar_type(expression.right.type_id, "string"));
				if (!scalar_type(expression.type_id, "boolean") || !comparable) throw new Error("Box program comparison expression types are inconsistent");
				return;
			}
			if (
				!scalar_type(expression.type_id, "number") ||
				!scalar_type(expression.left.type_id, "number") ||
				!scalar_type(expression.right.type_id, "number")
			) {
				throw new Error("Box program arithmetic expression types are inconsistent");
			}
			return;
		}
		if (expression.kind === "record") {
			const record_type = resolved_type(expression.type_id);
			if (record_type.kind !== "record") throw new Error("Box program record expression type is not a record");
			const supplied = new Map(expression.fields.map((field) => [field.field_id, field.value]));
			for (const field of record_type.fields) {
				const field_expression = supplied.get(field.id);
				if (!field_expression) {
					if (field.required) throw new Error("Box program record expression is missing a required field");
					continue;
				}
				validate_expression(field_expression, bindings);
				if (!same_type(field.type_id, field_expression.type_id)) throw new Error("Box program record field expression type is inconsistent");
				supplied.delete(field.id);
			}
			if (supplied.size > 0) throw new Error("Box program record expression contains an unknown field");
			return;
		}
		if (expression.kind === "field") {
			validate_expression(expression.record, bindings);
			const record_type = resolved_type(expression.record.type_id);
			if (record_type.kind !== "record") throw new Error("Box program field source is not a record");
			const field = record_type.fields.find((candidate) => candidate.id === expression.field_id);
			if (!field) throw new Error("Box program field expression references an unknown field");
			if (!same_type(field.type_id, expression.type_id)) throw new Error("Box program field expression type is inconsistent");
			return;
		}

		validate_expression(expression.list, bindings);
		const input_list_type = resolved_type(expression.list.type_id);
		if (input_list_type.kind !== "list") throw new Error("Box program list expression source is not a list");
		if (expression.kind === "list.length") {
			if (!scalar_type(expression.type_id, "number")) throw new Error("Box program list length type is not number");
			return;
		}
		if (expression.kind === "list.map") {
			const output_list_type = resolved_type(expression.type_id);
			if (output_list_type.kind !== "list") throw new Error("Box program list map result type is not a list");
			const nested = new Map(bindings);
			nested.set(expression.item_binding_id, input_list_type.item_type_id);
			validate_expression(expression.value, nested);
			if (!same_type(output_list_type.item_type_id, expression.value.type_id)) throw new Error("Box program list map result type is inconsistent");
			return;
		}
		if (expression.kind === "list.fold") {
			validate_expression(expression.initial, bindings);
			if (!same_type(expression.type_id, expression.initial.type_id)) throw new Error("Box program list fold initial type is inconsistent");
			const nested = new Map(bindings);
			nested.set(expression.item_binding_id, input_list_type.item_type_id);
			nested.set(expression.accumulator_binding_id, expression.type_id);
			validate_expression(expression.value, nested);
			if (!same_type(expression.type_id, expression.value.type_id)) throw new Error("Box program list fold result type is inconsistent");
			return;
		}
		if (!scalar_type(expression.type_id, "boolean")) throw new Error("Box program list every result type is not boolean");
		const nested = new Map(bindings);
		nested.set(expression.item_binding_id, input_list_type.item_type_id);
		validate_expression(expression.predicate, nested);
		if (!scalar_type(expression.predicate.type_id, "boolean")) throw new Error("Box program list every predicate type is not boolean");
	};

	for (const statement of program.body) {
		if (statement.kind === "write") {
			const cell_type = frame_cell_types.get(statement.cell_id);
			if (!cell_type) throw new Error("Box program writes an unknown frame cell");
			validate_expression(statement.value, new Map());
			if (!same_type(cell_type, statement.value.type_id)) throw new Error("Box program write type is inconsistent");
			continue;
		}
		if (statement.kind === "reject_if") {
			validate_expression(statement.condition, new Map());
			if (!scalar_type(statement.condition.type_id, "boolean")) throw new Error("Box program rejection condition is not boolean");
			if (statement.details) validate_expression(statement.details, new Map());
			continue;
		}
		for (const init of statement.init) {
			if (init.kind === "value") {
				validate_expression(init.value, new Map());
				continue;
			}
			if (!frame_cell_types.has(init.caller_cell_id)) throw new Error("Box program call reads an unknown frame cell");
		}
	}
};
