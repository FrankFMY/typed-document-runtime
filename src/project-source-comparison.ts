import { project_box_program_nodes } from "./box-program.js";
import { project_process_program_nodes } from "./process-program.js";
import type { ProjectSourceSnapshot } from "./project-source-snapshot.js";
import { project_source_values_equal } from "./project-source-snapshot.js";
import type { PublishedDocument } from "./published-document.js";

export interface ProjectSourceChange {
	category: "structure" | "document" | "presentation";
	object_kind: "realm" | "box" | "document" | "type" | "field" | "statement" | "expression" | "effect" | "binding";
	object_id: string;
	box_id?: string;
	property: string;
	before: unknown;
	after: unknown;
}

const equal = project_source_values_equal;

interface DocumentEntity {
	id: string;
	kind: ProjectSourceChange["object_kind"];
	value: Record<string, unknown>;
}

const document_entities = (document: PublishedDocument): DocumentEntity[] => {
	const entities: DocumentEntity[] = [];
	for (const node of document.nodes) {
		if (node.kind === "record") {
			entities.push({ id: node.id, kind: "type", value: { kind: node.kind } });
			for (const field of node.fields) entities.push({ id: field.id, kind: "field", value: { ...field, parent_id: node.id } });
		} else entities.push({ id: node.id, kind: "type", value: { ...node } });
	}
	if (document.schema === "box.document.v1") return entities;
	const statements = new Set(document.program.body.map((item) => item.id));
	const runtime =
		document.schema === "process.document.v1" ? project_process_program_nodes(document.program) : project_box_program_nodes(document.program);
	for (const node of runtime)
		entities.push({
			id: node.id,
			kind: statements.has(node.id) ? "statement" : ["value", "copy", "share"].includes(String(node.value.kind)) ? "binding" : "expression",
			value: node.value,
		});
	if (document.schema === "process.document.v1") {
		for (const effect of document.effects) entities.push({ id: effect.id, kind: "effect", value: { ...effect } });
	}
	return entities;
};

const document_contract = (document: PublishedDocument): Record<string, unknown> => ({
	schema: document.schema,
	root_id: document.root_id,
	program_schema: document.schema === "box.document.v1" ? null : document.program.schema,
	program_order: document.schema === "box.document.v1" ? [] : document.program.body.map((item) => item.id),
	input_cell_ids: document.schema === "process.document.v1" ? document.input_cell_ids : null,
	output_cell_ids: document.schema === "process.document.v1" ? document.output_cell_ids : null,
});

const compare_properties = (
	changes: ProjectSourceChange[],
	identity: Pick<ProjectSourceChange, "category" | "object_kind" | "object_id" | "box_id">,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): void => {
	for (const property of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		if (property === "id" || equal(before[property], after[property])) continue;
		changes.push({ ...identity, property, before: before[property] ?? null, after: after[property] ?? null });
	}
};

const compare_documents = (
	changes: ProjectSourceChange[],
	before: ProjectSourceSnapshot["boxes"][number],
	after: ProjectSourceSnapshot["boxes"][number],
): void => {
	const identity = { category: "document", object_kind: "document", object_id: after.id, box_id: after.id } as const;
	compare_properties(changes, identity, document_contract(before.document), document_contract(after.document));
	const left = new Map(document_entities(before.document).map((entity) => [entity.id, entity]));
	const right = new Map(document_entities(after.document).map((entity) => [entity.id, entity]));
	for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
		const previous = left.get(id);
		const next = right.get(id);
		const entity_identity = { ...identity, object_kind: (next ?? previous)!.kind, object_id: id };
		if (!previous || !next) changes.push({ ...entity_identity, property: "presence", before: previous?.value ?? null, after: next?.value ?? null });
		else compare_properties(changes, entity_identity, previous.value, next.value);
	}
};

export const compare_project_source = (before: ProjectSourceSnapshot, after: ProjectSourceSnapshot): ProjectSourceChange[] => {
	if (before.project_id !== after.project_id) throw new Error("Source comparison belongs to different Projects");
	const changes: ProjectSourceChange[] = [];
	const compare = <T extends { id: string }>(before_items: T[], after_items: T[], object_kind: "realm" | "box", properties: (keyof T)[]): void => {
		const previous = new Map(before_items.map((item) => [item.id, item]));
		const next = new Map(after_items.map((item) => [item.id, item]));
		for (const id of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
			const left = previous.get(id);
			const right = next.get(id);
			if (!left || !right) {
				changes.push({ category: "structure", object_kind, object_id: id, property: "presence", before: left ?? null, after: right ?? null });
				continue;
			}
			for (const property of properties) {
				if (!equal(left[property], right[property]))
					changes.push({
						category: "structure",
						object_kind,
						object_id: id,
						property: String(property),
						before: left[property],
						after: right[property],
					});
			}
		}
	};
	compare(before.realms, after.realms, "realm", ["name", "is_primary"]);
	compare(before.boxes, after.boxes, "box", ["name", "realm_id", "parent_id"]);
	const previous_boxes = new Map(before.boxes.map((box) => [box.id, box]));
	for (const box of after.boxes.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
		const previous = previous_boxes.get(box.id);
		if (!previous) continue;
		compare_documents(changes, previous, box);
		const identity = { category: "presentation", object_kind: "box", object_id: box.id, box_id: box.id } as const;
		if (!previous.presentation || !box.presentation) {
			if (!equal(previous.presentation, box.presentation))
				changes.push({ ...identity, property: "presence", before: previous.presentation ?? null, after: box.presentation ?? null });
			continue;
		}
		const { fields: before_fields, ...before_presentation } = previous.presentation;
		const { fields: after_fields, ...after_presentation } = box.presentation;
		compare_properties(changes, identity, before_presentation, after_presentation);
		const left = new Map(before_fields.map((field) => [field.field_id, field]));
		const right = new Map(after_fields.map((field) => [field.field_id, field]));
		for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
			const before_field = left.get(id);
			const after_field = right.get(id);
			const field_identity = { ...identity, object_kind: "field", object_id: id } as const;
			if (!before_field || !after_field)
				changes.push({ ...field_identity, property: "presence", before: before_field ?? null, after: after_field ?? null });
			else compare_properties(changes, field_identity, { ...before_field }, { ...after_field });
		}
	}
	return changes;
};
