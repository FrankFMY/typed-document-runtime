import type { BoxDocument, BoxDocumentDiff } from "./box-document.js";
import { diff_box_documents, is_canonical_box_document, normalize_box_document } from "./box-document.js";
import { project_box_program_nodes } from "./box-program.js";
import type { ProcessDocument } from "./process-document.js";
import { is_canonical_process_document, normalize_process_document } from "./process-document.js";
import { project_process_program_nodes } from "./process-program.js";

export type PublishedDocument = BoxDocument | ProcessDocument;

const document_schema = (input: unknown): unknown =>
	typeof input === "object" && input !== null && !Array.isArray(input) ? (input as { schema?: unknown }).schema : undefined;

export const normalize_published_document = (input: unknown): PublishedDocument => {
	if (document_schema(input) === "process.document.v1") return normalize_process_document(input);
	return normalize_box_document(input);
};

export const is_canonical_published_document = (input: unknown): input is PublishedDocument =>
	document_schema(input) === "process.document.v1" ? is_canonical_process_document(input) : is_canonical_box_document(input);

interface PublishedRuntimeNode {
	id: string;
	value: unknown;
}

const json_values_equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const runtime_nodes = (document: PublishedDocument): PublishedRuntimeNode[] => {
	if (document.schema === "box.document.v1") return [];
	if (document.schema === "box.document.v2") return project_box_program_nodes(document.program);
	return [
		...document.effects.map((item) => ({ id: item.id, value: { kind: "effect.declaration", ...item } })),
		...project_process_program_nodes(document.program),
	].toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
};

const program_contract = (document: PublishedDocument): unknown => {
	if (document.schema === "box.document.v1") return null;
	if (document.schema === "box.document.v2") return document.program;
	return {
		schema: document.schema,
		input_cell_ids: document.input_cell_ids,
		output_cell_ids: document.output_cell_ids,
		effects: document.effects,
		program: document.program,
	};
};

export const diff_published_documents = (before_input: unknown, after_input: unknown): BoxDocumentDiff => {
	const before = normalize_published_document(before_input);
	const after = normalize_published_document(after_input);
	if (before.schema !== "process.document.v1" && after.schema !== "process.document.v1") {
		return diff_box_documents(before, after);
	}
	const before_by_id = new Map(before.nodes.map((item) => [item.id, item]));
	const after_by_id = new Map(after.nodes.map((item) => [item.id, item]));
	const before_runtime_nodes = runtime_nodes(before);
	const after_runtime_nodes = runtime_nodes(after);
	const before_runtime_by_id = new Map(before_runtime_nodes.map((item) => [item.id, item.value]));
	const after_runtime_by_id = new Map(after_runtime_nodes.map((item) => [item.id, item.value]));
	return {
		root_changed: before.root_id !== after.root_id,
		added_node_ids: after.nodes.filter((item) => !before_by_id.has(item.id)).map((item) => item.id),
		removed_node_ids: before.nodes.filter((item) => !after_by_id.has(item.id)).map((item) => item.id),
		changed_node_ids: after.nodes
			.filter((item) => {
				const previous = before_by_id.get(item.id);
				return previous !== undefined && !json_values_equal(previous, item);
			})
			.map((item) => item.id),
		program_changed: !json_values_equal(program_contract(before), program_contract(after)),
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
