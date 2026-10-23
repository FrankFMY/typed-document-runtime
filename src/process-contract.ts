import type { BoxDocument } from "./box-document.js";
import { normalize_box_document } from "./box-document.js";
import type { BoxTypeDocument } from "./box-type-system.js";
import { create_box_type_comparer } from "./box-type-system.js";
import type { ProcessDocument } from "./process-document.js";
import { normalize_process_document } from "./process-document.js";

export interface ProcessOperationContract {
	effect_id: string;
	capability: string;
	request: OperationSchema;
	result: OperationSchema;
}
export interface InstalledOperationContract {
	capability: string;
	request: BoxDocument;
	result: BoxDocument;
}
export interface ProcessOperationCompatibility {
	status: "compatible" | "unavailable" | "invalid_contract" | "request_incompatible" | "result_incompatible" | "request_and_result_incompatible";
	compatible: boolean;
	request_compatible: boolean;
	result_compatible: boolean;
}
export interface ProcessApplicationContract {
	input_schema: OperationSchema;
	output_schema: OperationSchema;
}

const process_projection_schema = (document: ProcessDocument, cell_ids: readonly string[]): OperationSchema => {
	const root = document.nodes.find((node) => node.id === document.root_id);
	if (!root || root.kind !== "record") throw new Error("Process document root must be a record");
	const selected = new Set(cell_ids);
	const fields = root.fields.filter((field) => selected.has(field.id));
	const nodes = new Map(document.nodes.map((node) => [node.id, node]));
	const reached = new Set<string>();
	const pending = fields.map((field) => field.type_id);
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (reached.has(id)) continue;
		const node = nodes.get(id);
		if (!node) throw new Error("Process projection type is missing");
		reached.add(id);
		if (node.kind === "record") pending.push(...node.fields.map((field) => field.type_id));
		else if (node.kind === "list") pending.push(node.item_type_id);
		else if (node.kind === "reference") pending.push(node.target_id);
	}
	return canonical_schema({
		schema: "box.document.v1",
		root_id: root.id,
		nodes: [{ ...root, fields }, ...document.nodes.filter((node) => node.id !== root.id && reached.has(node.id))],
	});
};

export const process_application_contract = (input: ProcessDocument): ProcessApplicationContract => {
	const document = normalize_process_document(input);
	return {
		input_schema: process_projection_schema(document, document.input_cell_ids),
		output_schema: process_projection_schema(document, document.output_cell_ids),
	};
};
export const box_contract_schema = (document: BoxTypeDocument, root_id: string): OperationSchema => {
	const nodes = new Map(document.nodes.map((node) => [node.id, node]));
	if (nodes.size !== document.nodes.length) throw new Error("Operation contract contains duplicate types");
	const reached = new Set<string>();
	const pending = [root_id];
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (reached.has(id)) continue;
		const node = nodes.get(id);
		if (!node) throw new Error("Operation contract type is missing");
		reached.add(id);
		if (node.kind === "record") pending.push(...node.fields.map((field) => field.type_id));
		else if (node.kind === "list") pending.push(node.item_type_id);
		else if (node.kind === "reference") pending.push(node.target_id);
	}
	return canonical_schema({ schema: "box.document.v1", root_id, nodes: document.nodes.filter((node) => reached.has(node.id)) });
};
export const process_operation_contracts = (input: ProcessDocument): ProcessOperationContract[] => {
	const document = normalize_process_document(input);
	return document.effects.map((effect) => ({
		effect_id: effect.id,
		capability: effect.capability,
		request: box_contract_schema(document, effect.request_type_id),
		result: box_contract_schema(document, effect.result_type_id),
	}));
};
export const check_process_operation_contract = (
	required: ProcessOperationContract,
	installed: InstalledOperationContract | null,
): ProcessOperationCompatibility => {
	if (!installed || installed.capability !== required.capability)
		return {
			status: "unavailable",
			compatible: false,
			request_compatible: false,
			result_compatible: false,
		};
	try {
		const request_compatible = box_contract_accepts(installed.request, required.request);
		const result_compatible = box_contract_accepts(required.result, installed.result);
		const compatible = request_compatible && result_compatible;
		return {
			compatible,
			request_compatible,
			result_compatible,
			status: compatible
				? "compatible"
				: request_compatible
					? "result_incompatible"
					: result_compatible
						? "request_incompatible"
						: "request_and_result_incompatible",
		};
	} catch {
		return { status: "invalid_contract", compatible: false, request_compatible: false, result_compatible: false };
	}
};

export type OperationSchema = Extract<BoxDocument, { schema: "box.document.v1" }>;

const canonical_schema = (input: BoxDocument): OperationSchema => {
	const schema = normalize_box_document(input);
	if (schema.schema !== "box.document.v1") throw new Error("Operation contract must be a data schema");
	return schema;
};

// Every value admitted by source must be admitted by target; records reject unknown keys.
export const box_contract_accepts = (target_input: BoxDocument, source_input: BoxDocument): boolean => {
	const target = canonical_schema(target_input);
	const source = canonical_schema(source_input);
	const comparer = create_box_type_comparer();
	if (target.root_id === null || source.root_id === null) {
		const absent = (document: OperationSchema): boolean => document.root_id === null || comparer.scalar_type(document, document.root_id, "absence");
		return absent(target) && absent(source);
	}
	const memo = new Map<string, boolean>();
	const accepts = (target_id: string, source_id: string): boolean => {
		const key = `${target_id}\0${source_id}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		const to = comparer.resolved_type(target, target_id);
		const from = comparer.resolved_type(source, source_id);
		let result = false;
		if (to.kind === "scalar" && from.kind === "scalar") result = to.value_type === from.value_type;
		else if (to.kind === "list" && from.kind === "list") result = accepts(to.item_type_id, from.item_type_id);
		else if (to.kind === "record" && from.kind === "record") {
			const target_fields = new Map(to.fields.map((field) => [field.name, field]));
			const source_fields = new Map(from.fields.map((field) => [field.name, field]));
			result =
				to.fields.every((field) => !field.required || source_fields.get(field.name)?.required === true) &&
				from.fields.every((field) => {
					const accepted = target_fields.get(field.name);
					return (
						accepted !== undefined &&
						accepted.record_target?.entity_id === field.record_target?.entity_id &&
						accepts(accepted.type_id, field.type_id)
					);
				});
		}
		memo.set(key, result);
		return result;
	};
	return accepts(target.root_id, source.root_id);
};
