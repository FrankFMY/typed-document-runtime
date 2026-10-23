import { expect, test } from "bun:test";
import {
	application_data_capability,
	application_data_operation_contracts,
	compare_application_data_schema,
	fill_application_data_record,
	normalize_application_data_fill_plan,
	normalize_application_data_schema,
	project_application_data_value,
} from "./application-data-contract.js";
import type { BoxDocument } from "./box-document.js";
import { normalize_box_document, normalize_box_value } from "./box-document.js";
import type { OperationSchema } from "./process-contract.js";

const document_identities = (document: BoxDocument): string[] => {
	const identities: string[] = [];
	for (const node of document.nodes) {
		identities.push(node.id);
		if (node.kind === "record") identities.push(...node.fields.map((field) => field.id));
	}
	return identities;
};

const bounded_schema_id = (index: number): string => `57000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

export const data_schema = (): OperationSchema =>
	normalize_box_document({
		schema: "box.document.v1",
		root_id: "51000000-0000-4000-8000-000000000001",
		nodes: [
			{
				id: "51000000-0000-4000-8000-000000000001",
				kind: "record",
				fields: [{ id: "51000000-0000-4000-8000-000000000003", name: "Название", type_id: "51000000-0000-4000-8000-000000000002", required: true }],
			},
			{ id: "51000000-0000-4000-8000-000000000002", kind: "scalar", value_type: "string" },
		],
	}) as OperationSchema;

test("persistent schema uses an ordinary canonical record Box without a second document model", () => {
	const source = data_schema();
	expect(normalize_application_data_schema(source)).toEqual(source);
	expect(() => normalize_application_data_schema({ schema: "box.document.v1", root_id: null, nodes: [] })).toThrow();
});

test("an optional root field is a compatible additive data-schema change", () => {
	const before = data_schema();
	const after = normalize_box_document({
		...before,
		nodes: before.nodes.map((node) =>
			node.id === before.root_id && node.kind === "record"
				? {
						...node,
						fields: [
							...node.fields,
							{
								id: "51000000-0000-4000-8000-000000000004",
								name: "Описание",
								type_id: "51000000-0000-4000-8000-000000000002",
								required: false,
							},
						],
					}
				: node,
		),
	});

	expect(compare_application_data_schema(before, after)).toEqual({
		compatible: true,
		changes: [{ kind: "added", field_id: "51000000-0000-4000-8000-000000000004", name: "Описание" }],
	});
});

test("an explicit typed fill admits a new required root field", () => {
	const before = data_schema();
	const field_id = "51000000-0000-4000-8000-000000000004";
	const after = normalize_box_document({
		...before,
		nodes: [
			...before.nodes.map((node) =>
				node.id === before.root_id && node.kind === "record"
					? { ...node, fields: [...node.fields, { id: field_id, name: "Активно", type_id: "51000000-0000-4000-8000-000000000005", required: true }] }
					: node,
			),
			{ id: "51000000-0000-4000-8000-000000000005", kind: "scalar", value_type: "boolean" },
		],
	});
	expect(compare_application_data_schema(before, after, [{ field_id, value: false }])).toEqual({
		compatible: true,
		changes: [{ kind: "added", field_id, name: "Активно" }],
	});
	expect(compare_application_data_schema(before, after).compatible).toBe(false);
});

test("a structured and scalar multi-field fill is canonical, non-overwriting, and covers archived data equally", () => {
	const before = data_schema();
	const field_record = "51000000-0000-4000-8000-000000000020";
	const field_boolean = "51000000-0000-4000-8000-000000000021";
	const record_type = "51000000-0000-4000-8000-000000000022";
	const list_type = "51000000-0000-4000-8000-000000000023";
	const bool_type = "51000000-0000-4000-8000-000000000024";
	const after = normalize_box_document({
		...before,
		nodes: [
			...before.nodes.map((node) =>
				node.kind === "record" && node.id === before.root_id
					? {
							...node,
							fields: [
								...node.fields,
								{ id: field_record, name: "contacts", type_id: list_type, required: true },
								{ id: field_boolean, name: "active", type_id: bool_type, required: true },
							],
						}
					: node,
			),
			{
				id: record_type,
				kind: "record",
				fields: [{ id: "51000000-0000-4000-8000-000000000025", name: "code", type_id: "51000000-0000-4000-8000-000000000002", required: true }],
			},
			{ id: list_type, kind: "list", item_type_id: record_type },
			{ id: bool_type, kind: "scalar", value_type: "boolean" },
		],
	});
	const fills = normalize_application_data_fill_plan(before, after, [
		{ field_id: field_record, value: [{ code: "" }, { code: "X" }] },
		{ field_id: field_boolean, value: false },
	]);
	expect(compare_application_data_schema(before, after, fills).compatible).toBe(true);
	expect(fill_application_data_record(after, { Название: "old" }, fills)).toEqual({
		Название: "old",
		contacts: [{ code: "" }, { code: "X" }],
		active: false,
	});
	expect(() => fill_application_data_record(after, { Название: "old", active: true }, fills)).toThrow("replace existing");
	expect(() => normalize_application_data_fill_plan(before, after, [{ field_id: field_record, value: [] }])).toThrow("exactly");
	expect(() => normalize_application_data_fill_plan(before, after, [fills[0]!, fills[0]!])).toThrow("not a new required");
	expect(() => normalize_application_data_fill_plan(before, after, [{ field_id: field_record, value: [{ wrong: "X" }] }, fills[1]!])).toThrow();
});

const fill_test_id = (suffix: number): string => `51000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;

