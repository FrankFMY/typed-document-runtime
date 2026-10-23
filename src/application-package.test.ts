import { expect, test } from "bun:test";
import { application_data_operation_contracts, normalize_application_data_schema } from "./application-data-contract.js";
import { create_application_package, package_data_reference, package_digest, parse_application_package, remap_package_source } from "./application-package.js";
import { merge_package_source } from "./application-package-merge.js";
import { normalize_project_source_snapshot } from "./project-source-snapshot.js";
import { execute_project_runtime } from "./runtime.js";

const id = (value: number): string => `10000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const document = {
	schema: "box.document.v2",
	root_id: id(10),
	nodes: [
		{ id: id(11), kind: "scalar", value_type: "string" },
		{ id: id(10), kind: "record", fields: [{ id: id(12), name: "answer", type_id: id(11), required: false }] },
	],
	program: {
		schema: "box.program.v1",
		body: [{ id: id(13), kind: "write", cell_id: id(12), value: { id: id(14), kind: "literal", type_id: id(11), value: id(4) } }],
	},
};
const source = () =>
	normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1",
		project_id: id(1),
		revision: "3",
		realms: [{ id: id(2), name: "Main", is_primary: true }],
		boxes: [
			{
				id: id(3),
				realm_id: id(2),
				parent_id: null,
				name: "Caller",
				document_version: "1",
				document: {
					...document,
					program: {
						schema: "box.program.v1",
						body: [
							{ id: id(15), kind: "call", box_id: id(4), init: [{ id: id(16), kind: "share", caller_cell_id: id(12), callee_cell_id: id(12) }] },
						],
					},
				},
			},
			{ id: id(4), realm_id: id(2), parent_id: id(3), name: "Answer", document_version: "1", document },
		],
	});

test("remaps global source identities and actual calls while preserving local identities and UUID literals", () => {
	const original = source();
	const imported = remap_package_source(original, {
		project_id: id(21),
		realms: { [id(2)]: id(22) },
		boxes: { [id(3)]: id(23), [id(4)]: id(24) },
		versions: {},
	});
	expect(imported.project_id).toBe(id(21));
	expect(imported.realms[0]?.id).toBe(id(22));
	expect(imported.boxes.find((box) => box.id === id(24))?.parent_id).toBe(id(23));
	const outcome = execute_project_runtime({
		publication: { id: id(30), snapshot: imported },
		entry_box_id: id(23),
		input: [],
		output_cell_ids: [id(12)],
		budget: { max_steps: 100, max_call_depth: 8, max_value_nodes: 100, max_string_units: 1000 },
	});
	expect(outcome.status).toBe("success");
	if (outcome.status === "success") expect(outcome.outputs).toEqual([{ cell_id: id(12), value: id(4) }]);
	expect(original).toEqual(source());
});

test("remaps record target identities without rewriting document-local field identities", () => {
	const relation = normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1",
		project_id: id(1),
		revision: "1",
		realms: [{ id: id(2), name: "Main", is_primary: true }],
		boxes: [
			{
				id: id(3),
				realm_id: id(2),
				parent_id: null,
				name: "Customers",
				document_version: "1",
				document: {
					schema: "box.document.v1",
					root_id: id(30),
					nodes: [
						{ id: id(30), kind: "record", fields: [{ id: id(31), name: "name", type_id: id(32), required: true }] },
						{ id: id(32), kind: "scalar", value_type: "string" },
					],
				},
			},
			{
				id: id(4),
				realm_id: id(2),
				parent_id: null,
				name: "Orders",
				document_version: "1",
				document: {
					schema: "box.document.v1",
					root_id: id(40),
					nodes: [
						{
							id: id(40),
							kind: "record",
							fields: [
								{
									id: id(41),
									name: "customer_id",
									type_id: id(42),
									required: true,
									record_target: { entity_id: id(3) },
								},
							],
						},
						{ id: id(42), kind: "scalar", value_type: "string" },
					],
				},
			},
		],
	});

	const imported = remap_package_source(relation, {
		project_id: id(21),
		realms: { [id(2)]: id(22) },
		boxes: { [id(3)]: id(23), [id(4)]: id(24) },
		versions: {},
	});
	const orders = imported.boxes.find((box) => box.id === id(24))!;
	const root = orders.document.nodes.find((node) => node.id === orders.document.root_id);
	expect(root?.kind === "record" ? root.fields[0]?.record_target?.entity_id : undefined).toBe(id(23));
	expect(root?.kind === "record" ? root.fields[0]?.id : undefined).toBe(id(41));
});

test("immutable data-only export binds its publication and rejects changed content, unknown payloads and open calls", async () => {
	const snapshot = source();
	const content_digest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)))).toString("hex")}`;
	const packaged = await create_application_package({
		name: "Answer",
		publication: { id: id(40), content_digest },
		source: snapshot,
		data_schemas: [],
	});
	expect(packaged.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
	expect(Object.isFrozen(packaged.source.boxes)).toBe(true);
	expect(await parse_application_package(JSON.parse(JSON.stringify(packaged)))).toEqual(packaged);
	await expect(parse_application_package({ ...packaged, name: "Changed" })).rejects.toThrow();
	await expect(parse_application_package({ ...packaged, records: [] })).rejects.toThrow();
	await expect(
		create_application_package({
			name: "Open",
			publication: { id: id(40), content_digest },
			source: { ...snapshot, boxes: snapshot.boxes.slice(0, 1) },
			data_schemas: [],
		}),
	).rejects.toThrow();
});

