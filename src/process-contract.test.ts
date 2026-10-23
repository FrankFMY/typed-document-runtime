import { expect, test } from "bun:test";
import { normalize_box_document, normalize_box_value } from "./box-document.js";
import {
	box_contract_accepts,
	check_process_operation_contract,
	process_application_contract,
	process_operation_contracts,
} from "./process-contract.js";
import { normalize_process_document } from "./process-document.js";

const id = (n: number): string => `93000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const schema = (optional_extra: boolean, required = false) =>
	normalize_box_document({
		schema: "box.document.v1",
		root_id: id(1),
		nodes: [
			{
				id: id(1),
				kind: "record",
				fields: [
					{ id: id(3), name: "name", type_id: id(2), required: true },
					...(optional_extra ? [{ id: id(4), name: "note", type_id: id(2), required }] : []),
				],
			},
			{ id: id(2), kind: "scalar", value_type: "string" },
		],
	});

test("installed request can add an optional field while a strict old result cannot consume the same widening", () => {
	const old = schema(false);
	const next = schema(true);
	expect(box_contract_accepts(next, old)).toBe(true);
	expect(box_contract_accepts(old, next)).toBe(false);
	expect(normalize_box_value(next, { name: "sample" })).toEqual({ name: "sample" });
	expect(() => normalize_box_value(old, { name: "sample", note: "new" })).toThrow();
});

const process_document = () =>
	normalize_process_document({
		schema: "process.document.v1",
		root_id: id(20),
		nodes: [
			...schema(false).nodes,
			{
				id: id(20),
				kind: "record",
				fields: [
					{ id: id(21), name: "request", type_id: id(1), required: true },
					{ id: id(22), name: "result", type_id: id(1), required: false },
				],
			},
		],
		input_cell_ids: [id(21)],
		output_cell_ids: [id(22)],
		effects: [
			{
				id: id(23),
				capability: "example.record.lookup.v1",
				request_cell_id: id(21),
				request_type_id: id(1),
				result_cell_id: id(22),
				result_type_id: id(1),
			},
		],
		program: { schema: "process.program.v1", body: [{ id: id(24), kind: "effect", effect_id: id(23) }] },
	});

test("schema-only application contract projects only exposed root fields and their reachable type closure", () => {
	const document = normalize_process_document({
		schema: "process.document.v1",
		root_id: id(40),
		nodes: [
			{
				id: id(40),
				kind: "record",
				fields: [
					{ id: id(41), name: "query", type_id: id(50), required: true },
					{ id: id(42), name: "limit", type_id: id(51), required: false },
					{ id: id(43), name: "records", type_id: id(52), required: false },
					{ id: id(44), name: "total", type_id: id(51), required: true },
					{ id: id(45), name: "private_state", type_id: id(54), required: false },
				],
			},
			{ id: id(50), kind: "scalar", value_type: "string" },
			{ id: id(51), kind: "scalar", value_type: "number" },
			{ id: id(52), kind: "list", item_type_id: id(53) },
			{ id: id(53), kind: "reference", target_id: id(50) },
			{ id: id(54), kind: "scalar", value_type: "boolean" },
		],
		input_cell_ids: [id(42), id(41)],
		output_cell_ids: [id(44), id(43)],
		effects: [],
		program: { schema: "process.program.v1", body: [] },
	});

	expect(process_application_contract(document)).toEqual({
		input_schema: {
			schema: "box.document.v1",
			root_id: id(40),
			nodes: [
				{
					id: id(40),
					kind: "record",
					fields: [
						{ id: id(42), name: "limit", type_id: id(51), required: false },
						{ id: id(41), name: "query", type_id: id(50), required: true },
					],
				},
				{ id: id(50), kind: "scalar", value_type: "string" },
				{ id: id(51), kind: "scalar", value_type: "number" },
			],
		},
		output_schema: {
			schema: "box.document.v1",
			root_id: id(40),
			nodes: [
				{
					id: id(40),
					kind: "record",
					fields: [
						{ id: id(43), name: "records", type_id: id(52), required: false },
						{ id: id(44), name: "total", type_id: id(51), required: true },
					],
				},
				{ id: id(50), kind: "scalar", value_type: "string" },
				{ id: id(51), kind: "scalar", value_type: "number" },
				{ id: id(52), kind: "list", item_type_id: id(53) },
				{ id: id(53), kind: "reference", target_id: id(50) },
			],
		},
	});
});

test("schema-only application contract normalizes first and rejects malformed projection identities", () => {
	const invalid = process_document();
	invalid.input_cell_ids.push(id(99));
	expect(() => process_application_contract(invalid)).toThrow("unknown root cell");
});
test("publication requirements derive detached canonical reachable schemas from its immutable Process", () => {
	const document = process_document();
	const before = structuredClone(document);
	const contracts = process_operation_contracts(document);
	expect<unknown>(contracts).toEqual([{ effect_id: id(23), capability: "example.record.lookup.v1", request: schema(false), result: schema(false) }]);
	expect(document).toEqual(before);
	expect(contracts[0]!.request.nodes[0]).not.toBe(document.nodes[0]);
});

test("preflight checks requests contravariantly and results covariantly and never grants an unavailable operation", () => {
	const contract = process_operation_contracts(process_document())[0]!;
	expect(check_process_operation_contract(contract, { ...contract, request: schema(true) }).status).toBe("compatible");
	expect(check_process_operation_contract(contract, { ...contract, request: schema(true, true) }).status).toBe("request_incompatible");
	expect(check_process_operation_contract(contract, { ...contract, result: schema(true) }).status).toBe("result_incompatible");
	expect(check_process_operation_contract(contract, null).status).toBe("unavailable");
	expect(check_process_operation_contract(contract, { ...contract, capability: "example.other.lookup.v1" }).status).toBe("unavailable");
});

test("wire contract comparison follows nested lists and reference aliases independently of declaration identities", () => {
	const nested = normalize_box_document({
		schema: "box.document.v1",
		root_id: id(10),
		nodes: [...schema(false).nodes, { id: id(10), kind: "list", item_type_id: id(11) }, { id: id(11), kind: "reference", target_id: id(1) }],
	});
	const renamed = JSON.parse(JSON.stringify(nested).replaceAll("93000000-", "94000000-"));
	expect(box_contract_accepts(nested, renamed)).toBe(true);
	expect(box_contract_accepts(renamed, nested)).toBe(true);
	const widened = normalize_box_document({
		...nested,
		nodes: [...schema(true).nodes, ...nested.nodes.filter((node) => node.id === id(10) || node.id === id(11))],
	});
	expect(box_contract_accepts(widened, nested)).toBe(true);
	expect(box_contract_accepts(nested, widened)).toBe(false);
});

test("requiredness, renamed wire fields and scalar changes are not cosmetic compatibility", () => {
	expect(box_contract_accepts(schema(true, true), schema(false))).toBe(false);
	expect(box_contract_accepts(schema(true), schema(true, true))).toBe(true);
	expect(box_contract_accepts(schema(true, true), schema(true))).toBe(false);
	const renamed = normalize_box_document(JSON.parse(JSON.stringify(schema(false)).replace('"name":"name"', '"name":"label"')));
	expect(box_contract_accepts(schema(false), renamed)).toBe(false);
	const number = normalize_box_document({ schema: "box.document.v1", root_id: id(2), nodes: [{ id: id(2), kind: "scalar", value_type: "number" }] });
	expect(box_contract_accepts(number, schema(false))).toBe(false);
});

test("wire contract comparison preserves record relation target identity", () => {
	const related = (entity_id: string) => {
		const value = structuredClone(schema(false));
		const root = value.nodes.find((node) => node.id === value.root_id);
		if (root?.kind !== "record") throw new Error("Fixture root missing");
		root.fields[0]!.record_target = { entity_id };
		return normalize_box_document(value);
	};
	const original = related(id(70));
	const same = related(id(70));
	const retargeted = related(id(71));

	expect(box_contract_accepts(original, same)).toBe(true);
	expect(box_contract_accepts(original, retargeted)).toBe(false);
});

test("empty schema means absence and malformed installed contracts fail closed", () => {
	const empty = normalize_box_document({ schema: "box.document.v1", root_id: null, nodes: [] });
	const absence = normalize_box_document({
		schema: "box.document.v1",
		root_id: id(1),
		nodes: [{ id: id(1), kind: "scalar", value_type: "absence" }],
	});
	expect(box_contract_accepts(empty, absence)).toBe(true);
	expect(box_contract_accepts(absence, empty)).toBe(true);
	expect(box_contract_accepts(empty, schema(false))).toBe(false);
	const contract = process_operation_contracts(process_document())[0]!;
	expect(check_process_operation_contract(contract, { ...contract, request: { ...contract.request, nodes: [] } }).status).toBe("invalid_contract");
	expect(check_process_operation_contract(contract, { ...contract, request: schema(true, true), result: schema(true) }).status).toBe(
		"request_and_result_incompatible",
	);
	const invalid = process_document();
	invalid.effects.push(invalid.effects[0]!);
	expect(() => process_operation_contracts(invalid)).toThrow();
});