test("fill plans preserve zero, absence, empty text and reference-backed structured values without coercion", () => {
	const before = data_schema();
	const id = fill_test_id;
	const after = normalize_box_document({
		...before,
		nodes: [
			...before.nodes.map((node) =>
				node.kind === "record" && node.id === before.root_id
					? {
							...node,
							fields: [
								...node.fields,
								{ id: id(50), name: "zero", type_id: id(60), required: true },
								{ id: id(51), name: "absent", type_id: id(61), required: true },
								{ id: id(52), name: "empty", type_id: id(62), required: true },
								{ id: id(53), name: "structured", type_id: id(65), required: true },
								{ id: id(54), name: "optional", type_id: id(62), required: false },
							],
						}
					: node,
			),
			{ id: id(60), kind: "scalar", value_type: "number" },
			{ id: id(61), kind: "scalar", value_type: "absence" },
			{ id: id(62), kind: "scalar", value_type: "string" },
			{ id: id(63), kind: "record", fields: [{ id: id(64), name: "value", type_id: id(60), required: true }] },
			{ id: id(65), kind: "reference", target_id: id(63) },
		],
	});
	const choices = [
		{ field_id: id(50), value: 0 },
		{ field_id: id(51), value: null },
		{ field_id: id(52), value: "" },
		{ field_id: id(53), value: { value: 0 } },
	];
	const normalized = normalize_application_data_fill_plan(before, after, choices);
	expect(fill_application_data_record(after, { Название: "old" }, normalized)).toEqual({
		Название: "old",
		zero: 0,
		absent: null,
		empty: "",
		structured: { value: 0 },
	});
	choices[3]!.value = { value: 42 };
	expect(normalized.find((fill) => fill.field_id === id(53))?.value).toEqual({ value: 0 });
	for (const wrong of ["0", false, null, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() =>
			normalize_application_data_fill_plan(
				before,
				after,
				normalized.map((fill) => (fill.field_id === id(50) ? { ...fill, value: wrong } : fill)),
			),
		).toThrow();
	}
	for (const wrong_id of [id(54), id(99), "51000000-0000-4000-8000-000000000003"]) {
		expect(() =>
			normalize_application_data_fill_plan(
				before,
				after,
				normalized.map((fill) => (fill.field_id === id(52) ? { field_id: wrong_id, value: fill.value } : fill)),
			),
		).toThrow();
	}
});

test("a removed root field is incompatible and remains visible in the complete change list", () => {
	const before = data_schema();
	const after = normalize_box_document({
		schema: "box.document.v1",
		root_id: before.root_id,
		nodes: [{ id: before.root_id!, kind: "record", fields: [] }],
	});

	expect(compare_application_data_schema(before, after)).toEqual({
		compatible: false,
		changes: [{ kind: "removed", field_id: "51000000-0000-4000-8000-000000000003", name: "Название" }],
	});
});

