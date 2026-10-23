import { describe, expect, test } from "bun:test";
import type { RuntimePublication } from "./runtime.js";
import { execute_project_runtime } from "./runtime.js";

const id = (index: number): string => `30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const PROJECT_ID = id(1);
const PUBLICATION_ID = id(2);
const REALM_ID = id(3);
const CALLER_ID = id(4);
const CALLEE_ID = id(5);

const CALLER_NUMBER_ID = id(10);
const CALLER_ROOT_ID = id(11);
const SOURCE_ID = id(12);
const SHARED_ID = id(13);
const CALLER_UNSET_ID = id(14);

const CALLEE_NUMBER_ID = id(20);
const CALLEE_ROOT_ID = id(21);
const COPY_ID = id(22);
const CALLEE_SHARED_ID = id(23);
const LITERAL_ID = id(24);
const CALLEE_UNSET_ID = id(25);

const publication: RuntimePublication = {
	id: PUBLICATION_ID,
	snapshot: {
		schema: "project.source.snapshot.v1",
		project_id: PROJECT_ID,
		revision: "4",
		realms: [{ id: REALM_ID, name: "Main", is_primary: true }],
		boxes: [
			{
				id: CALLER_ID,
				realm_id: REALM_ID,
				parent_id: null,
				name: "Caller",
				document_version: "2",
				document: {
					schema: "box.document.v2",
					root_id: CALLER_ROOT_ID,
					nodes: [
						{ id: CALLER_NUMBER_ID, kind: "scalar", value_type: "number" },
						{
							id: CALLER_ROOT_ID,
							kind: "record",
							fields: [
								{ id: SHARED_ID, name: "shared", type_id: CALLER_NUMBER_ID, required: true },
								{ id: SOURCE_ID, name: "source", type_id: CALLER_NUMBER_ID, required: true },
							],
						},
					],
					program: {
						schema: "box.program.v1",
						body: [
							{
								id: id(100),
								kind: "call",
								box_id: CALLEE_ID,
								init: [
									{ id: id(101), kind: "copy", callee_cell_id: COPY_ID, caller_cell_id: SOURCE_ID },
									{ id: id(102), kind: "share", callee_cell_id: CALLEE_SHARED_ID, caller_cell_id: SHARED_ID },
									{
										id: id(103),
										kind: "value",
										callee_cell_id: LITERAL_ID,
										value: { id: id(104), kind: "literal", type_id: CALLER_NUMBER_ID, value: 3 },
									},
								],
							},
						],
					},
				},
			},
			{
				id: CALLEE_ID,
				realm_id: REALM_ID,
				parent_id: null,
				name: "Callee",
				document_version: "3",
				document: {
					schema: "box.document.v2",
					root_id: CALLEE_ROOT_ID,
					nodes: [
						{ id: CALLEE_NUMBER_ID, kind: "scalar", value_type: "number" },
						{
							id: CALLEE_ROOT_ID,
							kind: "record",
							fields: [
								{ id: COPY_ID, name: "copy", type_id: CALLEE_NUMBER_ID, required: true },
								{ id: LITERAL_ID, name: "literal", type_id: CALLEE_NUMBER_ID, required: true },
								{ id: CALLEE_SHARED_ID, name: "shared", type_id: CALLEE_NUMBER_ID, required: true },
							],
						},
					],
					program: {
						schema: "box.program.v1",
						body: [
							{
								id: id(200),
								kind: "write",
								cell_id: COPY_ID,
								value: {
									id: id(201),
									kind: "binary",
									type_id: CALLEE_NUMBER_ID,
									operator: "add",
									left: { id: id(202), kind: "cell", type_id: CALLEE_NUMBER_ID, cell_id: COPY_ID },
									right: { id: id(203), kind: "literal", type_id: CALLEE_NUMBER_ID, value: 100 },
								},
							},
							{
								id: id(210),
								kind: "write",
								cell_id: CALLEE_SHARED_ID,
								value: {
									id: id(211),
									kind: "binary",
									type_id: CALLEE_NUMBER_ID,
									operator: "add",
									left: {
										id: id(212),
										kind: "binary",
										type_id: CALLEE_NUMBER_ID,
										operator: "add",
										left: { id: id(213), kind: "cell", type_id: CALLEE_NUMBER_ID, cell_id: CALLEE_SHARED_ID },
										right: { id: id(214), kind: "cell", type_id: CALLEE_NUMBER_ID, cell_id: COPY_ID },
									},
									right: { id: id(215), kind: "cell", type_id: CALLEE_NUMBER_ID, cell_id: LITERAL_ID },
								},
							},
						],
					},
				},
			},
		],
	},
};

describe("Box call memory", () => {
	test("copies isolated values and shares one typed cell through $", () => {
		const request = {
			publication,
			entry_box_id: CALLER_ID,
			input: [
				{ cell_id: SOURCE_ID, value: 2 },
				{ cell_id: SHARED_ID, value: 5 },
			],
			output_cell_ids: [SOURCE_ID, SHARED_ID],
			budget: { max_steps: 100, max_call_depth: 4, max_value_nodes: 100, max_string_units: 10_000 },
		};
		const result = execute_project_runtime(request);
		expect(result.status).toBe("success");
		if (result.status !== "success") throw new Error(result.status === "fault" ? result.fault.code : result.rejection.code);
		expect(result.outputs).toEqual([
			{ cell_id: SOURCE_ID, value: 2 },
			{ cell_id: SHARED_ID, value: 110 },
		]);
		expect(result.usage.calls).toBe(2);
		expect(result.trace.some((event) => event.kind === "box.enter" && event.box_id === CALLEE_ID && event.depth === 1)).toBe(true);
		expect(execute_project_runtime(request)).toEqual(result);
	});

	test("rejects excess call depth before evaluating child initialization", () => {
		const outcome = execute_project_runtime({
			publication,
			entry_box_id: CALLER_ID,
			input: [
				{ cell_id: SOURCE_ID, value: 2 },
				{ cell_id: SHARED_ID, value: 5 },
			],
			output_cell_ids: [SHARED_ID],
			budget: { max_steps: 100, max_call_depth: 1, max_value_nodes: 100, max_string_units: 10_000 },
		});

		expect(outcome).toMatchObject({
			status: "fault",
			fault: { code: "budget_exceeded" },
			usage: { calls: 1, steps: 1 },
		});
		expect(outcome.trace.some((event) => event.kind === "box.enter" && event.box_id === CALLEE_ID)).toBe(false);
	});

	test("rejects a self-call before evaluating child initialization", () => {
		const recursive = structuredClone(publication);
		const caller = recursive.snapshot.boxes.find((box) => box.id === CALLER_ID);
		if (!caller || caller.document.schema !== "box.document.v2") throw new Error("Caller fixture is unavailable");
		const root = caller.document.nodes.find((node) => node.id === CALLER_ROOT_ID);
		if (!root || root.kind !== "record") throw new Error("Caller frame fixture is unavailable");
		root.fields.push({ id: CALLER_UNSET_ID, name: "unset", type_id: CALLER_NUMBER_ID, required: false });
		caller.document.program.body = [
			{
				id: id(120),
				kind: "call",
				box_id: CALLER_ID,
				init: [
					{
						id: id(121),
						kind: "value",
						callee_cell_id: SOURCE_ID,
						value: { id: id(122), kind: "cell", type_id: CALLER_NUMBER_ID, cell_id: CALLER_UNSET_ID },
					},
				],
			},
		];

		const outcome = execute_project_runtime({
			publication: recursive,
			entry_box_id: CALLER_ID,
			input: [
				{ cell_id: SOURCE_ID, value: 2 },
				{ cell_id: SHARED_ID, value: 5 },
			],
			output_cell_ids: [SHARED_ID],
			budget: { max_steps: 100, max_call_depth: 4, max_value_nodes: 100, max_string_units: 10_000 },
		});

		expect(outcome).toMatchObject({ status: "fault", fault: { code: "recursive_call" }, usage: { calls: 1, steps: 1 } });
		expect(outcome.trace.filter((event) => event.kind === "box.enter")).toHaveLength(1);
	});

	test("rejects a multi-Box cycle before evaluating the recursive child initialization", () => {
		const recursive = structuredClone(publication);
		const callee = recursive.snapshot.boxes.find((box) => box.id === CALLEE_ID);
		if (!callee || callee.document.schema !== "box.document.v2") throw new Error("Callee fixture is unavailable");
		const root = callee.document.nodes.find((node) => node.id === CALLEE_ROOT_ID);
		if (!root || root.kind !== "record") throw new Error("Callee frame fixture is unavailable");
		root.fields.push({ id: CALLEE_UNSET_ID, name: "unset", type_id: CALLEE_NUMBER_ID, required: false });
		callee.document.program.body = [
			{
				id: id(220),
				kind: "call",
				box_id: CALLER_ID,
				init: [
					{
						id: id(221),
						kind: "value",
						callee_cell_id: SOURCE_ID,
						value: { id: id(222), kind: "cell", type_id: CALLEE_NUMBER_ID, cell_id: CALLEE_UNSET_ID },
					},
				],
			},
		];

		const outcome = execute_project_runtime({
			publication: recursive,
			entry_box_id: CALLER_ID,
			input: [
				{ cell_id: SOURCE_ID, value: 2 },
				{ cell_id: SHARED_ID, value: 5 },
			],
			output_cell_ids: [SHARED_ID],
			budget: { max_steps: 100, max_call_depth: 4, max_value_nodes: 100, max_string_units: 10_000 },
		});

		expect(outcome).toMatchObject({ status: "fault", fault: { code: "recursive_call" }, usage: { calls: 2, steps: 3 } });
		expect(outcome.trace.filter((event) => event.kind === "box.enter" && event.box_id === CALLER_ID)).toHaveLength(1);
	});

	test("allocates deterministic distinct frame identities for sequential calls of the same Box", () => {
		const repeated = structuredClone(publication);
		const caller = repeated.snapshot.boxes.find((box) => box.id === CALLER_ID);
		if (!caller || caller.document.schema !== "box.document.v2") throw new Error("Caller fixture is unavailable");
		const first_call = caller.document.program.body[0];
		if (!first_call || first_call.kind !== "call") throw new Error("Call fixture is unavailable");
		caller.document.program.body.push({
			...structuredClone(first_call),
			id: id(110),
			init: first_call.init.map((item, index) => {
				const cloned = structuredClone(item);
				cloned.id = id(111 + index);
				if (cloned.kind === "value") cloned.value.id = id(120);
				return cloned;
			}),
		});
		const request = {
			publication: repeated,
			entry_box_id: CALLER_ID,
			input: [
				{ cell_id: SOURCE_ID, value: 2 },
				{ cell_id: SHARED_ID, value: 5 },
			],
			output_cell_ids: [SHARED_ID],
			budget: { max_steps: 100, max_call_depth: 4, max_value_nodes: 200, max_string_units: 10_000 },
			inspection: "structure" as const,
		};
		const first = execute_project_runtime(request);
		const second = execute_project_runtime(request);
		expect(second).toEqual(first);
		expect(first).toMatchObject({ status: "success", outputs: [{ cell_id: SHARED_ID, value: 215 }] });
		expect(first.inspection?.events.filter((event) => event.kind === "frame.enter")).toMatchObject([
			{ frame_id: 0, parent_frame_id: null, depth: 0, box_id: CALLER_ID },
			{ frame_id: 1, parent_frame_id: 0, depth: 1, box_id: CALLEE_ID },
			{ frame_id: 2, parent_frame_id: 0, depth: 1, box_id: CALLEE_ID },
		]);
	});
});
