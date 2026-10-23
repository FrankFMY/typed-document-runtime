import { z } from "zod";
import type { BoxPresentation } from "./box-presentation.js";
import { normalize_box_presentation, normalize_box_presentation_shape } from "./box-presentation.js";
import type { PublishedDocument } from "./published-document.js";
import { normalize_published_document } from "./published-document.js";

const MAX_REVISION = 9_223_372_036_854_775_807n;
const MAX_PUBLISHED_REALMS = 256;
const MAX_PUBLISHED_BOXES = 4096;
const MAX_PUBLISHED_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const CANONICAL_REVISION = /^(?:0|[1-9]\d*)$/u;

const revision = z.string().refine((value) => CANONICAL_REVISION.test(value) && BigInt(value) <= MAX_REVISION, "Некорректная ревизия");
const input_uuid = z.uuid().transform((value) => value.toLowerCase());
const normalized_name = z
	.string()
	.transform((value) => value.normalize("NFC").trim())
	.pipe(z.string().refine((value) => value.length > 0 && [...value].length <= 128, "Некорректное имя"));
const document = z.unknown().transform((value, context): PublishedDocument | typeof z.NEVER => {
	try {
		return normalize_published_document(value);
	} catch {
		context.addIssue({
			code: "custom",
			message: "Некорректный документ Бокса",
		});
		return z.NEVER;
	}
});

const realm = z.strictObject({
	id: input_uuid,
	name: normalized_name,
	is_primary: z.boolean(),
});

const box = z.strictObject({
	id: input_uuid,
	realm_id: input_uuid,
	parent_id: input_uuid.nullable(),
	name: normalized_name,
	document_version: revision,
	document,
	presentation: z.custom<BoxPresentation>().optional(),
});

const snapshot = z.strictObject({
	schema: z.literal("project.source.snapshot.v1"),
	project_id: input_uuid,
	revision,
	realms: z.array(realm),
	boxes: z.array(box),
});

export type ProjectSourceSnapshotRealm = z.infer<typeof realm>;
export type ProjectSourceSnapshotBox = z.infer<typeof box>;
export type ProjectSourceSnapshot = z.infer<typeof snapshot>;

const compare_code_units = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const by_id = <Value extends { id: string }>(left: Value, right: Value): number => compare_code_units(left.id, right.id);

