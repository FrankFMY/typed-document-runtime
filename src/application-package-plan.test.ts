import { expect, test } from "bun:test";
import { application_data_operation_contracts, normalize_application_data_schema } from "./application-data-contract.js";
import { create_application_package, package_digest, package_json } from "./application-package.js";
import type { PackageInstallation, PackageRequest } from "./application-package-plan.js";
import {
	package_commands,
	package_identity,
	parse_package_preview,
	parse_package_result,
	plan_application_package,
} from "./application-package-plan.js";
import { normalize_project_source_snapshot } from "./project-source-snapshot.js";

const id = (n: number): string => `b0000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const fixture = async () => {
	const source = normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1",
		project_id: id(1),
		revision: "1",
		realms: [{ id: id(2), name: "Main", is_primary: true }],
		boxes: [
			{
				id: id(3),
				realm_id: id(2),
				parent_id: null,
				name: "Record",
				document_version: "1",
				document: { schema: "box.document.v1", root_id: id(4), nodes: [{ id: id(4), kind: "record", fields: [] }] },
			},
		],
	});
	const file = await create_application_package({
		name: "Records",
		publication: { id: id(5), content_digest: await package_digest(source) },
		source,
		data_schemas: [],
	});
	const request: PackageRequest = {
		project_id: id(6),
		installation_id: id(7),
		operation_id: id(8),
		expected_revision: "1",
		previous_operation_id: null,
		name: "Records",
		package: file,
		resolutions: {},
	};
	const first = await plan_application_package({
		request,
		local: { ...source, project_id: id(6), boxes: [], realms: [{ id: id(9), name: "Main", is_primary: true }] },
		previous: null,
		capabilities: { application_data: true, operations: [] },
		version_heads: {},
	});
	const previous: PackageInstallation = {
		installation_id: request.installation_id,
		operation_id: request.operation_id,
		name: request.name,
		package: file,
		identities: first.identities,
		witnesses: first.witnesses,
		base: first.incoming,
		source_revision: first.source.revision,
	};
	return { source, request, first, previous };
};

test("an installed origin document version cannot be redefined by a later valid package", async () => {
	const { source, request, first, previous } = await fixture();
	const changed = structuredClone(source);
	changed.boxes[0]!.document.nodes.push({ id: id(15), kind: "scalar", value_type: "string" });
	const root = changed.boxes[0]!.document.nodes[0]!;
	if (root.kind === "record") root.fields.push({ id: id(18), name: "Added", type_id: id(15), required: false });
	const file = await create_application_package({
		name: "Records",
		publication: { id: id(16), content_digest: await package_digest(changed) },
		source: changed,
		data_schemas: [],
	});
	await expect(
		plan_application_package({
			request: {
				...request,
				package: file,
				operation_id: id(17),
				previous_operation_id: request.operation_id,
				expected_revision: first.source.revision,
			},
			local: first.source,
			previous,
			capabilities: { application_data: true, operations: [] },
			version_heads: { [first.source.boxes[0]!.id]: "1" },
		}),
	).rejects.toThrow("package_version_redefined");
});

const reordered = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(reordered)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.toReversed()
						.map(([key, item]) => [key, reordered(item)]),
				)
			: value;
test("preview digest survives JSON object reordering in durable receipts", async () => {
	const { request, first, previous } = await fixture();
	const next_request = { ...request, operation_id: id(17), previous_operation_id: request.operation_id, expected_revision: first.source.revision };
	const next = await plan_application_package({
		request: next_request,
		local: first.source,
		previous,
		capabilities: { application_data: true, operations: [] },
		version_heads: { [first.source.boxes[0]!.id]: "1" },
	});
	await expect(parse_package_preview(reordered(next), next_request)).resolves.toEqual(next);
});

test("data-only boundary rejects array accessors without invoking them", () => {
	let invoked = false;
	const array = [1];
	Object.defineProperty(array, "0", {
		get: () => {
			invoked = true;
			return 1;
		},
		enumerable: true,
	});
	expect(() => package_json(array)).toThrow("package_data_only");
	expect(invoked).toBe(false);
});

test("source preview separates exact operation readiness from publication and physical storage", async () => {
	const { request, first } = await fixture();
	expect(first).toMatchObject({
		readiness: { external: [], storage: [{ entity_id: first.source.boxes[0]!.id, document_version: "1", status: "publication_required" }] },
	});
	const forged = structuredClone(first) as unknown as { readiness: { storage: { status: string }[] } };
	forged.readiness.storage[0]!.status = "bound";
	await expect(parse_package_preview(forged, request)).rejects.toThrow("package_preview_integrity_mismatch");
});

test("merged local Process data references require an actual exact schema witness", async () => {
	const { request, first, previous } = await fixture();
	const local = structuredClone(first.source);
	const entity = local.boxes[0]!;
	const contract = application_data_operation_contracts(entity.id, "99", normalize_application_data_schema(entity.document))[0]!;
	local.boxes.push({
		id: id(30),
		realm_id: entity.realm_id,
		parent_id: null,
		name: "Local action",
		document_version: "1",
		document: {
			schema: "process.document.v1",
			root_id: id(31),
			nodes: [
				...new Map([...contract.request.nodes, ...contract.result.nodes].map((node) => [node.id, node])).values(),
				{
					id: id(31),
					kind: "record",
					fields: [
						{ id: id(32), name: "request", type_id: contract.request.root_id!, required: true },
						{ id: id(33), name: "result", type_id: contract.result.root_id!, required: false },
					],
				},
			],
			input_cell_ids: [id(32)],
			output_cell_ids: [id(33)],
			effects: [
				{
					id: id(34),
					capability: contract.capability,
					request_cell_id: id(32),
					request_type_id: contract.request.root_id!,
					result_cell_id: id(33),
					result_type_id: contract.result.root_id!,
				},
			],
			program: { schema: "process.program.v1", body: [{ id: id(35), kind: "effect", effect_id: id(34) }] },
		},
	});
	const planned = await plan_application_package({
		request: { ...request, operation_id: id(17), previous_operation_id: request.operation_id, expected_revision: first.source.revision },
		local,
		previous,
		capabilities: { application_data: true, operations: [] },
		version_heads: { [entity.id]: "1", [id(30)]: "1" },
	});
	expect(planned.blockers).toContain("package_data_schema_missing");
});

test("a recomputable blocked plan cannot be presented as an accepted package receipt", async () => {
	const { request, first } = await fixture();
	const changed = { ...request, resolutions: { "/missing": "local" as const } };
	const preview = await plan_application_package({
		request: changed,
		local: first.local,
		previous: null,
		version_heads: {},
		capabilities: first.capabilities,
	});
	expect(preview.blockers).toContain("package_resolution_stale");
	const children = await Promise.all(package_commands(preview).map((command) => package_identity(changed.operation_id, "command", command.role)));
	const revision = (BigInt(changed.expected_revision) + BigInt(children.length)).toString();
	const result = {
		schema: "application.package.result.v1",
		project_id: changed.project_id,
		actor_id: id(20),
		operation_id: changed.operation_id,
		preview_digest: preview.digest,
		request: changed,
		revision,
		child_operation_ids: children,
		preview,
		installation: {
			installation_id: changed.installation_id,
			operation_id: changed.operation_id,
			name: changed.name,
			package: changed.package,
			identities: preview.identities,
			witnesses: preview.witnesses,
			base: { ...preview.incoming, revision },
			source_revision: revision,
		},
	};
	await expect(parse_package_result(result, changed, preview.digest, id(20))).rejects.toThrow("package_result_not_admissible");
});

test("keeping a local deletion still materializes incoming immutable version witnesses", async () => {
	const { source, request, first, previous } = await fixture();
	const changed = structuredClone(source);
	changed.revision = "2";
	changed.boxes[0]!.document_version = "2";
	const node = changed.boxes[0]!.document.nodes[0]!;
	if (node.kind === "record") {
		node.fields.push({ id: id(40), name: "note", type_id: id(41), required: false });
		changed.boxes[0]!.document.nodes.push({ id: id(41), kind: "scalar", value_type: "string" });
	}
	const file = await create_application_package({
		name: "Records",
		publication: { id: id(42), content_digest: await package_digest(normalize_project_source_snapshot(changed)) },
		source: changed,
		data_schemas: [],
	});
	const box_id = first.source.boxes[0]!.id;
	const planned = await plan_application_package({
		request: {
			...request,
			operation_id: id(43),
			expected_revision: first.source.revision,
			previous_operation_id: request.operation_id,
			package: file,
			resolutions: { [`/boxes/@${box_id}`]: "local" },
		},
		local: { ...first.source, boxes: [] },
		previous,
		version_heads: { [box_id]: "1" },
		capabilities: first.capabilities,
	});
	expect(planned.source.boxes).toEqual([]);
	expect(planned.documents).toMatchObject([{ box_id, version: "2" }]);
	expect(package_commands(planned).map((command) => command.kind)).toEqual(["create", "document", "delete"]);
});

test("a combined graph with dangling presentation references requires explicit source repair", async () => {
	const { request, first, previous } = await fixture();
	const local = structuredClone(first.source);
	local.boxes[0]!.presentation = { schema: "box.presentation.v1", fields: [], record_title_field_id: id(50) };
	const planned = await plan_application_package({
		request: { ...request, operation_id: id(51), previous_operation_id: request.operation_id, expected_revision: first.source.revision },
		local,
		previous,
		version_heads: { [local.boxes[0]!.id]: "1" },
		capabilities: first.capabilities,
	});
	expect(planned.blockers).toContain("package_presentation_requires_source_repair");
});
