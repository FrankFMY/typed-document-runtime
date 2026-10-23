import { z } from "zod";
import type { ApplicationDataOperation } from "./application-data-contract.js";
import { application_data_capability, application_data_operation_contracts, normalize_application_data_schema } from "./application-data-contract.js";
import { create_box_type_comparer } from "./box-type-system.js";
import type { OperationSchema, ProcessOperationContract } from "./process-contract.js";
import { check_process_operation_contract, process_operation_contracts } from "./process-contract.js";
import type { ProjectSourceSnapshot } from "./project-source-snapshot.js";
import { project_source_values_equal as equal, normalize_project_source_snapshot } from "./project-source-snapshot.js";
import type { PublishedDocument } from "./published-document.js";
import { normalize_published_document } from "./published-document.js";

export const PACKAGE_MAX_BYTES = 12 * 1024 * 1024;
const uuid = z.uuid();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const version = z
	.string()
	.regex(/^[1-9]\d*$/u)
	.refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const schema_document = z.unknown().transform((value) => normalize_application_data_schema(value));
const envelope = z.strictObject({
	schema: z.literal("application.package.v1"),
	name: z.string().min(1).max(128),
	publication: z.strictObject({ id: uuid, content_digest: digest }),
	source: z.unknown().transform((value) => normalize_project_source_snapshot(value)),
	data_schemas: z.array(z.strictObject({ entity_id: uuid, document_version: version, document: schema_document })).max(4096),
	requirements: z
		.array(z.strictObject({ box_id: uuid, effect_id: uuid, capability: z.string().max(128), request: z.unknown(), result: z.unknown() }))
		.max(4096),
	digest,
});

export const package_data_reference = (
	capability: string,
): { entity_id: string; document_version: string; operation: ApplicationDataOperation } | null => {
	const match = /^data\.e(?<entity>[0-9a-f]{32})\.r(?<version>[1-9]\d*)\.(?<operation>create|read|update|archive|restore|list|query|aggregate)\.v1$/u.exec(
		capability,
	);
	if (!match) {
		if (capability.startsWith("data.")) throw new Error("package_data_capability_invalid");
		return null;
	}
	const hex = match.groups!.entity!;
	return {
		entity_id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
		document_version: version.parse(match.groups!.version),
		operation: match.groups!.operation as ApplicationDataOperation,
	};
};

// Data only, bounded before recursive semantic parsing. Do not invoke getters or toJSON.
export const package_json = (input: unknown): string => {
	let nodes = 0;
	let string_units = 0;
	const visit = (value: unknown, depth: number): void => {
		if (++nodes > 500_000 || depth > 96) throw new Error("package_limit");
		if (typeof value === "string") {
			string_units += value.length;
			if (string_units > PACKAGE_MAX_BYTES) throw new Error("package_limit");
			return;
		}
		if (value === null || typeof value === "boolean") return;
		if (typeof value === "number" && Number.isFinite(value)) return;
		if (typeof value !== "object" || value === null) throw new Error("package_data_only");
		if (Array.isArray(value)) {
			if (value.length > 65_536) throw new Error("package_limit");
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
				throw new Error("package_data_only");
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error("package_data_only");
				visit(descriptor.value, depth + 1);
			}
		} else {
			if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("package_data_only");
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key !== "string") throw new Error("package_data_only");
				string_units += key.length;
				if (string_units > PACKAGE_MAX_BYTES) throw new Error("package_limit");
				const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
				if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error("package_data_only");
				visit(descriptor.value, depth + 1);
			}
		}
	};
	visit(input, 0);
	const serialized = JSON.stringify(input);
	if (new TextEncoder().encode(serialized).byteLength > PACKAGE_MAX_BYTES) throw new Error("package_limit");
	return serialized;
};

export const package_digest = async (input: unknown): Promise<string> => {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(package_json(input)));
	return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