const normalize_snapshot = (input: unknown, published: boolean): ProjectSourceSnapshot => {
	const parsed = snapshot.parse(input);
	if (published && parsed.revision === "0") throw new Error("Published source revision must be positive");
	if (parsed.realms.length > MAX_PUBLISHED_REALMS) throw new Error("Published source has too many Realms");
	if (parsed.boxes.length > MAX_PUBLISHED_BOXES) throw new Error("Published source has too many Boxes");
	if (new Set(parsed.realms.map((item) => item.id)).size !== parsed.realms.length) {
		throw new Error("Published source contains duplicate Realm identity");
	}
	if (new Set(parsed.realms.map((item) => item.name)).size !== parsed.realms.length) {
		throw new Error("Published source contains duplicate Realm name");
	}
	if (parsed.realms.filter((item) => item.is_primary).length !== 1) {
		throw new Error("Published source must contain exactly one primary Realm");
	}
	const realm_ids = new Set(parsed.realms.map((item) => item.id));
	if (parsed.boxes.some((item) => !realm_ids.has(item.realm_id))) {
		throw new Error("Published source Box Realm is missing");
	}
	if (parsed.boxes.some((item) => BigInt(item.document_version) > BigInt(parsed.revision))) {
		throw new Error("Published source Box document version is from the future");
	}
	if (new Set(parsed.boxes.map((item) => item.id)).size !== parsed.boxes.length) {
		throw new Error("Published source contains duplicate Box identity");
	}
	const sibling_names = new Set<string>();
	for (const item of parsed.boxes) {
		const key = JSON.stringify([item.realm_id, item.parent_id, item.name]);
		if (sibling_names.has(key)) throw new Error("Published source contains duplicate sibling Box name");
		sibling_names.add(key);
	}
	const box_by_id = new Map(parsed.boxes.map((item) => [item.id, item]));
	for (const item of parsed.boxes) {
		if (item.parent_id === null) continue;
		const parent = box_by_id.get(item.parent_id);
		if (!parent) throw new Error("Published source Box parent is missing");
		if (parent.realm_id !== item.realm_id) throw new Error("Published source Box parent belongs to another Realm");
	}
	const resolved = new Set<string>();
	for (const start of parsed.boxes) {
		if (resolved.has(start.id)) continue;
		const chain: string[] = [];
		const in_chain = new Set<string>();
		let current = start;
		while (current.parent_id !== null && !resolved.has(current.id)) {
			if (in_chain.has(current.id)) throw new Error("Published source Box hierarchy contains a cycle");
			in_chain.add(current.id);
			chain.push(current.id);
			current = box_by_id.get(current.parent_id)!;
		}
		for (const id of chain) resolved.add(id);
	}
	const normalized: ProjectSourceSnapshot = {
		schema: parsed.schema,
		project_id: parsed.project_id,
		revision: parsed.revision,
		realms: parsed.realms.toSorted(by_id).map(({ id, name, is_primary }) => ({ id, name, is_primary })),
		boxes: parsed.boxes.toSorted(by_id).map(({ id, realm_id, parent_id, name, document_version, document: box_document, presentation }) => {
			const snapshot_box: ProjectSourceSnapshot["boxes"][number] = {
				id,
				realm_id,
				parent_id,
				name,
				document_version,
				document: box_document,
			};
			if (presentation !== undefined)
				snapshot_box.presentation = published
					? normalize_box_presentation(presentation, box_document)
					: normalize_box_presentation_shape(presentation);
			return snapshot_box;
		}),
	};
	const normalized_boxes = new Map(normalized.boxes.map((item) => [item.id, item]));
	for (const item of normalized.boxes) {
		for (const node of item.document.nodes) {
			if (node.kind !== "record") continue;
			if (item.document.schema === "box.document.v1" && node.id !== item.document.root_id && node.fields.some((field) => field.record_target)) {
				throw new Error("Box document data Box record target must belong to the root record");
			}
			for (const field of node.fields) {
				if (!field.record_target) continue;
				const target = normalized_boxes.get(field.record_target.entity_id);
				const root = target?.document.nodes.find((entry) => entry.id === target.document.root_id);
				if (!target || target.realm_id !== item.realm_id || target.document.schema !== "box.document.v1" || root?.kind !== "record") {
					throw new Error("Box document record target must be a same Realm data Box");
				}
			}
		}
	}
	if (published) {
		for (const item of normalized.boxes) {
			const binding = item.presentation?.record_action;
			if (!binding) continue;
			const target = normalized_boxes.get(binding.entity_id);
			const root = target?.document.nodes.find((node) => node.id === target.document.root_id);
			if (!target || target.realm_id !== item.realm_id || target.document.schema !== "box.document.v1" || root?.kind !== "record") {
				throw new Error("Box presentation record action must target a same Realm data Box");
			}
		}
	}
	if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_PUBLISHED_SNAPSHOT_BYTES) {
		throw new Error("Published source snapshot exceeds 8 MiB");
	}
	return normalized;
};

export const normalize_project_source_snapshot = (input: unknown): ProjectSourceSnapshot => normalize_snapshot(input, true);

export const serialize_project_source_snapshot = (input: unknown): string => JSON.stringify(normalize_project_source_snapshot(input));

// Source can be at genesis or awaiting presentation repair; publication admission stays stricter.
export const normalize_project_source_revision_snapshot = (input: unknown): ProjectSourceSnapshot => normalize_snapshot(input, false);

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
	const left_keys = Object.keys(left_record);
	if (left_keys.length !== Object.keys(right_record).length) return false;
	return left_keys.every((key) => Object.hasOwn(right_record, key) && json_values_equal(left_record[key], right_record[key]));
};

export { json_values_equal as project_source_values_equal };

export const is_canonical_project_source_revision_snapshot = (input: unknown): input is ProjectSourceSnapshot => {
	try {
		return json_values_equal(input, normalize_project_source_revision_snapshot(input));
	} catch {
		return false;
	}
};

export const is_canonical_project_source_snapshot = (input: unknown): input is ProjectSourceSnapshot => {
	try {
		return json_values_equal(input, normalize_project_source_snapshot(input));
	} catch {
		return false;
	}
};
