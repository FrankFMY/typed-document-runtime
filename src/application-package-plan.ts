import { z } from "zod";
import { application_data_operation_contracts, normalize_application_data_schema } from "./application-data-contract.js";
import type { ApplicationPackage, PackageIdentityMap } from "./application-package.js";
import {
	freeze_package_value,
	package_data_reference,
	package_digest,
	package_json,
	package_operation_digest,
	parse_application_package,
	remap_package_document,
	remap_package_source,
	validate_package_graph,
} from "./application-package.js";
import type { PackageConflict } from "./application-package-merge.js";
import { merge_package_source } from "./application-package-merge.js";
import { normalize_box_document } from "./box-document.js";
import type { InstalledOperationContract } from "./process-contract.js";
import { check_process_operation_contract, process_operation_contracts } from "./process-contract.js";
import type { ProjectSourceChange } from "./project-source-comparison.js";
import { compare_project_source } from "./project-source-comparison.js";
import type { ProjectSourceSnapshot } from "./project-source-snapshot.js";
import {
	project_source_values_equal as equal,
	normalize_project_source_revision_snapshot,
	normalize_project_source_snapshot,
} from "./project-source-snapshot.js";
import type { PublishedDocument } from "./published-document.js";
import { normalize_published_document } from "./published-document.js";

const uuid = z.uuid();
const revision = z
	.string()
	.regex(/^(?:0|[1-9]\d*)$/u)
	.refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
export const package_request_shape = z.strictObject({
	project_id: uuid,
	installation_id: uuid,
	operation_id: uuid,
	expected_revision: revision,
	previous_operation_id: uuid.nullable(),
	name: z.string().trim().min(1).max(64),
	package: z.unknown(),
	resolutions: z.record(z.string().max(2048), z.enum(["local", "incoming"])),
});
export interface PackageRequest extends Omit<z.infer<typeof package_request_shape>, "package"> {
	package: ApplicationPackage;
}
export interface PackageInstallation {
	installation_id: string;
	operation_id: string;
	name: string;
	package: ApplicationPackage;
	identities: PackageIdentityMap;
	base: ProjectSourceSnapshot;
	source_revision: string;
	witnesses: { box_id: string; document_version: string; document: PublishedDocument }[];
}
export interface PackagePlanInput {
	request: PackageRequest;
	local: ProjectSourceSnapshot;
	previous: PackageInstallation | null;
	version_heads: Record<string, string>;
	capabilities: { application_data: boolean; operations: InstalledOperationContract[] };
}
export interface PackagePreview extends PackagePlanInput {
	readiness: {
		external: { box_id: string; effect_id: string; capability: string; compatible: boolean }[];
		storage: { entity_id: string; document_version: string; status: "bound" | "publication_required" | "earlier_schema_required" | "unavailable" }[];
	};
	witnesses: PackageInstallation["witnesses"];
	identities: PackageIdentityMap;
	incoming: ProjectSourceSnapshot;
	source: ProjectSourceSnapshot;
	documents: { box_id: string; version: string; document: PublishedDocument }[];
	conflicts: PackageConflict[];
	changes: ProjectSourceChange[];
	blockers: string[];
	digest: string;
}
export interface PackageResult {
	schema: "application.package.result.v1";
	project_id: string;
	actor_id: string;
	operation_id: string;
	preview_digest: string;
	request: PackageRequest;
	revision: string;
	installation: PackageInstallation;
	child_operation_ids: string[];
	preview: PackagePreview;
}

export type PackageCommand =
	| { role: string; kind: "realm"; id: string; name: string }
	| { role: string; kind: "create"; box: ProjectSourceSnapshot["boxes"][number] }
	| { role: string; kind: "rename"; id: string; name: string }
	| { role: string; kind: "move"; id: string; parent_id: string | null }
	| { role: string; kind: "document"; id: string; version: string; document: PublishedDocument }
	| { role: string; kind: "presentation"; box: ProjectSourceSnapshot["boxes"][number] }
	| { role: string; kind: "delete"; id: string };

