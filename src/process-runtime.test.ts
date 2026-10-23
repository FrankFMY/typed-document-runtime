import { describe, expect, test } from "bun:test";
import type { BoxDocument } from "./box-document.js";
import type { ProcessDocument } from "./process-document.js";
import { execute_process_runtime } from "./process-runtime.js";
import { normalize_project_source_snapshot } from "./project-source-snapshot.js";

const id = (index: number): string => `72000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const PROJECT = id(1);
const REALM = id(2);
const PROCESS = id(3);
const PUBLICATION = id(4);
const INVOCATION = id(5);
const STRING = id(10);
const ROOT = id(11);
const INPUT = id(12);
const EFFECT_RESULT = id(13);
const OUTPUT = id(14);
const EFFECT = id(20);
const EFFECT_STATEMENT = id(21);
const WRITE_STATEMENT = id(22);
const WRITE_VALUE = id(23);
const BOOLEAN = id(30);
const REJECT_FLAG = id(31);
const REJECT_STATEMENT = id(32);
const REJECT_CONDITION = id(33);
const CHILD_BOX = id(40);
const CHILD_STRING = id(41);
const CHILD_ROOT = id(42);
const CHILD_VALUE = id(43);
const CHILD_WRITE = id(44);
const CHILD_CONCAT = id(45);
const CHILD_LEFT = id(46);
const CHILD_SUFFIX = id(47);
const PROCESS_CALL = id(48);
const PROCESS_SHARE = id(49);

const process_document: ProcessDocument = {
	schema: "process.document.v1",
	root_id: ROOT,
	nodes: [
		{ id: STRING, kind: "scalar", value_type: "string" },
		{
			id: ROOT,
			kind: "record",
			fields: [
				{ id: EFFECT_RESULT, name: "effect_result", type_id: STRING, required: false },
				{ id: INPUT, name: "input", type_id: STRING, required: true },
				{ id: OUTPUT, name: "output", type_id: STRING, required: false },
			],
		},
	],
	input_cell_ids: [INPUT],
	output_cell_ids: [OUTPUT],
	effects: [
		{
			id: EFFECT,
			capability: "postgres.probe.append.v1",
			request_cell_id: INPUT,
			request_type_id: STRING,
			result_cell_id: EFFECT_RESULT,
			result_type_id: STRING,
		},
	],
	program: {
		schema: "process.program.v1",
		body: [
			{ id: EFFECT_STATEMENT, kind: "effect", effect_id: EFFECT },
			{
				id: WRITE_STATEMENT,
				kind: "write",
				cell_id: OUTPUT,
				value: { id: WRITE_VALUE, kind: "cell", cell_id: EFFECT_RESULT, type_id: STRING },
			},
		],
	},
};

interface AdditionalBox {
	id: string;
	realm_id: string;
	parent_id: string | null;
	name: string;
	document_version: string;
	document: BoxDocument;
}

const publication_for = (document: ProcessDocument, additional_boxes: AdditionalBox[] = []) => ({
	id: PUBLICATION,
	snapshot: normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1",
		project_id: PROJECT,
		revision: "1",
		realms: [{ id: REALM, name: "Main", is_primary: true }],
		boxes: [
			{
				id: PROCESS,
				realm_id: REALM,
				parent_id: null,
				name: "Append",
				document_version: "1",
				document,
			},
			...additional_boxes,
		],
	}),
});

const publication = publication_for(process_document);

const request = {
	publication,
	process_id: PROCESS,
	invocation_id: INVOCATION,
	input: [{ cell_id: INPUT, value: "hello" }],
	effect_receipts: [],
	budget: { max_steps: 20, max_call_depth: 4, max_value_nodes: 40, max_string_units: 1000, max_effects: 4 },
};

describe("pure Process runtime protocol", () => {
	test("reuses pure Box share semantics before requesting a Process effect", () => {
		const child_document: BoxDocument = {
			schema: "box.document.v2",
			root_id: CHILD_ROOT,
			nodes: [
				{ id: CHILD_STRING, kind: "scalar", value_type: "string" },
				{
					id: CHILD_ROOT,
					kind: "record",
					fields: [{ id: CHILD_VALUE, name: "value", type_id: CHILD_STRING, required: true }],
				},
			],
			program: {
				schema: "box.program.v1",
				body: [
					{
						id: CHILD_WRITE,
						kind: "write",
						cell_id: CHILD_VALUE,
						value: {
							id: CHILD_CONCAT,
							kind: "binary",
							type_id: CHILD_STRING,
							operator: "concat",
							left: { id: CHILD_LEFT, kind: "cell", cell_id: CHILD_VALUE, type_id: CHILD_STRING },
							right: { id: CHILD_SUFFIX, kind: "literal", type_id: CHILD_STRING, value: ":box" },
						},
					},
				],
			},
		};
		const calling_document: ProcessDocument = {
			...process_document,
			program: {
				...process_document.program,
				body: [
					{
						id: PROCESS_CALL,
						kind: "call",
						box_id: CHILD_BOX,
						init: [{ id: PROCESS_SHARE, kind: "share", caller_cell_id: INPUT, callee_cell_id: CHILD_VALUE }],
					},
					...process_document.program.body,
				],
			},
		};
		const outcome = execute_process_runtime({
			...request,
			publication: publication_for(calling_document, [
				{
					id: CHILD_BOX,
					realm_id: REALM,
					parent_id: null,
					name: "Transform",
					document_version: "1",
					document: child_document,
				},
			]),
		});

		expect(outcome).toMatchObject({ status: "effect", effect: { request: "hello:box" }, usage: { calls: 2 } });
	});

	test("suspends with the next typed effect intent when no receipt exists", () => {
		expect(execute_process_runtime(request)).toMatchObject({
			status: "effect",
			publication_id: PUBLICATION,
			project_id: PROJECT,
			source_revision: "1",
			process_id: PROCESS,
			invocation_id: INVOCATION,
			effect: {
				index: 0,
				statement_id: EFFECT_STATEMENT,
				effect_id: EFFECT,
				capability: "postgres.probe.append.v1",
				request: "hello",
			},
		});
	});

	test("redacts every recorded value for an effectful Process while retaining metadata", () => {
		const outcome = execute_process_runtime({ ...request, inspection: "values" });
		expect(outcome).toMatchObject({ status: "effect", inspection: { mode: "values", values: "redacted", truncated: false } });
		const value_events = outcome.inspection?.events.filter((event) => event.value !== null) ?? [];
		expect(value_events.some((event) => event.kind === "cell.input" && event.cell_id === INPUT)).toBe(true);
		expect(value_events.some((event) => event.kind === "effect" && event.statement_id === EFFECT_STATEMENT)).toBe(true);
		expect(value_events.every((event) => event.value?.status === "redacted" || event.value?.status === "uninitialized")).toBe(true);
		expect(JSON.stringify(outcome.inspection)).not.toContain("hello");
	});

	test("replays one matching effect receipt into the declared result cell", () => {
		expect(
			execute_process_runtime({
				...request,
				effect_receipts: [
					{
						statement_id: EFFECT_STATEMENT,
						effect_id: EFFECT,
						capability: "postgres.probe.append.v1",
						request: "hello",
						result: "stored",
					},
				],
			}),
		).toMatchObject({
			status: "success",
			process_id: PROCESS,
			invocation_id: INVOCATION,
			outputs: [{ cell_id: OUTPUT, value: "stored" }],
			usage: { effects: 1 },
		});
	});

	test("faults instead of ignoring an effect receipt after typed rejection", () => {
		const rejecting_document: ProcessDocument = {
			...process_document,
			nodes: [
				...process_document.nodes.map((node) =>
					node.kind === "record" && node.id === ROOT
						? { ...node, fields: [...node.fields, { id: REJECT_FLAG, name: "reject_flag", type_id: BOOLEAN, required: false }] }
						: node,
				),
				{ id: BOOLEAN, kind: "scalar", value_type: "boolean" },
			],
			program: {
				schema: "process.program.v1",
				body: [
					process_document.program.body[0]!,
					{
						id: REJECT_STATEMENT,
						kind: "reject_if",
						code: "probe_rejected",
						condition: { id: REJECT_CONDITION, kind: "literal", type_id: BOOLEAN, value: true },
					},
				],
			},
		};
		const receipt = {
			statement_id: EFFECT_STATEMENT,
			effect_id: EFFECT,
			capability: "postgres.probe.append.v1",
			request: "hello",
			result: "stored",
		};

		expect(
			execute_process_runtime({
				...request,
				publication: publication_for(rejecting_document),
				effect_receipts: [receipt, receipt],
			}),
		).toMatchObject({ status: "fault", fault: { code: "invalid_effect_receipt" } });
	});

	test("rejects an over-budget receipt transcript before entering the Process", () => {
		const receipt = {
			statement_id: EFFECT_STATEMENT,
			effect_id: EFFECT,
			capability: "postgres.probe.append.v1",
			request: "hello",
			result: "stored",
		};

		expect(
			execute_process_runtime({
				...request,
				effect_receipts: Array.from({ length: 5 }, () => receipt),
				budget: { ...request.budget, max_effects: 4 },
			}),
		).toMatchObject({ status: "fault", fault: { code: "invalid_budget" }, trace: [], usage: { effects: 0 } });
	});
});