test("retained root field metadata changes are reported as incompatible", () => {
	const before = data_schema();
	const changed_field = (change: { name?: string; required?: boolean }) =>
		normalize_box_document({
			...before,
			nodes: before.nodes.map((node) =>
				node.id === before.root_id && node.kind === "record" ? { ...node, fields: node.fields.map((field) => ({ ...field, ...change })) } : node,
			),
		});

	expect(compare_application_data_schema(before, changed_field({ name: "Наименование" }))).toEqual({
		compatible: false,
		changes: [{ kind: "changed", field_id: "51000000-0000-4000-8000-000000000003", name: "Наименование" }],
	});
	expect(compare_application_data_schema(before, changed_field({ required: false }))).toEqual({
		compatible: false,
		changes: [{ kind: "changed", field_id: "51000000-0000-4000-8000-000000000003", name: "Название" }],
	});
});

test("retargeting or removing an installed record relation is incompatible", () => {
	const before = data_schema();
	const with_target = (entity_id?: string) =>
		normalize_box_document({
			...before,
			nodes: before.nodes.map((node) =>
				node.id === before.root_id && node.kind === "record"
					? {
							...node,
							fields: node.fields.map((field) => ({
								...field,
								...(entity_id ? { record_target: { entity_id } } : {}),
							})),
						}
					: node,
			),
		});
	const installed = with_target("51000000-0000-4000-8000-000000000010");

	expect(compare_application_data_schema(installed, with_target("51000000-0000-4000-8000-000000000011"))).toEqual({
		compatible: false,
		changes: [{ kind: "changed", field_id: "51000000-0000-4000-8000-000000000003", name: "Название" }],
	});
	expect(compare_application_data_schema(installed, before).compatible).toBe(false);
});

test("a retained root field requires its complete nested type closure to stay exact", () => {
	const before = normalize_box_document({
		schema: "box.document.v1",
		root_id: "52000000-0000-4000-8000-000000000001",
		nodes: [
			{
				id: "52000000-0000-4000-8000-000000000001",
				kind: "record",
				fields: [
					{
						id: "52000000-0000-4000-8000-000000000002",
						name: "Детали",
						type_id: "52000000-0000-4000-8000-000000000003",
						required: true,
					},
				],
			},
			{
				id: "52000000-0000-4000-8000-000000000003",
				kind: "record",
				fields: [
					{
						id: "52000000-0000-4000-8000-000000000004",
						name: "Значение",
						type_id: "52000000-0000-4000-8000-000000000005",
						required: true,
					},
				],
			},
			{ id: "52000000-0000-4000-8000-000000000005", kind: "scalar", value_type: "string" },
		],
	});
	const after = normalize_box_document({
		...before,
		nodes: before.nodes.map((node) =>
			node.id === "52000000-0000-4000-8000-000000000005" && node.kind === "scalar" ? { ...node, value_type: "number" as const } : node,
		),
	});

	expect(compare_application_data_schema(before, after)).toEqual({
		compatible: false,
		changes: [{ kind: "changed", field_id: "52000000-0000-4000-8000-000000000002", name: "Детали" }],
	});
});

test("changing the record-root identity marks every otherwise retained root field as changed", () => {
	const before = data_schema();
	const after = normalize_box_document({
		...before,
		root_id: "51000000-0000-4000-8000-000000000006",
		nodes: before.nodes.map((node) =>
			node.id === before.root_id && node.kind === "record" ? { ...node, id: "51000000-0000-4000-8000-000000000006" } : node,
		),
	});

	expect(compare_application_data_schema(before, after)).toEqual({
		compatible: false,
		changes: [{ kind: "changed", field_id: "51000000-0000-4000-8000-000000000003", name: "Название" }],
	});
});

test("application-data capabilities encode exact entity, revision and operation witnesses", () => {
	expect(application_data_capability("550e8400-e29b-41d4-a716-446655440000", "42", "update")).toBe(
		"data.e550e8400e29b41d4a716446655440000.r42.update.v1",
	);
});