export const package_commands = (preview: Omit<PackagePreview, "digest">): PackageCommand[] => {
	const { local, source } = preview;
	const commands: PackageCommand[] = [];
	for (const realm of source.realms)
		if (!local.realms.some((item) => item.id === realm.id))
			commands.push({ role: `realm:${realm.id}`, kind: "realm", id: realm.id, name: realm.name });
	for (const box of local.boxes) {
		const next = source.boxes.find((item) => item.id === box.id);
		if (!next || box.name !== next.name || box.parent_id !== next.parent_id)
			commands.push({ role: `temporary-name:${box.id}`, kind: "rename", id: box.id, name: `package-${preview.request.operation_id}-${box.id}` });
		if (next && box.parent_id !== next.parent_id && box.parent_id !== null)
			commands.push({ role: `detach:${box.id}`, kind: "move", id: box.id, parent_id: null });
	}
	const ordered: ProjectSourceSnapshot["boxes"] = [];
	const pending = [...source.boxes];
	while (pending.length > 0) {
		const index = pending.findIndex((box) => box.parent_id === null || ordered.some((parent) => parent.id === box.parent_id));
		if (index === -1) throw new Error("package_parent_closure");
		ordered.push(pending.splice(index, 1)[0]!);
	}
	for (const box of ordered) {
		const before = local.boxes.find((item) => item.id === box.id);
		if (before) {
			if (before.parent_id !== box.parent_id && box.parent_id !== null)
				commands.push({ role: `move:${box.id}`, kind: "move", id: box.id, parent_id: box.parent_id });
			if (before.name !== box.name || before.parent_id !== box.parent_id)
				commands.push({ role: `rename:${box.id}`, kind: "rename", id: box.id, name: box.name });
		} else {
			commands.push({ role: `create:${box.id}`, kind: "create", box });
		}
	}
	// A rejected source addition/update still needs a real immutable version for
	// the retained identity map. Materialize it through ordinary temporary source
	// creation/document/deletion in this same transaction, preserving local absence.
	const retained_only = preview.incoming.boxes.filter(
		(box) => !source.boxes.some((item) => item.id === box.id) && preview.documents.some((item) => item.box_id === box.id),
	);
	for (const box of retained_only)
		if (!local.boxes.some((item) => item.id === box.id))
			commands.push({
				role: `witness-create:${box.id}`,
				kind: "create",
				box: { ...box, parent_id: null, name: `package-${preview.request.operation_id}-${box.id}` },
			});
	for (const document of preview.documents)
		commands.push({
			role: `document:${document.box_id}:${document.version}`,
			kind: "document",
			id: document.box_id,
			version: document.version,
			document: document.document,
		});
	for (const box of source.boxes)
		if (!equal(local.boxes.find((item) => item.id === box.id)?.presentation, box.presentation))
			commands.push({ role: `presentation:${box.id}`, kind: "presentation", box });
	const removed = [
		...local.boxes.filter((box) => !source.boxes.some((item) => item.id === box.id)),
		...retained_only.filter((box) => !local.boxes.some((item) => item.id === box.id)).map((box) => ({ id: box.id, parent_id: null })),
	];
	while (removed.length > 0) {
		const index = removed.findIndex((box) => !removed.some((child) => child.parent_id === box.id));
		if (index === -1) throw new Error("package_deletion_closure");
		const box = removed.splice(index, 1)[0]!;
		commands.push({ role: `delete:${box.id}`, kind: "delete", id: box.id });
	}
	return commands;
};

export const parse_package_request = async (input: unknown): Promise<PackageRequest> => {
	package_json(input);
	const parsed = package_request_shape.parse(input);
	const result = { ...parsed, package: await parse_application_package(parsed.package) };
	if (!equal(input, result)) throw new Error("package_request_not_canonical");
	return freeze_package_value(result);
};