// Operation integrity is independent of JSON/JSONB object key order. The existing
// publication digest above deliberately keeps its canonical snapshot encoding.
const ordered_value = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(ordered_value);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, child]) => [key, ordered_value(child)]),
		);
	return value;
};
export const package_operation_digest = (input: unknown): Promise<string> => {
	package_json(input);
	return package_digest(ordered_value(input));
};

export const freeze_package_value = <T>(value: T): T => {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze_package_value(child);
		Object.freeze(value);
	}
	return value;
};

export const validate_package_graph = (source: ProjectSourceSnapshot): void => {
	const boxes = new Map(source.boxes.map((box) => [box.id, box]));
	const edges = new Map<string, string[]>();
	const comparer = create_box_type_comparer();
	for (const box of source.boxes) {
		const document = box.document;
		if (document.schema === "box.document.v1") continue;
		const root = document.nodes.find((node) => node.id === document.root_id);
		const cells = root?.kind === "record" ? root.fields : [];
		const targets: string[] = [];
		for (const statement of document.program.body) {
			if (statement.kind !== "call") continue;
			const target = boxes.get(statement.box_id);
			if (!target || target.realm_id !== box.realm_id || target.document.schema !== "box.document.v2") throw new Error("package_call_not_closed");
			const target_root = target.document.nodes.find((node) => node.id === target.document.root_id);
			if (target_root?.kind !== "record") throw new Error("package_call_not_closed");
			for (const init of statement.init) {
				const callee = target_root.fields.find((field) => field.id === init.callee_cell_id);
				const type = init.kind === "value" ? init.value.type_id : cells.find((field) => field.id === init.caller_cell_id)?.type_id;
				if (!callee || !type || !comparer.same_type(document, type, target.document, callee.type_id))
					throw new Error("package_call_contract_invalid");
			}
			targets.push(target.id);
		}
		edges.set(box.id, targets);
	}
	const visited = new Set<string>();
	const active = new Set<string>();
	const visit = (id: string): void => {
		if (active.has(id)) throw new Error("package_recursive_call");
		if (visited.has(id)) return;
		active.add(id);
		for (const target of edges.get(id) ?? []) visit(target);
		active.delete(id);
		visited.add(id);
	};
	for (const id of boxes.keys()) visit(id);
};

export interface ApplicationPackage {
	schema: "application.package.v1";
	name: string;
	publication: { id: string; content_digest: string };
	source: ProjectSourceSnapshot;
	data_schemas: { entity_id: string; document_version: string; document: OperationSchema }[];
	requirements: (ProcessOperationContract & { box_id: string })[];
	digest: string;
}

const package_requirements = (source: ProjectSourceSnapshot): ApplicationPackage["requirements"] =>
	source.boxes.flatMap((box) =>
		box.document.schema === "process.document.v1"
			? process_operation_contracts(box.document).map((requirement) => ({
					box_id: box.id,
					effect_id: requirement.effect_id,
					capability: requirement.capability,
					request: requirement.request,
					result: requirement.result,
				}))
			: [],
	);

const package_content = async (
	input: Omit<ApplicationPackage, "schema" | "requirements" | "digest">,
): Promise<Omit<ApplicationPackage, "digest">> => {
	const parsed = envelope.parse({ ...input, schema: "application.package.v1", requirements: [], digest: `sha256:${"0".repeat(64)}` });
	const source = parsed.source;
	validate_package_graph(source);
	if ((await package_digest(source)) !== parsed.publication.content_digest) throw new Error("package_publication_mismatch");
	const requirements = package_requirements(source);
	const needed = new Set<string>();
	for (const requirement of requirements) {
		const data = package_data_reference(requirement.capability);
		if (!data) continue;
		const entity = source.boxes.find((box) => box.id === data.entity_id);
		if (!entity || BigInt(data.document_version) > BigInt(entity.document_version)) throw new Error("package_data_not_owned");
		const witness = parsed.data_schemas.find((item) => item.entity_id === data.entity_id && item.document_version === data.document_version);
		if (!witness) throw new Error("package_data_schema_missing");
		if (entity.document_version === data.document_version && !equal(entity.document, witness.document))
			throw new Error("package_data_schema_mismatch");
		const contract = application_data_operation_contracts(data.entity_id, data.document_version, witness.document).find(
			(item) => item.operation === data.operation,
		)!;
		if (!check_process_operation_contract(requirement, contract).compatible) throw new Error("package_data_contract_mismatch");
		needed.add(`${data.entity_id}:${data.document_version}`);
	}
	if (parsed.data_schemas.length !== needed.size || parsed.data_schemas.some((item) => !needed.delete(`${item.entity_id}:${item.document_version}`)))
		throw new Error("package_data_schema_closure");
	return {
		schema: "application.package.v1",
		name: parsed.name,
		publication: parsed.publication,
		source,
		data_schemas: parsed.data_schemas.toSorted((a, b) =>
			`${a.entity_id}:${a.document_version}`.localeCompare(`${b.entity_id}:${b.document_version}`, "en"),
		),
		requirements,
	};
};