test("application-data capability tokens reject noncanonical or out-of-range input without repair", () => {
	const entity_id = "550e8400-e29b-41d4-a716-446655440000";
	for (const invalid_entity of [entity_id.toUpperCase(), entity_id.replaceAll("-", ""), "550e8400-e29b-01d4-a716-446655440000"]) {
		expect(() => application_data_capability(invalid_entity, "1", "read")).toThrow();
	}
	for (const invalid_revision of ["0", "01", "+1", "9223372036854775808"]) {
		expect(() => application_data_capability(entity_id, invalid_revision, "read")).toThrow();
	}
	expect(() => application_data_capability(entity_id, "1", "drop" as "read")).toThrow();
});

test("create operation contract embeds the exact authored data schema in its request and record result", () => {
	const [contract] = application_data_operation_contracts("550e8400-e29b-41d4-a716-446655440000", "42", data_schema());
	expect(contract?.operation).toBe("create");
	expect(contract?.capability).toBe("data.e550e8400e29b41d4a716446655440000.r42.create.v1");
	expect(normalize_box_value(contract!.request, { data: { Название: "Запись" } })).toEqual({ data: { Название: "Запись" } });
	expect(
		normalize_box_value(contract!.result, {
			status: "ok",
			record: { id: "record-id", revision: "1", archived: false, data: { Название: "Запись" } },
		}),
	).toEqual({
		record: { archived: false, data: { Название: "Запись" }, id: "record-id", revision: "1" },
		status: "ok",
	});
	expect(() => normalize_box_value(contract!.request, {})).toThrow();
	expect(() => normalize_box_value(contract!.result, { status: "ok", record: { id: "record-id" } })).toThrow();
});

test("operation catalogue exposes the exact read, update, lifecycle, list and aggregate wire records", () => {
	const contracts = application_data_operation_contracts("550e8400-e29b-41d4-a716-446655440000", "42", data_schema());
	expect(contracts.map(({ operation }) => operation)).toEqual(["create", "read", "update", "archive", "restore", "list", "query", "aggregate"]);
	const by_operation = new Map(contracts.map((contract) => [contract.operation, contract]));

	expect(normalize_box_value(by_operation.get("read")!.request, { id: "record-id" })).toEqual({ id: "record-id" });
	expect(normalize_box_value(by_operation.get("update")!.request, { id: "record-id", revision: "2", data: { Название: "Новое" } })).toEqual({
		data: { Название: "Новое" },
		id: "record-id",
		revision: "2",
	});
	for (const operation of ["archive", "restore"] as const) {
		expect(normalize_box_value(by_operation.get(operation)!.request, { id: "record-id", revision: "2" })).toEqual({
			id: "record-id",
			revision: "2",
		});
	}
	expect(
		normalize_box_value(by_operation.get("list")!.request, {
			after_id: "record-id",
			limit: 25,
			include_archived: true,
			search_field: "Название",
			search: "Зап",
		}),
	).toEqual({ after_id: "record-id", include_archived: true, limit: 25, search: "Зап", search_field: "Название" });
	expect(
		normalize_box_value(by_operation.get("list")!.result, {
			items: [{ id: "record-id", revision: "2", archived: false, data: { Название: "Запись" } }],
			next_after_id: "record-id",
		}),
	).toEqual({
		items: [{ archived: false, data: { Название: "Запись" }, id: "record-id", revision: "2" }],
		next_after_id: "record-id",
	});
	for (const operation of ["read", "update", "archive", "restore"] as const) {
		expect(normalize_box_value(by_operation.get(operation)!.result, { status: "not_found" })).toEqual({ status: "not_found" });
	}
});