test("owned data effects rebind entity and exact historical schema versions without rewriting document-local types", async () => {
	const entity = normalize_application_data_schema({
		schema: "box.document.v1",
		root_id: id(50),
		nodes: [
			{
				id: id(50),
				kind: "record",
				fields: [
					{ id: id(51), name: "name", type_id: id(52), required: true },
					{ id: id(53), name: "expected_revision", type_id: id(52), required: true },
				],
			},
			{ id: id(52), kind: "scalar", value_type: "string" },
		],
	});
	const contract = application_data_operation_contracts(id(4), "2", entity)[0]!;
	const request_root = contract.request.nodes.find((node) => node.id === contract.request.root_id);
	const request_data = request_root?.kind === "record" ? request_root.fields.find((field) => field.name === "data") : undefined;
	const entity_root = entity.nodes.find((node) => node.id === entity.root_id);
	const entity_name = entity_root?.kind === "record" ? entity_root.fields.find((field) => field.name === "name") : undefined;
	const entity_revision = entity_root?.kind === "record" ? entity_root.fields.find((field) => field.name === "expected_revision") : undefined;
	if (!request_data || !entity_name || !entity_revision) throw new Error("Package contextual action fixture is incomplete");
	const snapshot = normalize_project_source_snapshot({
		...source(),
		boxes: [
			{ id: id(4), realm_id: id(2), parent_id: null, name: "Entity", document_version: "2", document: entity },
			{
				id: id(3),
				realm_id: id(2),
				parent_id: null,
				name: "Create",
				document_version: "1",
				document: {
					schema: "process.document.v1",
					root_id: id(60),
					nodes: [
						...new Map([...contract.request.nodes, ...contract.result.nodes].map((node) => [node.id, node])).values(),
						{
							id: id(60),
							kind: "record",
							fields: [
								{ id: id(61), name: "request", type_id: contract.request.root_id, required: true },
								{ id: id(62), name: "result", type_id: contract.result.root_id, required: false },
							],
						},
					],
					input_cell_ids: [id(61)],
					output_cell_ids: [id(62)],
					effects: [
						{
							id: id(63),
							capability: contract.capability,
							request_cell_id: id(61),
							request_type_id: contract.request.root_id,
							result_cell_id: id(62),
							result_type_id: contract.result.root_id,
						},
					],
					program: { schema: "process.program.v1", body: [{ id: id(64), kind: "effect", effect_id: id(63) }] },
				},
				presentation: {
					schema: "box.presentation.v1",
					fields: [],
					record_action: {
						entity_id: id(4),
						input_field_path: [id(61), request_data.id, entity_name.id],
						revision_input_field_path: [id(61), request_data.id, entity_revision.id],
					},
				},
			},
		],
	});
	const packaged = await create_application_package({
		name: "Records",
		publication: { id: id(40), content_digest: await package_digest(snapshot) },
		source: snapshot,
		data_schemas: [{ entity_id: id(4), document_version: "2", document: entity }],
	});
	const map = { project_id: id(21), realms: { [id(2)]: id(22) }, boxes: { [id(3)]: id(23), [id(4)]: id(24) }, versions: { [`${id(4)}:2`]: "1" } };
	const imported = remap_package_source(packaged.source, map);
	const process = imported.boxes.find((box) => box.id === id(23))!.document;
	expect(process.schema === "process.document.v1" && process.effects[0]?.capability).toBe(
		application_data_operation_contracts(id(24), "1", entity)[0]!.capability,
	);
	expect(process.nodes).toEqual(snapshot.boxes.find((box) => box.id === id(3))!.document.nodes);
	expect(imported.boxes.find((box) => box.id === id(23))!.presentation?.record_action?.entity_id).toBe(id(24));
	expect(imported.boxes.find((box) => box.id === id(23))!.presentation?.record_action?.revision_input_field_path).toEqual([
		id(61),
		request_data.id,
		entity_revision.id,
	]);
	expect(() => remap_package_source(packaged.source, { ...map, versions: {} })).toThrow("package_data_version_missing");
});

