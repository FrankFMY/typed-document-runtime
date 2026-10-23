import { describe, expect, test } from "bun:test";
import type { BoxDocumentNode } from "./box-document.js";
import type { RuntimeExecutionRequest, RuntimePublication } from "./runtime.js";
import { execute_project_runtime, RUNTIME_BUDGET_LIMITS } from "./runtime.js";

const id = (index: number): string => `40000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const STRING = id(1);
const ROOT = id(2);
const OUTPUT = id(3);
const REALM = id(4);
const BOX = id(5);
const NUMBER = id(8);
const NUMBER_LIST = id(9);
const ITEMS = id(12);

const publication: RuntimePublication = {
	id: id(6),
	snapshot: {
		schema: "project.source.snapshot.v1",
		project_id: id(7),
		revision: "1",
		realms: [{ id: REALM, name: "Primary", is_primary: true }],
		boxes: [
			{
				id: BOX,
				realm_id: REALM,
				parent_id: null,
				name: "Bounded Box",
				document_version: "1",
				document: {
					schema: "box.document.v2",
					root_id: ROOT,
					nodes: [
						{ id: STRING, kind: "scalar", value_type: "string" },
						{
							id: ROOT,
							kind: "record",
							fields: [
								{ id: ITEMS, name: "items", type_id: NUMBER_LIST, required: false },
								{ id: OUTPUT, name: "output", type_id: STRING, required: false },
							],
						},
						{ id: NUMBER, kind: "scalar", value_type: "number" },
						{ id: NUMBER_LIST, kind: "list", item_type_id: NUMBER },
					],
					program: {
						schema: "box.program.v1",
						body: [
							{
								id: id(10),
								kind: "write",
								cell_id: OUTPUT,
								value: { id: id(11), kind: "literal", type_id: STRING, value: "done" },
							},
						],
					},
				},
			},
		],
	},
};

const request: RuntimeExecutionRequest = {
	publication,
	entry_box_id: BOX,
	input: [],
	output_cell_ids: [OUTPUT],
	budget: { max_steps: 1, max_call_depth: 4, max_value_nodes: 100, max_string_units: 10_000 },
};

describe("Runtime resource fences", () => {
	test("stops before exceeding the deterministic step budget", () => {
		const first = execute_project_runtime(request);
		const second = execute_project_runtime(request);

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			status: "fault",
			fault: { code: "budget_exceeded" },
			usage: { steps: 1 },
		});
		expect(first.usage.steps).toBeLessThanOrEqual(request.budget.max_steps);
		expect(first.trace.at(-1)).toMatchObject({ kind: "box.exit", outcome: "fault" });
	});

	test("attributes a pre-event step-budget failure to the attempted next statement", () => {
		const two_statements = structuredClone(publication);
		const box = two_statements.snapshot.boxes[0];
		if (!box || box.document.schema !== "box.document.v2") throw new Error("Executable fixture missing");
		const first_statement = box.document.program.body[0];
		if (!first_statement || first_statement.kind !== "write") throw new Error("Write fixture missing");
		const second_statement_id = id(20);
		box.document.program.body.push({
			...structuredClone(first_statement),
			id: second_statement_id,
			value: { ...structuredClone(first_statement.value), id: id(21) },
		});
		const outcome = execute_project_runtime({
			...request,
			publication: two_statements,
			budget: { ...request.budget, max_steps: 2 },
			inspection: "structure",
		});
		expect(outcome).toMatchObject({ status: "fault", fault: { code: "budget_exceeded" } });
		expect(outcome.inspection?.events.find((event) => event.kind === "failure")).toMatchObject({
			statement_id: second_statement_id,
			expression_id: null,
			outcome: "fault",
		});
	});

	test("stops before exceeding the deterministic value budget", () => {
		const outcome = execute_project_runtime({
			...request,
			input: [{ cell_id: OUTPUT, value: "seed" }],
			budget: { ...request.budget, max_steps: 10, max_value_nodes: 1 },
		});

		expect(outcome).toMatchObject({
			status: "fault",
			fault: { code: "budget_exceeded" },
			usage: { value_nodes: 1 },
		});
		expect(outcome.usage.value_nodes).toBeLessThanOrEqual(1);
	});

	test("records the target output cell when final output accounting faults", () => {
		const outcome = execute_project_runtime({
			...request,
			budget: { ...request.budget, max_steps: 10, max_string_units: 4 },
			inspection: "structure",
		});
		expect(outcome).toMatchObject({ status: "fault", fault: { code: "budget_exceeded" }, usage: { string_units: 4 } });
		expect(outcome.inspection?.events.slice(-2)).toMatchObject([
			{ kind: "frame.exit", outcome: "success" },
			{ kind: "failure", statement_id: null, expression_id: null, cell_id: OUTPUT, outcome: "fault" },
		]);
		expect(outcome.inspection?.events.filter((event) => event.kind === "failure")).toHaveLength(1);
	});

	test("rejects an oversized input before traversing its values", () => {
		let read = false;
		const values = [1];
		Object.defineProperty(values, 0, {
			get() {
				read = true;
				throw new Error("must not read beyond the budget");
			},
		});
		const outcome = execute_project_runtime({
			...request,
			input: [{ cell_id: ITEMS, value: values }],
			budget: { ...request.budget, max_steps: 10, max_value_nodes: 1 },
		});

		expect(outcome).toMatchObject({ status: "fault", fault: { code: "budget_exceeded" }, usage: { value_nodes: 0 } });
		expect(read).toBe(false);
	});

	test("rejects caller budgets above the platform ceilings", () => {
		expect(
			execute_project_runtime({
				...request,
				budget: { ...RUNTIME_BUDGET_LIMITS, max_steps: RUNTIME_BUDGET_LIMITS.max_steps + 1 },
			}),
		).toMatchObject({ status: "fault", fault: { code: "invalid_budget" }, usage: { steps: 0, calls: 0, value_nodes: 0 }, trace: [] });
	});

	test("compares compact shared type DAGs without expanding structural signatures", () => {
		const nodes: BoxDocumentNode[] = [{ id: id(1000), kind: "scalar", value_type: "number" }];
		let previous_type_id = id(1000);
		let left_cell_id = "";
		let right_cell_id = "";
		for (let level = 1; level <= 18; level += 1) {
			left_cell_id = id(2000 + level * 2);
			right_cell_id = id(2001 + level * 2);
			const current_type_id = id(1000 + level);
			nodes.push({
				id: current_type_id,
				kind: "record",
				fields: [
					{ id: left_cell_id, name: "left", type_id: previous_type_id, required: false },
					{ id: right_cell_id, name: "right", type_id: previous_type_id, required: false },
				],
			});
			previous_type_id = current_type_id;
		}

		const compact_publication: RuntimePublication = {
			id: id(4000),
			snapshot: {
				schema: "project.source.snapshot.v1",
				project_id: id(4001),
				revision: "1",
				realms: [{ id: id(4002), name: "Primary", is_primary: true }],
				boxes: [
					{
						id: id(4003),
						realm_id: id(4002),
						parent_id: null,
						name: "Shared type graph",
						document_version: "1",
						document: {
							schema: "box.document.v2",
							root_id: previous_type_id,
							nodes,
							program: {
								schema: "box.program.v1",
								body: [
									{
										id: id(4004),
										kind: "write",
										cell_id: left_cell_id,
										value: { id: id(4005), kind: "cell", type_id: id(1017), cell_id: right_cell_id },
									},
								],
							},
						},
					},
				],
			},
		};

		const outcome = execute_project_runtime({
			publication: compact_publication,
			entry_box_id: id(4003),
			input: [],
			output_cell_ids: [],
			budget: { max_steps: 10, max_call_depth: 4, max_value_nodes: 10, max_string_units: 10_000 },
		});

		expect(outcome).toMatchObject({ status: "fault", fault: { code: "uninitialized_cell" }, usage: { steps: 2, calls: 1 } });
	});

	test("stops repeated string concatenation before allocating an oversized result", () => {
		const doubling = structuredClone(publication);
		const box = doubling.snapshot.boxes[0];
		if (!box || box.document.schema !== "box.document.v2") throw new Error("String budget fixture is unavailable");
		box.document.program.body = Array.from({ length: 20 }, (_, index) => ({
			id: id(5000 + index * 4),
			kind: "write" as const,
			cell_id: OUTPUT,
			value: {
				id: id(5001 + index * 4),
				kind: "binary" as const,
				type_id: STRING,
				operator: "concat" as const,
				left: { id: id(5002 + index * 4), kind: "cell" as const, type_id: STRING, cell_id: OUTPUT },
				right: { id: id(5003 + index * 4), kind: "cell" as const, type_id: STRING, cell_id: OUTPUT },
			},
		}));

		const outcome = execute_project_runtime({
			publication: doubling,
			entry_box_id: BOX,
			input: [{ cell_id: OUTPUT, value: "x" }],
			output_cell_ids: [OUTPUT],
			budget: { max_steps: 100, max_call_depth: 4, max_value_nodes: 100, max_string_units: 2_048 },
		});

		expect(outcome).toMatchObject({ status: "fault", fault: { code: "budget_exceeded" } });
		expect(outcome.usage.string_units).toBeLessThanOrEqual(2_048);
	});

	test("charges selected output strings before they escape", () => {
		const outcome = execute_project_runtime({
			...request,
			budget: { ...request.budget, max_steps: 10, max_value_nodes: 10, max_string_units: 4 },
		});

		expect(outcome).toMatchObject({ status: "fault", fault: { code: "budget_exceeded" }, usage: { string_units: 4 } });
	});
});