export const create_application_package = async (
	input: Omit<ApplicationPackage, "schema" | "requirements" | "digest">,
): Promise<ApplicationPackage> => {
	package_json(input);
	const content = await package_content(input);
	return freeze_package_value({ ...content, digest: await package_digest(content) });
};

export const parse_application_package = async (input: unknown): Promise<ApplicationPackage> => {
	package_json(input);
	const parsed = envelope.parse(input);
	const content = await package_content({
		name: parsed.name,
		publication: parsed.publication,
		source: parsed.source,
		data_schemas: parsed.data_schemas,
	});
	const normalized = { ...content, digest: await package_digest(content) };
	if (!equal(input, normalized)) throw new Error("package_integrity_mismatch");
	return freeze_package_value(normalized);
};

export interface PackageIdentityMap {
	project_id: string;
	realms: Record<string, string>;
	boxes: Record<string, string>;
	versions: Record<string, string>;
}

const mapped = (items: Record<string, string>, id: string): string => {
	const target = items[id];
	if (!target) throw new Error("Package identity mapping is incomplete");
	return target;
};

export const remap_package_source = (source: ProjectSourceSnapshot, identities: PackageIdentityMap): ProjectSourceSnapshot => {
	const result = structuredClone(source);
	result.project_id = identities.project_id;
	for (const realm of result.realms) realm.id = mapped(identities.realms, realm.id);
	for (const box of result.boxes) {
		box.document_version = identities.versions[`${box.id}:${box.document_version}`] ?? box.document_version;
		if (box.presentation?.record_action) {
			box.presentation.record_action.entity_id = mapped(identities.boxes, box.presentation.record_action.entity_id);
		}
		box.id = mapped(identities.boxes, box.id);
		box.realm_id = mapped(identities.realms, box.realm_id);
		if (box.parent_id !== null) box.parent_id = mapped(identities.boxes, box.parent_id);
		box.document = remap_package_document(box.document, identities);
	}
	return normalize_project_source_snapshot(result);
};

export const remap_package_document = (input: PublishedDocument, identities: PackageIdentityMap): PublishedDocument => {
	const document = structuredClone(input);
	const mapped = (id: string): string => {
		const target = identities.boxes[id];
		if (!target) throw new Error("package_identity_missing");
		return target;
	};
	for (const node of document.nodes) {
		if (node.kind !== "record") continue;
		for (const field of node.fields) {
			if (field.record_target) field.record_target.entity_id = mapped(field.record_target.entity_id);
		}
	}
	if (document.schema !== "box.document.v1") {
		for (const statement of document.program.body) {
			if (statement.kind === "call") statement.box_id = mapped(statement.box_id);
		}
	}
	if (document.schema === "process.document.v1") {
		for (const effect of document.effects) {
			const data = package_data_reference(effect.capability);
			if (!data) continue;
			const target_version = identities.versions[`${data.entity_id}:${data.document_version}`];
			if (!target_version) throw new Error("package_data_version_missing");
			effect.capability = application_data_capability(mapped(data.entity_id), target_version, data.operation);
		}
	}
	return normalize_published_document(document);
};