export const package_identity = async (installation_id: string, kind: string, original: string): Promise<string> => {
	const hash = (await package_digest(["application.package.identity.v1", installation_id, kind, original])).slice(7, 39);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
};

const installation_realm_name = (name: string, realm: ProjectSourceSnapshot["realms"][number]): string => {
	const label = `${name} · ${realm.name}`;
	return [...label].length <= 128 ? label : `${[...label].slice(0, 108).join("")} · ${realm.id.replaceAll("-", "").slice(0, 16)}`;
};

export const plan_application_package = async (input: PackagePlanInput): Promise<PackagePreview> => {
	package_json(input);
	const request = await parse_package_request(input.request);
	const local = normalize_project_source_revision_snapshot(input.local);
	const capabilities = z
		.strictObject({
			application_data: z.boolean(),
			operations: z
				.array(
					z.strictObject({
						capability: z.string().max(128),
						request: z.unknown().transform(normalize_box_document),
						result: z.unknown().transform(normalize_box_document),
					}),
				)
				.max(4096),
		})
		.parse(input.capabilities);
	if (
		!equal(capabilities, input.capabilities) ||
		new Set(capabilities.operations.map((item) => item.capability)).size !== capabilities.operations.length
	)
		throw new Error("package_capabilities_invalid");
	z.record(uuid, revision).parse(input.version_heads);
	if (local.project_id !== request.project_id || local.revision !== request.expected_revision) throw new Error("package_source_stale");
	const previous = input.previous;
	if (previous) {
		const parsed = z
			.strictObject({
				installation_id: uuid,
				operation_id: uuid,
				name: z.string().min(1).max(64),
				package: z.unknown(),
				identities: z.strictObject({
					project_id: uuid,
					realms: z.record(uuid, uuid),
					boxes: z.record(uuid, uuid),
					versions: z.record(z.string().regex(/^[0-9a-f-]{36}:(?:0|[1-9]\d*)$/u), revision),
				}),
				base: z.unknown(),
				source_revision: revision,
				witnesses: z
					.array(z.strictObject({ box_id: uuid, document_version: revision, document: z.unknown().transform(normalize_published_document) }))
					.max(16384),
			})
			.parse(previous);
		if (
			!equal(parsed, previous) ||
			previous.identities.project_id !== request.project_id ||
			previous.base.project_id !== request.project_id ||
			previous.base.revision !== previous.source_revision
		)
			throw new Error("package_installation_invalid");
		await parse_application_package(previous.package);
		normalize_project_source_revision_snapshot(previous.base);
		const projected = remap_package_source({ ...previous.package.source, revision: previous.source_revision }, previous.identities);
		const retained_primary = previous.base.realms.find((realm) => realm.is_primary)!;
		if (
			!equal(
				previous.base,
				normalize_project_source_revision_snapshot({
					...projected,
					realms: [
						retained_primary,
						...projected.realms.map((realm) => ({ id: realm.id, name: installation_realm_name(previous.name, realm), is_primary: false })),
					],
				}),
			)
		)
			throw new Error("package_installation_base_mismatch");
		const mapping = await Promise.all(
			["realm", "box"].flatMap((kind) =>
				Object.entries(kind === "realm" ? previous.identities.realms : previous.identities.boxes).map(
					async ([original, target]) => target === (await package_identity(request.installation_id, kind, original)),
				),
			),
		);
		if (mapping.some((valid) => !valid)) throw new Error("package_identity_invalid");
	}
	const witnesses: PackageInstallation["witnesses"] = structuredClone(previous?.witnesses ?? []);
	const witnessed = new Map(witnesses.map((item) => [`${item.box_id}:${item.document_version}`, item.document]));
	if (
		witnessed.size !== witnesses.length ||
		(previous &&
			(Object.keys(previous.identities.versions).length !== witnessed.size ||
				[...witnessed.keys()].some((key) => !previous.identities.versions[key])))
	)
		throw new Error("package_version_witness_invalid");
	for (const item of [
		...request.package.source.boxes.map((box) => ({ box_id: box.id, document_version: box.document_version, document: box.document })),
		...request.package.data_schemas.map((schema) => ({
			box_id: schema.entity_id,
			document_version: schema.document_version,
			document: schema.document,
		})),
	]) {
		const key = `${item.box_id}:${item.document_version}`;
		if (witnessed.has(key) && !equal(witnessed.get(key), item.document)) throw new Error("package_version_redefined");
		if (!witnessed.has(key)) {
			witnesses.push(item);
			witnessed.set(key, item.document);
		}
	}
	witnesses.sort((a, b) => `${a.box_id}:${a.document_version}`.localeCompare(`${b.box_id}:${b.document_version}`, "en"));
	if (
		(previous?.operation_id ?? null) !== request.previous_operation_id ||
		(previous &&
			(previous.installation_id !== request.installation_id ||
				previous.name !== request.name ||
				previous.package.source.project_id !== request.package.source.project_id))
	)
		throw new Error("package_installation_stale");
	const identities: PackageIdentityMap = previous
		? structuredClone(previous.identities)
		: { project_id: request.project_id, realms: {}, boxes: {}, versions: {} };
	const realm_entries = await Promise.all(
		request.package.source.realms.map(
			async (realm) => [realm.id, identities.realms[realm.id] ?? (await package_identity(request.installation_id, "realm", realm.id))] as const,
		),
	);
	const box_entries = await Promise.all(
		request.package.source.boxes.map(
			async (box) => [box.id, identities.boxes[box.id] ?? (await package_identity(request.installation_id, "box", box.id))] as const,
		),
	);
	Object.assign(identities.realms, Object.fromEntries(realm_entries));
	Object.assign(identities.boxes, Object.fromEntries(box_entries));
	const version_heads = { ...input.version_heads };
	const pending: { original: string; version: string; document: PublishedDocument }[] = [];
	const allocate = (original: string, source_version: string, document: PublishedDocument): void => {
		const key = `${original}:${source_version}`;
		if (identities.versions[key]) return;
		const box_id = identities.boxes[original]!;
		const version = (BigInt(version_heads[box_id] ?? "0") + 1n).toString();
		version_heads[box_id] = version;
		identities.versions[key] = version;
		pending.push({ original, version, document });
	};
	for (const schema of request.package.data_schemas) {
		if (request.package.source.boxes.find((box) => box.id === schema.entity_id)?.document_version !== schema.document_version)
			allocate(schema.entity_id, schema.document_version, schema.document);
	}
	for (const box of request.package.source.boxes) allocate(box.id, box.document_version, box.document);
	const high_revision = (
		BigInt(local.revision) +
		BigInt(request.package.source.boxes.length * 6 + request.package.data_schemas.length + request.package.source.realms.length + 1)
	).toString();
	const remapped = remap_package_source({ ...request.package.source, revision: high_revision }, identities);
	const primary = local.realms.find((realm) => realm.is_primary)!;
	const incoming = normalize_project_source_revision_snapshot({
		...remapped,
		realms: [primary, ...remapped.realms.map((realm) => ({ id: realm.id, name: installation_realm_name(request.name, realm), is_primary: false }))],
	});
	const base = previous?.base ?? { ...local, realms: [primary], boxes: [] };
	const blockers: string[] = [];
	let source = local;
	let conflicts: PackageConflict[] = [];
	try {
		const merged = merge_package_source(base, local, incoming, request.resolutions);
		source = merged.source;
		conflicts = merged.conflicts;
	} catch (error) {
		blockers.push(error instanceof Error ? error.message : "package_graph_invalid");
	}
	const documents: PackagePreview["documents"] = [];
	for (const item of pending) {
		const box_id = identities.boxes[item.original]!;
		documents.push({ box_id, version: item.version, document: remap_package_document(item.document, identities) });
	}
	for (const box of source.boxes) {
		const last = documents.findLast((item) => item.box_id === box.id);
		const current = local.boxes.find((item) => item.id === box.id);
		if (!equal(last?.document ?? current?.document, box.document)) {
			const version = (BigInt(version_heads[box.id] ?? "0") + 1n).toString();
			version_heads[box.id] = version;
			documents.push({ box_id: box.id, version, document: box.document });
		}
		box.document_version = documents.findLast((item) => item.box_id === box.id)?.version ?? box.document_version;
	}
	source = normalize_project_source_revision_snapshot({ ...source, revision: high_revision });
	validate_package_graph(source);
	try {
		normalize_project_source_snapshot(source);
	} catch {
		blockers.push("package_presentation_requires_source_repair");
	}
	const readiness: PackagePreview["readiness"] = { external: [], storage: [] };
	for (const box of source.boxes) {
		if (box.document.schema === "process.document.v1") {
			for (const effect of box.document.effects) {
				if (package_data_reference(effect.capability)) continue;
				const contract = process_operation_contracts(box.document).find((item) => item.effect_id === effect.id)!;
				const compatible = check_process_operation_contract(
					contract,
					capabilities.operations.find((item) => item.capability === effect.capability) ?? null,
				).compatible;
				readiness.external.push({ box_id: box.id, effect_id: effect.id, capability: effect.capability, compatible });
				if (!compatible) blockers.push("package_capability_unavailable");
			}
		}
	}
	const data_witnesses = request.package.data_schemas.map((schema) => ({
		entity_id: identities.boxes[schema.entity_id]!,
		document_version: identities.versions[`${schema.entity_id}:${schema.document_version}`]!,
		document: schema.document,
	}));
	for (const process of source.boxes) {
		if (process.document.schema !== "process.document.v1") continue;
		for (const requirement of process_operation_contracts(process.document)) {
			const data = package_data_reference(requirement.capability);
			if (!data) continue;
			const entity = source.boxes.find((box) => box.id === data.entity_id);
			if (!entity) {
				blockers.push("package_data_not_owned");
				continue;
			}
			const retained = witnesses.find(
				(item) =>
					identities.boxes[item.box_id] === data.entity_id &&
					identities.versions[`${item.box_id}:${item.document_version}`] === data.document_version,
			);
			const candidate =
				entity.document_version === data.document_version
					? entity.document
					: (documents.find((item) => item.box_id === data.entity_id && item.version === data.document_version)?.document ?? retained?.document);
			let installed = capabilities.operations.find((item) => item.capability === requirement.capability) ?? null;
			if (candidate) {
				try {
					const document = normalize_application_data_schema(candidate);
					installed = application_data_operation_contracts(data.entity_id, data.document_version, document).find(
						(item) => item.operation === data.operation,
					)!;
					if (!data_witnesses.some((item) => item.entity_id === data.entity_id && item.document_version === data.document_version))
						data_witnesses.push({ entity_id: data.entity_id, document_version: data.document_version, document });
				} catch {
					installed = null;
				}
			}
			if (!installed) blockers.push("package_data_schema_missing");
			else if (!check_process_operation_contract(requirement, installed).compatible) blockers.push("package_data_contract_mismatch");
		}
	}
	for (const box of source.boxes) {
		if (!Object.values(identities.boxes).includes(box.id)) continue;
		try {
			const document = normalize_application_data_schema(box.document);
			if (!data_witnesses.some((item) => item.entity_id === box.id && item.document_version === box.document_version))
				data_witnesses.push({ entity_id: box.id, document_version: box.document_version, document });
		} catch {
			/* Canonical executable/non-record documents do not own record storage. */
		}
	}
	for (const schema of data_witnesses) {
		const box = source.boxes.find((item) => item.id === schema.entity_id);
		if (!box) continue;
		const contracts = application_data_operation_contracts(schema.entity_id, schema.document_version, schema.document);
		const bound = contracts.every(
			(contract) =>
				check_process_operation_contract(
					{ ...contract, effect_id: schema.entity_id },
					capabilities.operations.find((item) => item.capability === contract.capability) ?? null,
				).compatible,
		);
		const status = capabilities.application_data
			? bound
				? "bound"
				: box.document_version === schema.document_version
					? "publication_required"
					: "earlier_schema_required"
			: "unavailable";
		readiness.storage.push({ entity_id: schema.entity_id, document_version: schema.document_version, status });
		if (status === "earlier_schema_required") blockers.push("package_earlier_schema_required");
	}
	if (!capabilities.application_data && request.package.data_schemas.length > 0) blockers.push("package_data_unavailable");
	for (const realm of local.realms) {
		const next = source.realms.find((item) => item.id === realm.id);
		if (!next || !equal(realm, next)) blockers.push("package_realm_change_requires_source_repair");
	}
	for (const box of local.boxes) {
		const next = source.boxes.find((item) => item.id === box.id);
		if (next && next.realm_id !== box.realm_id) blockers.push("package_cross_realm_move_requires_source_repair");
	}
	const content = {
		request,
		local,
		previous,
		version_heads: input.version_heads,
		capabilities,
		readiness,
		witnesses,
		identities,
		incoming,
		source,
		documents,
		conflicts,
		changes: compare_project_source(local, source),
		blockers: [...new Set(blockers)],
	};
	return freeze_package_value({ ...content, digest: await package_operation_digest(content) });
};