test("aggregate data effects export, parse and rebind their exact owned entity and schema version", async () => {
	const entity = normalize_application_data_schema({
		schema: "box.document.v1", root_id: id(50),
		nodes: [
			{ id: id(50), kind: "record", fields: [{ id: id(51), name: "amount", type_id: id(52), required: true }] },
			{ id: id(52), kind: "scalar", value_type: "number" },
		],
	});
	const contracts = application_data_operation_contracts(id(4), "2", entity);
	for (const operation of contracts)
		expect(package_data_reference(operation.capability)).toEqual({ entity_id: id(4), document_version: "2", operation: operation.operation });
	const contract = contracts.find((item) => item.operation === "aggregate")!;
	for (const invalid of [contract.capability.replace(".aggregate.", ".unknown."), `${contract.capability}.suffix`])
		expect(() => package_data_reference(invalid)).toThrow("package_data_capability_invalid");
	const snapshot = normalize_project_source_snapshot({
		...source(),
		boxes: [
			{ id: id(4), realm_id: id(2), parent_id: null, name: "Entity", document_version: "2", document: entity },
			{
				id: id(3), realm_id: id(2), parent_id: null, name: "Aggregate", document_version: "1",
				document: {
					schema: "process.document.v1", root_id: id(60),
					nodes: [
						...new Map([...contract.request.nodes, ...contract.result.nodes].map((node) => [node.id, node])).values(),
						{ id: id(60), kind: "record", fields: [
							{ id: id(61), name: "request", type_id: contract.request.root_id, required: true },
							{ id: id(62), name: "result", type_id: contract.result.root_id, required: false },
						] },
					],
					input_cell_ids: [id(61)], output_cell_ids: [id(62)],
					effects: [{ id: id(63), capability: contract.capability, request_cell_id: id(61), request_type_id: contract.request.root_id, result_cell_id: id(62), result_type_id: contract.result.root_id }],
					program: { schema: "process.program.v1", body: [{ id: id(64), kind: "effect", effect_id: id(63) }] },
				},
			},
		],
	});
	const packaged = await create_application_package({
		name: "Exact totals", publication: { id: id(40), content_digest: await package_digest(snapshot) },
		source: snapshot, data_schemas: [{ entity_id: id(4), document_version: "2", document: entity }],
	});
	expect(await parse_application_package(JSON.parse(JSON.stringify(packaged)))).toEqual(packaged);
	const map = { project_id: id(21), realms: { [id(2)]: id(22) }, boxes: { [id(3)]: id(23), [id(4)]: id(24) }, versions: { [`${id(4)}:2`]: "1" } };
	const imported = remap_package_source(packaged.source, map);
	const process = imported.boxes.find((box) => box.id === id(23))!.document;
	expect(process.schema === "process.document.v1" && process.effects[0]?.capability).toBe(
		application_data_operation_contracts(id(24), "1", entity).find((item) => item.operation === "aggregate")!.capability,
	);
	expect(process.nodes).toEqual(snapshot.boxes.find((box) => box.id === id(3))!.document.nodes);
	expect(() => remap_package_source(packaged.source, { ...map, versions: {} })).toThrow("package_data_version_missing");
});

test("three-way source changes preserve independent local work and require witnessed choices for competing edits", () => {
	const base = source();
	const local = structuredClone(base);
	local.boxes[0]!.name = "Local caller";
	const incoming = structuredClone(base);
	const answer = incoming.boxes[1]!.document;
	if (answer.schema !== "box.document.v2" || answer.program.body[0]?.kind !== "write" || answer.program.body[0].value.kind !== "literal")
		throw new Error("Fixture shape");
	answer.program.body[0].value.value = "Upstream answer";
	const merged = merge_package_source(base, local, incoming);
	expect(merged.source.boxes[1]!.document).toEqual(answer);
	expect(merged.source.boxes[0]!.name).toBe("Local caller");
	expect(merged.conflicts).toEqual([]);
	incoming.boxes[0]!.name = "Upstream caller";
	const conflict = merge_package_source(base, local, incoming);
	expect(conflict.conflicts).toHaveLength(1);
	const path = conflict.conflicts[0]!.path;
	expect(merge_package_source(base, local, incoming, { [path]: "incoming" }).source.boxes[0]!.name).toBe("Upstream caller");
	expect(merge_package_source(base, local, incoming, { [path]: "local" }).source.boxes[0]!.name).toBe("Local caller");
	expect(() => merge_package_source(base, local, incoming, { stale: "incoming" })).toThrow();
});