test("query and aggregate are separately versioned typed operations while the historical list contract stays unchanged", () => {
	const contracts = application_data_operation_contracts("550e8400-e29b-41d4-a716-446655440000", "42", data_schema());
	expect(contracts.map(({ operation }) => operation)).toEqual(["create", "read", "update", "archive", "restore", "list", "query", "aggregate"]);
	const by_operation = new Map(contracts.map((contract) => [contract.operation, contract]));
	expect(
		normalize_box_value(by_operation.get("list")!.request, {
			after_id: "record-id",
			limit: 25,
			include_archived: true,
			search_field: "Название",
			search: "Зап",
		}),
	).toEqual({ after_id: "record-id", include_archived: true, limit: 25, search: "Зап", search_field: "Название" });
	expect(
		normalize_box_value(by_operation.get("query")!.request, {
			limit: 25,
			include_archived: false,
			filters: [
				{
					field_id: "51000000-0000-4000-8000-000000000003",
					operator: "equal",
					string_value: "Запись",
				},
			],
			sort: {
				field_id: "51000000-0000-4000-8000-000000000003",
				direction: "asc",
				missing_position: "last",
			},
		}),
	).toEqual({
		filters: [{ field_id: "51000000-0000-4000-8000-000000000003", operator: "equal", string_value: "Запись" }],
		include_archived: false,
		limit: 25,
		sort: { direction: "asc", field_id: "51000000-0000-4000-8000-000000000003", missing_position: "last" },
	});
	expect(
		normalize_box_value(by_operation.get("query")!.result, {
			items: [{ id: "record-id", revision: "2", archived: false, data: { Название: "Запись" } }],
			next_cursor: "opaque",
		}),
	).toEqual({
		items: [{ archived: false, data: { Название: "Запись" }, id: "record-id", revision: "2" }],
		next_cursor: "opaque",
	});
	expect(
		normalize_box_value(by_operation.get("aggregate")!.request, {
			filters: [{ field_id: "51000000-0000-4000-8000-000000000003", operator: "is_present" }],
			include_archived: true,
			value_field_id: "51000000-0000-4000-8000-000000000003",
			multiplier_field_id: "51000000-0000-4000-8000-000000000003",
			scale: 6,
		}),
	).toEqual({
		filters: [{ field_id: "51000000-0000-4000-8000-000000000003", operator: "is_present" }],
		include_archived: true,
		multiplier_field_id: "51000000-0000-4000-8000-000000000003",
		scale: 6,
		value_field_id: "51000000-0000-4000-8000-000000000003",
	});
	expect(normalize_box_value(by_operation.get("aggregate")!.result, { count: 12, total: "3.140000" })).toEqual({ count: 12, total: "3.140000" });
});

test("historical value projection removes current-only root fields", () => {
	expect(project_application_data_value(data_schema(), { Название: "Запись", Описание: "Только новая схема" })).toEqual({ Название: "Запись" });
});

test("historical projection rejects malformed current records without invoking accessors", () => {
	let getter_calls = 0;
	const accessor: Record<string, unknown> = {};
	Object.defineProperty(accessor, "Название", {
		enumerable: true,
		get: () => {
			getter_calls += 1;
			return "Запись";
		},
	});
	expect(() => project_application_data_value(data_schema(), accessor)).toThrow();
	expect(getter_calls).toBe(0);

	const cyclic: Record<string, unknown> = { Название: "Запись" };
	cyclic.current_only = cyclic;
	expect(() => project_application_data_value(data_schema(), cyclic)).toThrow();
});

test("exact schemas are unchanged while required root additions are reported and blocked", () => {
	const before = data_schema();
	expect(compare_application_data_schema(before, before)).toEqual({ compatible: true, changes: [] });
	const root = before.nodes.find((node) => node.id === before.root_id);
	if (root?.kind !== "record") throw new Error("Test data root missing");
	const after = normalize_box_document({
		...before,
		nodes: before.nodes.map((node) =>
			node.id === root.id
				? {
						...root,
						fields: [
							...root.fields,
							{
								id: "51000000-0000-4000-8000-000000000007",
								name: "Обязательное",
								type_id: "51000000-0000-4000-8000-000000000002",
								required: true,
							},
						],
					}
				: node,
		),
	});
	expect(compare_application_data_schema(before, after)).toEqual({
		compatible: false,
		changes: [{ kind: "added", field_id: "51000000-0000-4000-8000-000000000007", name: "Обязательное" }],
	});
});