export const parse_package_preview = async (input: unknown, request: PackageRequest): Promise<PackagePreview> => {
	package_json(input);
	if (typeof input !== "object" || input === null) throw new Error("package_preview_invalid");
	const value = input as PackagePreview;
	if (!equal(value.request, request)) throw new Error("package_preview_request_mismatch");
	const recomputed = await plan_application_package({
		request,
		local: value.local,
		previous: value.previous,
		version_heads: value.version_heads,
		capabilities: value.capabilities,
	});
	if (!equal(recomputed, input)) throw new Error("package_preview_integrity_mismatch");
	return recomputed;
};

export const parse_package_result = async (
	input: unknown,
	request: PackageRequest,
	preview_digest: string,
	actor_id: string,
): Promise<PackageResult> => {
	package_json(input);
	if (typeof input !== "object" || input === null) throw new Error("package_result_invalid");
	const result = input as PackageResult;
	const preview = await parse_package_preview(result.preview, request);
	if (preview.digest !== preview_digest) throw new Error("package_result_preview_mismatch");
	uuid.parse(actor_id);
	if (preview.blockers.length > 0 || preview.conflicts.some((conflict) => !Object.hasOwn(request.resolutions, conflict.path)))
		throw new Error("package_result_not_admissible");
	const child_operation_ids = await Promise.all(
		package_commands(preview).map((command) => package_identity(request.operation_id, "command", command.role)),
	);
	const revision = (BigInt(request.expected_revision) + BigInt(child_operation_ids.length)).toString();
	const expected: PackageResult = {
		schema: "application.package.result.v1",
		project_id: request.project_id,
		actor_id,
		operation_id: request.operation_id,
		preview_digest,
		request,
		revision,
		child_operation_ids,
		preview,
		installation: {
			installation_id: request.installation_id,
			operation_id: request.operation_id,
			name: request.name,
			package: request.package,
			identities: preview.identities,
			witnesses: preview.witnesses,
			base: { ...preview.incoming, revision },
			source_revision: revision,
		},
	};
	if (!equal(input, expected)) throw new Error("package_result_integrity_mismatch");
	return freeze_package_value(expected);
};
