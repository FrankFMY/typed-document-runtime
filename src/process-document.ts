import { z } from "zod";
import type { BoxDocument, BoxDocumentNode } from "./box-document.js";
import { normalize_box_document } from "./box-document.js";
import type { BoxProgramStatement } from "./box-program.js";
import { create_box_type_comparer } from "./box-type-system.js";
import type { ProcessProgram } from "./process-program.js";
import { normalize_process_program, process_program_identities } from "./process-program.js";

const MAX_PROCESS_EFFECTS = 64;
const MAX_PROCESS_PROJECTIONS = 128;
const input_uuid = z.uuid().transform((value) => value.toLowerCase());
const capability = z
	.string()
	.max(128)
	.regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v[1-9]\d*$/u);

const effect = z.strictObject({
	id: input_uuid,
	capability,
	request_cell_id: input_uuid,
	request_type_id: input_uuid,
	result_cell_id: input_uuid,
	result_type_id: input_uuid,
});

const input_document = z.strictObject({
	schema: z.literal("process.document.v1"),
	root_id: z.unknown(),
	nodes: z.array(z.unknown()),
	input_cell_ids: z.array(input_uuid).max(MAX_PROCESS_PROJECTIONS),
	output_cell_ids: z.array(input_uuid).max(MAX_PROCESS_PROJECTIONS),
	effects: z.array(effect).max(MAX_PROCESS_EFFECTS),
	program: z.unknown(),
});

export interface ProcessEffectDeclaration {
	id: string;
	capability: string;
	request_cell_id: string;
	request_type_id: string;
	result_cell_id: string;
	result_type_id: string;
}

export interface ProcessDocument {
	schema: "process.document.v1";
	root_id: string;
	nodes: BoxDocumentNode[];
	input_cell_ids: string[];
	output_cell_ids: string[];
	effects: ProcessEffectDeclaration[];
	program: ProcessProgram;
}

const compare_code_units = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const by_id = <Value extends { id: string }>(left: Value, right: Value): number => compare_code_units(left.id, right.id);

const unique_sorted = (values: string[], duplicate_message: string): string[] => {
	if (new Set(values).size !== values.length) throw new Error(duplicate_message);
	return values.toSorted(compare_code_units);
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
	const left_record = left as Record<string, unknown>;
	const right_record = right as Record<string, unknown>;
	const keys = Object.keys(left_record);
	return (
		keys.length === Object.keys(right_record).length &&
		keys.every((key) => Object.hasOwn(right_record, key) && json_values_equal(left_record[key], right_record[key]))
	);
};

export const normalize_process_document = (input: unknown): ProcessDocument => {
	const parsed = input_document.parse(input);
	const program = normalize_process_program(parsed.program);
	const ordinary_body = program.body.filter((statement): statement is BoxProgramStatement => statement.kind !== "effect");
	const frame = normalize_box_document({
		schema: "box.document.v2",
		root_id: parsed.root_id,
		nodes: parsed.nodes,
		program: { schema: "box.program.v1", body: ordinary_body },
	});
	if (frame.root_id === null) throw new Error("Process document root must be a record");
	const root = frame.nodes.find((node) => node.id === frame.root_id);
	if (!root || root.kind !== "record") throw new Error("Process document root must be a record");
	const root_cells = new Map(root.fields.map((field) => [field.id, field]));
	const input_cell_ids = unique_sorted(parsed.input_cell_ids, "Process document contains duplicate input projection");
	const output_cell_ids = unique_sorted(parsed.output_cell_ids, "Process document contains duplicate output projection");
	for (const cell_id of [...input_cell_ids, ...output_cell_ids]) {
		if (!root_cells.has(cell_id)) throw new Error("Process document projection references an unknown root cell");
	}

	const effects = parsed.effects.toSorted(by_id);
	if (new Set(effects.map((item) => item.id)).size !== effects.length) throw new Error("Process document contains duplicate effect identity");
	const type_comparer = create_box_type_comparer();
	for (const item of effects) {
		const request_cell = root_cells.get(item.request_cell_id);
		const result_cell = root_cells.get(item.result_cell_id);
		if (!request_cell || !result_cell) throw new Error("Process document effect references an unknown root cell");
		type_comparer.resolved_type(frame, item.request_type_id);
		type_comparer.resolved_type(frame, item.result_type_id);
		if (!type_comparer.same_type(frame, request_cell.type_id, frame, item.request_type_id)) {
			throw new Error("Process document effect request type is inconsistent");
		}
		if (!type_comparer.same_type(frame, result_cell.type_id, frame, item.result_type_id)) {
			throw new Error("Process document effect result type is inconsistent");
		}
	}

	const effect_ids = new Set(effects.map((item) => item.id));
	const used_effect_ids = new Set<string>();
	for (const statement of program.body) {
		if (statement.kind !== "effect") continue;
		if (!effect_ids.has(statement.effect_id)) throw new Error("Process program uses an undeclared effect");
		if (used_effect_ids.has(statement.effect_id)) throw new Error("Process program uses an effect more than once");
		used_effect_ids.add(statement.effect_id);
	}
	if (used_effect_ids.size !== effects.length) throw new Error("Process document contains an unused effect declaration");

	const identities = new Set<string>();
	for (const node of frame.nodes) {
		if (identities.has(node.id)) throw new Error("Process document contains duplicate identity");
		identities.add(node.id);
		if (node.kind === "record") {
			for (const field of node.fields) {
				if (identities.has(field.id)) throw new Error("Process document contains duplicate identity");
				identities.add(field.id);
			}
		}
	}
	for (const item of effects) {
		if (identities.has(item.id)) throw new Error("Process document contains duplicate identity");
		identities.add(item.id);
	}
	for (const id of process_program_identities(program)) {
		if (identities.has(id)) throw new Error("Process document contains duplicate identity");
		identities.add(id);
	}

	return {
		schema: parsed.schema,
		root_id: frame.root_id,
		nodes: frame.nodes,
		input_cell_ids,
		output_cell_ids,
		effects,
		program,
	};
};

export const is_canonical_process_document = (input: unknown): input is ProcessDocument => {
	try {
		return json_values_equal(input, normalize_process_document(input));
	} catch {
		return false;
	}
};

export const process_document_box_schema = (document: ProcessDocument): Extract<BoxDocument, { schema: "box.document.v2" }> => ({
	schema: "box.document.v2" as const,
	root_id: document.root_id,
	nodes: document.nodes,
	program: {
		schema: "box.program.v1" as const,
		body: document.program.body.filter((statement): statement is BoxProgramStatement => statement.kind !== "effect"),
	},
});