test("historical projection preserves retained nested records and lists while rejecting malformed retained values", () => {
	const historical = normalize_box_document({
		schema: "box.document.v1",
		root_id: "56000000-0000-4000-8000-000000000001",
		nodes: [
			{
				id: "56000000-0000-4000-8000-000000000001",
				kind: "record",
				fields: [
					{
						id: "56000000-0000-4000-8000-000000000002",
						name: "Строки",
						type_id: "56000000-0000-4000-8000-000000000003",
						required: true,
					},
				],
			},
			{ id: "56000000-0000-4000-8000-000000000003", kind: "list", item_type_id: "56000000-0000-4000-8000-000000000004" },
			{
				id: "56000000-0000-4000-8000-000000000004",
				kind: "record",
				fields: [
					{
						id: "56000000-0000-4000-8000-000000000005",
						name: "Значение",
						type_id: "56000000-0000-4000-8000-000000000006",
						required: true,
					},
				],
			},
			{ id: "56000000-0000-4000-8000-000000000006", kind: "scalar", value_type: "string" },
		],
	});
	expect(project_application_data_value(historical, { Строки: [{ Значение: "А", Новое: 1 }], Новое: true })).toEqual({
		Строки: [{ Значение: "А" }],
	});
	expect(() => project_application_data_value(historical, { Строки: [{ Значение: 1 }] })).toThrow();
});

test("operation projection is deterministic and wrapper identities never collide with source identities", () => {
	const entity_id = "550e8400-e29b-41d4-a716-446655440000";
	const baseline = application_data_operation_contracts(entity_id, "42", data_schema());
	expect(application_data_operation_contracts(entity_id, "42", data_schema())).toEqual(baseline);
	const source_identities = new Set(document_identities(data_schema()));
	const wrappers = baseline
		.flatMap(({ request, result }) => [request, result].flatMap(document_identities))
		.filter((identity) => !source_identities.has(identity));
	expect(new Set(wrappers).size).toBe(wrappers.length);
	expect(wrappers.every((identity) => !source_identities.has(identity))).toBe(true);

	const source = data_schema();
	const root = source.nodes.find((node) => node.id === source.root_id);
	if (root?.kind !== "record" || !wrappers[0] || !wrappers[1]) throw new Error("Generated identity fixture missing");
	const colliding_source = normalize_box_document({
		...source,
		nodes: [
			...source.nodes.map((node) =>
				node.id === root.id
					? {
							id: root.id,
							kind: "record" as const,
							fields: [...root.fields, { id: wrappers[1]!, name: "Коллизия", type_id: wrappers[0]!, required: false }],
						}
					: node,
			),
			{ id: wrappers[0], kind: "scalar", value_type: "string" },
		],
	});
	const colliding_source_identities = new Set(document_identities(colliding_source));
	const retried_wrappers = application_data_operation_contracts(entity_id, "42", colliding_source)
		.flatMap(({ request, result }) => [request, result].flatMap(document_identities))
		.filter((identity) => !colliding_source_identities.has(identity));
	expect(new Set(retried_wrappers).size).toBe(retried_wrappers.length);
	expect(retried_wrappers.every((identity) => !colliding_source_identities.has(identity))).toBe(true);
});

test("operation metadata fails explicitly instead of truncating an admitted 256-node data schema", () => {
	const nodes: Parameters<typeof normalize_box_document>[0] = {
		schema: "box.document.v1",
		root_id: bounded_schema_id(0),
		nodes: [
			{
				id: bounded_schema_id(0),
				kind: "record",
				fields: [{ id: "57000000-0000-4000-8000-ffffffffffff", name: "Значение", type_id: bounded_schema_id(1), required: true }],
			},
			...Array.from({ length: 254 }, (_, offset) => ({
				id: bounded_schema_id(offset + 1),
				kind: "reference" as const,
				target_id: bounded_schema_id(offset + 2),
			})),
			{ id: bounded_schema_id(255), kind: "scalar", value_type: "string" as const },
		],
	};
	const admitted = normalize_box_document(nodes);
	expect(admitted.nodes).toHaveLength(256);
	expect(() => application_data_operation_contracts("550e8400-e29b-41d4-a716-446655440000", "1", admitted)).toThrow("too many nodes");
});
