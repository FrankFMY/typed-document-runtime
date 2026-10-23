import { z } from "zod";
import type { ProjectSourceChange } from "./project-source-comparison.js";
import { compare_project_source } from "./project-source-comparison.js";
import type { ProjectSourceSnapshot } from "./project-source-snapshot.js";
import {
	is_canonical_project_source_revision_snapshot,
	normalize_project_source_revision_snapshot,
	project_source_values_equal,
} from "./project-source-snapshot.js";

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const revision = z.string().refine((value) => /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const name = z
	.string()
	.min(1)
	.refine((value) => value === value.trim() && [...value].length <= 128);
const date = z
	.string()
	.refine(
		(value) =>
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
	);
export const source_operation_kind = z.enum([
	"root_box.create.v1",
	"root_box.create.v2",
	"child_box.create.v1",
	"realm.create.v1",
	"box.rename.v1",
	"box.move.v1",
	"box.delete.v1",
	"box.document.set.v1",
	"box.document.restore.v1",
	"box.presentation.set.v1",
	"project.publish.v1",
]);
export type ProjectSourceOperationKind = z.infer<typeof source_operation_kind>;
export const source_history_list_input = z.strictObject({
	project_id: uuid,
	before_revision: revision.optional(),
	limit: z.number().int().min(1).max(100).default(20),
});
const affected = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("project"), id: uuid, publication_id: uuid }),
	z.strictObject({ kind: z.literal("realm"), id: uuid, name }),
	z.strictObject({
		kind: z.literal("box"),
		id: uuid,
		name: name.optional(),
		realm_id: uuid.optional(),
		parent_id: uuid.nullable(),
		document_version: revision.optional(),
		restored_from_version: revision.optional(),
	}),
]);
const history_item = z.strictObject({
	operation_id: uuid,
	revision,
	expected_revision: revision,
	kind: source_operation_kind,
	iat: date,
	affected,
	materialization: z
		.strictObject({
			operation_id: uuid,
			template_id: z.string().min(1).max(128),
			template_version: z.string().min(1).max(128),
			role: z.string().min(1).max(128),
		})
		.optional(),
});
const history_page = z.strictObject({
	project_id: uuid,
	head_revision: revision,
	items: z.array(history_item).max(100),
	next_before_revision: revision.nullable(),
});
export type ProjectSourceHistoryListInput = z.infer<typeof source_history_list_input>;
export type ProjectSourceHistoryItem = z.infer<typeof history_item>;
export type ProjectSourceHistoryPage = z.infer<typeof history_page>;

export const parse_project_source_history_page = (input: unknown, expected: ProjectSourceHistoryListInput): ProjectSourceHistoryPage | null => {
	try {
		const request = source_history_list_input.parse(expected);
		const result = history_page.parse(input);
		if (result.project_id !== request.project_id || result.items.length > request.limit) return null;
		const seen = new Set<string>();
		let before = request.before_revision === undefined ? BigInt(result.head_revision) + 1n : BigInt(request.before_revision);
		for (const item of result.items) {
			if (
				BigInt(item.revision) >= before ||
				BigInt(item.revision) > BigInt(result.head_revision) ||
				BigInt(item.expected_revision) + 1n !== BigInt(item.revision) ||
				seen.has(item.operation_id)
			)
				return null;
			seen.add(item.operation_id);
			before = BigInt(item.revision);
			const kind = item.kind === "project.publish.v1" ? "project" : item.kind === "realm.create.v1" ? "realm" : "box";
			if (item.affected.kind !== kind || (kind === "project" && item.affected.id !== request.project_id)) return null;
			if (item.affected.kind === "box") {
				const document = item.kind === "box.document.set.v1" || item.kind === "box.document.restore.v1";
				if (
					document !== (item.affected.document_version !== undefined) ||
					(item.kind === "box.document.restore.v1") !== (item.affected.restored_from_version !== undefined)
				)
					return null;
				if (
					item.affected.document_version !== undefined &&
					(BigInt(item.affected.document_version) === 0n || BigInt(item.affected.document_version) > BigInt(item.revision))
				)
					return null;
				if (
					item.affected.restored_from_version !== undefined &&
					BigInt(item.affected.restored_from_version) >= BigInt(item.affected.document_version!)
				)
					return null;
			}
		}
		if (
			result.next_before_revision !== null &&
			(result.items.length !== request.limit ||
				result.next_before_revision !== result.items.at(-1)?.revision ||
				BigInt(result.next_before_revision) <= 1n)
		)
			return null;
		return result;
	} catch {
		return null;
	}
};
const witness = z
	.strictObject({ revision, operation_id: uuid.nullable() })
	.refine((value) => (value.revision === "0") === (value.operation_id === null));
const comparison_input = z
	.strictObject({ project_id: uuid, from: witness, to: witness })
	.refine((value) => (value.from.revision === value.to.revision) === (value.from.operation_id === value.to.operation_id));

export type ProjectSourceRevisionWitness = z.infer<typeof witness>;
export type ProjectSourceComparisonInput = z.infer<typeof comparison_input>;
export type ProjectSourceRevision = ProjectSourceRevisionWitness & { snapshot: ProjectSourceSnapshot };
export type ProjectSourceComparison = {
	project_id: string;
	head_revision: string;
} & (
	| { status: "ready"; from: ProjectSourceRevision; to: ProjectSourceRevision; changes: ProjectSourceChange[] }
	| {
			status: "unavailable";
			from: ProjectSourceRevisionWitness;
			to: ProjectSourceRevisionWitness;
			reason: "history_incomplete" | "history_limit";
	  }
);

export const source_comparison_input = comparison_input;

const snapshot = z.custom<ProjectSourceSnapshot>(is_canonical_project_source_revision_snapshot).transform(normalize_project_source_revision_snapshot);
const evidence = witness.safeExtend({ snapshot });
const comparison = z.discriminatedUnion("status", [
	z.strictObject({
		project_id: uuid,
		head_revision: revision,
		status: z.literal("ready"),
		from: evidence,
		to: evidence,
		changes: z.array(z.unknown()),
	}),
	z.strictObject({
		project_id: uuid,
		head_revision: revision,
		status: z.literal("unavailable"),
		from: witness,
		to: witness,
		reason: z.enum(["history_incomplete", "history_limit"]),
	}),
]);

export const parse_project_source_comparison = (input: unknown, expected: ProjectSourceComparisonInput): ProjectSourceComparison | null => {
	try {
		const request = comparison_input.parse(expected);
		const result = comparison.parse(input);
		if (result.project_id !== request.project_id) return null;
		for (const side of ["from", "to"] as const) {
			if (
				result[side].revision !== request[side].revision ||
				result[side].operation_id !== request[side].operation_id ||
				BigInt(result[side].revision) > BigInt(result.head_revision)
			)
				return null;
			if (
				result.status === "ready" &&
				(result[side].snapshot.project_id !== request.project_id || result[side].snapshot.revision !== request[side].revision)
			)
				return null;
		}
		if (result.status === "unavailable") return result;
		if (result.from.revision === result.to.revision && !project_source_values_equal(result.from.snapshot, result.to.snapshot)) return null;
		const changes = compare_project_source(result.from.snapshot, result.to.snapshot);
		if (!project_source_values_equal(result.changes, changes)) return null;
		return { ...result, changes };
	} catch {
		return null;
	}
};
